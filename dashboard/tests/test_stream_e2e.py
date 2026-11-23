"""Live view end to end: the dashboard's live.js in Chromium, a stand-in for
the WebSocket relay (ws.py's behaviour), the agent's stream_session and the
real signage-stream with ffmpeg's test pattern instead of the screen.

Needs GStreamer's webrtcbin with Python GI (python3-gst-1.0,
gir1.2-gst-plugins-bad-1.0, gstreamer1.0-nice), ffmpeg with libx264, and
Node with Playwright's Chromium; skipped when any of them is missing.
"""

import asyncio
import functools
import http.server
import json
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

websockets = pytest.importorskip("websockets")
from test_terminal import load_agent  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
STREAM = ROOT / "agent/signage-stream"

PAGE = """<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css">
<div id="box"></div><div id="toast"></div>
<script type="module">
import { initLive, openLive } from "/live.js";
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const api = async (method, path, body) => { window.apiCalls = [...(window.apiCalls || []), { method, path, body }];
  return { session: "s1", token: "t", ws_url: "ws://127.0.0.1:WSPORT/prod", ice_servers: [] }; };
initLive({ h, api, toast: (m) => console.log("toast", m) });
window.stopLive = openLive("dev1", document.getElementById("box"), { outputs: [] });
</script>"""

DRIVER = r"""
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: process.env.LIVE_SHOT ? 2 : 1 });
  page.on('console', (m) => console.error('page:', m.text()));
  await page.goto(process.argv[2]);
  await page.waitForFunction(() => /Live/.test(document.querySelector('.panel .muted.small').textContent), null, { timeout: 30000 });
  await page.waitForFunction(() => /fps/.test(document.querySelector('.mono').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const v = document.querySelector('video'), s = document.querySelector('.live-screen').getBoundingClientRect();
    return { w: v.videoWidth, h: v.videoHeight, stats: document.querySelector('.mono').textContent, sw: s.width, sh: s.height, calls: window.apiCalls };
  });
  if (process.env.LIVE_SHOT) await page.screenshot({ path: process.env.LIVE_SHOT });
  const box = await page.locator('.live-screen').boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await page.keyboard.press('KeyA');
  await page.waitForTimeout(1000);
  await page.click('text=Close');
  await page.waitForTimeout(1000);
  console.log(JSON.stringify(r));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
"""


def gi_python():
    for py in ("/usr/bin/python3", "python3.13", "python3.12", "python3.11"):
        exe = shutil.which(py)
        if exe and subprocess.run([exe, "-c", "import gi; gi.require_version('GstWebRTC', '1.0'); "
                                   "from gi.repository import Gst; Gst.init(None); "
                                   "assert Gst.ElementFactory.find('webrtcbin') and Gst.ElementFactory.find('nicesrc')"],
                                  capture_output=True).returncode == 0:
            return exe
    return None


def test_live_view_in_browser(tmp_path, monkeypatch):
    py = gi_python()
    if not py or not shutil.which("ffmpeg") or not shutil.which("node"):
        pytest.skip("needs GStreamer webrtcbin (Python GI), ffmpeg and node")
    if subprocess.run(["node", "-e", "require('playwright')"], capture_output=True).returncode:
        pytest.skip("needs Playwright for node")
    wrapper = tmp_path / "signage-stream"
    wrapper.write_text(f"#!/bin/sh\nSIGNAGE_STREAM_SOURCE=test exec {py} {STREAM} \"$@\"\n")
    wrapper.chmod(0o755)
    monkeypatch.setenv("SIGNAGE_STREAM_BIN", str(wrapper))
    agent = load_agent()

    from_device = []
    results = {}
    conns = {}

    async def relay(ws):
        q = dict(p.split("=", 1) for p in ws.request.path.split("?", 1)[1].split("&"))
        role = q["role"]
        peer_role = "device" if role == "admin" else "admin"
        conns[role] = ws
        if role == "admin":
            # The dashboard queued a command; the device picks it up and joins.
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, lambda: results.update(device=agent.stream_session({
                "ws_url": f"ws://127.0.0.1:{port}/prod", "session": "s1", "token": "t",
                "quality": "720", "control": True, "ice_servers": []})))
        elif "admin" in conns:
            await conns["admin"].send('{"t":"ready"}')
        try:
            async for msg in ws:
                if msg in ('{"t":"ping"}', '{"t":"hello"}'):
                    continue
                if role == "device":
                    from_device.append(json.loads(msg))
                if peer_role in conns:
                    await conns[peer_role].send(msg)
        finally:
            conns.pop(role, None)
            if peer_role in conns:
                await conns[peer_role].send('{"t":"closed"}')
                await conns[peer_role].close()

    async def serve(ready, done):
        nonlocal port
        async with websockets.serve(relay, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            ready.set()
            await asyncio.get_running_loop().run_in_executor(None, done.wait, 90)

    port = None
    ready, done = threading.Event(), threading.Event()
    threading.Thread(target=lambda: asyncio.run(serve(ready, done)), daemon=True).start()
    ready.wait(10)

    static = tmp_path / "static"
    shutil.copytree(ROOT / "src/static", static, ignore=shutil.ignore_patterns("player"))
    (static / "index.html").write_text(PAGE.replace("WSPORT", str(port)))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(static)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    drv = tmp_path / "drive.js"
    drv.write_text(DRIVER)
    try:
        r = subprocess.run(["node", str(drv), f"http://127.0.0.1:{httpd.server_address[1]}/index.html"],
                           capture_output=True, text=True, timeout=90)
    finally:
        httpd.shutdown()
    assert r.returncode == 0, r.stderr[-3000:]
    got = json.loads(r.stdout.strip().splitlines()[-1])
    for _ in range(50):
        if "device" in results:
            break
        threading.Event().wait(0.1)
    done.set()

    assert (got["w"], got["h"]) == (1280, 720)
    assert "fps" in got["stats"] and "libx264" in got["stats"]
    assert abs(got["sw"] / got["sh"] - 16 / 9) < 0.02
    assert got["calls"][0]["body"] == {"quality": "native", "output": "", "control": True}
    info = next(m for m in from_device if m["t"] == "info")
    assert info["encoder"] == "libx264" and info["control"] is True
    echoed = [m["m"] for m in from_device if m["t"] == "echo"]
    clicks = [m for m in echoed if m["t"] == "b"]
    assert [(m["b"], m["d"]) for m in clicks] == [(0, 1), (0, 0)]
    move = next(m for m in echoed if m["t"] == "m")
    assert abs(move["x"] - 0.25) < 0.02 and abs(move["y"] - 0.75) < 0.02
    assert {"t": "k", "c": "KeyA", "d": 1} in echoed and {"t": "k", "c": "KeyA", "d": 0} in echoed
    assert results.get("device") in ("closed by the viewer", "viewer closed", "stream ended")
