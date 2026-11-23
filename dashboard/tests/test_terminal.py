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
        await ws.send(json.dumps({"t": "i", "d": "stty size; echo hi-$((40+2))\n"}))
        out = b""
        while b"hi-42" not in out:
            m = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if m["t"] == "o":
                out += base64.b64decode(m["d"])
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
