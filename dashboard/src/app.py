"""HTTP API for the signage dashboard (API Gateway HTTP API, payload v2).

  /, /static/*, /sw.js     the dashboard web app
  /api/login               admin password -> session token
  /api/...                 admin API (Authorization: Bearer <token>)
  /device/enroll           device enrollment (shared enroll token)
  /device/checkin          device check-in (Authorization: Device <id>:<token>)
"""

import base64
import io
import json
import mimetypes
import os
import re
import time
import traceback
import urllib.request
import zipfile
from pathlib import Path

import boto3
from boto3.dynamodb.conditions import Attr

import common as c
import tomlw
import validate

STATIC = Path(__file__).parent / "static"
WS_URL = os.environ.get("WS_URL", "")
ENROLL_TOKEN = os.environ.get("ENROLL_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
MIRROR_FUNCTION = os.environ.get("MIRROR_FUNCTION", "")

POLL = 15          # normal check-in interval, seconds
POLL_FAST = 3      # while someone has the device open in the dashboard
ONLINE_GRACE = 60  # last check-in within this many seconds = online
SESSION_TTL = 12 * 3600
CMD_TTL = 7 * 86400
SHOT_TTL = 14 * 86400
COMMANDS = {"reboot", "restart-player", "screenshot", "os-update", "resync"}


class HttpError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


def resp(status, body=None, headers=None, raw=None, b64=False):
    h = {"cache-control": "no-store"}
    if raw is None:
        h["content-type"] = "application/json"
        raw = json.dumps(body if body is not None else {})
    h.update(headers or {})
    return {"statusCode": status, "headers": h, "body": raw, "isBase64Encoded": b64}


# ------------------------------------------------------------------ routing

ROUTES = []


def route(method, pattern, auth="admin"):
    rx = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn):
        ROUTES.append((method, rx, auth, fn))
        return fn
    return deco


class Req:
    def __init__(self, event):
        self.event = event
        http = event.get("requestContext", {}).get("http", {})
        self.method = http.get("method", "GET")
        self.path = event.get("rawPath", "/")
        self.ip = http.get("sourceIp", "")
        self.headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        self.query = event.get("queryStringParameters") or {}
        body = event.get("body") or ""
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode()
        self.raw = body
        self.domain = event.get("requestContext", {}).get("domainName", "")
        self.device = None

    def json(self):
        if not self.raw:
            return {}
        try:
            return json.loads(self.raw)
        except ValueError:
            raise HttpError(400, "body is not valid JSON")

    @property
    def base_url(self):
        host = self.headers.get("x-forwarded-host") or self.headers.get("host") or self.domain
        proto = self.headers.get("x-forwarded-proto", "https")
        return f"{proto}://{host}"


def handler(event, context=None):
    req = Req(event)
    try:
        if req.method == "GET" and not req.path.startswith(("/api/", "/device/")):
            return static(req.path)
        for method, rx, auth, fn in ROUTES:
            m = rx.match(req.path)
            if m and method == req.method:
                if auth == "admin":
                    authz = req.headers.get("authorization", "")
                    if not authz.startswith("Bearer ") or not c.verify(authz[7:], "admin"):
                        raise HttpError(401, "log in again")
                elif auth == "device":
                    req.device = device_auth(req)
                return fn(req, **m.groupdict())
        raise HttpError(404, f"no route for {req.method} {req.path}")
    except HttpError as e:
        return resp(e.status, {"error": e.message, **e.extra})
    except Exception:
        traceback.print_exc()
        return resp(500, {"error": "internal error, see the function logs"})


def static(path):
    if path in ("", "/"):
        path = "/index.html"
    name = path.lstrip("/")
    if name.startswith("static/"):
        name = name[7:]
    f = (STATIC / name).resolve()
    if STATIC.resolve() not in f.parents or not f.is_file():
        f = STATIC / "index.html"  # client-side routes
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if f.suffix in (".js", ".mjs"):
        ctype = "text/javascript"
    headers = {"content-type": ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""),
               "cache-control": "no-cache"}
    if f.name == "sw.js":
        headers["service-worker-allowed"] = "/"
    return resp(200, raw=f.read_text(), headers=headers)


# ------------------------------------------------------------------ admin auth

@route("POST", "/api/login", auth=None)
def login(req):
    body = req.json()
    if not c.check_password(body.get("password")):
        time.sleep(1)
        raise HttpError(401, "wrong password")
    return resp(200, {"token": c.sign({"k": "admin"}, SESSION_TTL), "expires_in": SESSION_TTL})


@route("GET", "/api/info")
def info(req):
    return resp(200, {
        "ws_url": WS_URL,
        "github_repo": GITHUB_REPO,
        "dashboard_url": req.base_url,
        "enroll_token_set": bool(ENROLL_TOKEN),
        "server_time": time.time(),
    })


# ------------------------------------------------------------------ devices (admin)

def device_item(did):
    item = c.get(f"DEVICE#{did}")
    if not item:
        raise HttpError(404, "no such device")
    return item


def device_view(item, full=False):
    status = c.loads(item.get("status"), {})
    settings = c.loads(item.get("settings"), {})
    last = int(item.get("last_seen", 0))
    v = {
        "id": item["id"],
        "name": settings.get("device", {}).get("name") or status.get("hostname") or item.get("hostname") or item["id"],
        "hostname": status.get("hostname") or item.get("hostname", ""),
        "mac": item.get("mac", ""),
        "program_id": item.get("program_id", ""),
        "notes": item.get("notes", ""),
        "last_seen": last,
        "online": c.now() - last <= ONLINE_GRACE,
        "ip": item.get("ip", ""),
        "clock_offset": float(item.get("clock_offset", 0)),
        "os_version": status.get("os_version", ""),
        "settings": settings,
        "params": c.loads(item.get("params"), {}),
        "settings_rev": int(item.get("settings_rev", 0)),
        "applied_settings_rev": int(item.get("applied_settings_rev", 0)),
        "content_rev": item.get("content_rev", ""),
        "created": int(item.get("created", 0)),
        "summary": {
            "addresses": status.get("addresses", []),
            "network": status.get("network", {}),
            "ntp": status.get("ntp", {}),
            "player": status.get("player", ""),
            "display": status.get("display", {}),
            "uptime": status.get("uptime", 0),
            "content": status.get("content", {}),
            "errors": status.get("errors", []),
            "update": status.get("update"),
        },
    }
    if full:
        v["status"] = status
    return v


@route("GET", "/api/devices")
def list_devices(req):
    items = c.by_kind("device")
    devices = [device_view(i) for i in items]
    devices.sort(key=lambda d: d["name"])
    return resp(200, {"devices": devices, "server_time": time.time()})


@route("GET", "/api/devices/{did}")
def get_device(req, did):
    item = device_item(did)
    # Someone is looking: have the device poll fast so commands land quickly.
    c.update(item["pk"], "META", {"watch_until": c.now() + 90})
    v = device_view(item, full=True)
    cmds = c.query(item["pk"], "CMD#", forward=False, limit=30)
    v["commands"] = [c.loads(x["data"]) for x in cmds]
    return resp(200, v)


@route("PATCH", "/api/devices/{did}")
def patch_device(req, did):
    item = device_item(did)
    body = req.json()
    changes = {}
    if "settings" in body:
        clean, errs = validate.settings(resolve_saved_wifi(body["settings"] or {}))
        if errs:
            raise HttpError(400, "invalid settings", {"errors": errs})
        if clean != c.loads(item.get("settings"), {}):
            changes["settings"] = c.dumps(clean)
            changes["settings_rev"] = int(item.get("settings_rev", 0)) + 1
    if "program_id" in body:
        pid = body["program_id"] or ""
        if pid and not c.get(f"PROGRAM#{pid}"):
            raise HttpError(400, "no such program")
        changes["program_id"] = pid
    if "notes" in body:
        changes["notes"] = str(body["notes"])[:2000]
    if "params" in body:
        changes["params"] = c.dumps(check_params(body["params"]))
    if changes:
        item = c.update(item["pk"], "META", changes)
    return resp(200, device_view(item, full=True))


@route("POST", "/api/devices/bulk")
def bulk_devices(req):
    """Assign a program or queue a command on several devices at once."""
    body = req.json()
    ids = body.get("ids") or []
    out = []
    for did in ids:
        item = device_item(did)
        if "program_id" in body:
            pid = body["program_id"] or ""
            if pid and not c.get(f"PROGRAM#{pid}"):
                raise HttpError(400, "no such program")
            c.update(item["pk"], "META", {"program_id": pid})
        if body.get("command"):
            out.append(queue_command(did, body["command"], body.get("args") or {}))
    return resp(200, {"ok": True, "commands": out})


@route("DELETE", "/api/devices/{did}")
def delete_device(req, did):
    item = device_item(did)
    for x in c.query(item["pk"]):
        c.delete(x["pk"], x["sk"])
    return resp(200, {"ok": True})


def queue_command(did, ctype, args=None, ttl=3600):
    if ctype not in COMMANDS and ctype != "terminal":
        raise HttpError(400, f"unknown command {ctype}")
    cid = f"{c.now_ms()}-{c.new_id(3)}"
    cmd = {"id": cid, "type": ctype, "args": args or {}, "state": "pending",
           "created": c.now(), "expires": c.now() + ttl}
    c.put({"pk": f"DEVICE#{did}", "sk": f"CMD#{cid}", "data": c.dumps(cmd), "ttl": c.now() + CMD_TTL})
    return cmd


@route("POST", "/api/devices/{did}/commands")
def post_command(req, did):
    device_item(did)
    body = req.json()
    args = body.get("args") or {}
    if body.get("type") == "os-update" and args.get("version"):
        if validate.slug(args["version"], "version"):
            raise HttpError(400, "bad version")
    return resp(200, queue_command(did, body.get("type"), args))


@route("POST", "/api/devices/{did}/terminal")
def open_terminal(req, did):
    item = device_item(did)
    if not WS_URL:
        raise HttpError(500, "WS_URL is not configured")
    sid = c.new_id(12)
    secret = c.new_id(24)
    c.put({"pk": f"TERM#{sid}", "sk": "META", "device_id": did, "device_secret": c.sha256(secret),
           "created": c.now(), "ttl": c.now() + 86400})
    queue_command(did, "terminal", {"session": sid, "token": secret, "ws_url": WS_URL}, ttl=180)
    c.update(item["pk"], "META", {"watch_until": c.now() + 180})
    token = c.sign({"k": "term", "sid": sid}, 600)
    return resp(200, {"session": sid, "ws_url": WS_URL, "token": token})


@route("GET", "/api/devices/{did}/screenshots")
def list_screenshots(req, did):
    device_item(did)
    shots = c.query(f"DEVICE#{did}", "SHOT#", forward=False, limit=24)
    out = []
    for s in shots:
        out.append({
            "taken": int(s["taken"]),
            "url": c.s3().generate_presigned_url(
                "get_object", Params={"Bucket": c.BUCKET, "Key": s["key"]}, ExpiresIn=3600),
        })
    return resp(200, {"screenshots": out})


# ------------------------------------------------------------------ devices (device side)

def device_auth(req):
    authz = req.headers.get("authorization", "")
    if not authz.startswith("Device "):
        raise HttpError(401, "missing device credentials")
    try:
        did, token = authz[7:].split(":", 1)
    except ValueError:
        raise HttpError(401, "bad device credentials")
    item = c.get(f"DEVICE#{did}")
    if not item or not c.verify_equal(item.get("token_hash", ""), c.sha256(token)):
        raise HttpError(401, "unknown device, enroll again")
    return item


@route("POST", "/device/enroll", auth=None)
def enroll(req):
    body = req.json()
    if not ENROLL_TOKEN or not c.verify_equal(c.sha256(body.get("enroll_token") or ""), c.sha256(ENROLL_TOKEN)):
        time.sleep(1)
        raise HttpError(403, "wrong enroll token")
    mac = re.sub(r"[^0-9a-f]", "", str(body.get("mac", "")).lower())
    did = mac if len(mac) == 12 else c.new_id(6)
    token = c.new_id(32)
    pk = f"DEVICE#{did}"
    fields = {
        "kind": "device", "id": did, "token_hash": c.sha256(token),
        "hostname": str(body.get("hostname", ""))[:64], "mac": str(body.get("mac", ""))[:32],
        "machine_id": str(body.get("machine_id", ""))[:64], "enrolled": c.now(), "ip": req.ip,
    }
    if not c.get(pk):
        fields.update({"created": c.now(), "settings": "{}", "settings_rev": 0, "program_id": ""})
    # Re-enrolling (e.g. after a reinstall) keeps the settings and program.
    c.update(pk, "META", fields)
    return resp(200, {"device_id": did, "token": token})


def resolve_content(item):
    pid = item.get("program_id") or ""
    content = {"program": None, "layers": [], "packages": [], "warnings": []}
    if not pid:
        return content
    prog = c.get(f"PROGRAM#{pid}")
    if not prog:
        content["warnings"].append("assigned program no longer exists")
        return content
    p = c.loads(prog["data"])
    content["program"] = {"id": pid, "name": p["name"]}
    params = c.loads(item.get("params"), {})   # per-device graphic parameters, by package
    pkgs, vers, need = {}, {}, {}
    for layer in p["layers"]:
        items = []
        for it in layer["items"]:
            pkg_id = it["package"]
            if pkg_id not in pkgs:
                meta = c.get(f"PKG#{pkg_id}")
                pkgs[pkg_id] = c.loads(meta["data"]) if meta else None
            meta = pkgs[pkg_id]
            if not meta:
                content["warnings"].append(f"package {pkg_id} is not uploaded")
                continue
            version = it.get("version") or meta.get("active_version")
            key = (pkg_id, version)
            if key not in vers:
                v = c.get(f"PKG#{pkg_id}", f"VER#{version}")
                vers[key] = c.loads(v["data"]) if v else None
            ver = vers[key]
            if not ver:
                content["warnings"].append(f"{pkg_id} {version} is not uploaded")
                continue
            need[key] = ver
            out = {k: v for k, v in it.items() if k != "version"}
            if params.get(pkg_id):
                out["data"] = {**(it.get("data") or {}), **params[pkg_id]}
            out.update({"package": pkg_id, "version": version, "main": ver.get("main", ""),
                        "manifest": ver.get("manifest_file", "")})
            items.append(out)
        content["layers"].append({"name": layer["name"], "layer": layer["layer"], "items": items})
    for (pkg_id, version), ver in sorted(need.items()):
        content["packages"].append({"id": pkg_id, "version": version, "sha256": ver["sha256"],
                                    "size": ver["size"], "root": ver.get("root", "")})
    return content


@route("POST", "/device/checkin", auth="device")
def checkin(req):
    item = req.device
    did = item["id"]
    pk = item["pk"]
    body = req.json()
    status = body.get("status") or {}
    now = time.time()
    changes = {"last_seen": int(now), "ip": req.ip}
    if status:
        changes["status"] = c.dumps(status)[:300000]
    if isinstance(body.get("time"), (int, float)):
        changes["clock_offset"] = str(round(body["time"] - now, 3))
    if "settings_rev" in body:
        changes["applied_settings_rev"] = int(body.get("settings_rev") or 0)
    if body.get("content_rev"):
        changes["content_rev"] = str(body["content_rev"])[:64]

    # Results of commands the device ran since the last check-in.
    for r in body.get("results") or []:
        cid = str(r.get("id", ""))
        x = c.get(pk, f"CMD#{cid}")
        if not x:
            continue
        cmd = c.loads(x["data"])
        cmd.update(state="done" if r.get("ok") else "failed", done=c.now(),
                   output=str(r.get("output", ""))[-8000:])
        c.update(pk, f"CMD#{cid}", {"data": c.dumps(cmd)})
        if cmd["type"] == "screenshot" and r.get("ok") and cmd["args"].get("key"):
            c.put({"pk": pk, "sk": f"SHOT#{c.now_ms()}", "key": cmd["args"]["key"],
                   "taken": c.now(), "ttl": c.now() + SHOT_TTL})

    # Commands waiting for the device.
    commands = []
    for x in c.query(pk, "CMD#"):
        cmd = c.loads(x["data"])
        if cmd["state"] != "pending":
            continue
        if cmd["expires"] < c.now():
            cmd["state"] = "expired"
        else:
            if cmd["type"] == "screenshot":
                key = f"screenshots/{did}/{c.now_ms()}.png"
                cmd["args"]["key"] = key
                cmd["args"]["upload_url"] = c.s3().generate_presigned_url(
                    "put_object", Params={"Bucket": c.BUCKET, "Key": key, "ContentType": "image/png"},
                    ExpiresIn=900)
            cmd["state"] = "sent"
            cmd["sent"] = c.now()
            commands.append({k: cmd[k] for k in ("id", "type", "args")})
            cmd["args"] = {k: v for k, v in cmd["args"].items() if k not in ("upload_url", "token")}
        c.update(pk, x["sk"], {"data": c.dumps(cmd)})

    item = c.update(pk, "META", changes)
    out = {
        "server_time": time.time(),
        "poll_interval": POLL_FAST if int(item.get("watch_until", 0)) > now else POLL,
        "commands": commands,
        "ws_url": WS_URL,
        "settings_rev": int(item.get("settings_rev", 0)),
    }
    if int(body.get("settings_rev", -1)) != out["settings_rev"]:
        out["settings"] = c.loads(item.get("settings"), {})

    content = resolve_content(item)
    rev = c.sha256(c.dumps(content))[:16]
    out["content_rev"] = rev
    if body.get("content_rev") != rev:
        content["rev"] = rev
        for p in content["packages"]:
            p["url"] = c.s3().generate_presigned_url(
                "get_object", Params={"Bucket": c.BUCKET, "Key": f"packages/{p['id']}/{p['version']}.zip"},
                ExpiresIn=3600)
        out["content"] = content
    return resp(200, out)


def check_params(params):
    """Per-device graphic parameters: {package id: {parameter: value}}. They
    replace the program's values for every item of that package."""
    if not isinstance(params, dict):
        raise HttpError(400, "params must be an object")
    out = {}
    for pkg, vals in params.items():
        if not isinstance(pkg, str) or not validate.SLUG_RE.match(pkg):
            raise HttpError(400, f"params: bad package id {pkg!r}")
        if not isinstance(vals, dict):
            raise HttpError(400, f"params.{pkg} must be an object")
        if vals:
            out[pkg] = vals
    if len(c.dumps(out)) > 64000:
        raise HttpError(400, "params are too large")
    return out


# ------------------------------------------------------------------ programs

@route("GET", "/api/programs")
def list_programs(req):
    progs = []
    for i in c.by_kind("program"):
        progs.append(c.loads(i["data"]))
    progs.sort(key=lambda p: p["name"].lower())
    return resp(200, {"programs": progs})


@route("POST", "/api/programs")
def create_program(req):
    clean, errs = validate.program(req.json())
    if errs:
        raise HttpError(400, "invalid program", {"errors": errs})
    clean["id"] = c.new_id(5)
    clean["updated"] = c.now()
    c.put({"pk": f"PROGRAM#{clean['id']}", "sk": "META", "kind": "program", "data": c.dumps(clean)})
    return resp(200, clean)


@route("GET", "/api/programs/{pid}")
def get_program(req, pid):
    x = c.get(f"PROGRAM#{pid}")
    if not x:
        raise HttpError(404, "no such program")
    return resp(200, c.loads(x["data"]))


@route("PUT", "/api/programs/{pid}")
def put_program(req, pid):
    if not c.get(f"PROGRAM#{pid}"):
        raise HttpError(404, "no such program")
    clean, errs = validate.program(req.json())
    if errs:
        raise HttpError(400, "invalid program", {"errors": errs})
    clean["id"] = pid
    clean["updated"] = c.now()
    c.put({"pk": f"PROGRAM#{pid}", "sk": "META", "kind": "program", "data": c.dumps(clean)})
    return resp(200, clean)


@route("DELETE", "/api/programs/{pid}")
def delete_program(req, pid):
    users = [i["id"] for i in c.by_kind("device") if i.get("program_id") == pid]
    if users:
        raise HttpError(409, f"still assigned to {len(users)} device(s)", {"devices": users})
    c.delete(f"PROGRAM#{pid}")
    return resp(200, {"ok": True})


# ------------------------------------------------------------------ OGraf packages

def package_views():
    out = []
    for i in c.by_kind("package"):
        meta = c.get(i["pk"])
        if not meta:
            continue
        p = c.loads(meta["data"])
        p["versions"] = sorted((c.loads(v["data"]) for v in c.query(i["pk"], "VER#")),
                               key=lambda v: v["uploaded"], reverse=True)
        out.append(p)
    out.sort(key=lambda p: p["id"])
    return out


@route("GET", "/api/packages")
def list_packages(req):
    return resp(200, {"packages": package_views()})


@route("POST", "/api/packages/upload")
def package_upload_url(req):
    key = f"uploads/{c.new_id(10)}.zip"
    url = c.s3().generate_presigned_url(
        "put_object", Params={"Bucket": c.BUCKET, "Key": key, "ContentType": "application/zip"},
        ExpiresIn=900)
    return resp(200, {"key": key, "url": url})


def read_package_zip(data):
    """Find the OGraf manifest in a zip; returns (manifest, manifest path, root prefix)."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HttpError(400, "not a zip file")
    names = [n for n in z.namelist() if not n.endswith("/")]
    for n in names:
        if n.startswith("/") or ".." in n.split("/"):
            raise HttpError(400, f"unsafe path in zip: {n}")
    manifests = sorted((n for n in names if n.endswith(".ograf.json") and "__MACOSX" not in n),
                       key=lambda n: (n.count("/"), n))
    if not manifests:
        raise HttpError(400, "no *.ograf.json manifest in the zip")
    mpath = manifests[0]
    root = mpath.rsplit("/", 1)[0] + "/" if "/" in mpath else ""
    try:
        manifest = json.loads(z.read(mpath))
    except ValueError:
        raise HttpError(400, f"{mpath} is not valid JSON")
    if not isinstance(manifest, dict):
        raise HttpError(400, f"{mpath} must be a JSON object")
    main = manifest.get("main")
    if not isinstance(main, str) or root + main.lstrip("./") not in names:
        raise HttpError(400, f"manifest main {main!r} is not in the zip")
    return manifest, mpath[len(root):], root


@route("POST", "/api/packages/import")
def package_import(req):
    body = req.json()
    key = body.get("key", "")
    if not re.fullmatch(r"uploads/[0-9a-f]{20}\.zip", key):
        raise HttpError(400, "bad upload key")
    try:
        data = c.s3().get_object(Bucket=c.BUCKET, Key=key)["Body"].read()
    except Exception:
        raise HttpError(400, "upload not found; try again")
    manifest, mfile, root = read_package_zip(data)
    pkg_id = str(body.get("id") or manifest.get("id") or "").strip()
    version = str(body.get("version") or manifest.get("version") or time.strftime("%Y%m%d.%H%M%S")).strip()
    for v, what in ((pkg_id, "package id"), (version, "version")):
        e = validate.slug(v, what)
        if e:
            raise HttpError(400, e + f" (got {v!r}); set it in the manifest or the upload form")
    digest = c.sha256(data)
    existing = c.get(f"PKG#{pkg_id}", f"VER#{version}")
    if existing:
        if c.loads(existing["data"])["sha256"] == digest:
            c.s3().delete_object(Bucket=c.BUCKET, Key=key)
            return resp(200, {"id": pkg_id, "version": version, "unchanged": True})
        raise HttpError(409, f"{pkg_id} {version} already exists with different contents; bump the version")
    c.s3().copy_object(Bucket=c.BUCKET, Key=f"packages/{pkg_id}/{version}.zip",
                       CopySource={"Bucket": c.BUCKET, "Key": key})
    c.s3().delete_object(Bucket=c.BUCKET, Key=key)
    ver = {"version": version, "sha256": digest, "size": len(data), "uploaded": c.now(),
           "main": manifest["main"].lstrip("./"), "manifest_file": mfile, "root": root,
           "name": manifest.get("name", ""), "description": manifest.get("description", ""),
           "schema": manifest.get("schema") if isinstance(manifest.get("schema"), dict) else None,
           # Items are stored as sorted JSON, so keep the manifest's parameter order for forms.
           "schema_order": list((manifest.get("schema") or {}).get("properties") or {})
           if isinstance(manifest.get("schema"), dict) and isinstance(manifest["schema"].get("properties"), dict) else [],
           "manifest": manifest}
    c.put({"pk": f"PKG#{pkg_id}", "sk": f"VER#{version}", "data": c.dumps(ver)})
    meta = c.get(f"PKG#{pkg_id}")
    p = c.loads(meta["data"]) if meta else {"id": pkg_id, "active_version": version, "created": c.now()}
    p["name"] = manifest.get("name") or p.get("name") or pkg_id
    p["description"] = manifest.get("description") or p.get("description", "")
    if body.get("activate"):
        p["active_version"] = version
    c.put({"pk": f"PKG#{pkg_id}", "sk": "META", "kind": "package", "data": c.dumps(p)})
    return resp(200, {"id": pkg_id, "version": version, "active_version": p["active_version"]})


@route("PATCH", "/api/packages/{pkg}")
def package_patch(req, pkg):
    meta = c.get(f"PKG#{pkg}")
    if not meta:
        raise HttpError(404, "no such package")
    body = req.json()
    p = c.loads(meta["data"])
    if "active_version" in body:
        if not c.get(f"PKG#{pkg}", f"VER#{body['active_version']}"):
            raise HttpError(400, "no such version")
        p["active_version"] = body["active_version"]
    c.put({"pk": f"PKG#{pkg}", "sk": "META", "kind": "package", "data": c.dumps(p)})
    return resp(200, p)


def programs_using(pkg, version=None):
    used = []
    for i in c.by_kind("program"):
        p = c.loads(i["data"])
        for layer in p["layers"]:
            for it in layer["items"]:
                if it["package"] == pkg and (version is None or it.get("version") == version):
                    used.append(p["name"])
    return sorted(set(used))


@route("DELETE", "/api/packages/{pkg}/versions/{version}")
def package_delete_version(req, pkg, version):
    meta = c.get(f"PKG#{pkg}")
    if not meta or not c.get(f"PKG#{pkg}", f"VER#{version}"):
        raise HttpError(404, "no such version")
    if c.loads(meta["data"]).get("active_version") == version:
        raise HttpError(409, "this is the active version; activate another one first")
    used = programs_using(pkg, version)
    if used:
        raise HttpError(409, "pinned by programs: " + ", ".join(used))
    c.delete(f"PKG#{pkg}", f"VER#{version}")
    c.s3().delete_object(Bucket=c.BUCKET, Key=f"packages/{pkg}/{version}.zip")
    return resp(200, {"ok": True})


@route("DELETE", "/api/packages/{pkg}")
def package_delete(req, pkg):
    if not c.get(f"PKG#{pkg}"):
        raise HttpError(404, "no such package")
    used = programs_using(pkg)
    if used:
        raise HttpError(409, "used by programs: " + ", ".join(used))
    for x in c.query(f"PKG#{pkg}"):
        if x["sk"].startswith("VER#"):
            c.s3().delete_object(Bucket=c.BUCKET, Key=f"packages/{pkg}/{x['sk'][4:]}.zip")
        c.delete(x["pk"], x["sk"])
    return resp(200, {"ok": True})


# ------------------------------------------------------------------ OS images and stick export

def github(path):
    req = urllib.request.Request(f"https://api.github.com{path}", headers={
        "Accept": "application/vnd.github+json", "User-Agent": "signage-dashboard",
        **({"Authorization": f"Bearer {GITHUB_TOKEN}"} if GITHUB_TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise HttpError(502, f"GitHub said {e.code} for {path}"
                        + ("; is GitHubToken set and allowed to read the repo?" if e.code in (401, 403, 404) else ""))


def stick_asset(release):
    for a in release.get("assets", []):
        if re.fullmatch(r"signage_[^/]+\.raw\.xz", a["name"]) and ".usr" not in a["name"]:
            return a
    return None


@route("GET", "/api/releases")
def list_releases(req):
    mirrored = {i["pk"][8:]: i for i in c.by_kind("release")}
    out = []
    if GITHUB_REPO:
        for r in github(f"/repos/{GITHUB_REPO}/releases?per_page=20"):
            a = stick_asset(r)
            m = mirrored.pop(r["tag_name"], None)
            out.append({"tag": r["tag_name"], "name": r.get("name") or r["tag_name"],
                        "published": r.get("published_at"), "prerelease": r.get("prerelease", False),
                        "asset": a and {"name": a["name"], "size": a["size"]},
                        "mirror": c.loads(m["data"]) if m else None})
    for tag, m in mirrored.items():
        out.append({"tag": tag, "name": tag, "published": None, "asset": None, "mirror": c.loads(m["data"])})
    return resp(200, {"releases": out, "repo": GITHUB_REPO})


@route("POST", "/api/releases/{tag}/mirror")
def mirror_release(req, tag):
    if validate.slug(tag, "tag"):
        raise HttpError(400, "bad tag")
    if not GITHUB_REPO or not MIRROR_FUNCTION:
        raise HttpError(400, "GitHubRepo is not configured for this deployment")
    state = {"state": "queued", "tag": tag, "updated": c.now()}
    c.put({"pk": f"RELEASE#{tag}", "sk": "META", "kind": "release", "data": c.dumps(state)})
    boto3.client("lambda").invoke(FunctionName=MIRROR_FUNCTION, InvocationType="Event",
                                  Payload=json.dumps({"tag": tag}).encode())
    return resp(200, state)


@route("GET", "/api/releases/{tag}/image")
def release_image(req, tag):
    m = c.get(f"RELEASE#{tag}")
    st = c.loads(m["data"]) if m else {}
    if st.get("state") != "ready":
        raise HttpError(409, "this release isn't copied to the dashboard yet")
    sign = lambda key: c.s3().generate_presigned_url(  # noqa: E731
        "get_object", Params={"Bucket": c.BUCKET, "Key": key}, ExpiresIn=6 * 3600)
    st["url"] = sign(st["key"])
    if st.get("gz_head_key"):
        st["gz_head_url"] = sign(st["gz_head_key"])
        st["gz_tail_url"] = sign(st["gz_tail_key"])
    return resp(200, st)


# ------------------------------------------------------------------ saved WiFi and stick defaults
# Saved networks keep their password on the server. The API never sends a
# saved password back to the browser; it is only written into a generated
# config.toml or a device's settings, which need it. Settings anywhere can
# name a saved network as {"saved": "<id>"} instead of spelling it out.

def wifi_view(item):
    w = c.loads(item["data"])
    return {"id": w["id"], "ssid": w["ssid"], "priority": w.get("priority", 0), "hidden": w.get("hidden", False),
            "has_psk": bool(w.get("psk")), "updated": w.get("updated")}


def saved_wifi(wid):
    item = c.get(f"WIFI#{wid}") if isinstance(wid, str) and re.fullmatch(r"[0-9a-f]{4,32}", wid) else None
    return c.loads(item["data"]) if item else None


def resolve_saved_wifi(settings):
    """Replace {"saved": id} entries in network.wifi with the stored network."""
    wifi = settings.get("network", {}).get("wifi") if isinstance(settings, dict) and isinstance(settings.get("network"), dict) else None
    if not isinstance(wifi, list) or not any(isinstance(w, dict) and "saved" in w for w in wifi):
        return settings
    out, errs = [], []
    for i, w in enumerate(wifi):
        if isinstance(w, dict) and "saved" in w:
            sw = saved_wifi(w["saved"])
            if not sw:
                errs.append(f"network.wifi[{i}]: that saved network was deleted")
                continue
            out.append({k: sw[k] for k in ("ssid", "psk", "priority", "hidden") if k in sw})
        else:
            out.append(w)
    if errs:
        raise HttpError(400, "invalid settings", {"errors": errs})
    return {**settings, "network": {**settings["network"], "wifi": out}}


def check_wifi(w, keep_psk=None):
    if not isinstance(w, dict):
        raise HttpError(400, "network must be an object")
    net = {"ssid": w.get("ssid"), "priority": w.get("priority", 0), "hidden": w.get("hidden", False),
           "psk": keep_psk if w.get("psk") is None and keep_psk is not None else (w.get("psk") or "")}
    clean, errs = validate.settings({"network": {"wifi": [net]}})
    if errs:
        raise HttpError(400, "invalid network", {"errors": [e.replace("network.wifi[0].", "") for e in errs]})
    return clean["network"]["wifi"][0]


@route("GET", "/api/wifi")
def list_wifi(req):
    nets = sorted((wifi_view(i) for i in c.by_kind("wifi")), key=lambda w: (-w["priority"], w["ssid"].lower()))
    return resp(200, {"networks": nets})


@route("POST", "/api/wifi")
def create_wifi(req):
    net = check_wifi(req.json())
    net.update(id=c.new_id(), updated=c.now())
    c.put({"pk": f"WIFI#{net['id']}", "sk": "META", "kind": "wifi", "data": c.dumps(net)})
    return resp(201, wifi_view({"data": c.dumps(net)}))


@route("PUT", "/api/wifi/{wid}")
def put_wifi(req, wid):
    """Update a saved network. Leave psk out (or null) to keep the stored password."""
    old = saved_wifi(wid)
    if not old:
        raise HttpError(404, "no such saved network")
    net = check_wifi(req.json(), keep_psk=old.get("psk", ""))
    net.update(id=wid, updated=c.now())
    c.put({"pk": f"WIFI#{wid}", "sk": "META", "kind": "wifi", "data": c.dumps(net)})
    return resp(200, wifi_view({"data": c.dumps(net)}))


@route("DELETE", "/api/wifi/{wid}")
def delete_wifi(req, wid):
    if not saved_wifi(wid):
        raise HttpError(404, "no such saved network")
    c.delete(f"WIFI#{wid}")
    return resp(200, {"ok": True})


URL_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[^\s]*)?$")


def stick_options(body, errs):
    """Validate the stick settings shared by defaults and stick-config."""
    settings = {k: body[k] for k in ("device", "network", "ntp", "display") if k in body}
    clean, e = validate.settings(settings)
    errs += e
    countdown = body.get("countdown", 15)
    if not validate.is_int(countdown) or not 0 <= countdown <= 600:
        errs.append("install countdown must be 0 to 600 seconds")
    mok = body.get("mok_password") or "signage"
    if not isinstance(mok, str) or not 1 <= len(mok) <= 256:
        errs.append("Secure Boot enrollment password must be 1 to 256 characters")
    url = (body.get("dashboard_url") or "").strip().rstrip("/")
    if url and not URL_RE.match(url):
        errs.append("dashboard address must look like https://signs.example.org")
    return clean, countdown, mok, url


@route("GET", "/api/stick-defaults")
def get_stick_defaults(req):
    item = c.get("CONFIG", "STICK")
    d = c.loads(item["data"]) if item else {}
    known = {i["pk"][5:] for i in c.by_kind("wifi")}
    d["wifi"] = [w for w in d.get("wifi", []) if w in known]
    return resp(200, {"defaults": d, "enroll_token_set": bool(ENROLL_TOKEN), "dashboard_url": req.base_url})


@route("PUT", "/api/stick-defaults")
def put_stick_defaults(req):
    """Saved defaults for the Install images form. WiFi is a list of saved
    network ids; the device name is per stick and isn't kept."""
    body = req.json()
    if not isinstance(body, dict):
        raise HttpError(400, "body must be an object")
    errs = []
    wifi = body.get("wifi", [])
    if not isinstance(wifi, list) or not all(isinstance(w, str) for w in wifi):
        errs.append("wifi must be a list of saved network ids")
        wifi = []
    missing = [w for w in wifi if not saved_wifi(w)]
    if missing:
        errs.append("a selected WiFi network was deleted; reload the page")
    body = {k: v for k, v in body.items() if k != "wifi"}
    if isinstance(body.get("device"), dict):
        body["device"] = {k: v for k, v in body["device"].items() if k != "name"}
    clean, countdown, mok, url = stick_options(body, errs)
    if errs:
        raise HttpError(400, "invalid settings", {"errors": errs})
    d = {"device": clean.get("device", {}), "display": clean.get("display", {}),
         "ntp": clean.get("ntp", {}), "countdown": countdown, "mok_password": mok,
         "dashboard_url": url, "wifi": wifi, "updated": c.now()}
    c.put({"pk": "CONFIG", "sk": "STICK", "data": c.dumps(d)})
    return resp(200, {"defaults": d})


@route("POST", "/api/stick-config")
def stick_config(req):
    """Render a config.toml for a new install stick, enrolled in this dashboard."""
    body = req.json()
    if not isinstance(body, dict):
        raise HttpError(400, "body must be an object")
    body = resolve_saved_wifi(body)
    errs = []
    clean, countdown, mok, url = stick_options(body, errs)
    if errs:
        raise HttpError(400, "invalid settings", {"errors": errs})
    cfg = {
        "device": {"timezone": "America/New_York", **clean.get("device", {})},
        "dashboard": {"url": url or req.base_url, "enroll_token": ENROLL_TOKEN},
        "network": {"wifi": clean.get("network", {}).get("wifi", [])},
        "ntp": {"servers": clean.get("ntp", {}).get("servers", [])},
        "display": {"rotation": 0, **clean.get("display", {})},
        "install": {"countdown": countdown, "mok_password": mok},
    }
    if not cfg["network"]["wifi"]:
        del cfg["network"]["wifi"]
    header = ("# Signage player configuration, generated by the dashboard.\n"
              "# Edit on any computer. Settings changed later from the dashboard\n"
              "# override what is here.\n")
    return resp(200, {"config": tomlw.dumps(cfg, header)})


# ------------------------------------------------------------------ parameter options
# Lists offered by searchable inputs for graphic parameters marked in the
# manifest schema with "x-signage-options". Fetched here rather than in the
# browser so the source's CORS settings don't matter.

OPTION_SOURCES = {"schedule": {"locations": "/locations?limit=-1", "tracks": "/tracks?limit=-1"}}
_options_cache = {}


@route("GET", "/api/options")
def param_options(req):
    source, lst = req.query.get("source", ""), req.query.get("list", "")
    base = (req.query.get("base") or "https://schedule.magfest.net").strip().rstrip("/")
    path = OPTION_SOURCES.get(source, {}).get(lst)
    if not path:
        raise HttpError(400, "unknown option list")
    if not URL_RE.match(base) or not base.startswith("https://"):
        raise HttpError(400, "the server address must be an https:// URL")
    key = (base, path)
    hit = _options_cache.get(key)
    if hit and time.time() - hit[0] < 300:
        return resp(200, hit[1])
    try:
        r = urllib.request.urlopen(urllib.request.Request(base + path, headers={
            "Accept": "application/json", "User-Agent": "signage-dashboard"}), timeout=10)
        data = json.loads(r.read(5_000_000))
    except Exception as e:
        raise HttpError(502, f"couldn't load {lst} from {base}: {e}")
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [])
    opts, seen = [], set()
    for x in data if isinstance(data, list) else []:
        if not isinstance(x, dict) or x.get("name") in (None, ""):
            continue
        name = str(x["name"])
        if name in seen:
            continue
        seen.add(name)
        opts.append({"value": name, "id": str(x.get("id", "")), "hint": str(x.get("description") or "")[:120]})
    # Booths are numerous and rarely what a sign shows; list them last.
    opts.sort(key=lambda o: ("booth" in o["value"].lower(), o["value"].lower()))
    body = {"options": opts, "source": base + path}
    _options_cache[key] = (time.time(), body)
    return resp(200, body)
