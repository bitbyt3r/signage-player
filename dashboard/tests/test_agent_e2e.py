"""End to end: the real device agent against the dev server (moto-backed).

Runs the agent in dry-run mode (no systemctl, no NetworkManager) with its
state in a temp dir, and uses the image's own signage-config to validate
the overrides it writes.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import time
import tomllib
import urllib.request
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SIGNAGE_CONFIG = ROOT.parent / "mkosi.extra/usr/lib/signage/signage-config"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(method, url, body=None, token=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": ctype})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=20) as r:
        out = r.read()
        return json.loads(out) if r.headers.get("content-type") == "application/json" else out


@pytest.fixture(scope="module")
def server():
    port, moto_port = free_port(), free_port()
    env = dict(os.environ, DEV_QUIET="1")
    for k in ("AWS_ENDPOINT_URL", "ADMIN_PASSWORD", "ENROLL_TOKEN", "TABLE", "BUCKET"):
        env.pop(k, None)
    p = subprocess.Popen([sys.executable, str(ROOT / "scripts/dev_server.py"), "--port", str(port),
                          "--moto-port", str(moto_port)], env=env)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/", timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    yield base
    p.terminate()
    p.wait()


@pytest.fixture
def agent_mod(tmp_path, monkeypatch, server):
    state = tmp_path / "state"
    state.mkdir()
    (tmp_path / "run").mkdir()
    (state / "config.toml").write_text(
        f'[device]\ntimezone = "America/New_York"\n\n[dashboard]\nurl = "{server}"\n'
        'enroll_token = "dev-enroll-token-0000"\n\n[[network.wifi]]\nssid = "Stick"\npsk = "stickpass"\n')
    monkeypatch.setenv("SIGNAGE_STATE", str(state))
    monkeypatch.setenv("SIGNAGE_RUN", str(tmp_path / "run"))
    monkeypatch.setenv("SIGNAGE_AGENT_DRY_RUN", "1")
    checker = tmp_path / "signage-config"
    checker.write_text(f"#!/bin/sh\nexec {sys.executable} {SIGNAGE_CONFIG} \"$@\"\n")
    checker.chmod(0o755)
    monkeypatch.setenv("SIGNAGE_CONFIG_BIN", str(checker))
    loader = importlib.machinery.SourceFileLoader("signage_agent", str(ROOT / "agent/signage-agent"))
    spec = importlib.util.spec_from_loader("signage_agent", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod, state


def cycle(agent):
    url, token = agent.dashboard()
    ident = agent.identity(url, token)
    agent.handle(agent.checkin(url, ident))
    return ident


@pytest.mark.skipif(not SIGNAGE_CONFIG.exists(), reason="needs the image's signage-config next to dashboard/")
def test_agent_end_to_end(server, agent_mod):
    mod, state = agent_mod
    agent = mod.Agent()
    (state / "agent").mkdir()
    ident = cycle(agent)
    did = ident["device_id"]
    tok = http("POST", f"{server}/api/login", {"password": "dev-password-123"})["token"]
    dev = http("GET", f"{server}/api/devices/{did}", token=tok)
    assert dev["online"]
    assert dev["status"]["config"]["base"]["network"]["wifi"][0]["psk"] == "********"
    assert "dashboard" not in dev["status"]["config"]["base"]

    # Upload an OGraf package through the presigned URL, like the browser does.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("pkg/clock.ograf.json", json.dumps({"id": "clock", "version": "2.0.0", "name": "Clock", "main": "clock.mjs"}))
        z.writestr("pkg/clock.mjs", "export default class Clock extends HTMLElement {}")
        z.writestr("pkg/assets/logo.svg", "<svg/>")
    up = http("POST", f"{server}/api/packages/upload", {}, tok)
    http("PUT", up["url"], raw=buf.getvalue(), ctype="application/zip")
    http("POST", f"{server}/api/packages/import", {"key": up["key"], "activate": True}, tok)
    prog = http("POST", f"{server}/api/programs", {"name": "Lobby", "layers": [
        {"name": "Main", "layer": 10, "items": [{"package": "clock", "duration": 20, "data": {"tz": "local"}}]}]}, tok)
    settings = {"device": {"name": "lobby-left"}, "display": {"rotation": 90},
                "network": {"wifi": [{"ssid": "Venue", "psk": "venuepass1", "priority": 3}]}}
    http("PATCH", f"{server}/api/devices/{did}", {"program_id": prog["id"], "settings": settings}, tok)
    http("POST", f"{server}/api/devices/{did}/commands", {"type": "screenshot"}, tok)

    cycle(agent)
    over = tomllib.loads((state / "overrides.toml").read_text())
    assert over["display"]["rotation"] == 90 and over["network"]["wifi"][0]["ssid"] == "Venue"
    assert not (state / "overrides.toml.prev").exists()
    assert agent.st["rollback"]["rev"] == 1  # network changed: rollback armed
    content = json.loads((state / "content.json").read_text())
    item = content["layers"][0]["items"][0]
    assert item["package"] == "clock" and item["version"] == "2.0.0" and item["main"] == "clock.mjs"
    pkgdir = Path(item["path"])
    assert (pkgdir / "clock.mjs").exists() and (pkgdir / "assets/logo.svg").exists()
    assert item["url"] == "/packages/clock/2.0.0/"
    assert content["generation"] == 2 and "url" not in content["packages"][0]

    # Next check-in reports results, confirms the network change and the settings.
    cycle(agent)
    assert "rollback" not in agent.st
    dev = http("GET", f"{server}/api/devices/{did}", token=tok)
    assert dev["applied_settings_rev"] == dev["settings_rev"] == 1
    shot = next(c for c in dev["commands"] if c["type"] == "screenshot")
    assert shot["state"] == "failed" and "Wayland" in shot["output"]
    assert dev["content_rev"] == content["rev"]

    # A network change that loses the dashboard is rolled back.
    settings["network"]["wifi"][0]["ssid"] = "Typo"
    http("PATCH", f"{server}/api/devices/{did}", {"settings": settings}, tok)
    cycle(agent)
    assert "Typo" in (state / "overrides.toml").read_text()
    agent.st["rollback"]["deadline"] = 0
    agent.maybe_roll_back()
    assert "Venue" in (state / "overrides.toml").read_text()
    assert agent.st["bad_settings_rev"] == 2 and agent.st["settings_rev"] == 1
    cycle(agent)  # the server still offers rev 2; the agent refuses to re-apply it
    assert "Venue" in (state / "overrides.toml").read_text()
    dev = http("GET", f"{server}/api/devices/{did}", token=tok)
    assert dev["status"]["config"]["rolled_back"]

    # Unassigning the program prunes the package.
    http("PATCH", f"{server}/api/devices/{did}", {"program_id": ""}, tok)
    cycle(agent)
    assert not pkgdir.exists()
    assert json.loads((state / "content.json").read_text())["generation"] == 3
