#!/usr/bin/env python3
"""Signal bridge and web server for the Pearl panel-room page.

The Pearl's REST API wants a password and refuses cross-origin preflight
requests, so a page running in the Pearl's Web Graphics input can't ask it
directly whether video is coming in. This polls the Pearl once a second and
answers GET /status with {"video": true|false|null, ...} (CORS open, no
password), and serves the page itself:

    /            pearl/ (index.html, room.mjs)
    /packages/   the repo's git-ignored packages/ folder (theme art)
    /status      the signal state

Read-only: it only ever GETs /api/v2.0/inputs/<input>/status.

    PEARL_PASS=... python3 pearl/pearl-bridge.py --pearl 10.1.29.127 --port 8099

then point the Pearl's Web Graphics input at
    http://<this machine>:8099/?room=Panels%201&status=/status
"""

import argparse
import base64
import functools
import http.server
import json
import os
import pathlib
import threading
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
PACKAGES = (HERE.parent / "packages").resolve()


def has_video(status):
    """Mirror of pearlHasVideo() in room.mjs. Pearl Mini 4.24 reports an
    unplugged HDMI input as state "active" at 0x0, so look at the size."""
    v = (status or {}).get("video")
    if not v:
        return None
    if v.get("state") and v["state"] != "active":
        return False
    try:
        w, h = (int(x) for x in str(v.get("resolution") or "0x0").split("x"))
    except ValueError:
        return None
    return w > 0 and h > 0


class Poller(threading.Thread):
    def __init__(self, pearl, user, password, input_id, interval):
        super().__init__(daemon=True)
        self.url = f"http://{pearl}/api/v2.0/inputs/{input_id}/status"
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.input_id, self.interval = input_id, interval
        self.lock = threading.Lock()
        self.state = {"video": None, "input": input_id, "error": "starting", "at": 0}

    def run(self):
        while True:
            try:
                req = urllib.request.Request(self.url, headers={"Authorization": self.auth})
                with urllib.request.urlopen(req, timeout=3) as r:
                    body = json.load(r)
                res = body.get("result") or {}
                video = res.get("video") or {}
                new = {"video": has_video(res), "input": self.input_id, "resolution": video.get("resolution"),
                       "fps": video.get("actual_fps"), "error": "", "at": time.time()}
            except Exception as e:  # noqa: BLE001 - report anything to the page
                new = {"video": None, "input": self.input_id, "error": str(e), "at": time.time()}
            with self.lock:
                if new["video"] != self.state.get("video"):
                    print(f"[bridge] {self.input_id}: video {self.state.get('video')} -> {new['video']}"
                          f" {new.get('resolution') or new['error']}", flush=True)
                self.state = new
            time.sleep(self.interval)

    def get(self):
        with self.lock:
            return dict(self.state)


class Handler(http.server.SimpleHTTPRequestHandler):
    poller = None

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/packages/"):
            rel = clean[len("/packages/"):]
            target = (PACKAGES / urllib.request.url2pathname(rel)).resolve()
            return str(target) if target.is_relative_to(PACKAGES) else str(PACKAGES / "__nope__")
        return super().translate_path(path)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/status":
            body = json.dumps(self.poller.get()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if "/status" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pearl", required=True, help="Pearl address, e.g. 10.1.29.127")
    ap.add_argument("--user", default=os.environ.get("PEARL_USER", "admin"))
    ap.add_argument("--input", default="hdmi-a", help="input to watch (default hdmi-a)")
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--port", type=int, default=8099)
    a = ap.parse_args()
    password = os.environ.get("PEARL_PASS")
    if password is None:
        ap.error("set PEARL_PASS in the environment")
    Handler.poller = Poller(a.pearl, a.user, password, a.input, a.interval)
    Handler.poller.start()
    srv = http.server.ThreadingHTTPServer(("", a.port), functools.partial(Handler, directory=str(HERE)))
    print(f"[bridge] serving {HERE} on :{a.port}, watching {a.input} on {a.pearl}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
