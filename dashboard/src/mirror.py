"""Copy a release's install-stick image from GitHub into the dashboard bucket.

Runs as its own Lambda (invoked asynchronously by the API). Streams the
signage_<v>.raw.xz asset, decompresses it on the fly and writes the raw
image to S3 with a multipart upload, so memory use stays at one part
(64 MiB) no matter how large the image is. While it streams, it reads the
GPT to find the SIGNCFG partition, which is what the browser replaces when
it builds a pre-configured image.

The raw image (not the .xz) is stored because the browser needs byte ranges
of it, and S3 serves those with the CORS headers GitHub's downloads lack.
"""

import json
import lzma
import os
import re
import struct
import traceback
import urllib.error
import urllib.request
import uuid
import zlib

import common as c

GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
PART = 64 * 1024 * 1024
CHUNK = 1024 * 1024
CONFIG_TYPE = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"


def gh_request(url, accept="application/vnd.github+json"):
    h = {"Accept": accept, "User-Agent": "signage-dashboard"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return urllib.request.Request(url, headers=h)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def open_asset(url):
    """Download a release asset. The API answers with a redirect to a signed
    storage URL, which must be fetched *without* our Authorization header
    (urllib would forward it, and the storage host rejects that)."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        return opener.open(gh_request(url, "application/octet-stream"), timeout=60)
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        loc = e.headers["Location"]
    return urllib.request.urlopen(urllib.request.Request(loc, headers={"User-Agent": "signage-dashboard"}), timeout=60)


def guid(b):
    return str(uuid.UUID(bytes_le=bytes(b)))


def parse_gpt(head):
    """Return (sector size, partitions) from the first bytes of a disk."""
    for ss in (512, 4096):
        hdr = head[ss:ss + 92]
        if hdr[:8] == b"EFI PART":
            break
    else:
        raise ValueError("no GPT header in the image")
    entries_lba, count, size = struct.unpack_from("<QII", hdr, 72)
    parts = []
    for i in range(count):
        off = entries_lba * ss + i * size
        e = head[off:off + size]
        if len(e) < 128:
            raise ValueError("GPT entries beyond the bytes read")
        if e[:16] == b"\0" * 16:
            continue
        first, last = struct.unpack_from("<QQ", e, 32)
        name = e[56:128].decode("utf-16-le").rstrip("\0")
        parts.append({"type": guid(e[:16]), "uuid": guid(e[16:32]), "label": name,
                      "offset": first * ss, "size": (last - first + 1) * ss})
    return ss, parts


def set_state(tag, **kw):
    item = c.get(f"RELEASE#{tag}")
    st = c.loads(item["data"]) if item else {"tag": tag}
    st.update(kw, updated=c.now())
    c.put({"pk": f"RELEASE#{tag}", "sk": "META", "kind": "release", "data": c.dumps(st)})
    return st


def handler(event, context=None):
    tag = event["tag"]
    try:
        return mirror(tag)
    except Exception as e:
        traceback.print_exc()
        set_state(tag, state="failed", error=str(e)[:500])
        raise


class Upload:
    """Streams bytes into one S3 object with a multipart upload."""

    def __init__(self, key, ctype):
        self.s3, self.key = c.s3(), key
        self.id = self.s3.create_multipart_upload(Bucket=c.BUCKET, Key=key, ContentType=ctype)["UploadId"]
        self.parts, self.buf, self.size = [], bytearray(), 0

    def _part(self, body):
        n = len(self.parts) + 1
        e = self.s3.upload_part(Bucket=c.BUCKET, Key=self.key, UploadId=self.id, PartNumber=n, Body=body)
        self.parts.append({"PartNumber": n, "ETag": e["ETag"]})

    def write(self, data):
        self.buf += data
        self.size += len(data)
        while len(self.buf) >= PART:
            self._part(bytes(self.buf[:PART]))
            del self.buf[:PART]

    def close(self):
        if self.buf or not self.parts:
            self._part(bytes(self.buf))
        self.s3.complete_multipart_upload(Bucket=c.BUCKET, Key=self.key, UploadId=self.id,
                                          MultipartUpload={"Parts": self.parts})
        return self.size

    def abort(self):
        try:
            self.s3.abort_multipart_upload(Bucket=c.BUCKET, Key=self.key, UploadId=self.id)
        except Exception:
            pass


def config_partition(gpt):
    return next((p for p in gpt if p["label"] == "SIGNCFG"), None) \
        or next((p for p in gpt if p["type"] == CONFIG_TYPE), None)


def mirror(tag):
    """Stores three objects: the raw image, and gzip members of everything
    before and after the SIGNCFG partition. The browser builds a compressed
    pre-configured image by concatenating head.gz + gzip(new FAT32) + tail.gz,
    which is a valid multi-member gzip file."""
    with urllib.request.urlopen(gh_request(f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}"),
                                timeout=20) as r:
        release = json.loads(r.read())
    asset = next((a for a in release.get("assets", [])
                  if re.fullmatch(r"signage_[^/]+\.raw\.xz", a["name"]) and ".usr" not in a["name"]), None)
    if not asset:
        raise ValueError("release has no signage_<version>.raw.xz asset")
    name = asset["name"][:-3]
    base = f"images/{tag}/{name}"
    set_state(tag, state="copying", asset=asset["name"], xz_size=asset["size"], copied=0)

    raw = Upload(base, "application/octet-stream")
    uploads = [raw]
    st = {"pos": 0, "layout": None, "cfg": None, "pre": bytearray()}
    zh = zlib.compressobj(6, zlib.DEFLATED, 31)
    zt = zlib.compressobj(6, zlib.DEFLATED, 31)

    def start(head_bytes):
        st["layout"] = parse_gpt(bytes(head_bytes))
        st["cfg"] = config_partition(st["layout"][1])
        if not st["cfg"]:
            raise ValueError("no SIGNCFG partition in the image")
        st["head"] = Upload(f"{base}.head.gz", "application/gzip")
        st["tail"] = Upload(f"{base}.tail.gz", "application/gzip")
        uploads.extend([st["head"], st["tail"]])

    def feed(data):
        cfg = st["cfg"]
        lo, hi = cfg["offset"], cfg["offset"] + cfg["size"]
        a = st["pos"]
        b = a + len(data)
        if a < lo:
            st["head"].write(zh.compress(data[:min(b, lo) - a]))
        if b > hi:
            st["tail"].write(zt.compress(data[max(a, hi) - a:]))
        st["pos"] = b

    def take(data):
        raw.write(data)
        if st["layout"] is None:
            st["pre"] += data
            if len(st["pre"]) < 1024 * 1024:
                return
            start(st["pre"])
            data, st["pre"] = bytes(st["pre"]), bytearray()
        feed(data)

    dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
    last_report = 0
    try:
        with open_asset(asset["url"]) as r:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                # Bound the decompressor's output so buffers never grow far past PART.
                data = dec.decompress(chunk, max_length=PART)
                while True:
                    take(data)
                    if dec.eof or dec.needs_input:
                        break
                    data = dec.decompress(b"", max_length=PART)
                if raw.size - last_report > 256 * 1024 * 1024:
                    last_report = raw.size
                    set_state(tag, copied=raw.size)
        if not dec.eof:
            raise ValueError("the .xz download ended early")
        if st["layout"] is None:
            start(st["pre"])
            feed(bytes(st["pre"]))
        st["head"].write(zh.flush())
        st["tail"].write(zt.flush())
        total = raw.close()
        head_size = st["head"].close()
        tail_size = st["tail"].close()
    except Exception:
        for u in uploads:
            u.abort()
        raise

    ss, gpt = st["layout"]
    cfg = st["cfg"]
    return set_state(tag, state="ready", key=base, filename=name, size=total, sector_size=ss,
                     config_offset=cfg["offset"], config_size=cfg["size"], partitions=gpt, copied=total,
                     gz_head_key=f"{base}.head.gz", gz_head_size=head_size,
                     gz_tail_key=f"{base}.tail.gz", gz_tail_size=tail_size)
