#!/usr/bin/env node
// Generates icons/*.png and icons/*.svg from src/shared/icon-raster.js.
// Node built-ins only (zlib for PNG). Usage:
//   node tools/make-icons.mjs           write all icons
//   node tools/make-icons.mjs --ascii   also print a 16px and 32px preview

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { rasterizeIcon, iconSvg, ICON_COLORS } from '../src/shared/icon-raster.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ascii(size) {
  const px = rasterizeIcon(size, '#000000');
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let y = 0; y < size; y++) {
    let line = '';
    for (let x = 0; x < size; x++) line += ramp[Math.round((px[(y * size + x) * 4 + 3] / 255) * (ramp.length - 1))].repeat(2);
    lines.push(line);
  }
  return lines.join('\n');
}

const written = [];
for (const [variant, color] of Object.entries(ICON_COLORS)) {
  for (const size of [16, 32, 48, 128]) {
    const file = join(outDir, `${variant}-${size}.png`);
    writeFileSync(file, encodePng(size, rasterizeIcon(size, color)));
    written.push(`${variant}-${size}.png`);
  }
  writeFileSync(join(outDir, `${variant}.svg`), iconSvg(color));
  written.push(`${variant}.svg`);
}
console.log(`icons written to ${outDir}:\n  ${written.join('\n  ')}`);
if (process.argv.includes('--ascii')) {
  console.log('\n16px:\n' + ascii(16));
  console.log('\n32px:\n' + ascii(32));
}
