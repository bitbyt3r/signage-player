// Builds a pre-configured install image in the browser: the release's raw
// image is streamed from S3 in byte ranges, and the SIGNCFG partition is
// swapped for a freshly made FAT32 filesystem holding config.toml. Output
// goes straight to disk, so memory use stays at about one chunk.
import { makeFat32 } from "./fat32.js";

const CHUNK = 4 * 2 ** 20;

async function* remote(url, from, to, signal) {
  let pos = from;
  let tries = 0;
  while (pos < to) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${pos}-${to - 1}` }, signal });
      if (r.status !== 206) throw new Error(`image download failed (${r.status})`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pos += value.length;
        tries = 0;
        yield value;
      }
      if (pos < to) throw new Error("connection closed early");
    } catch (e) {
      if (signal?.aborted || ++tries > 5) throw e;
      await new Promise((res) => setTimeout(res, 1000 * tries));
    }
  }
}

// Re-chunk into CHUNK-sized pieces so writes and messages stay efficient.
async function* rechunk(src) {
  let buf = new Uint8Array(CHUNK);
  let n = 0;
  for await (const piece of src) {
    let off = 0;
    while (off < piece.length) {
      const take = Math.min(CHUNK - n, piece.length - off);
      buf.set(piece.subarray(off, off + take), n);
      n += take;
      off += take;
      if (n === CHUNK) {
        yield buf;
        buf = new Uint8Array(CHUNK);
        n = 0;
      }
    }
  }
  if (n) yield buf.subarray(0, n);
}

export async function* imageStream({ url, size, configOffset, configSize, files, signal }) {
  const fs = makeFat32(configSize, files, { label: "SIGNCFG", hiddenSectors: configOffset / 512 });
  if (fs.size !== configSize) throw new Error("config partition size is not a whole number of sectors");
  yield* rechunk(remote(url, 0, configOffset, signal));
  for (let off = 0; off < configSize; off += CHUNK) yield fs.read(off, Math.min(CHUNK, configSize - off));
  yield* rechunk(remote(url, configOffset + configSize, size, signal));
}

// Save with the File System Access API (Chrome, Edge) or a service-worker
// download (Firefox, Safari).
export async function saveStream(filename, size, gen, onProgress) {
  let written = 0;
  const progress = (n) => {
    written += n;
    onProgress?.(written, size);
  };
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: filename });
    const w = await handle.createWritable();
    try {
      for await (const chunk of gen) {
        await w.write(chunk);
        progress(chunk.length);
      }
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
    return;
  }
  if (!navigator.serviceWorker) throw new Error("this browser can't stream downloads; use Chrome or Firefox");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sw = reg.active || navigator.serviceWorker.controller;
  const id = Math.random().toString(36).slice(2);
  const chan = new MessageChannel();
  await new Promise((res) => {
    chan.port1.onmessage = (e) => e.data.type === "registered" && res();
    sw.postMessage({ type: "download", id, filename, size }, [chan.port2]);
  });
  const ping = setInterval(() => fetch("/download/ping").catch(() => {}), 10000);
  return new Promise((resolve, reject) => {
    const it = gen[Symbol.asyncIterator]();
    chan.port1.onmessage = async (e) => {
      if (e.data.type === "cancel") {
        clearInterval(ping);
        it.return?.();
        reject(new Error("download cancelled"));
        return;
      }
      try {
        const { done, value } = await it.next();
        if (done) {
          chan.port1.postMessage({ done: true });
          clearInterval(ping);
          resolve();
        } else {
          const copy = value.slice().buffer;
          chan.port1.postMessage({ chunk: copy }, [copy]);
          progress(value.length);
        }
      } catch (err) {
        chan.port1.postMessage({ error: String(err.message || err) });
        clearInterval(ping);
        reject(err);
      }
    };
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = `/download/${id}/${encodeURIComponent(filename)}`;
    document.body.appendChild(iframe);
  });
}
