// Streams pre-configured images to disk as a normal browser download, for
// browsers without the File System Access API. The page feeds chunks over a
// MessagePort on demand, so only one chunk is in memory at a time.
const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "download") {
    pending.set(e.data.id, { ...e.data, port: e.ports[0] });
    e.ports[0].postMessage({ type: "registered" });
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === "/download/ping") {
    // The page pings while a download runs; each fetch keeps this worker alive.
    e.respondWith(new Response(null, { status: 204 }));
    return;
  }
  const m = url.pathname.match(/^\/download\/([\w-]+)\//);
  if (!m || !pending.has(m[1])) return;
  const d = pending.get(m[1]);
  pending.delete(m[1]);
  const stream = new ReadableStream(
    {
      pull(ctrl) {
        return new Promise((resolve) => {
          d.port.onmessage = (ev) => {
            const msg = ev.data;
            if (msg.error) ctrl.error(new Error(msg.error));
            else if (msg.done) ctrl.close();
            else ctrl.enqueue(new Uint8Array(msg.chunk));
            resolve();
          };
          d.port.postMessage({ type: "pull" });
        });
      },
      cancel() {
        d.port.postMessage({ type: "cancel" });
      },
    },
    { highWaterMark: 1 },
  );
  const filename = d.filename.replace(/[^\w.-]/g, "_");
  e.respondWith(
    new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(d.size),
      },
    }),
  );
});

// ---------------------------------------------------------------- program preview
// The program editor plays its draft in the real player (/static/player/) in
// an iframe whose URL carries ?preview=<id>. For that iframe this worker plays
// signage-web's part: /content.json is the editor's latest draft (posted here
// by the editor), /packages/<id>/<version>/<path> is unzipped from the
// package's zip in S3, /status/... are stand-ins, and /perf is dropped.

const sessions = new Map(); // preview id -> {content, layout, updated}
const zips = new Map();     // sha256 -> Promise<{buf, entries}>
const SESSION_CACHE = "signage-preview-sessions";
const ZIP_CACHE = "signage-preview-zips";

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "preview" && d.id) {
    const s = { content: d.content, layout: d.layout || "screen", outputs: d.outputs || null, updated: Date.now() };
    sessions.set(d.id, s);
    e.waitUntil(caches.open(SESSION_CACHE).then((c) => c.put(`/__preview/${d.id}`, new Response(JSON.stringify(s)))));
    for (const p of d.content?.packages || []) zipFor(p).catch(() => {}); // start downloads early
    e.ports[0]?.postMessage({ type: "ok" });
  } else if (d.type === "preview-end" && d.id) {
    sessions.delete(d.id);
    e.waitUntil(caches.open(SESSION_CACHE).then((c) => c.delete(`/__preview/${d.id}`)));
  }
});

async function session(id) {
  if (sessions.has(id)) return sessions.get(id);
  const r = await (await caches.open(SESSION_CACHE)).match(`/__preview/${id}`);
  if (!r) return null;
  const s = await r.json();
  sessions.set(id, s);
  return s;
}

async function previewId(e) {
  for (const cid of [e.clientId, e.resultingClientId]) {
    if (!cid) continue;
    const c = await self.clients.get(cid);
    const id = c && new URL(c.url).searchParams.get("preview");
    if (id) return id;
  }
  return null;
}

const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TYPES = { html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
  otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  txt: "text/plain", wasm: "application/wasm" };

// The zip's central directory: name -> {offset, csize, size, method}.
function readZip(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
    entries.set(name, { local, csize, size, method });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

function zipFor(pkg) {
  if (!zips.has(pkg.sha256)) {
    const key = `/__zip/${pkg.sha256}`;
    const p = (async () => {
      const cache = await caches.open(ZIP_CACHE);
      let r = await cache.match(key);
      if (!r) {
        const got = await fetch(pkg.url);
        if (!got.ok) throw new Error(`package ${pkg.id} ${pkg.version}: HTTP ${got.status}`);
        await cache.put(key, got.clone());
        r = got;
      }
      const buf = await r.arrayBuffer();
      return { buf, entries: readZip(buf) };
    })();
    p.catch(() => zips.delete(pkg.sha256));
    zips.set(pkg.sha256, p);
  }
  return zips.get(pkg.sha256);
}

async function unzipEntry(buf, ent) {
  const v = new DataView(buf);
  const start = ent.local + 30 + v.getUint16(ent.local + 26, true) + v.getUint16(ent.local + 28, true);
  const raw = new Uint8Array(buf, start, ent.csize);
  if (ent.method === 0) return raw;
  if (ent.method !== 8) throw new Error(`zip compression method ${ent.method} isn't supported`);
  return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

async function servePackage(s, id, version, path) {
  const pkg = (s?.content?.packages || []).find((p) => p.id === id && p.version === version)
    || [...sessions.values()].flatMap((x) => x.content?.packages || []).find((p) => p.id === id && p.version === version);
  if (!pkg) return new Response("package not in this preview", { status: 404 });
  const { buf, entries } = await zipFor(pkg);
  const ent = entries.get((pkg.root || "") + path);
  if (!ent) return new Response(`${path} is not in ${id} ${version}`, { status: 404 });
  const body = await unzipEntry(buf, ent);
  const ext = path.split(".").pop().toLowerCase();
  return new Response(body, { headers: { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache" } });
}

async function previewResponse(e, url) {
  const id = await previewId(e);
  const s = id ? await session(id) : null;
  const m = url.pathname.match(/^\/packages\/([^/]+)\/([^/]+)\/(.*)$/);
  if (m) return servePackage(s, decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3]));
  if (!id) return null;
  const p = url.pathname;
  if (p === "/content.json") return s ? json(s.content) : json({ error: "preview closed" }, 404);
  if (p === "/perf") return new Response(null, { status: 204 });
  if (p === "/status/display.json") {
    return json({ layout: s?.layout || "screen", ...(s?.outputs ? { span: s.outputs.map((o) => o.name) } : {}) });
  }
  if (p === "/status/status.json") {
    return json({ hostname: "Preview", version: "dashboard preview", addresses: "this browser",
      clock: new Date().toLocaleString(), config: "the program editor's unsaved program", display: s?.layout || "screen" });
  }
  if (p === "/status/agent.json") return json({ state: "connected", last_ok: Date.now(), last_attempt: Date.now() });
  if (p === "/status/update.json") return json({}); // no OS update running
  // [display] span: the monitors side by side; a 404 means one screen.
  if (p === "/status/outputs.json") return s?.outputs ? json(s.outputs) : new Response("", { status: 404 });
  if (p.startsWith("/status/")) return new Response("", { status: 404 });
  return null;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (!(p === "/content.json" || p === "/perf" || p.startsWith("/status/") || p.startsWith("/packages/"))) return;
  e.respondWith((async () => {
    try {
      return (await previewResponse(e, url)) || fetch(e.request);
    } catch (err) {
      return new Response(String(err?.message || err), { status: 500 });
    }
  })());
});
