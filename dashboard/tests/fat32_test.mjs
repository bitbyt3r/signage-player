import { makeFat32 } from "../src/static/fat32.js";
import { openSync, writeSync, closeSync } from "node:fs";
const enc = new TextEncoder();
const files = [
  { name: "config.toml", data: enc.encode("[device]\nname = \"lobby\"\n".repeat(50)) },
  { name: "README.txt", data: enc.encode("hello\n") },
];
const size = Number(process.argv[3] || 256 * 2 ** 20);
const fs = makeFat32(size, files, { label: "SIGNCFG", hiddenSectors: 2048, volumeId: 0x1234abcd });
const fd = openSync(process.argv[2], "w");
const CH = 4 * 2 ** 20;
for (let off = 0; off < fs.size; off += CH) writeSync(fd, fs.read(off, Math.min(CH, fs.size - off)));
closeSync(fd);
