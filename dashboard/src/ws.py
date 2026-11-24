"""WebSocket API: terminal and live view relay, and device control sockets.

Control sockets: each device keeps one connection open with ?role=control and
an "Authorization: Device <id>:<token>" header (its check-in credentials).
The dashboard sends {"t":"wake"} down it whenever there is something new for
the device (a command, settings, content); the device then checks in at once
instead of at its next poll. The socket carries no commands itself, so
everything still flows through the check-in, which keeps working on its own
when the socket is down. The device sends {"t":"ping"} every few minutes
(API Gateway drops connections idle for 10 minutes) and gets {"t":"pong"}
back, which tells it the connection is still alive. API Gateway also closes
every connection after 2 hours; the device reconnects.

A terminal session has two ends: the admin's browser and the device agent.
Each connects with ?session=<id>&role=admin|device&token=<...>. Frames from
one end are forwarded verbatim to the other. Frames are small JSON objects:

  {"t":"i","d":"<text>"}           keyboard input (browser -> device)
  {"t":"r","cols":80,"rows":24}    resize (browser -> device)
  {"t":"o","d":"<base64>"}         terminal output (device -> browser)
  {"t":"ready"} / {"t":"closed"}   sent by the relay
  {"t":"ping"}                     keepalive, dropped
"""

import json

import boto3

import common as c

PEER = {"admin": "device", "device": "admin"}


def _api(event):
    rc = event["requestContext"]
    return boto3.client("apigatewaymanagementapi",
                        endpoint_url=f"https://{rc['domainName']}/{rc['stage']}")


def _send(api, conn, msg):
    if not conn:
        return False
    try:
        api.post_to_connection(ConnectionId=conn, Data=msg if isinstance(msg, (bytes, str)) else json.dumps(msg))
        return True
    except api.exceptions.GoneException:
        return False


def _device(event):
    """The device whose check-in credentials are in the Authorization header."""
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    authz = headers.get("authorization", "")
    if not authz.startswith("Device "):
        return None
    did, _, token = authz[7:].partition(":")
    item = c.get(f"DEVICE#{did}") if did else None
    if not item or not c.verify_equal(item.get("token_hash", ""), c.sha256(token)):
        return None
    return item


def control(event, route, conn, me=None):
    if route == "$connect":
        item = _device(event)
        if not item:
            return {"statusCode": 403}
        c.put({"pk": f"CONN#{conn}", "sk": "META", "role": "control", "device_id": item["id"],
               "ttl": c.now() + 86400})
        try:
            c.update(item["pk"], "META", {"ctl_conn": conn, "ctl_since": c.now()}, condition=c.exists_cond())
        except c.table().meta.client.exceptions.ConditionalCheckFailedException:
            return {"statusCode": 403}  # removed meanwhile
        return {"statusCode": 200}
    if route == "$disconnect":
        c.delete(f"CONN#{conn}")
        c.forget_control(f"DEVICE#{me['device_id']}", conn)
        return {"statusCode": 200}
    if (event.get("body") or "").startswith('{"t":"ping"'):
        _send(_api(event), conn, {"t": "pong"})
    return {"statusCode": 200}


def handler(event, context=None):
    rc = event["requestContext"]
    route = rc["routeKey"]
    conn = rc["connectionId"]

    if route == "$connect":
        q = event.get("queryStringParameters") or {}
        if q.get("role") == "control":
            return control(event, route, conn)
        sid, role, token = q.get("session", ""), q.get("role", ""), q.get("token", "")
        sess = c.get(f"TERM#{sid}") if sid else None
        if not sess or role not in PEER:
            return {"statusCode": 403}
        if role == "admin":
            claims = c.verify(token, "term")
            if not claims or claims.get("sid") != sid:
                return {"statusCode": 403}
        elif not c.verify_equal(sess["device_secret"], c.sha256(token)):
            return {"statusCode": 403}
        c.put({"pk": f"CONN#{conn}", "sk": "META", "sid": sid, "role": role, "ttl": c.now() + 86400})
        sess = c.update(f"TERM#{sid}", "META", {f"{role}_conn": conn})
        peer = sess.get(f"{PEER[role]}_conn")
        if peer:
            # Both ends are here; tell the browser (it can't hear us on the
            # device's own $connect, so only the existing end gets this).
            _send(_api(event), peer, {"t": "ready"})
        return {"statusCode": 200}

    me = c.get(f"CONN#{conn}")
    if not me:
        return {"statusCode": 200}
    if me.get("role") == "control":
        return control(event, route, conn, me)
    sess = c.get(f"TERM#{me['sid']}") or {}
    peer = sess.get(f"{PEER[me['role']]}_conn")
    api = _api(event)

    if route == "$disconnect":
        c.delete(f"CONN#{conn}")
        if peer:
            _send(api, peer, {"t": "closed"})
            try:
                api.delete_connection(ConnectionId=peer)
            except Exception:
                pass
        c.delete(f"TERM#{me['sid']}")
        return {"statusCode": 200}

    body = event.get("body") or ""
    if body == '{"t":"ping"}':
        return {"statusCode": 200}
    if body == '{"t":"hello"}':
        # The browser says hello once open; covers the device connecting first.
        if peer:
            _send(api, conn, {"t": "ready"})
        return {"statusCode": 200}
    if not _send(api, peer, body) and me["role"] == "admin":
        _send(api, conn, {"t": "waiting"})
    return {"statusCode": 200}
