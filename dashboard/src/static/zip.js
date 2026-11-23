// Just enough zip reading for the Packages page to open a bundle (a zip of
// OGraf package zips) in the browser and upload each package on its own.

export function listZip(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    out.push({ name: dec.decode(new Uint8Array(buf, p + 46, nlen)), method, csize, size, local });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

export async function readEntry(buf, e) {
  const v = new DataView(buf);
  if (v.getUint32(e.local, true) !== 0x04034b50) throw new Error(`bad zip entry ${e.name}`);
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const raw = new Uint8Array(buf, start, e.csize);
  if (e.method === 0) return raw.slice();
  if (e.method !== 8) throw new Error(`${e.name}: unsupported zip compression`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const junk = (n) => n.includes("__MACOSX/") || n.split("/").pop().startsWith("._");

// The package zips inside a bundle, or null when the zip is a package itself.
export function bundledZips(entries) {
  if (entries.some((e) => e.name.endsWith(".ograf.json") && !junk(e.name))) return null;
  const zips = entries.filter((e) => e.name.toLowerCase().endsWith(".zip") && !junk(e.name));
  return zips.length ? zips : null;
}
