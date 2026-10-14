// Packs the Chrome recorder for the Chrome Web Store: makes its icons (the brand's blue square with a white mark) and
// zips extension/ into dist/claritia-recorder.zip.
//   node scripts/pack-extension.ts

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { zipSync } from "fflate";

const dir = new URL("../extension/", import.meta.url);

/** A square PNG: brand blue, with a white square mark in the middle (like the app's logo dot). */
function icon(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inner = [Math.round(size * 0.34), Math.round(size * 0.66)];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const white = x >= inner[0]! && x < inner[1]! && y >= inner[0]! && y < inner[1]!;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]] = white ? [255, 255, 255, 255] : [0x26, 0x6d, 0xf0, 255];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

await mkdir(new URL("icons/", dir), { recursive: true });
for (const s of [16, 48, 128]) await writeFile(new URL(`icons/${s}.png`, dir), icon(s));

const files: Record<string, Uint8Array> = {};
for (const name of await readdir(dir, { recursive: true })) {
  const path = String(name);
  if (!/\.(js|json|html|css|png)$/.test(path)) continue;
  files[path] = await readFile(new URL(path, dir));
}
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/claritia-recorder.zip", import.meta.url), zipSync(files, { level: 9 }));
console.log(`dist/claritia-recorder.zip: ${Object.keys(files).sort().join(", ")}`);
