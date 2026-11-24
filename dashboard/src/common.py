"""Shared helpers for the HTTP and WebSocket Lambda handlers."""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

import boto3
from boto3.dynamodb.conditions import Attr, Key

TABLE_NAME = os.environ.get("TABLE", "signage")
BUCKET = os.environ.get("BUCKET", "signage")

_ddb = None
_s3 = None


def table():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb").Table(TABLE_NAME)
    return _ddb


def s3():
    global _s3
    if _s3 is None:
        from botocore.config import Config
        _s3 = boto3.client("s3", config=Config(signature_version="s3v4"))
    return _s3


def reset_clients():
    """Tests swap AWS mocks in and out; drop cached clients."""
    global _ddb, _s3
    _ddb = None
    _s3 = None


def now():
    return int(time.time())


def now_ms():
    return int(time.time() * 1000)


def new_id(n=8):
    return secrets.token_hex(n)


def sha256(data):
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def dumps(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def loads(s, default=None):
    if s is None or s == "":
        return default
    return json.loads(s)


# ------------------------------------------------------------------ items
# Nested documents are stored as JSON strings so DynamoDB's Decimal handling
# never leaks into the API.

def get(pk, sk="META"):
    return table().get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item")


def query(pk, prefix=None, forward=True, limit=None):
    cond = Key("pk").eq(pk)
    if prefix:
        cond = cond & Key("sk").begins_with(prefix)
    kw = {"KeyConditionExpression": cond, "ScanIndexForward": forward, "ConsistentRead": True}
    if limit:
        kw["Limit"] = limit
    items = []
    while True:
        r = table().query(**kw)
        items += r["Items"]
        if limit and len(items) >= limit:
            return items[:limit]
        if "LastEvaluatedKey" not in r:
            return items
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def by_kind(kind):
    kw = {"IndexName": "kind-index", "KeyConditionExpression": Key("kind").eq(kind)}
    items = []
    while True:
        r = table().query(**kw)
        items += r["Items"]
        if "LastEvaluatedKey" not in r:
            return items
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def put(item, **kw):
    table().put_item(Item=item, **kw)


def delete(pk, sk="META"):
    table().delete_item(Key={"pk": pk, "sk": sk})


def update(pk, sk, values, remove=(), condition=None):
    """SET each attribute in values (and REMOVE those in remove)."""
    names, vals, sets = {}, {}, []
    for i, (k, v) in enumerate(values.items()):
        names[f"#a{i}"] = k
        vals[f":v{i}"] = v
        sets.append(f"#a{i} = :v{i}")
    expr = []
    if sets:
        expr.append("SET " + ", ".join(sets))
    if remove:
        rm = []
        for j, k in enumerate(remove):
            names[f"#r{j}"] = k
            rm.append(f"#r{j}")
        expr.append("REMOVE " + ", ".join(rm))
    kw = {
        "Key": {"pk": pk, "sk": sk},
        "UpdateExpression": " ".join(expr),
        "ExpressionAttributeNames": names,
        "ReturnValues": "ALL_NEW",
    }
    if vals:
        kw["ExpressionAttributeValues"] = vals
    if condition is not None:
        kw["ConditionExpression"] = condition
    return table().update_item(**kw)["Attributes"]


def exists_cond():
    return Attr("pk").exists()


def forget_control(pk, conn):
    """Clear a device's control socket (ws.py), unless it has already reconnected."""
    try:
        update(pk, "META", {}, remove=("ctl_conn",), condition=Attr("ctl_conn").eq(conn))
    except table().meta.client.exceptions.ConditionalCheckFailedException:
        pass


# ------------------------------------------------------------------ admin auth

def _secret():
    """Per-deployment HMAC key, created on first use."""
    item = get("CONFIG", "SECRET")
    if item:
        return base64.b64decode(item["value"])
    value = base64.b64encode(secrets.token_bytes(32)).decode()
    try:
        put({"pk": "CONFIG", "sk": "SECRET", "value": value}, ConditionExpression=Attr("pk").not_exists())
    except table().meta.client.exceptions.ConditionalCheckFailedException:
        return _secret()
    return base64.b64decode(value)


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(payload, ttl):
    body = dict(payload, exp=now() + ttl)
    raw = _b64(dumps(body).encode())
    mac = _b64(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest())
    return f"{raw}.{mac}"


def verify(token, kind):
    try:
        raw, mac = token.split(".", 1)
        good = _b64(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(mac, good):
            return None
        body = json.loads(_unb64(raw))
    except Exception:
        return None
    if body.get("k") != kind or body.get("exp", 0) < now():
        return None
    return body


def check_password(given):
    want = os.environ.get("ADMIN_PASSWORD", "")
    if not want:
        return False
    return hmac.compare_digest(sha256(given or ""), sha256(want))


def verify_equal(a, b):
    return hmac.compare_digest(str(a), str(b))
