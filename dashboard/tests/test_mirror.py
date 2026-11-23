"""Mirror job: streams an .xz release asset into S3 and finds SIGNCFG."""

import hashlib
import io
import json
import lzma
import os
import shutil
import subprocess

import boto3
import pytest

from test_api import aws  # noqa: F401  (fixture)
import common
import mirror


@pytest.mark.skipif(not shutil.which("sfdisk"), reason="needs sfdisk")
def test_mirror_streams_xz_to_s3(aws, tmp_path, monkeypatch):  # noqa: F811
    disk = tmp_path / "signage_0.1.raw"
    with open(disk, "wb") as f:
        f.truncate(48 << 20)
    subprocess.run(["sfdisk", "-q", str(disk)], check=True, text=True, input=(
        "label: gpt\n"
        "start=2048, size=8M, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name=\"esp\"\n"
        "size=8M, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=\"root\"\n"
        "size=20M, type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name=\"SIGNCFG\"\n"))
    with open(disk, "r+b") as f:
        f.seek(2 << 20)
        f.write(os.urandom(6 << 20))
    raw = disk.read_bytes()
    xz = lzma.compress(raw, preset=0)

    release = {"assets": [
        {"name": "signage_0.1.usr-x86-64.raw.zst", "url": "u1", "size": 1},
        {"name": "signage_0.1.raw.xz", "url": "https://api.github.com/assets/2", "size": len(xz)}]}

    def fake_urlopen(req, timeout=None):
        url = req.full_url
        if url.endswith("/releases/tags/v0.1"):
            return io.BytesIO(json.dumps(release).encode())
        raise AssertionError(url)

    monkeypatch.setattr(mirror.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(mirror, "open_asset", lambda url: io.BytesIO(xz) if url.endswith("/assets/2") else None)
    monkeypatch.setattr(mirror, "PART", 5 << 20)
    monkeypatch.setattr(mirror, "GITHUB_REPO", "example/signage")
    st = mirror.handler({"tag": "v0.1"})
    assert st["state"] == "ready" and st["size"] == len(raw)
    assert st["config_offset"] == (2048 * 512 + (16 << 20)) and st["config_size"] == 20 << 20
    body = boto3.client("s3").get_object(Bucket="signage-test", Key=st["key"])["Body"].read()
    assert hashlib.sha256(body).digest() == hashlib.sha256(raw).digest()
    assert json.loads(common.get("RELEASE#v0.1")["data"])["state"] == "ready"
    # head.gz + gzip(config partition) + tail.gz is a multi-member gzip of the whole image.
    import gzip
    get = lambda k: boto3.client("s3").get_object(Bucket="signage-test", Key=k)["Body"].read()  # noqa: E731
    head, tail = get(st["gz_head_key"]), get(st["gz_tail_key"])
    assert len(head) == st["gz_head_size"] and len(tail) == st["gz_tail_size"]
    lo, hi = st["config_offset"], st["config_offset"] + st["config_size"]
    assert gzip.decompress(head) == raw[:lo] and gzip.decompress(tail) == raw[hi:]
    whole = head + gzip.compress(raw[lo:hi]) + tail
    assert gzip.decompress(whole) == raw
    assert len(whole) < len(raw) // 3


def test_asset_redirect_drops_auth(monkeypatch):
    """GitHub redirects asset downloads to signed storage URLs that reject a
    second Authorization header."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    seen = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get("Authorization"), self.headers.get("Accept")))
            if self.path == "/asset":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{srv.server_port}/blob?sig=x")
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"DATA")

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(mirror, "GITHUB_TOKEN", "secret")
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("http_proxy", raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    with mirror.open_asset(f"http://127.0.0.1:{srv.server_port}/asset") as r:
        assert r.read() == b"DATA"
    srv.shutdown()
    assert seen[0] == ("/asset", "Bearer secret", "application/octet-stream")
    assert seen[1][0] == "/blob?sig=x" and seen[1][1] is None
