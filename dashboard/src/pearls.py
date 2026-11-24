"""Epiphan Pearls: registration, status and remote control through gateways.

The dashboard can't reach a Pearl on a venue network, and a Pearl can't run
our agent. A *gateway* (agent/pearl-gateway, on any machine on the Pearls'
network) checks in here, reports a snapshot of each of its Pearls, and runs
the Pearl API calls queued for them ("ops"). Pearl passwords are stored here
and handed to the gateway, never back to the browser.

  admin:   /api/gateways, /api/pearls, /api/pearls/{pid}/ops, /api/pearls/ops
  gateway: /gateway/checkin   (Authorization: Gateway <id>:<token>)

Imported at the bottom of app.py, so it can use app's route() and helpers.
"""

import re
import time

import common as c
from app import HttpError, ONLINE_GRACE, resp, route

GW_POLL = 10        # gateway check-in interval when nothing is happening
GW_POLL_FAST = 2    # while someone has a Pearl open or ops are queued
SNAP_SLOW = 30      # seconds between full Pearl snapshots, normally
SNAP_FAST = 5       # ... while someone is looking
WATCH_SECS = 90
OP_TTL = 300        # a queued op the gateway hasn't picked up by then expires
OP_KEEP = 3600      # done ops stay readable this long
PREVIEW_TTL = 3600
SNAPSHOT_MAX = 350_000

METHODS = {"GET", "PUT", "PATCH", "POST", "DELETE"}
# Pearl API paths a gateway may call: the REST API and the older CGI one.
PATH_RE = re.compile(r"^/(api/v2\.[0-9]+|admin)/[A-Za-z0-9._~/-]*$")
PREVIEW_RE = re.compile(r"^(inputs/[A-Za-z0-9._-]+|channels/[0-9]+(/layouts/[0-9]+)?|outputs/[A-Za-z0-9._-]+)$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$")


# ------------------------------------------------------------------ gateways

def gateway_item(gid):
    item = c.get(f"GATEWAY#{gid}")
    if not item:
        raise HttpError(404, "no such gateway")
    return item


def gateway_view(item):
    last = int(item.get("last_seen", 0))
    return {"id": item["id"], "name": item.get("name", ""), "created": int(item.get("created", 0)),
            "last_seen": last, "online": c.now() - last <= ONLINE_GRACE, "ip": item.get("ip", ""),
            "version": item.get("version", ""), "local_ips": c.loads(item.get("local_ips"), [])}


@route("GET", "/api/gateways")
def list_gateways(req):
    gws = sorted((gateway_view(i) for i in c.by_kind("gateway")), key=lambda g: g["name"].lower())
    return resp(200, {"gateways": gws})


@route("POST", "/api/gateways")
def create_gateway(req):
    name = str(req.json().get("name") or "").strip()[:60]
    if not name:
        raise HttpError(400, "name the gateway, e.g. after the machine or room it's in")
    gid, token = c.new_id(6), "pgw_" + c.secrets.token_urlsafe(32)
    item = {"pk": f"GATEWAY#{gid}", "sk": "META", "kind": "gateway", "id": gid, "name": name,
            "token_hash": c.sha256(token), "created": c.now()}
    c.put(item)
    return resp(201, {**gateway_view(item), "token": token})


@route("PATCH", "/api/gateways/{gid}")
def patch_gateway(req, gid):
    gateway_item(gid)
    name = str(req.json().get("name") or "").strip()[:60]
    if not name:
        raise HttpError(400, "the name can't be empty")
    return resp(200, gateway_view(c.update(f"GATEWAY#{gid}", "META", {"name": name})))


@route("DELETE", "/api/gateways/{gid}")
def delete_gateway(req, gid):
    gateway_item(gid)
    used = [p.get("name") or p["id"] for p in c.by_kind("pearl") if p.get("gateway_id") == gid]
    if used:
        raise HttpError(409, f"move these Pearls to another gateway first: {', '.join(used)}")
    c.delete(f"GATEWAY#{gid}")
    return resp(200, {"ok": True})


def gateway_auth(req):
    authz = req.headers.get("authorization", "")
    if not authz.startswith("Gateway "):
        raise HttpError(401, "missing gateway credentials")
    try:
        gid, token = authz[8:].split(":", 1)
    except ValueError:
        raise HttpError(401, "bad gateway credentials")
    item = c.get(f"GATEWAY#{gid}") if re.fullmatch(r"[0-9a-f]{6,32}", gid) else None
    if not item or not c.verify_equal(item.get("token_hash", ""), c.sha256(token)):
        time.sleep(1)
        raise HttpError(401, "unknown gateway or wrong token")
    return item


# ------------------------------------------------------------------ Pearls

def pearl_item(pid):
    item = c.get(f"PEARL#{pid}") if re.fullmatch(r"[0-9a-f]{6,32}", pid or "") else None
    if not item:
        raise HttpError(404, "no such Pearl")
    return item


def _signal(st):
    v = (st or {}).get("video") or {}
    if not v:
        return None
    if v.get("state") and v["state"] != "active":
        return False
    w, _, hh = str(v.get("resolution") or "0x0").partition("x")
    return w.isdigit() and hh.isdigit() and int(w) > 0 and int(hh) > 0


def summary(snap):
    """The fleet list's columns, from a gateway snapshot."""
    if not snap:
        return {}
    fw = snap.get("firmware") or {}
    sysst = snap.get("system_status") or {}
    inputs = []
    for i in snap.get("inputs") or []:
        if not i.get("video"):
            continue
        st = (snap.get("input_status") or {}).get(i["id"]) or {}
        v = st.get("video") or {}
        inputs.append({"id": i["id"], "name": i.get("name", i["id"]), "type": i.get("type", ""),
                       "signal": _signal(st), "resolution": v.get("resolution", ""), "state": v.get("state", "")})
    chans = []
    for ch in snap.get("channels") or []:
        cid = str(ch.get("id"))
        layouts = (snap.get("layouts") or {}).get(cid) or []
        active = next((l for l in layouts if l.get("active")), None)
        pubs = (snap.get("publisher_status") or {}).get(cid) or []
        chans.append({"id": cid, "name": ch.get("name", cid), "layout": active and active.get("name"),
                      "streaming": sum(1 for p in pubs if (p.get("status") or {}).get("started")),
                      "publishers": len(pubs)})
    recs = []
    for r in snap.get("recorders") or []:
        st = (snap.get("recorder_status") or {}).get(str(r["id"])) or {}
        recs.append({"id": str(r["id"]), "name": r.get("name", ""), "state": st.get("state", "")})
    outs = []
    for o in snap.get("outputs") or []:
        s = (snap.get("output_settings") or {}).get(o["id"]) or {}
        st = (snap.get("output_status") or {}).get(o["id"]) or {}
        outs.append({"id": o["id"], "name": o.get("name", ""), "source": s.get("source"), "state": st.get("state", "")})
    wg = {}
    for i in snap.get("inputs") or []:
        if i.get("type") == "web-graphics":
            wg[i["id"]] = (((snap.get("input_settings") or {}).get(i["id"]) or {}).get("web_graphics") or {}).get("url", "")
    return {"firmware": fw.get("version", ""), "product": fw.get("product_name", ""),
            "ident": (snap.get("ident") or {}).get("name", ""),
            "cpuload": sysst.get("cpuload"), "cputemp": sysst.get("cputemp"), "uptime": sysst.get("uptime"),
            "inputs": inputs, "channels": chans, "recorders": recs, "outputs": outs, "web_graphics": wg}


def load_snapshot(item):
    """A Pearl's last full snapshot with its latest quick status pass on top.
    They're separate items so the frequent status writes stay small."""
    out = {}
    for x in c.query(item["pk"], "SNAP"):
        if x["sk"] in ("SNAP#FULL", "SNAP#STATUS"):
            out[x["sk"]] = c.loads(x.get("data"), {})
    return {**out.get("SNAP#FULL", {}), **out.get("SNAP#STATUS", {})}


def pearl_view(item, full=False):
    snap = load_snapshot(item)
    snap_at = int(item.get("snapshot_at", 0))
    gw = c.get(f"GATEWAY#{item['gateway_id']}") if item.get("gateway_id") else None
    gw_ok = bool(gw) and c.now() - int(gw.get("last_seen", 0)) <= ONLINE_GRACE
    v = {"id": item["id"], "name": item.get("name", ""), "room": item.get("room", ""), "host": item.get("host", ""),
         "username": item.get("username", ""), "has_password": bool(item.get("password")),
         "gateway_id": item.get("gateway_id", ""), "gateway_name": (gw or {}).get("name", ""), "gateway_online": gw_ok,
         "notes": item.get("notes", ""), "created": int(item.get("created", 0)),
         "snapshot_at": snap_at, "error": item.get("error", ""),
         # Reachable: the gateway is up and got an answer from the Pearl recently.
         "online": gw_ok and not item.get("error") and c.now() - snap_at <= max(ONLINE_GRACE, SNAP_SLOW * 3),
         "summary": summary(snap)}
    if full:
        v["snapshot"] = snap
    return v


def check_pearl(body, old=None):
    old = old or {}
    out, errs = {}, []
    for k, n in (("name", 60), ("room", 120), ("notes", 2000), ("username", 64)):
        if k in body:
            out[k] = str(body[k] or "").strip()[:n]
    if "host" in body:
        host = str(body["host"] or "").strip()
        if not HOST_RE.match(host):
            errs.append("host: an IP address or name, e.g. 10.1.29.127 or gsaa798666.local")
        out["host"] = host
    if body.get("password") is not None:     # null or missing keeps the stored one
        out["password"] = str(body["password"])[:128]
    if "gateway_id" in body:
        gid = str(body["gateway_id"] or "")
        if gid and not c.get(f"GATEWAY#{gid}"):
            errs.append("gateway: no such gateway")
        out["gateway_id"] = gid
    merged = {**old, **out}
    if not merged.get("name"):
        errs.append("name: required")
    if not merged.get("host"):
        errs.append("host: required")
    if errs:
        raise HttpError(400, "invalid Pearl", {"errors": errs})
    return out


@route("GET", "/api/pearls")
def list_pearls(req):
    pearls = sorted((pearl_view(i) for i in c.by_kind("pearl")), key=lambda p: (p["room"].lower(), p["name"].lower()))
    return resp(200, {"pearls": pearls, "server_time": time.time()})


@route("POST", "/api/pearls")
def create_pearl(req):
    fields = check_pearl({"username": "admin", **req.json()})
    pid = c.new_id(6)
    item = {"pk": f"PEARL#{pid}", "sk": "META", "kind": "pearl", "id": pid, "created": c.now(),
            "username": "admin", "password": "", "gateway_id": "", **fields}
    c.put(item)
    return resp(201, pearl_view(item))


@route("GET", "/api/pearls/{pid}")
def get_pearl(req, pid):
    item = pearl_item(pid)
    # Someone is looking: have the gateway snapshot this Pearl often.
    item = c.update(item["pk"], "META", {"watch_until": c.now() + WATCH_SECS})
    return resp(200, pearl_view(item, full=True))


@route("PATCH", "/api/pearls/{pid}")
def patch_pearl(req, pid):
    item = pearl_item(pid)
    fields = check_pearl(req.json(), old=item)
    if not fields:
        return resp(200, pearl_view(item))
    if "host" in fields or "password" in fields or "username" in fields or "gateway_id" in fields:
        fields["error"] = ""
    return resp(200, pearl_view(c.update(item["pk"], "META", fields)))


@route("DELETE", "/api/pearls/{pid}")
def delete_pearl(req, pid):
    item = pearl_item(pid)
    for x in c.query(item["pk"]):
        c.delete(item["pk"], x["sk"])
    return resp(200, {"ok": True})


# ------------------------------------------------------------------ ops

def check_op(body):
    kind = body.get("kind", "api")
    if kind == "preview":
        target = str(body.get("target") or "")
        if not PREVIEW_RE.match(target):
            raise HttpError(400, "preview target: inputs/<id>, channels/<id>[/layouts/<id>] or outputs/<id>")
        res = str(body.get("resolution") or "960")
        if not re.fullmatch(r"\d{2,4}(x\d{2,4})?|auto", res):
            raise HttpError(400, "resolution: 960, 1280x720 or auto")
        return {"kind": "preview", "method": "GET", "path": f"/api/v2.0/{target}/preview",
                "query": {"resolution": res}, "body": None}
    method = str(body.get("method") or "GET").upper()
    path = "/" + str(body.get("path") or "").lstrip("/")
    if not path.startswith(("/api/", "/admin/")):
        path = "/api/v2.0" + path
    if method not in METHODS:
        raise HttpError(400, f"method must be one of {', '.join(sorted(METHODS))}")
    if not PATH_RE.match(path) or ".." in path:
        raise HttpError(400, "path: a Pearl API path such as /api/v2.0/inputs or /admin/get_params.cgi")
    query = body.get("query") or {}
    if not isinstance(query, dict) or not all(isinstance(k, str) and isinstance(v, (str, int, float, bool)) or v is None
                                              for k, v in query.items()):
        raise HttpError(400, "query must be an object of strings")
    payload = body.get("body")
    if payload is not None and len(c.dumps(payload)) > 100_000:
        raise HttpError(400, "body too large")
    return {"kind": "api", "method": method, "path": path,
            "query": {k: ("" if v is None else str(v)) for k, v in query.items()}, "body": payload}


def queue_op(item, op, label=""):
    if not item.get("gateway_id"):
        raise HttpError(409, f"{item.get('name') or item['id']} has no gateway; pick one in its settings")
    oid = f"{c.now_ms()}-{c.new_id(3)}"
    rec = {"id": oid, "pearl": item["id"], "state": "pending", "created": c.now(), "label": str(label)[:120], **op}
    c.put({"pk": item["pk"], "sk": f"OP#{oid}", "data": c.dumps(rec), "ttl": c.now() + OP_KEEP})
    # Wake the gateway into fast polling.
    c.update(item["pk"], "META", {"ops_until": c.now() + OP_TTL})
    return rec


def op_view(rec):
    out = {k: rec.get(k) for k in ("id", "pearl", "kind", "method", "path", "query", "label", "state",
                                    "created", "done", "status", "result", "error")}
    if rec.get("kind") == "preview" and rec.get("state") == "done" and rec.get("key"):
        out["url"] = c.s3().generate_presigned_url("get_object", Params={"Bucket": c.BUCKET, "Key": rec["key"]},
                                                   ExpiresIn=900)
    return out


@route("POST", "/api/pearls/{pid}/ops")
def post_op(req, pid):
    item = pearl_item(pid)
    body = req.json()
    return resp(200, op_view(queue_op(item, check_op(body), body.get("label", ""))))


@route("POST", "/api/pearls/ops")
def post_ops_bulk(req):
    """Queue ops on several Pearls at once: {"ops": [{"pearl": id, method, path, body, label}, ...]}."""
    ops = req.json().get("ops")
    if not isinstance(ops, list) or not ops or len(ops) > 500:
        raise HttpError(400, "ops: a list of 1 to 500 ops")
    checked, errs = [], []
    items = {}
    for n, o in enumerate(ops):
        try:
            pid = str((o or {}).get("pearl") or "")
            items[pid] = items.get(pid) or pearl_item(pid)
            checked.append((items[pid], check_op(o), o.get("label", "")))
        except HttpError as e:
            errs.append(f"ops[{n}]: {e.message}")
    if errs:
        raise HttpError(400, "invalid ops", {"errors": errs})
    out = []
    for item, op, label in checked:
        try:
            out.append(op_view(queue_op(item, op, label)))
        except HttpError as e:
            out.append({"pearl": item["id"], "state": "failed", "error": e.message})
    return resp(200, {"ops": out})


@route("GET", "/api/pearls/{pid}/ops/{oid}")
def get_op(req, pid, oid):
    item = pearl_item(pid)
    x = c.get(item["pk"], f"OP#{oid}")
    if not x:
        raise HttpError(404, "no such op")
    return resp(200, op_view(expire(item["pk"], x)))


@route("GET", "/api/pearls/{pid}/ops")
def list_ops(req, pid):
    item = pearl_item(pid)
    xs = c.query(item["pk"], "OP#", forward=False, limit=50)
    return resp(200, {"ops": [op_view(expire(item["pk"], x)) for x in xs]})


def expire(pk, x):
    rec = c.loads(x["data"])
    if rec["state"] in ("pending", "sent") and rec["created"] < c.now() - OP_TTL:
        rec.update(state="failed", error="the gateway didn't run it in time; is it online?", done=c.now())
        c.update(pk, x["sk"], {"data": c.dumps(rec)})
    return rec


# ------------------------------------------------------------------ gateway check-in

@route("POST", "/gateway/checkin", auth=None)
def gateway_checkin(req):
    gw = gateway_auth(req)
    gid = gw["id"]
    body = req.json()
    now = c.now()
    gw_changes = {"last_seen": now, "ip": req.ip, "version": str(body.get("version", ""))[:40]}
    if isinstance(body.get("local_ips"), list):
        gw_changes["local_ips"] = c.dumps([str(x)[:64] for x in body["local_ips"][:8]])
    c.update(gw["pk"], "META", gw_changes)

    pearls = {p["id"]: p for p in c.by_kind("pearl") if p.get("gateway_id") == gid}

    # Snapshots and errors, per Pearl.
    for pid, snap in (body.get("snapshots") or {}).items():
        p = pearls.get(pid)
        if not p or not isinstance(snap, dict):
            continue
        if snap.get("error"):
            c.update(p["pk"], "META", {"error": str(snap["error"])[:500], "error_at": now})
            continue
        data = snap.get("data")
        if not isinstance(data, dict):
            continue
        raw = c.dumps(data)
        if len(raw) > SNAPSHOT_MAX:
            c.update(p["pk"], "META", {"error": "snapshot too large", "error_at": now})
            continue
        if snap.get("full"):
            c.put({"pk": p["pk"], "sk": "SNAP#FULL", "data": raw, "at": now})
            c.delete(p["pk"], "SNAP#STATUS")   # the full one is newer
        else:
            c.put({"pk": p["pk"], "sk": "SNAP#STATUS", "data": raw, "at": now})
        p.update(c.update(p["pk"], "META", {"snapshot_at": now, "error": ""}))

    # Multiviewer frames uploaded since the last check-in: {pid: {target: time}}.
    for pid, fr in (body.get("frames") or {}).items():
        p = pearls.get(pid)
        if p and isinstance(fr, dict) and fr:
            old = c.loads(p.get("mv_frames"), {})
            old.update({str(k)[:80]: int(v) for k, v in fr.items() if isinstance(v, (int, float))})
            p.update(c.update(p["pk"], "META", {"mv_frames": c.dumps(old)}))

    # Results of ops.
    for r in body.get("results") or []:
        p = pearls.get(str(r.get("pearl", "")))
        if not p:
            continue
        x = c.get(p["pk"], f"OP#{r.get('id', '')}")
        if not x:
            continue
        rec = c.loads(x["data"])
        result = r.get("result")
        if result is not None and len(c.dumps(result)) > 200_000:
            result = {"truncated": True}
        rec.update(state="done" if r.get("ok") else "failed", done=now, status=r.get("status"),
                   result=result, error=str(r.get("error") or "")[:2000])
        c.update(p["pk"], x["sk"], {"data": c.dumps(rec)})

    # Ops waiting, and what the gateway should poll.
    ops, fast = [], False
    out_pearls = []
    for pid, p in pearls.items():
        watched = int(p.get("watch_until", 0)) > now
        busy = int(p.get("ops_until", 0)) > now
        mv = mv_for_gateway(p, now)
        fast = fast or watched or busy or bool(mv)
        out_pearls.append({"id": pid, "name": p.get("name", ""), "host": p.get("host", ""),
                           "username": p.get("username", "admin"), "password": p.get("password", ""),
                           "snapshot_every": SNAP_FAST if watched else SNAP_SLOW, "multiview": mv})
        if not busy:
            continue
        for x in c.query(p["pk"], "OP#"):
            rec = c.loads(x["data"])
            if rec["state"] != "pending":
                continue
            if rec["created"] < now - OP_TTL:
                expire(p["pk"], x)
                continue
            send = {k: rec[k] for k in ("id", "pearl", "kind", "method", "path", "query", "body")}
            if rec["kind"] == "preview":
                key = f"pearl-previews/{pid}/{rec['id']}.jpg"
                rec["key"] = key
                send["upload_url"] = c.s3().generate_presigned_url(
                    "put_object", Params={"Bucket": c.BUCKET, "Key": key, "ContentType": "image/jpeg"},
                    ExpiresIn=600)
            rec.update(state="sent", sent=now)
            c.update(p["pk"], x["sk"], {"data": c.dumps(rec)})
            ops.append(send)
    return resp(200, {"server_time": time.time(), "poll_interval": GW_POLL_FAST if fast or ops else GW_POLL,
                      "pearls": out_pearls, "ops": ops})


# ------------------------------------------------------------------ multiviewer
# While a multiviewer is open the gateways upload preview frames of the
# chosen sources straight to S3, one fixed key per source, every few
# seconds; the browser polls /api/pearls/multiview for fresh URLs and frame
# times and only reloads tiles that changed. Nothing is stored per frame.

MV_TTL = 45                 # keep streaming this long after the last poll
MV_EVERY = (2, 5, 10, 30)
MV_WIDTHS = (320, 480, 640, 960)
MV_SHOW = ("inputs", "outputs", "both")


def mv_targets(snap, show):
    """[(target, label, kind)] for a Pearl's snapshot: video inputs that
    exist (not unplugged USB), and/or the HDMI outputs and channels."""
    out = []
    if show in ("inputs", "both"):
        for i in snap.get("inputs") or []:
            if not i.get("video"):
                continue
            st = ((snap.get("input_status") or {}).get(i["id"]) or {}).get("video") or {}
            if i.get("type") == "usb" and st.get("state") != "active":
                continue
            out.append((f"inputs/{i['id']}", i.get("name") or i["id"], "input"))
    if show in ("outputs", "both"):
        chans = {str(ch["id"]): ch.get("name", ch["id"]) for ch in snap.get("channels") or []}
        for o in snap.get("outputs") or []:
            src = ((snap.get("output_settings") or {}).get(o["id"]) or {}).get("source")
            label = f"{o.get('name') or o['id']} out" + (f" ({chans.get(str(src), src)})" if src else "")
            out.append((f"outputs/{o['id']}", label, "output"))
        for cid, name in chans.items():
            out.append((f"channels/{cid}", name, "channel"))
    return out


def mv_key(pid, target):
    return f"pearl-mv/{pid}/{target.replace('/', '_')}.jpg"


@route("POST", "/api/pearls/multiview")
def multiview(req):
    """Start or keep up a multiviewer and get its tiles.
    {"pearls": [ids] (default all), "show": inputs|outputs|both, "every": s, "width": px}"""
    body = req.json()
    show = body.get("show", "both")
    if show not in MV_SHOW:
        raise HttpError(400, f"show: one of {', '.join(MV_SHOW)}")
    every = body.get("every", 5)
    width = body.get("width", 480)
    if every not in MV_EVERY:
        raise HttpError(400, f"every: one of {MV_EVERY}")
    if width not in MV_WIDTHS:
        raise HttpError(400, f"width: one of {MV_WIDTHS}")
    want = body.get("pearls")
    items = [p for p in c.by_kind("pearl") if not want or p["id"] in want]
    items.sort(key=lambda p: (p.get("room", "").lower(), p.get("name", "").lower()))
    now = c.now()
    pearls = []
    for item in items:
        v = pearl_view(item, full=True)
        snap = v.pop("snapshot")
        targets = mv_targets(snap, show)
        conf = {"targets": [t for t, _, _ in targets], "every": every, "width": width, "until": now + MV_TTL}
        old = c.loads(item.get("mv"), {})
        if {k: old.get(k) for k in ("targets", "every", "width")} != {k: conf[k] for k in ("targets", "every", "width")} \
                or int(old.get("until", 0)) < now + MV_TTL - 15:
            c.update(item["pk"], "META", {"mv": c.dumps(conf)})
        frames = c.loads(item.get("mv_frames"), {})
        sigs = {i["id"]: i["signal"] for i in v["summary"].get("inputs", [])}
        tiles = []
        for t, label, kind in targets:
            at = int(frames.get(t, 0))
            tile = {"target": t, "label": label, "kind": kind, "at": at}
            if kind == "input":
                tile["signal"] = sigs.get(t.split("/", 1)[1])
            if at:
                tile["url"] = c.s3().generate_presigned_url(
                    "get_object", Params={"Bucket": c.BUCKET, "Key": mv_key(item["id"], t)}, ExpiresIn=600)
            tiles.append(tile)
        pearls.append({k: v[k] for k in ("id", "name", "room", "host", "online", "error", "gateway_online")} | {"tiles": tiles})
    return resp(200, {"pearls": pearls, "server_time": time.time()})


def mv_for_gateway(p, now):
    """The multiviewer job for this Pearl's gateway, with upload URLs, or None."""
    conf = c.loads(p.get("mv"), {})
    if int(conf.get("until", 0)) <= now or not conf.get("targets"):
        return None
    return {"every": conf["every"], "width": conf["width"], "until_in": int(conf["until"]) - now,
            "targets": [{"target": t, "upload_url": c.s3().generate_presigned_url(
                "put_object", Params={"Bucket": c.BUCKET, "Key": mv_key(p["id"], t), "ContentType": "image/jpeg"},
                ExpiresIn=600)} for t in conf["targets"]]}
