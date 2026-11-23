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
