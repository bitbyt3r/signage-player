"""API tests against moto's in-memory DynamoDB and S3.

  pip install boto3 "moto[dynamodb,s3]" pytest
  pytest tests/
"""

import io
import json
import os
import sys
import zipfile
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

os.environ.update({
    "AWS_DEFAULT_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
    "TABLE": "signage-test", "BUCKET": "signage-test", "ADMIN_PASSWORD": "correct horse battery",
    "ENROLL_TOKEN": "enroll-me-please-0123", "WS_URL": "wss://ws.example/prod",
})
os.environ.pop("AWS_ENDPOINT_URL", None)

import app  # noqa: E402
import common  # noqa: E402
import ws  # noqa: E402


def make_table():
    boto3.client("dynamodb").create_table(
        TableName="signage-test", BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("pk", "sk", "kind")],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        GlobalSecondaryIndexes=[{"IndexName": "kind-index", "Projection": {"ProjectionType": "ALL"},
                                 "KeySchema": [{"AttributeName": "kind", "KeyType": "HASH"},
                                               {"AttributeName": "pk", "KeyType": "RANGE"}]}])
    boto3.client("s3").create_bucket(Bucket="signage-test")


@pytest.fixture
def aws():
    with mock_aws():
        common.reset_clients()
        make_table()
        yield
        common.reset_clients()


def call(method, path, body=None, token=None, device=None, raw=None):
    headers = {"host": "dash.example"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if device:
        headers["authorization"] = f"Device {device[0]}:{device[1]}"
    path, _, qs = path.partition("?")
    from urllib.parse import parse_qsl
    ev = {"rawPath": path, "queryStringParameters": dict(parse_qsl(qs)) or None, "headers": headers, "requestContext": {"http": {"method": method, "sourceIp": "203.0.113.5"},
                                                                   "domainName": "dash.example"},
          "body": raw if raw is not None else (json.dumps(body) if body is not None else None)}
    r = app.handler(ev)
    data = json.loads(r["body"]) if r["headers"].get("content-type") == "application/json" else r["body"]
    return r["statusCode"], data


def login():
    s, d = call("POST", "/api/login", {"password": "correct horse battery"})
    assert s == 200
    return d["token"]


def enroll(mac="52:54:00:12:34:56"):
    s, d = call("POST", "/device/enroll", {"enroll_token": "enroll-me-please-0123", "mac": mac, "hostname": "signage-123456"})
    assert s == 200, d
    return d["device_id"], d["token"]


def make_zip(version="1.0.0", folder="lower-third/", main="graphic.mjs"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(f"{folder}lower-third.ograf.json", json.dumps({
            "$schema": "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
            "id": "magfest-lower-third", "version": version, "name": "Lower third", "main": main,
            "schema": {"type": "object", "properties": {"title": {"type": "string", "default": "Hello"}}}}))
        z.writestr(f"{folder}{main}", "export default class extends HTMLElement {}")
    return buf.getvalue()


def upload_package(token, data, activate=True):
    s, u = call("POST", "/api/packages/upload", {}, token)
    assert s == 200
    boto3.client("s3").put_object(Bucket="signage-test", Key=u["key"], Body=data)
    return call("POST", "/api/packages/import", {"key": u["key"], "activate": activate}, token)


def test_static_and_auth(aws):
    s, body = call("GET", "/")
    assert s == 200 and "<title>Signage Dashboard</title>" in body
    s, body = call("GET", "/static/app.js")
    assert s == 200 and "hashchange" in body
    assert call("GET", "/api/devices")[0] == 401
    assert call("GET", "/api/devices", token="nope.nope")[0] == 401
    assert call("POST", "/api/login", {"password": "wrong"})[0] == 401
    assert call("GET", "/api/devices", token=login())[0] == 200


def test_enroll_and_checkin(aws):
    assert call("POST", "/device/enroll", {"enroll_token": "bad", "mac": "x"})[0] == 403
    did, tok = enroll()
    assert did == "525400123456"
    assert call("POST", "/device/checkin", {}, device=(did, "wrong"))[0] == 401
    s, r = call("POST", "/device/checkin", {"status": {"hostname": "signage-123456", "os_version": "0.1.0"},
                                            "settings_rev": 0, "content_rev": "", "time": 0}, device=(did, tok))
    assert s == 200
    assert r["poll_interval"] == 15 and r["commands"] == [] and "settings" not in r
    assert r["content"]["layers"] == [] and r["content"]["rev"]
    # Unchanged content isn't resent.
    s, r2 = call("POST", "/device/checkin", {"settings_rev": 0, "content_rev": r["content_rev"]}, device=(did, tok))
    assert "content" not in r2
    token = login()
    s, d = call("GET", "/api/devices", token=token)
    dev = d["devices"][0]
    assert dev["online"] and dev["os_version"] == "0.1.0" and dev["ip"] == "203.0.113.5"
    assert dev["clock_offset"] < -1e9  # device sent time 0
    # Re-enrolling keeps the device (and invalidates the old token).
    did2, tok2 = enroll()
    assert did2 == did
    assert call("POST", "/device/checkin", {}, device=(did, tok))[0] == 401


def test_settings_validation_and_delivery(aws):
    did, tok = enroll()
    token = login()
    s, d = call("PATCH", f"/api/devices/{did}", {"settings": {"display": {"rotation": 45}}}, token)
    assert s == 400 and any("rotation" in e for e in d["errors"])
    s, d = call("PATCH", f"/api/devices/{did}", {"settings": {"network": {"wifi": [{"ssid": "x", "psk": "short"}]}}}, token)
    assert s == 400
    s, d = call("PATCH", f"/api/devices/{did}", {"settings": {"bogus": {}}}, token)
    assert s == 400
    good = {"device": {"name": "lobby-left", "timezone": "America/Chicago"},
            "display": {"rotation": 90, "mode": "1920x1080@60", "scale": 1},
            "network": {"wifi": [{"ssid": "MAGFest", "psk": "supersecret", "priority": 5}]},
            "ntp": {"servers": ["10.0.0.1"]}}
    s, d = call("PATCH", f"/api/devices/{did}", {"settings": good}, token)
    assert s == 200, d
    assert d["settings_rev"] == 1 and d["name"] == "lobby-left"
    s, r = call("POST", "/device/checkin", {"settings_rev": 0}, device=(did, tok))
    assert r["settings_rev"] == 1
    assert r["settings"]["display"]["scale"] == 1.0
    assert r["settings"]["network"]["wifi"][0] == {"ssid": "MAGFest", "psk": "supersecret", "priority": 5, "hidden": False}
    s, r = call("POST", "/device/checkin", {"settings_rev": 1}, device=(did, tok))
    assert "settings" not in r
    # Saving the same settings again doesn't bump the revision.
    s, d = call("PATCH", f"/api/devices/{did}", {"settings": good}, token)
    assert d["settings_rev"] == 1


def test_commands_and_screenshots(aws):
    did, tok = enroll()
    token = login()
    assert call("POST", f"/api/devices/{did}/commands", {"type": "format-disk"}, token)[0] == 400
    s, cmd = call("POST", f"/api/devices/{did}/commands", {"type": "screenshot"}, token)
    assert s == 200 and cmd["state"] == "pending"
    call("GET", f"/api/devices/{did}", token=token)  # watching -> fast polling
    s, r = call("POST", "/device/checkin", {}, device=(did, tok))
    assert r["poll_interval"] == 3
    [c] = r["commands"]
    assert c["type"] == "screenshot" and c["args"]["upload_url"].startswith("https://")
    boto3.client("s3").put_object(Bucket="signage-test", Key=c["args"]["key"], Body=b"\x89PNG")
    s, r = call("POST", "/device/checkin", {"results": [{"id": c["id"], "ok": True, "output": "4 bytes"}]}, device=(did, tok))
    assert r["commands"] == []
    s, d = call("GET", f"/api/devices/{did}", token=token)
    assert d["commands"][0]["state"] == "done"
    assert "upload_url" not in d["commands"][0]["args"]
    s, shots = call("GET", f"/api/devices/{did}/screenshots", token=token)
    assert len(shots["screenshots"]) == 1
    # Bulk reboot.
    s, b = call("POST", "/api/devices/bulk", {"ids": [did], "command": "reboot"}, token)
    assert s == 200 and b["commands"][0]["type"] == "reboot"


def test_packages_programs_content(aws):
    did, tok = enroll()
    token = login()
    s, r = upload_package(token, make_zip("1.0.0"))
    assert s == 200, r
    assert r == {"id": "magfest-lower-third", "version": "1.0.0", "active_version": "1.0.0"}
    s, r = upload_package(token, make_zip("1.0.0"))
    assert r.get("unchanged")
    s, r = upload_package(token, make_zip("1.0.0", main="other.mjs"))
    assert s == 409
    s, r = upload_package(token, make_zip("1.1.0"), activate=False)
    assert s == 200 and r["active_version"] == "1.0.0"
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("x.txt", "hi")
    assert upload_package(token, bad.getvalue())[0] == 400

    prog = {"name": "Main hall", "layers": [
        {"name": "Lower thirds", "layer": 20, "items": [
            {"package": "magfest-lower-third", "duration": 15, "data": {"title": "Welcome"}},
            {"package": "magfest-lower-third", "version": "1.1.0", "duration": 10, "data": {},
             "days": [4, 5], "start": "09:00", "end": "18:00", "from": "2027-01-08T00:00"}]}]}
    assert call("POST", "/api/programs", {"name": "", "layers": [{"items": [{"package": "a b"}]}]}, token)[0] == 400
    s, p = call("POST", "/api/programs", prog, token)
    assert s == 200, p
    s, d = call("PATCH", f"/api/devices/{did}", {"program_id": p["id"]}, token)
    assert d["program_id"] == p["id"]

    s, r = call("POST", "/device/checkin", {}, device=(did, tok))
    c = r["content"]
    assert c["program"]["name"] == "Main hall" and not c["warnings"]
    items = c["layers"][0]["items"]
    assert [i["version"] for i in items] == ["1.0.0", "1.1.0"]
    assert items[0]["main"] == "graphic.mjs" and items[0]["manifest"] == "lower-third.ograf.json"
    assert items[1]["days"] == [4, 5] and items[1]["start"] == "09:00"
    assert {(p["version"], p["root"]) for p in c["packages"]} == {("1.0.0", "lower-third/"), ("1.1.0", "lower-third/")}
    assert all(p["url"].startswith("https://") for p in c["packages"])
    rev = r["content_rev"]

    # Activating a new version changes the content for unpinned items.
    call("PATCH", "/api/packages/magfest-lower-third", {"active_version": "1.1.0"}, token)
    s, r = call("POST", "/device/checkin", {"content_rev": rev}, device=(did, tok))
    assert r["content_rev"] != rev
    assert [i["version"] for i in r["content"]["layers"][0]["items"]] == ["1.1.0", "1.1.0"]
    assert len(r["content"]["packages"]) == 1

    # Can't delete what is in use.
    assert call("DELETE", "/api/packages/magfest-lower-third/versions/1.1.0", token=token)[0] == 409
    assert call("DELETE", "/api/packages/magfest-lower-third/versions/1.0.0", token=token)[0] == 200
    assert call("DELETE", f"/api/programs/{p['id']}", token=token)[0] == 409
    call("PATCH", f"/api/devices/{did}", {"program_id": ""}, token)
    assert call("DELETE", f"/api/programs/{p['id']}", token=token)[0] == 200
    assert call("DELETE", "/api/packages/magfest-lower-third", token=token)[0] == 200


def test_stick_config(aws):
    import tomllib
    token = login()
    s, r = call("POST", "/api/stick-config", {"device": {"timezone": "America/New_York"},
                                              "network": {"wifi": [{"ssid": "Venue \"5G\"", "psk": "p4ssw0rd!"}]},
                                              "display": {"rotation": 270}, "countdown": 5}, token)
    assert s == 200, r
    cfg = tomllib.loads(r["config"])
    assert cfg["dashboard"] == {"url": "https://dash.example", "enroll_token": "enroll-me-please-0123"}
    assert cfg["network"]["wifi"][0]["ssid"] == 'Venue "5G"'
    assert cfg["display"]["rotation"] == 270 and cfg["install"] == {"countdown": 5, "mok_password": "signage"}
    # The device's own validator accepts it.
    sc = ROOT.parent / "mkosi.extra/usr/lib/signage/signage-config"
    if sc.exists():
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".toml") as f:
            f.write(r["config"])
            f.flush()
            out = subprocess.run([sys.executable, str(sc), "--check", f.name], capture_output=True, text=True)
            assert out.returncode == 0, out.stdout
    assert call("POST", "/api/stick-config", {"display": {"rotation": 1}}, token)[0] == 400


def test_saved_wifi_and_stick_defaults(aws):
    import tomllib
    token = login()
    assert call("POST", "/api/wifi", {"ssid": "Venue", "psk": "short"}, token)[0] == 400
    s, w = call("POST", "/api/wifi", {"ssid": "Venue", "psk": "venue-pass-1", "priority": 5}, token)
    assert s == 201 and w["has_psk"] and "psk" not in w
    s, o = call("POST", "/api/wifi", {"ssid": "Open"}, token)
    assert s == 201 and not o["has_psk"]
    s, r = call("GET", "/api/wifi", None, token)
    assert [n["ssid"] for n in r["networks"]] == ["Venue", "Open"] and "venue-pass-1" not in json.dumps(r)
    # Editing without a psk keeps the stored password.
    s, w2 = call("PUT", f"/api/wifi/{w['id']}", {"ssid": "Venue", "priority": 7}, token)
    assert s == 200 and w2["has_psk"] and w2["priority"] == 7

    s, r = call("PUT", "/api/stick-defaults", {"device": {"timezone": "America/Chicago", "name": "ignored"},
                                               "display": {"rotation": 90}, "ntp": {"servers": ["10.0.0.1"]},
                                               "countdown": 3, "mok_password": "enroll",
                                               "dashboard_url": "https://signs.example.org/", "wifi": [w["id"], o["id"]]}, token)
    assert s == 200, r
    s, r = call("GET", "/api/stick-defaults", None, token)
    d = r["defaults"]
    assert d["device"] == {"timezone": "America/Chicago"} and d["display"] == {"rotation": 90}
    assert d["dashboard_url"] == "https://signs.example.org" and d["wifi"] == [w["id"], o["id"]]
    assert "venue-pass-1" not in json.dumps(r)
    assert call("PUT", "/api/stick-defaults", {"wifi": ["deadbeef"]}, token)[0] == 400
    assert call("PUT", "/api/stick-defaults", {"dashboard_url": "ftp://x"}, token)[0] == 400

    # A stick built from saved networks gets their passwords.
    s, r = call("POST", "/api/stick-config", {"network": {"wifi": [{"saved": w["id"]}, {"saved": o["id"]}]},
                                              "dashboard_url": "https://signs.example.org"}, token)
    assert s == 200, r
    cfg = tomllib.loads(r["config"])
    assert cfg["dashboard"]["url"] == "https://signs.example.org"
    assert cfg["network"]["wifi"][0] == {"ssid": "Venue", "psk": "venue-pass-1", "priority": 7, "hidden": False}
    # Device settings can use them too.
    did, _ = enroll()
    s, r = call("PATCH", f"/api/devices/{did}", {"settings": {"network": {"wifi": [{"saved": w["id"]}]}}}, token)
    assert s == 200 and r["settings"]["network"]["wifi"][0]["psk"] == "venue-pass-1"

    # Deleted networks drop out of the defaults and can't be used.
    assert call("DELETE", f"/api/wifi/{o['id']}", None, token)[0] == 200
    assert call("GET", "/api/stick-defaults", None, token)[1]["defaults"]["wifi"] == [w["id"]]
    assert call("POST", "/api/stick-config", {"network": {"wifi": [{"saved": o["id"]}]}}, token)[0] == 400


def test_device_params_and_options(aws, monkeypatch):
    token = login()
    did0, _ = enroll("52:54:00:00:00:99")
    s, r = call("PATCH", f"/api/devices/{did0}", {"settings": {"display": {"layout": "arch", "mode": "3840x2160"}}}, token)
    assert s == 200 and r["settings"]["display"]["layout"] == "arch"
    assert call("PATCH", f"/api/devices/{did0}", {"settings": {"display": {"layout": "wall"}}}, token)[0] == 400
    schema = {"type": "object", "properties": {"rooms": {"type": "array", "items": {"type": "string"}, "default": []},
                                               "title": {"type": "string", "default": ""}}}
    data = make_zip()
    upload_package(token, data)
    pkg = call("GET", "/api/packages", None, token)[1]["packages"][0]
    s, prog = call("POST", "/api/programs", {"name": "Hall", "layers": [{"name": "Main", "layer": 10, "items": [
        {"package": pkg["id"], "duration": 0, "data": {"rooms": ["Panels 1"], "title": "Hi"}}]}]}, token)
    assert s in (200, 201), prog
    did, dtok = enroll()
    call("PATCH", f"/api/devices/{did}", {"program_id": prog["id"]}, token)
    first = call("POST", "/device/checkin", {}, device=(did, dtok))[1]
    assert first["content"]["layers"][0]["items"][0]["data"] == {"rooms": ["Panels 1"], "title": "Hi"}

    assert call("PATCH", f"/api/devices/{did}", {"params": {"bad id!": {}}}, token)[0] == 400
    s, r = call("PATCH", f"/api/devices/{did}", {"params": {pkg["id"]: {"rooms": ["Panels 2 (Baltimore 3,4,5)"]}, "other": {}}}, token)
    assert s == 200 and r["params"] == {pkg["id"]: {"rooms": ["Panels 2 (Baltimore 3,4,5)"]}}
    second = call("POST", "/device/checkin", {"content_rev": first["content_rev"]}, device=(did, dtok))[1]
    assert second["content_rev"] != first["content_rev"]
    assert second["content"]["layers"][0]["items"][0]["data"] == {"rooms": ["Panels 2 (Baltimore 3,4,5)"], "title": "Hi"}

    class Fake(io.BytesIO):
        pass
    seen = []

    def fake_urlopen(rq, timeout=None):
        seen.append(rq.full_url)
        return Fake(json.dumps([{"id": "2", "name": "Panels 2"}, {"id": "9", "name": "Booth 12"},
                                {"id": "1", "name": "Panels 1"}, {"id": "3"}]).encode())
    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)
    app._options_cache.clear()
    s, r = call("GET", "/api/options?source=schedule&list=locations&base=https://sched.example/", None, token)
    assert s == 200 and [o["value"] for o in r["options"]] == ["Panels 1", "Panels 2", "Booth 12"]
    assert seen == ["https://sched.example/locations?limit=-1"]
    assert call("GET", "/api/options?source=schedule&list=nope", None, token)[0] == 400
    assert call("GET", "/api/options?source=schedule&list=tracks&base=http://10.0.0.1", None, token)[0] == 400


def test_perf_samples(aws):
    import time
    token = login()
    did, dtok = enroll("52:54:00:00:00:77")
    now = time.time()
    batch = [{"t": now - 20, "cpu": 12.5, "temp_cpu": 55.2, "fps": 60, "frame_p95": 18.1, "bogus": "x",
              "active": [{"layer": 20, "package": "magfest-schedule", "version": "1.4.1", "label": "Panels", "from": now - 30, "to": None, "evil": 1}]},
             {"t": now - 10, "cpu": "nope", "mem_used_mb": 1900, "mem_total_mb": 7800},
             {"t": now - 7200 * 2, "cpu": 1}, "junk"]
    s, r = call("POST", "/device/checkin", {"perf": batch}, device=(did, dtok))
    assert s == 200 and r["perf_ack"] == batch[1]["t"]
    call("POST", "/device/checkin", {"perf": [{"t": now - 5, "cpu": 30}]}, device=(did, dtok))
    s, r = call("GET", f"/api/devices/{did}/perf?minutes=60", None, token)
    assert s == 200
    ts = [x["t"] for x in r["samples"]]
    assert ts == sorted(ts) and len(ts) == 3   # the 4-hour-old sample is outside the hour
    first = r["samples"][0]
    assert "bogus" not in first and first["active"][0] == {"layer": 20, "package": "magfest-schedule", "version": "1.4.1", "label": "Panels", "from": now - 30}
    assert "cpu" not in r["samples"][1] and r["samples"][1]["mem_used_mb"] == 1900
    assert "perf_ack" not in call("POST", "/device/checkin", {}, device=(did, dtok))[1]


def test_profile_and_fetch_file(aws):
    token = login()
    did, dtok = enroll("52:54:00:00:00:66")
    assert call("POST", f"/api/devices/{did}/commands", {"type": "profile", "args": {"seconds": 500}}, token)[0] == 400
    assert call("POST", f"/api/devices/{did}/commands", {"type": "fetch-file", "args": {"name": "../../etc/shadow"}}, token)[0] == 400
    s, prof = call("POST", f"/api/devices/{did}/commands", {"type": "profile", "args": {"seconds": 20, "x": 1}}, token)
    assert s == 200 and prof["args"] == {"seconds": 20}
    s, fetch = call("POST", f"/api/devices/{did}/commands", {"type": "fetch-file", "args": {"name": "profile-sign-1.json.gz"}}, token)
    assert s == 200
    s, r = call("POST", "/device/checkin", {}, device=(did, dtok))
    sent = {c["type"]: c for c in r["commands"]}
    assert sent["profile"]["args"]["upload_url"].startswith("http") and sent["profile"]["args"]["key"].startswith(f"files/{did}/")
    assert sent["fetch-file"]["args"]["name"] == "profile-sign-1.json.gz"
    assert call("GET", f"/api/devices/{did}/commands/{prof['id']}/file", None, token)[0] == 404   # not done yet
    common.s3().put_object(Bucket=common.BUCKET, Key=sent["profile"]["args"]["key"], Body=b"gz")
    call("POST", "/device/checkin", {"results": [{"id": prof["id"], "ok": True, "output": "ok", "file": "profile-sign-2.json.gz"},
                                                 {"id": fetch["id"], "ok": True, "output": "ok", "file": "../evil"}]}, device=(did, dtok))
    s, r = call("GET", f"/api/devices/{did}/commands/{prof['id']}/file", None, token)
    assert s == 200 and r["name"] == "profile-sign-2.json.gz" and "response-content-disposition" in r["url"].lower()
    s, r = call("GET", f"/api/devices/{did}/commands/{fetch['id']}/file", None, token)
    assert s == 200 and r["name"] == "profile-sign-1.json.gz"
    dev = call("GET", f"/api/devices/{did}", None, token)[1]
    assert all("upload_url" not in c["args"] for c in dev["commands"])


def test_preview(aws):
    token = login()
    upload_package(token, make_zip("1.0.0"))
    upload_package(token, make_zip("1.1.0"), activate=False)
    draft = {"name": "", "layers": [{"name": "Main", "layer": 10, "items": [
        {"package": "magfest-lower-third", "duration": 15, "data": {"title": "Draft"}},
        {"package": "", "duration": 10}]}]}     # half-added graphic: left out
    assert call("POST", "/api/preview", {"program": draft})[0] == 401
    s, r = call("POST", "/api/preview", {"program": draft}, token)
    assert s == 200, r
    assert r["layout"] == "screen" and r["device"] is None
    c = r["content"]
    assert c["program"]["name"] == "Preview" and c["rev"]
    [it] = c["layers"][0]["items"]
    assert it["version"] == "1.0.0" and it["data"] == {"title": "Draft"}
    assert it["url"] == "/packages/magfest-lower-third/1.0.0/"
    [pkg] = c["packages"]
    assert pkg["url"].startswith("https://") and pkg["root"] == "lower-third/"
    # Activating another version shows in the next preview, like on a device.
    call("PATCH", "/api/packages/magfest-lower-third", {"active_version": "1.1.0"}, token)
    r2 = call("POST", "/api/preview", {"program": draft, "layout": "arch"}, token)[1]
    assert r2["layout"] == "arch" and r2["content"]["layers"][0]["items"][0]["version"] == "1.1.0"
    assert r2["content"]["rev"] != c["rev"]
    # As a device: its parameters and layout.
    did, _ = enroll("52:54:00:00:00:55")
    s, r = call("PATCH", f"/api/devices/{did}", {"settings": {"device": {"name": "arch-1"}, "display": {"layout": "arch"}},
                                                 "params": {"magfest-lower-third": {"title": "Device"}}}, token)
    assert s == 200, r
    r3 = call("POST", "/api/preview", {"program": draft, "device_id": did}, token)[1]
    assert r3["layout"] == "arch" and r3["device"]["name"] == "arch-1"
    assert r3["content"]["layers"][0]["items"][0]["data"]["title"] == "Device"
    assert call("POST", "/api/preview", {"program": draft, "device_id": did, "layout": "screen"}, token)[1]["layout"] == "screen"
    bad = {"layers": [{"name": "Main", "layer": 10, "items": [{"package": "a b"}]}]}
    s, r = call("POST", "/api/preview", {"program": bad}, token)
    assert s == 400 and r["errors"]
    # Nothing was saved and no device appeared.
    assert call("GET", "/api/programs", None, token)[1]["programs"] == []
    assert [d["id"] for d in call("GET", "/api/devices", None, token)[1]["devices"]] == [did]


def test_player_served_for_preview(aws):
    s, body = call("GET", "/static/player/index.html")
    assert s == 200 and "player" in body
    assert call("GET", "/static/player/player.mjs")[0] == 200
    s, body = call("GET", "/sw.js")
    assert s == 200 and "preview" in body
    s, body = call("GET", "/static/player/../../app.py")   # outside static: the app page, not the file
    assert "<title>Signage Dashboard</title>" in body and "def " not in body


def test_terminal_ws_auth(aws):
    did, tok = enroll()
    token = login()
    s, t = call("POST", f"/api/devices/{did}/terminal", {}, token)
    assert s == 200
    s, r = call("POST", "/device/checkin", {}, device=(did, tok))
    [c] = r["commands"]
    assert c["type"] == "terminal" and c["args"]["session"] == t["session"]

    def connect(role, tkn, conn):
        return ws.handler({"requestContext": {"routeKey": "$connect", "connectionId": conn,
                                              "domainName": "ws.example", "stage": "prod"},
                           "queryStringParameters": {"session": t["session"], "role": role, "token": tkn}})
    assert connect("admin", "bad", "c0")["statusCode"] == 403
    assert connect("device", "bad", "c0")["statusCode"] == 403
    assert connect("admin", t["token"], "c1")["statusCode"] == 200
    sent = []
    ws._send = lambda api, conn, msg: sent.append((conn, msg)) or True
    assert connect("device", c["args"]["token"], "c2")["statusCode"] == 200
    assert sent == [("c1", {"t": "ready"})]
    ws.handler({"requestContext": {"routeKey": "$default", "connectionId": "c1", "domainName": "ws.example", "stage": "prod"},
                "body": '{"t":"i","d":"ls\\r"}'})
    assert sent[-1] == ("c2", '{"t":"i","d":"ls\\r"}')
    # The command record doesn't keep the device's terminal secret.
    s, d = call("GET", f"/api/devices/{did}", token=token)
    assert "token" not in d["commands"][0]["args"]
