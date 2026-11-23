// Builds a FAT32 filesystem image lazily: nothing is allocated for the
// (mostly zero) data area, so a 256 MiB partition costs a few MiB of RAM.
//
//   const fs = makeFat32(256 * 2 ** 20, [{name: "config.toml", data: bytes}],
//                        {label: "SIGNCFG", hiddenSectors: lba});
//   fs.read(offset, length) -> Uint8Array

const SS = 512;

function shortName(name, n) {
  const dot = name.lastIndexOf(".");
  let base = (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  let ext = (dot > 0 ? name.slice(dot + 1) : "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const fits = base.length <= 8 && ext.length <= 3 && name.toUpperCase() === (ext ? `${base}.${ext}` : base);
  // Pure-case names fit in an 8.3 entry, with the NT "lower case" flags.
  const lowerBase = dot > 0 ? name.slice(0, dot) : name;
  const lowerExt = dot > 0 ? name.slice(dot + 1) : "";
  const caseOk = (s) => s === s.toUpperCase() || s === s.toLowerCase();
  if (fits && caseOk(lowerBase) && caseOk(lowerExt)) {
    let flags = 0;
    if (lowerBase && lowerBase === lowerBase.toLowerCase() && lowerBase !== lowerBase.toUpperCase()) flags |= 0x08;
    if (lowerExt && lowerExt === lowerExt.toLowerCase() && lowerExt !== lowerExt.toUpperCase()) flags |= 0x10;
    return { short: base.padEnd(8) + ext.padEnd(3), lfn: false, flags };
  }
  base = base.slice(0, 6) + "~" + n;
  return { short: base.padEnd(8) + ext.slice(0, 3).padEnd(3), lfn: true, flags: 0 };
}

function lfnChecksum(short) {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + short.charCodeAt(i)) & 0xff;
  return sum;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function dirEntries(name, short, attr, cluster, size, flags, lfn, when) {
  const out = [];
  if (lfn) {
    const units = [];
    for (const ch of name) units.push(ch.charCodeAt(0));
    units.push(0);
    while (units.length % 13) units.push(0xffff);
    const count = units.length / 13;
    const sum = lfnChecksum(short);
    for (let i = count; i >= 1; i--) {
      const e = new Uint8Array(32);
      const v = new DataView(e.buffer);
      e[0] = i | (i === count ? 0x40 : 0);
      e[11] = 0x0f;
      e[13] = sum;
      const u = units.slice((i - 1) * 13, i * 13);
      const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
      pos.forEach((p, k) => v.setUint16(p, u[k], true));
      out.push(e);
    }
  }
  const e = new Uint8Array(32);
  const v = new DataView(e.buffer);
  for (let i = 0; i < 11; i++) e[i] = short.charCodeAt(i);
  e[11] = attr;
  e[12] = flags;
  const { time, date } = dosDateTime(when);
  v.setUint16(14, time, true);
  v.setUint16(16, date, true);
  v.setUint16(18, date, true);
  v.setUint16(20, cluster >>> 16, true);
  v.setUint16(22, time, true);
  v.setUint16(24, date, true);
  v.setUint16(26, cluster & 0xffff, true);
  v.setUint32(28, size, true);
  out.push(e);
  return out;
}

export function makeFat32(size, files, opts = {}) {
  const label = (opts.label || "NO NAME").toUpperCase().slice(0, 11).padEnd(11);
  const when = opts.date || new Date();
  const totalSectors = Math.floor(size / SS);
  const reserved = 32;
  const spc = opts.sectorsPerCluster || (totalSectors >= 2 * 1024 * 1024 ? 8 : 1);
  // FAT size: solve for the number of clusters that fit next to two FATs.
  let fatSectors = 1;
  for (;;) {
    const clusters = Math.floor((totalSectors - reserved - 2 * fatSectors) / spc);
    const need = Math.ceil(((clusters + 2) * 4) / SS);
    if (need <= fatSectors) break;
    fatSectors = need;
  }
  const dataStart = reserved + 2 * fatSectors;
  const clusters = Math.floor((totalSectors - dataStart) / spc);
  if (clusters < 65525) throw new Error("partition too small for FAT32");
  const clusterBytes = spc * SS;

  // Lay out the root directory and files.
  const sectors = new Map(); // sector number -> Uint8Array(512)
  const fat = [0x0ffffff8, 0x0fffffff];
  let next = 2;
  const alloc = (bytes) => {
    const n = Math.max(1, Math.ceil(bytes / clusterBytes));
    const first = next;
    for (let i = 0; i < n; i++) fat[next + i] = i === n - 1 ? 0x0fffffff : next + i + 1;
    next += n;
    return first;
  };
  const putData = (cluster, bytes) => {
    const base = dataStart + (cluster - 2) * spc;
    for (let off = 0; off < bytes.length; off += SS) {
      const s = new Uint8Array(SS);
      s.set(bytes.subarray(off, off + SS));
      sectors.set(base + off / SS, s);
    }
  };

  const entries = [];
  {
    const e = new Uint8Array(32);
    for (let i = 0; i < 11; i++) e[i] = label.charCodeAt(i);
    e[11] = 0x08;
    entries.push(e);
  }
  const placed = files.map((f, i) => {
    const sn = shortName(f.name, i + 1);
    return { ...f, ...sn };
  });
  // Root directory size first, so file clusters come after it.
  let rootEntries = 1;
  for (const f of placed) rootEntries += 1 + (f.lfn ? Math.ceil((f.name.length + 1) / 13) : 0);
  const rootBytes = Math.ceil((rootEntries * 32) / clusterBytes) * clusterBytes;
  const rootCluster = alloc(rootBytes);
  for (const f of placed) {
    const first = f.data.length ? alloc(f.data.length) : 0;
    if (first) putData(first, f.data);
    entries.push(...dirEntries(f.name, f.short, 0x20, first, f.data.length, f.flags, f.lfn, when));
  }
  const root = new Uint8Array(rootBytes);
  entries.forEach((e, i) => root.set(e, i * 32));
  putData(rootCluster, root);

  // FAT copies.
  const fatBytes = new Uint8Array(Math.ceil((fat.length * 4) / SS) * SS);
  const fv = new DataView(fatBytes.buffer);
  fat.forEach((v, i) => fv.setUint32(i * 4, v, true));
  for (let copy = 0; copy < 2; copy++) {
    for (let off = 0; off < fatBytes.length; off += SS) {
      sectors.set(reserved + copy * fatSectors + off / SS, fatBytes.slice(off, off + SS));
    }
  }

  // Boot sector, FSInfo and their backups.
  const boot = new Uint8Array(SS);
  const bv = new DataView(boot.buffer);
  boot.set([0xeb, 0x58, 0x90]);
  "MSWIN4.1".split("").forEach((ch, i) => (boot[3 + i] = ch.charCodeAt(0)));
  bv.setUint16(11, SS, true);
  boot[13] = spc;
  bv.setUint16(14, reserved, true);
  boot[16] = 2;
  boot[21] = 0xf8;
  bv.setUint16(24, 63, true);
  bv.setUint16(26, 255, true);
  bv.setUint32(28, opts.hiddenSectors || 0, true);
  bv.setUint32(32, totalSectors, true);
  bv.setUint32(36, fatSectors, true);
  bv.setUint32(44, rootCluster, true);
  bv.setUint16(48, 1, true);
  bv.setUint16(50, 6, true);
  boot[64] = 0x80;
  boot[66] = 0x29;
  bv.setUint32(67, opts.volumeId ?? (Math.random() * 0xffffffff) >>> 0, true);
  for (let i = 0; i < 11; i++) boot[71 + i] = label.charCodeAt(i);
  "FAT32   ".split("").forEach((ch, i) => (boot[82 + i] = ch.charCodeAt(0)));
  boot[510] = 0x55;
  boot[511] = 0xaa;
  const fsinfo = new Uint8Array(SS);
  const iv = new DataView(fsinfo.buffer);
  iv.setUint32(0, 0x41615252, true);
  iv.setUint32(484, 0x61417272, true);
  iv.setUint32(488, clusters - (next - 2), true);
  iv.setUint32(492, next, true);
  iv.setUint32(508, 0xaa550000, true);
  sectors.set(0, boot);
  sectors.set(1, fsinfo);
  sectors.set(6, boot);
  sectors.set(7, fsinfo);
  // Sector 2 (and its backup, 8) carry only the boot signature.
  const s2 = new Uint8Array(SS);
  s2[510] = 0x55;
  s2[511] = 0xaa;
  sectors.set(2, s2);
  sectors.set(8, s2);

  return {
    size: totalSectors * SS,
    read(offset, length) {
      const out = new Uint8Array(length);
      const first = Math.floor(offset / SS);
      const last = Math.floor((offset + length - 1) / SS);
      for (let s = first; s <= last; s++) {
        const sec = sectors.get(s);
        if (!sec) continue;
        const secStart = s * SS;
        const from = Math.max(offset, secStart);
        const to = Math.min(offset + length, secStart + SS);
        out.set(sec.subarray(from - secStart, to - secStart), from - offset);
      }
      return out;
    },
  };
}
