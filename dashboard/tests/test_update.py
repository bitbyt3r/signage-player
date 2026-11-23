"""OS update progress: update.json, status, and the check after reboot."""

import importlib.machinery
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FAKE = """#!/bin/sh
case "$1" in
  check-new) echo 0.1.2 ;;
  update)
    echo "Selected update '$2' for install."
    for p in 10 50 100; do echo "Downloading signage_$2.usr-x86-64.raw.zst: $p%"; done
    echo "Successfully acquired 'signage_$2.efi'."
    echo "Installing..."
    ;;
esac
"""


def load(tmp_path, monkeypatch):
    for d in ("state/agent", "run"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    fake = tmp_path / "sysupdate"
    fake.write_text(FAKE)
    fake.chmod(0o755)
    monkeypatch.setenv("SIGNAGE_STATE", str(tmp_path / "state"))
    monkeypatch.setenv("SIGNAGE_RUN", str(tmp_path / "run"))
    monkeypatch.setenv("SIGNAGE_SYSUPDATE", str(fake))
    monkeypatch.setenv("SIGNAGE_AGENT_DRY_RUN", "1")
    loader = importlib.machinery.SourceFileLoader("agent_u", str(ROOT / "agent/signage-agent"))
    spec = importlib.util.spec_from_loader("agent_u", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_update_progress_and_reboot_check(tmp_path, monkeypatch):
    mod = load(tmp_path, monkeypatch)
    monkeypatch.setattr(mod, "os_release", lambda: {"IMAGE_VERSION": "0.1.1"})
    a = mod.Agent()
    seen = []
    orig = a.set_update
    a.set_update = lambda *x, **k: (orig(*x, **k), seen.append(dict(a.st["update"])))
    ok, out = a.os_update("")
    assert ok and a.reboot_requested
    states = [u["state"] for u in seen]
    assert states[0] == "checking" and "downloading" in states and states[-1] == "rebooting"
    pct = [u["percent"] for u in seen if u["state"] == "downloading"]
    assert pct == sorted(pct) and max(pct) >= 85
    disk = json.loads((tmp_path / "run/update.json").read_text())
    assert disk["state"] == "rebooting" and disk["version"] == "0.1.2" and disk["percent"] == 100

    # Next boot, on the new version.
    monkeypatch.setattr(mod, "os_release", lambda: {"IMAGE_VERSION": "0.1.2"})
    b = mod.Agent()
    b.finish_update_after_boot()
    assert b.st["update"]["state"] == "done"
    # A boot that fell back to the old version is reported as failed.
    b.st["update"]["state"] = "rebooting"
    monkeypatch.setattr(mod, "os_release", lambda: {"IMAGE_VERSION": "0.1.1"})
    b.finish_update_after_boot()
    assert b.st["update"]["state"] == "failed" and "0.1.1" in b.st["update"]["message"]


def test_agent_status_file(tmp_path, monkeypatch):
    mod = load(tmp_path, monkeypatch)
    a = mod.Agent()
    a.write_agent_status("unconfigured", "no url")
    j = json.loads((tmp_path / "run/agent.json").read_text())
    assert j["state"] == "unconfigured" and j["last_ok"] is None and j["dashboard"] is None
    (tmp_path / "state/config.toml").write_text('[dashboard]\nurl = "https://x.example/"\nenroll_token = "secret-token"\n')
    a.write_agent_status("connected")
    j = json.loads((tmp_path / "run/agent.json").read_text())
    assert j["state"] == "connected" and j["dashboard"] == "x.example" and j["last_ok"]
    assert "secret" not in (tmp_path / "run/agent.json").read_text()
