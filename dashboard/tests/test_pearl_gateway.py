"""agent/pearl-gateway on its own, with the dashboard and Pearls faked.

  pytest tests/test_pearl_gateway.py
"""

import importlib.machinery
import importlib.util
import io
import json
import pathlib
import threading
import time

import pytest

PATH = pathlib.Path(__file__).resolve().parent.parent / "agent" / "pearl-gateway"


@pytest.fixture
def gwmod():
    loader = importlib.machinery.SourceFileLoader("pearl_gateway", str(PATH))
    spec = importlib.util.spec_from_loader("pearl_gateway", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def gateway(gwmod, monkeypatch, n=3, reply=None):
    """A gateway looking after n Pearls whose snapshots are ready to send.
    Returns (gateway, list of check-in bodies sent)."""
    sent = []

    def urlopen(req, timeout=None):
        body = json.loads(req.data)
        sent.append(body)
        r = reply(body) if reply else {"pearls": [], "ops": []}
        if isinstance(r, Exception):
            raise r
        return FakeResp(json.dumps(r).encode())

    monkeypatch.setattr(gwmod.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(gwmod, "local_ips", lambda: [])
    g = gwmod.Gateway("https://dash.example", "abc123", "pgw_x")
    for i in range(n):
        w = gwmod.Worker(g, {"id": f"p{i}", "host": f"10.0.0.{i}"})
        w.full = {"inputs": [], "pad": "x" * 400_000}
        g.workers[w.pearl.id] = w
    return g, sent


def test_checkin_stays_under_budget(gwmod, monkeypatch):
    monkeypatch.setattr(gwmod, "CHECKIN_BUDGET", 1_000_000)
    pearls = lambda body: {"pearls": [{"id": f"p{i}", "host": f"10.0.0.{i}"} for i in range(5)], "ops": []}
    g, sent = gateway(gwmod, monkeypatch, n=5, reply=pearls)
    g.checkin()
    g.checkin()
    g.checkin()
    assert [len(b["snapshots"]) for b in sent] == [2, 2, 1]
    assert set().union(*(b["snapshots"] for b in sent)) == {f"p{i}" for i in range(5)}


def test_failed_checkin_resends_only_what_it_carried(gwmod, monkeypatch):
    fail = [True]

    def reply(body):
        if fail[0]:
            fail[0] = False
            return OSError("network down")
        return {"pearls": [{"id": f"p{i}", "host": f"10.0.0.{i}"} for i in range(2)], "ops": []}

    g, sent = gateway(gwmod, monkeypatch, n=2, reply=reply)
    with pytest.raises(OSError):
        g.checkin()
    g.checkin()
    g.checkin()
    assert [sorted(b["snapshots"]) for b in sent] == [["p0", "p1"], ["p0", "p1"], []]


def test_repeated_ops_run_once_and_bad_paths_are_refused(gwmod, monkeypatch):
    op = {"id": "1-a", "pearl": "p0", "kind": "api", "method": "GET", "path": "/api/v2.0/system/status"}
    bad = {"id": "2-b", "pearl": "p0", "kind": "api", "method": "GET", "path": "/etc/passwd"}
    g, sent = gateway(gwmod, monkeypatch, n=1,
                      reply=lambda body: {"pearls": [{"id": "p0", "host": "10.0.0.0"}], "ops": [op, bad]})
    got = []
    g.workers["p0"].add_ops = got.extend
    g.checkin()
    g.checkin()
    assert [o["id"] for o in got] == ["1-a", "2-b"]

    ran = []
    g.workers["p0"].pearl.request = lambda *a, **k: ran.append(a) or (200, {"status": "ok"})
    g.workers["p0"].run_op(bad)
    assert ran == [] and g.results[-1]["ok"] is False and "refusing" in g.results[-1]["error"]


def test_recovery_resends_unchanged_snapshot(gwmod, monkeypatch):
    g, sent = gateway(gwmod, monkeypatch, n=1)
    w = g.workers["p0"]
    assert w.report()["full"] is True
    assert w.report() is None             # unchanged: nothing to send
    w.error = "can't reach 10.0.0.0"
    assert w.report() == {"error": "can't reach 10.0.0.0"}
    # snap_loop's success path, once the Pearl answers again
    w.pearl.full = lambda: {"inputs": [], "pad": "x" * 400_000}
    w.next_full = w.next_quick = 0
    w.stop = False
    t = threading.Thread(target=w.snap_loop, daemon=True)
    t.start()
    for _ in range(50):
        if w.error is None:
            break
        time.sleep(0.05)
    w.close()
    assert w.error is None and w.report()["full"] is True
