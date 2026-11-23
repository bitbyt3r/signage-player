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


def mirror(tag):
    with urllib.request.urlopen(gh_request(f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}"),
                                timeout=20) as r:
        release = json.loads(r.read())
    asset = next((a for a in release.get("assets", [])
                  if re.fullmatch(r"signage_[^/]+\.raw\.xz", a["name"]) and ".usr" not in a["name"]), None)
    if not asset:
        raise ValueError("release has no signage_<version>.raw.xz asset")
    name = asset["name"][:-3]
    key = f"images/{tag}/{name}"
    set_state(tag, state="copying", asset=asset["name"], xz_size=asset["size"], copied=0)

    s3 = c.s3()
    mp = s3.create_multipart_upload(Bucket=c.BUCKET, Key=key, ContentType="application/octet-stream")
    parts, buf, total, head, layout = [], bytearray(), 0, bytearray(), None
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
    last_report = 0
    try:
        # The asset API URL redirects to a short-lived download URL.
        with open_asset(asset["url"]) as r:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                # Bound the decompressor's output so a part never grows far past PART.
                data = dec.decompress(chunk, max_length=PART)
                while True:
                    if layout is None and len(head) < 1024 * 1024:
                        head += data[:1024 * 1024 - len(head)]
                        if len(head) >= 1024 * 1024:
                            layout = parse_gpt(bytes(head))
                    buf += data
                    total += len(data)
                    while len(buf) >= PART:
                        n = len(parts) + 1
                        e = s3.upload_part(Bucket=c.BUCKET, Key=key, UploadId=mp["UploadId"],
                                           PartNumber=n, Body=bytes(buf[:PART]))
                        parts.append({"PartNumber": n, "ETag": e["ETag"]})
                        del buf[:PART]
                    if dec.eof or dec.needs_input:
                        break
                    data = dec.decompress(b"", max_length=PART)
                if total - last_report > 256 * 1024 * 1024:
                    last_report = total
                    set_state(tag, copied=total)
        if not dec.eof:
            raise ValueError("the .xz download ended early")
        if buf or not parts:
            n = len(parts) + 1
            e = s3.upload_part(Bucket=c.BUCKET, Key=key, UploadId=mp["UploadId"], PartNumber=n, Body=bytes(buf))
            parts.append({"PartNumber": n, "ETag": e["ETag"]})
        s3.complete_multipart_upload(Bucket=c.BUCKET, Key=key, UploadId=mp["UploadId"],
                                     MultipartUpload={"Parts": parts})
    except Exception:
        s3.abort_multipart_upload(Bucket=c.BUCKET, Key=key, UploadId=mp["UploadId"])
        raise

    if layout is None:
        layout = parse_gpt(bytes(head))
    ss, gpt = layout
    cfg = next((p for p in gpt if p["label"] == "SIGNCFG"), None) \
        or next((p for p in gpt if p["type"] == CONFIG_TYPE), None)
    if not cfg:
        raise ValueError("no SIGNCFG partition in the image")
    return set_state(tag, state="ready", key=key, filename=name, size=total, sector_size=ss,
                     config_offset=cfg["offset"], config_size=cfg["size"], partitions=gpt, copied=total)
