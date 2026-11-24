"""Pearls and gateways (src/pearls.py) against moto.

  pytest tests/test_pearls.py
"""

import json

from test_api import aws, call, login  # noqa: F401  (aws is a fixture)


def gw_call(gw, body):
    return call("POST", "/gateway/checkin", body, token=None) if gw is None else _gw(gw, body)


def _gw(gw, body):
    import app
    ev = {"rawPath": "/gateway/checkin", "headers": {"host": "dash.example", "authorization": f"Gateway {gw[0]}:{gw[1]}"},
          "requestContext": {"http": {"method": "POST", "sourceIp": "203.0.113.9"}, "domainName": "dash.example"},
          "body": json.dumps(body)}
    r = app.handler(ev)
    return r["statusCode"], json.loads(r["body"])


SNAP = {
    "firmware": {"version": "4.24.7", "product_name": "Pearl Mini"},
    "ident": {"name": "GSAA798666"},
    "system_status": {"cpuload": 20, "cputemp": 48, "uptime": 100},
    "inputs": [{"id": "hdmi-a", "name": "HDMI-A", "video": True, "type": "embedded"},
               {"id": "WEBG1", "name": "Graphics 1", "video": True, "type": "web-graphics"}],
    "input_status": {"hdmi-a": {"video": {"state": "active", "resolution": "0x0"}},
                     "WEBG1": {"video": {"state": "active", "resolution": "1920x1080"}}},
    "input_settings": {"WEBG1": {"web_graphics": {"url": "http://x/?room=Panels%201"}}},
    "channels": [{"id": "1", "name": "HDMI-A"}],
    "layouts": {"1": [{"id": "1", "name": "Default", "active": True}]},
    "outputs": [{"id": "D1", "name": "HDMI"}],
    "output_settings": {"D1": {"source": "1"}},
}


def setup(tok):
    s, gw = call("POST", "/api/gateways", {"name": "Mac"}, token=tok)
    assert s == 201 and gw["token"].startswith("pgw_")
    s, p = call("POST", "/api/pearls", {"name": "Panels 1", "room": "Panels 1", "host": "10.1.29.127",
                                         "password": "secret-pw", "gateway_id": gw["id"]}, token=tok)
    assert s == 201, p
    return (gw["id"], gw["token"]), p


def test_password_never_reaches_the_browser(aws):
    tok = login()
    gw, p = setup(tok)
    assert "password" not in p and p["has_password"]
    s, d = call("GET", f"/api/pearls/{p['id']}", token=tok)
    assert "secret-pw" not in json.dumps(d)
    s, lst = call("GET", "/api/pearls", token=tok)
    assert "secret-pw" not in json.dumps(lst)
    # PATCH without a password keeps it.
    call("PATCH", f"/api/pearls/{p['id']}", {"name": "Renamed"}, token=tok)
    s, out = gw_call(gw, {})
    assert out["pearls"][0]["password"] == "secret-pw"


def test_gateway_auth(aws):
    tok = login()
    gw, _ = setup(tok)
    s, _ = gw_call((gw[0], "pgw_wrong"), {})
    assert s == 401
    s, out = gw_call(gw, {"version": "1", "local_ips": ["10.1.14.15"]})
    assert s == 200 and out["pearls"][0]["host"] == "10.1.29.127"
    s, gws = call("GET", "/api/gateways", token=tok)
    assert gws["gateways"][0]["online"] and gws["gateways"][0]["local_ips"] == ["10.1.14.15"]
    assert "token" not in gws["gateways"][0]


def test_snapshots_and_summary(aws):
    tok = login()
    gw, p = setup(tok)
    gw_call(gw, {"snapshots": {p["id"]: {"full": True, "data": SNAP}}})
    s, d = call("GET", f"/api/pearls/{p['id']}", token=tok)
    sm = d["summary"]
    assert d["online"] and sm["firmware"] == "4.24.7"
    assert [i["signal"] for i in sm["inputs"]] == [False, True]
    assert sm["channels"][0]["layout"] == "Default" and sm["outputs"][0]["source"] == "1"
    assert sm["web_graphics"]["WEBG1"].startswith("http://x/")
    # A quick pass overrides the status parts only.
    gw_call(gw, {"snapshots": {p["id"]: {"full": False, "data": {
        "input_status": {"hdmi-a": {"video": {"state": "active", "resolution": "1920x1080"}}}}}}})
    s, d = call("GET", f"/api/pearls/{p['id']}", token=tok)
    assert d["summary"]["inputs"][0]["signal"] is True and d["summary"]["firmware"] == "4.24.7"
    # Watching makes the gateway snapshot fast.
    s, out = gw_call(gw, {})
    assert out["pearls"][0]["snapshot_every"] == 5 and out["poll_interval"] == 2
    # Errors mark it offline.
    gw_call(gw, {"snapshots": {p["id"]: {"error": "can't reach 10.1.29.127"}}})
    s, d = call("GET", f"/api/pearls/{p['id']}", token=tok)
    assert not d["online"] and "can't reach" in d["error"]


def test_ops_round_trip(aws):
    tok = login()
    gw, p = setup(tok)
    s, op = call("POST", f"/api/pearls/{p['id']}/ops",
                 {"method": "put", "path": "channels/3/layouts/active", "query": {"id": "1"}, "label": "Switch"}, token=tok)
    assert s == 200 and op["state"] == "pending" and op["path"] == "/api/v2.0/channels/3/layouts/active"
    s, out = gw_call(gw, {})
    assert [o["id"] for o in out["ops"]] == [op["id"]] and out["ops"][0]["method"] == "PUT"
    s, again = gw_call(gw, {})
    assert again["ops"] == []           # sent once
    gw_call(gw, {"results": [{"id": op["id"], "pearl": p["id"], "ok": True, "status": 200, "result": {"status": "ok"}}]})
    s, done = call("GET", f"/api/pearls/{p['id']}/ops/{op['id']}", token=tok)
    assert done["state"] == "done" and done["result"] == {"status": "ok"}


def test_op_validation_and_bulk(aws):
    tok = login()
    gw, p = setup(tok)
    for bad in ({"method": "GET", "path": "inputs?x=1#y"}, {"method": "GET", "path": "/api/v2.0/a b"}, {"method": "GET", "path": "/api/v2.0/../x"},
                {"method": "TRACE", "path": "inputs"}, {"kind": "preview", "target": "../x"}):
        s, _ = call("POST", f"/api/pearls/{p['id']}/ops", bad, token=tok)
        assert s == 400, bad
    s, out = call("POST", "/api/pearls/ops", {"ops": [
        {"pearl": p["id"], "method": "POST", "path": "/api/v2.0/recorders/control/start"},
        {"pearl": p["id"], "method": "GET", "path": "/admin/get_params.cgi", "query": {"firmware_version": None}}]}, token=tok)
    assert s == 200 and len(out["ops"]) == 2
    s, gwout = gw_call(gw, {})
    assert gwout["ops"][1]["query"] == {"firmware_version": ""}


def test_preview_op_gets_upload_url(aws):
    tok = login()
    gw, p = setup(tok)
    s, op = call("POST", f"/api/pearls/{p['id']}/ops", {"kind": "preview", "target": "channels/1/layouts/1"}, token=tok)
    assert s == 200 and op["path"] == "/api/v2.0/channels/1/layouts/1/preview"
    s, out = gw_call(gw, {})
    assert out["ops"][0]["upload_url"].startswith("https://")
    gw_call(gw, {"results": [{"id": op["id"], "pearl": p["id"], "ok": True, "status": 200}]})
    s, done = call("GET", f"/api/pearls/{p['id']}/ops/{op['id']}", token=tok)
    assert done["url"].startswith("https://")


def test_no_gateway_and_delete(aws):
    tok = login()
    s, p = call("POST", "/api/pearls", {"name": "Lonely", "host": "pearl.local"}, token=tok)
    s, e = call("POST", f"/api/pearls/{p['id']}/ops", {"method": "GET", "path": "inputs"}, token=tok)
    assert s == 409
    s, e = call("POST", "/api/pearls", {"name": "Bad", "host": "http://x/y"}, token=tok)
    assert s == 400
    gw, p2 = setup(tok)
    s, e = call("DELETE", f"/api/gateways/{gw[0]}", token=tok)
    assert s == 409   # still has a Pearl
    assert call("DELETE", f"/api/pearls/{p2['id']}", token=tok)[0] == 200
    assert call("DELETE", f"/api/gateways/{gw[0]}", token=tok)[0] == 200
