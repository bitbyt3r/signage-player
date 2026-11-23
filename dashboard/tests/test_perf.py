"""Agent performance sampling against a fake /proc and /sys."""

import importlib.machinery
import importlib.util
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(tmp, monkeypatch):
    for k, d in (("SIGNAGE_PROC", "proc"), ("SIGNAGE_SYS", "sys"), ("SIGNAGE_RUN", "run"), ("SIGNAGE_STATE", "state")):
        (tmp / d).mkdir(exist_ok=True)
        monkeypatch.setenv(k, str(tmp / d))
    monkeypatch.setenv("SIGNAGE_AGENT_DRY_RUN", "1")
    loader = importlib.machinery.SourceFileLoader("agent_p", str(ROOT / "agent/signage-agent"))
    spec = importlib.util.spec_from_loader("agent_p", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_perf_sample(tmp_path, monkeypatch):
    d = tmp_path
    write(d / "proc/stat", "cpu 100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0\n")
    write(d / "proc/meminfo", "MemTotal: 8000000 kB\nMemFree: 1000 kB\nMemAvailable: 6000000 kB\n")
    write(d / "proc/loadavg", "0.52 0.4 0.3 1/200 123\n")
    write(d / "proc/42/cmdline", "/usr/lib/firefox-esr/firefox-esr\0--kiosk")
    write(d / "proc/42/statm", "1000 25600 0 0 0 0 0")
    write(d / "sys/class/hwmon/hwmon0/name", "k10temp\n")
    write(d / "sys/class/hwmon/hwmon0/temp1_input", "55250\n")
    write(d / "sys/class/hwmon/hwmon1/name", "amdgpu\n")
    write(d / "sys/class/hwmon/hwmon1/temp1_input", "48000\n")
    write(d / "sys/class/drm/card0/device/gpu_busy_percent", "37\n")
    mod = load(d, monkeypatch)
    p = mod.Perf()
    write(d / "proc/stat", "cpu 200 0 200 1000 0 0 0 0\ncpu0 250 0 50 500 0 0 0 0\ncpu1 50 0 50 500 0 0 0 0\n")
    now = time.time()
    write(d / "run/perf.json", json.dumps({"t": now - 6, "window": 5, "frames": 300, "frame_ms": {"p50": 16, "p95": 18, "p99": 25, "max": 40},
                                           "long_frames": 0, "layout": "screen",
                                           "active": [{"layer": 20, "package": "a", "version": "1", "from": now - 11, "to": None}]}))
    p.read_player()
    write(d / "run/perf.json", json.dumps({"t": now - 1, "window": 5, "frames": 250, "frame_ms": {"p50": 18, "p95": 30, "p99": 60, "max": 90},
                                           "long_frames": 3,
                                           "active": [{"layer": 20, "package": "b", "version": "2", "label": "B", "from": now - 3, "to": None}]}))
    s = p.sample()
    assert s["cpu"] == 50.0 and s["cpu_max_core"] == 66.7 and s["load1"] == 0.52
    assert s["mem_total_mb"] == 7812 and s["mem_used_mb"] == 1953 and s["ff_rss_mb"] == round(25600 * os.sysconf("SC_PAGE_SIZE") / 2**20, 1)
    assert s["temp_cpu"] == 55.25 and s["temp_gpu"] == 48.0 and s["gpu_busy"] == 37
    assert s["fps"] == 55.0 and s["frame_p50"] == 17.0 and s["frame_p95"] == 30 and s["frame_max"] == 90
    assert s["long_frames"] == 3 and s["layout"] == "screen"
    assert [a["package"] for a in s["active"]] == ["a", "b"] and s["active"][1]["label"] == "B"
    # A stale perf.json (player stopped) leaves the frame fields out.
    write(d / "run/perf.json", json.dumps({"t": now - 120, "frames": 1}))
    time.sleep(0.15)
    s2 = p.sample()
    assert "fps" not in s2 and s2["temp_cpu"] == 55.25
    assert len(p.pending()) == 2
    p.ack(s["t"])
    assert [x["t"] for x in p.pending()] == [s2["t"]]


def test_profiles_listed_and_fetched(tmp_path, monkeypatch):
    mod = load(tmp_path, monkeypatch)
    prof = tmp_path / "state/profiles"
    prof.mkdir(parents=True)
    (prof / "profile-sign-1.json.gz").write_bytes(b"x" * 10)
    (prof / "notes.txt").write_text("no")
    assert [p["name"] for p in mod.list_profiles()] == ["profile-sign-1.json.gz"]
    a = mod.Agent()
    up = []
    monkeypatch.setattr(a, "upload_file", lambda path, url: up.append((Path(path).name, url)) or 10)
    a._threaded("c1", "fetch-file", {"name": "profile-sign-1.json.gz", "upload_url": "https://u"})
    a._threaded("c2", "fetch-file", {"name": "../profile-x.json.gz", "upload_url": "https://u"})
    assert up == [("profile-sign-1.json.gz", "https://u")]
    assert a.results[0]["ok"] and a.results[0]["file"] == "profile-sign-1.json.gz"
    assert not a.results[1]["ok"]
    # profile: runs signage-profile, then uploads the file it wrote.
    tool = tmp_path / "signage-profile"
    tool.write_text(f"#!/bin/sh\necho captured $1\necho data > {prof}/profile-sign-2.json.gz\n")
    tool.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    a._threaded("c3", "profile", {"seconds": 5, "upload_url": "https://v"})
    assert up[-1] == ("profile-sign-2.json.gz", "https://v")
    assert a.results[2]["ok"] and "captured 5" in a.results[2]["output"] and a.results[2]["file"] == "profile-sign-2.json.gz"
