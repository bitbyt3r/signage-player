"""The agent's stdlib WebSocket client and PTY relay, against a local server."""

import asyncio
import base64
import importlib.machinery
import importlib.util
import json
import threading
from pathlib import Path

import pytest

websockets = pytest.importorskip("websockets")
ROOT = Path(__file__).resolve().parents[1]


def load_agent():
    loader = importlib.machinery.SourceFileLoader("signage_agent_t", str(ROOT / "agent/signage-agent"))
    spec = importlib.util.spec_from_loader("signage_agent_t", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_terminal_session_round_trip():
    agent = load_agent()
    got = {}

    async def relay(ws):
        got["path"] = ws.request.path
        await ws.send(json.dumps({"t": "r", "cols": 100, "rows": 30}))
        # Input frames arrive out of order; the agent must put them back.
        await ws.send(json.dumps({"t": "i", "s": 1, "d": "echo hi-$((40+2))\n"}))
        await ws.send(json.dumps({"t": "i", "s": 0, "d": "stty size; "}))
        frames = {}
        while b"hi-42" not in b"".join(frames[k] for k in sorted(frames)):
            m = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if m["t"] == "o":
                frames[m["s"]] = base64.b64decode(m["d"])
        assert sorted(frames) == list(range(len(frames)))
        out = b"".join(frames[k] for k in sorted(frames))
        got["out"] = out
        await ws.send(json.dumps({"t": "i", "d": "exit\n"}))
        try:
            while True:
                await asyncio.wait_for(ws.recv(), 10)
        except Exception:
            pass

    async def main(port_box, done):
        async with websockets.serve(relay, "127.0.0.1", 0) as srv:
            port_box.append(srv.sockets[0].getsockname()[1])
            await asyncio.get_running_loop().run_in_executor(None, done.wait, 20)

    port_box, done = [], threading.Event()
    t = threading.Thread(target=lambda: asyncio.run(main(port_box, done)), daemon=True)
    t.start()
    while not port_box:
        pass
    result = {}

    def run():
        result["r"] = agent.terminal_session({"ws_url": f"ws://127.0.0.1:{port_box[0]}/prod",
                                              "session": "abc", "token": "tok"})
    w = threading.Thread(target=run)
    w.start()
    w.join(20)
    done.set()
    assert result.get("r") == "terminal closed"
    assert got["path"] == "/prod?session=abc&role=device&token=tok"
    assert b"30 100" in got["out"] and b"hi-42" in got["out"]


def test_reorder_skips_lost_frames(monkeypatch):
    agent = load_agent()
    r = agent.Reorder()
    assert r.push(1, "b") == []
    assert r.push(0, "a") == ["a", "b"]
    assert r.push(0, "dup") == []
    t = [100.0]
    monkeypatch.setattr(agent.time, "monotonic", lambda: t[0])
    assert r.push(3, "d") == []      # frame 2 lost
    t[0] += 2
    assert r.push(4, "e") == ["d", "e"]


def test_stream_session_relays_handshake(tmp_path, monkeypatch):
    """The agent runs signage-stream and carries its offer and the browser's
    answer over the relay. A stub stands in for signage-stream here; the real
    one is exercised by tests/stream_e2e.mjs."""
    stub = tmp_path / "signage-stream"
    stub.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "cfg = json.loads(sys.argv[1])\n"
        "print(json.dumps({'t': 'info', 'cfg': cfg}), flush=True)\n"
        "print(json.dumps({'t': 'offer', 'sdp': 'v=0 offer'}), flush=True)\n"
        "for line in sys.stdin:\n"
        "    m = json.loads(line)\n"
        "    if m['t'] == 'answer':\n"
        "        print(json.dumps({'t': 'connected', 'got': m['sdp']}), flush=True)\n"
        "    elif m['t'] == 'stop':\n"
        "        break\n"
        "print(json.dumps({'t': 'ended', 'reason': 'closed by the viewer'}), flush=True)\n")
    stub.chmod(0o755)
    monkeypatch.setenv("SIGNAGE_STREAM_BIN", str(stub))
    agent = load_agent()
    seen = []

    async def relay(ws):
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), 10))
            seen.append(m)
            if m["t"] == "offer":
                await ws.send(json.dumps({"t": "answer", "sdp": "v=0 answer"}))
            elif m["t"] == "connected":
                await ws.send(json.dumps({"t": "stop"}))
            elif m["t"] == "ended":
                break

    async def main(port_box, done):
        async with websockets.serve(relay, "127.0.0.1", 0) as srv:
            port_box.append(srv.sockets[0].getsockname()[1])
            await asyncio.get_running_loop().run_in_executor(None, done.wait, 20)

    port_box, done = [], threading.Event()
    threading.Thread(target=lambda: asyncio.run(main(port_box, done)), daemon=True).start()
    while not port_box:
        pass
    result = {}
    w = threading.Thread(target=lambda: result.update(r=agent.stream_session({
        "ws_url": f"ws://127.0.0.1:{port_box[0]}/prod", "session": "s", "token": "t",
        "quality": "720", "control": True, "ice_servers": [{"urls": "stun:x"}]})))
    w.start()
    w.join(20)
    done.set()
    assert result.get("r") == "closed by the viewer"
    assert [m["t"] for m in seen] == ["info", "offer", "connected", "ended"]
    assert seen[0]["cfg"]["quality"] == "720" and seen[0]["cfg"]["ice_servers"] == [{"urls": "stun:x"}]
    assert seen[2]["got"] == "v=0 answer"
