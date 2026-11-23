#!/usr/bin/env python3
"""Run the dashboard locally against moto (fake DynamoDB + S3), no AWS needed.

  pip install boto3 "moto[server,dynamodb,s3]"
  python3 scripts/dev_server.py            # http://127.0.0.1:8000, password "dev-password-123"

Devices can enroll with token "dev-enroll-token-0000". Point an agent at it
with SIGNAGE_AGENT_DRY_RUN=1 and a config.toml in SIGNAGE_STATE (see
tests/test_agent_e2e.py). The terminal relay (WebSocket API) isn't emulated.
"""

import argparse
import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--moto-port", type=int, default=5001)
    ap.add_argument("--fake-release", help="raw disk image to offer as release v0.0.1 on the Install images page")
    args = ap.parse_args()

    from moto.server import ThreadedMotoServer
    moto = ThreadedMotoServer(ip_address="127.0.0.1", port=args.moto_port)
    moto.start()
    os.environ.update({
        "AWS_ENDPOINT_URL": f"http://127.0.0.1:{args.moto_port}",
        "AWS_DEFAULT_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "dev", "AWS_SECRET_ACCESS_KEY": "dev",
        "TABLE": "signage-dev", "BUCKET": "signage-dev",
        "ADMIN_PASSWORD": os.environ.get("ADMIN_PASSWORD", "dev-password-123"),
        "ENROLL_TOKEN": os.environ.get("ENROLL_TOKEN", "dev-enroll-token-0000"),
        "WS_URL": "ws://127.0.0.1:9/unsupported-locally",
    })
    os.environ.pop("AWS_CA_BUNDLE", None)
    import boto3
    ddb = boto3.client("dynamodb")
    ddb.create_table(
        TableName="signage-dev", BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("pk", "sk", "kind")],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        GlobalSecondaryIndexes=[{"IndexName": "kind-index", "Projection": {"ProjectionType": "ALL"},
                                 "KeySchema": [{"AttributeName": "kind", "KeyType": "HASH"},
                                               {"AttributeName": "pk", "KeyType": "RANGE"}]}])
    s3 = boto3.client("s3")
    s3.create_bucket(Bucket="signage-dev")
    s3.put_bucket_cors(Bucket="signage-dev", CORSConfiguration={"CORSRules": [{
        "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedOrigins": ["*"], "AllowedHeaders": ["*"],
        "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"]}]})

    import app
    import common
    import mirror

    if args.fake_release:
        raw = Path(args.fake_release)
        key = f"images/v0.0.1/{raw.name}"
        s3.upload_file(str(raw), "signage-dev", key)
        with open(raw, "rb") as f:
            ss, parts = mirror.parse_gpt(f.read(1 << 20))
        cfg = next(p for p in parts if p["label"] == "SIGNCFG")
        import gzip
        import tempfile
        gz = {}
        with open(raw, "rb") as f, tempfile.TemporaryDirectory() as td:
            for which, lo, hi in (("head", 0, cfg["offset"]), ("tail", cfg["offset"] + cfg["size"], raw.stat().st_size)):
                out = Path(td, which)
                f.seek(lo)
                with gzip.open(out, "wb", compresslevel=6) as g:
                    left = hi - lo
                    while left:
                        b = f.read(min(left, 8 << 20))
                        g.write(b)
                        left -= len(b)
                s3.upload_file(str(out), "signage-dev", f"{key}.{which}.gz")
                gz[f"gz_{which}_key"] = f"{key}.{which}.gz"
                gz[f"gz_{which}_size"] = out.stat().st_size
        common.put({"pk": "RELEASE#v0.0.1", "sk": "META", "kind": "release", "data": common.dumps({
            "tag": "v0.0.1", "state": "ready", "key": key, "filename": raw.name, "size": raw.stat().st_size,
            "sector_size": ss, "config_offset": cfg["offset"], "config_size": cfg["size"], "partitions": parts, **gz})})
        app.GITHUB_REPO = "example/signage-player"
        app.github = lambda path: [{"tag_name": "v0.0.1", "name": "v0.0.1", "published_at": "2026-11-23T00:00:00Z",
                                    "assets": [{"name": "signage_0.0.1.raw.xz", "size": 123456789}]}]

    class Handler(BaseHTTPRequestHandler):
        def _go(self):
            u = urlsplit(self.path)
            n = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(n) if n else b""
            ev = {
                "rawPath": u.path,
                "queryStringParameters": {k: v[0] for k, v in parse_qs(u.query).items()} or None,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "requestContext": {"http": {"method": self.command, "sourceIp": self.client_address[0]},
                                   "domainName": self.headers.get("host", "")},
                "body": base64.b64encode(body).decode() if body else None,
                "isBase64Encoded": bool(body),
            }
            ev["headers"]["x-forwarded-proto"] = "http"
            r = app.handler(ev)
            out = r["body"].encode() if isinstance(r["body"], str) else r["body"]
            self.send_response(r["statusCode"])
            for k, v in r["headers"].items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _go

        def log_message(self, fmt, *a):
            if os.environ.get("DEV_QUIET") != "1":
                super().log_message(fmt, *a)

    print(f"dashboard on http://127.0.0.1:{args.port} (password {os.environ['ADMIN_PASSWORD']!r})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
