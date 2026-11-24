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


def test_control_socket_wakes_and_reconnects():
    """The control socket sends the device's credentials, turns each wake
    into a check-in, pings, and reconnects when the server drops it (as API
    Gateway does after 2 hours)."""
    agent = load_agent()
    agent.Control.PING = 0.3
    seen = {"connects": [], "pings": 0}
    port_box, done = [], threading.Event()

    async def server(ws):
        seen["connects"].append((ws.request.path, ws.request.headers.get("Authorization")))
        if len(seen["connects"]) == 1:
            await ws.send('{"t":"wake"}')
            await ws.send("not json")
            await ws.send('{"t":"wake"}')
            # Answer pings for a while, then hang up.
            for _ in range(2):
                assert json.loads(await asyncio.wait_for(ws.recv(), 5)) == {"t": "ping"}
                seen["pings"] += 1
                await ws.send('{"t":"pong"}')
            await ws.close()
        else:
            await ws.send('{"t":"wake"}')
            # Keep answering pings until the test is done, so a slow run
            # doesn't see the agent time out and reconnect a third time.
            while not done.is_set():
                try:
                    await asyncio.wait_for(ws.recv(), 0.1)
                    await ws.send('{"t":"pong"}')
                except asyncio.TimeoutError:
                    pass
                except websockets.ConnectionClosed:
                    return

    async def main():
        async with websockets.serve(server, "127.0.0.1", 0) as srv:
            port_box.append(srv.sockets[0].getsockname()[1])
            await asyncio.get_running_loop().run_in_executor(None, done.wait, 30)

    threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
    while not port_box:
        pass

    # Number connections on the agent's side: the server's handler can start
    # after the agent has already seen the handshake and fired its first wake.
    opened = []

    class CountingWebSocket(agent.WebSocket):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            opened.append(self)

    agent.WebSocket = CountingWebSocket
    wakes = []
    ctl = agent.Control(lambda: wakes.append(len(opened)))
    ctl.set_target(f"ws://127.0.0.1:{port_box[0]}/prod", "dev1", "tok1")
    import time
    deadline = time.time() + 20
    try:
        while len(wakes) < 5:
            assert time.time() < deadline, (seen, wakes)
            time.sleep(0.05)
        time.sleep(0.2)  # anything extra would show up now
        assert seen["connects"][0] == ("/prod?role=control", "Device dev1:tok1")
        assert len(seen["connects"]) == 2 and seen["pings"] >= 2
        # A check-in on each connect, plus one per wake.
        assert wakes == [1, 1, 1, 2, 2]
        assert ctl.connected
    finally:
        done.set()
