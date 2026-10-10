#!/usr/bin/env node
// Procedurally draws the Pevqori app icon and writes:
//   build/icon.png  512×512 RGBA PNG (electron-builder / Linux / docs)
//   build/icon.ico  Windows icon: 16–128 px as 32-bit BMP entries + 256 px as an embedded PNG
// Design: rounded square with an indigo → deep-blue diagonal gradient, a faint ledger page with a
// margin rule, and a white ₹ glyph built from simple shapes (bars, half-ring bowl, diagonal leg).
// Uses only node:* modules (zlib for PNG deflate; CRC32 implemented here).
//
//   node scripts/make-icon.mjs              (re)generate both files
//   node scripts/make-icon.mjs --if-missing only when one is missing (CI; keeps a hand-made icon)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');

// ───────────────────────────── geometry (512-unit design grid) ─────────────────────────────

const BG = { x0: 16, y0: 16, x1: 496, y1: 496, r: 112 };
const PAGE = { x0: 108, y0: 92, x1: 404, y1: 420, r: 30 };
const RULE = { x0: 146, y0: 92, x1: 154, y1: 420 }; // ledger margin line
const STOPS = [
  [0, [99, 102, 241]], // indigo-500 #6366F1
  [0.55, [67, 56, 202]], // indigo-700 #4338CA
  [1, [30, 58, 138]], // blue-900  #1E3A8A
];

// ₹ glyph, offset so its optical centre sits on the canvas centre.
const GX = -6;
const GY = -16;
const STROKE = 32;
const BAR_TOP = { x0: 178 + GX, y0: 128 + GY, x1: 354 + GX, y1: 128 + STROKE + GY };
const BAR_MID = { x0: 178 + GX, y0: 200 + GY, x1: 354 + GX, y1: 200 + STROKE + GY };
const BOWL = { cx: 236 + GX, cy: 212 + GY, R: 84, r: 84 - STROKE };
const BOWL_FOOT = { x0: 178 + GX, y0: 212 + 84 - STROKE + GY, x1: 236 + GX, y1: 212 + 84 + GY };
const LEG = { ax: 206 + GX, ay: 282 + GY, bx: 344 + GX, by: 404 + GY, hw: 18 };

function inRect(x, y, b) {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

function inRoundRect(x, y, b) {
  if (!inRect(x, y, b)) return false;
  const dx = Math.max(b.x0 + b.r - x, 0, x - (b.x1 - b.r));
  const dy = Math.max(b.y0 + b.r - y, 0, y - (b.y1 - b.r));
  return dx * dx + dy * dy <= b.r * b.r;
}

function inCapsule(x, y, c) {
  const vx = c.bx - c.ax;
  const vy = c.by - c.ay;
  const t = Math.max(0, Math.min(1, ((x - c.ax) * vx + (y - c.ay) * vy) / (vx * vx + vy * vy)));
  const px = c.ax + t * vx - x;
  const py = c.ay + t * vy - y;
  return px * px + py * py <= c.hw * c.hw;
}

function inBowl(x, y) {
  if (x < BOWL.cx) return false;
  const d = (x - BOWL.cx) ** 2 + (y - BOWL.cy) ** 2;
  return d <= BOWL.R * BOWL.R && d >= BOWL.r * BOWL.r;
}

function inRupee(x, y) {
  return inRect(x, y, BAR_TOP) || inRect(x, y, BAR_MID) || inBowl(x, y) || inRect(x, y, BOWL_FOOT) || inCapsule(x, y, LEG);
}

function gradient(x, y) {
  const t = Math.max(0, Math.min(1, (x - BG.x0 + (y - BG.y0)) / (BG.x1 - BG.x0 + (BG.y1 - BG.y0))));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (t <= t1) {
      const [t0, c0] = STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return STOPS[STOPS.length - 1][1].slice();
}

function mixWhite(c, a) {
  return [c[0] + (255 - c[0]) * a, c[1] + (255 - c[1]) * a, c[2] + (255 - c[2]) * a];
}

/** Rasterise at `size` px with N×N supersampling. Returns straight-alpha RGBA bytes (top-down). */
function render(size) {
  const n = size <= 64 ? 8 : 4;
  const detail = size >= 48; // the faint ledger page only adds noise at tiny sizes
  const scale = 512 / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) * scale;
          const y = (py + (sy + 0.5) / n) * scale;
          if (!inRoundRect(x, y, BG)) continue;
          let c = gradient(x, y);
          if (detail && inRoundRect(x, y, PAGE)) c = mixWhite(c, 0.13);
          if (detail && inRect(x, y, RULE)) c = mixWhite(c, 0.32);
          if (inRupee(x, y)) c = [255, 255, 255];
          sr += c[0];
          sg += c[1];
          sb += c[2];
          sa += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (sa > 0) {
        out[i] = Math.round(sr / sa);
        out[i + 1] = Math.round(sg / sa);
        out[i + 2] = Math.round(sb / sa);
        out[i + 3] = Math.round((sa / (n * n)) * 255);
      }
    }
  }
  return out;
}

// ───────────────────────────── PNG encoder ─────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // filter: Sub
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      raw[o + 1 + x] = (cur - left) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────────── ICO writer ─────────────────────────────

/** 32-bit BGRA DIB (BITMAPINFOHEADER, bottom-up, height doubled) + 1-bit AND mask. */
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  const maskStride = Math.ceil(size / 32) * 4;
  const xorSize = size * size * 4;
  const maskSize = maskStride * size;
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorSize + maskSize, 20); // biSizeImage
  const xor = Buffer.alloc(xorSize);
  const mask = Buffer.alloc(maskSize);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, xor, mask]);
}

function encodeIco(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette colours
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

// ───────────────────────────── verification ─────────────────────────────

function verifyPng(buf, expected) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG signature mismatch');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('first chunk is not IHDR');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== expected || h !== expected) throw new Error(`PNG is ${w}×${h}, expected ${expected}`);
  if (buf[24] !== 8 || buf[25] !== 6) throw new Error('PNG is not 8-bit RGBA');
  if (crc32(buf.subarray(12, 29)) !== buf.readUInt32BE(29)) throw new Error('IHDR CRC mismatch');
  // Walk chunks, check CRCs and inflate IDAT to the expected size.
  let p = 8;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (crc32(buf.subarray(p + 4, p + 8 + len)) !== buf.readUInt32BE(p + 8 + len)) throw new Error(`${type} CRC mismatch`);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (w * 4 + 1) * h) throw new Error('IDAT size mismatch');
  return `${w}×${h} RGBA, ${buf.length} bytes`;
}

function verifyIco(buf, sizes) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ICO header invalid');
  const count = buf.readUInt16LE(4);
  if (count !== sizes.length) throw new Error('ICO entry count mismatch');
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const w = buf[e] || 256;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (w !== sizes[i] || off + len > buf.length) throw new Error(`ICO entry ${i} invalid`);
    if (w === 256) verifyPng(buf.subarray(off, off + len), 256);
    else if (buf.readUInt32LE(off) !== 40 || buf.readInt32LE(off + 8) !== w * 2) throw new Error(`ICO DIB ${w} invalid`);
  }
  return `${count} images (${sizes.join(', ')} px), ${buf.length} bytes`;
}

// ───────────────────────────── main ─────────────────────────────

const pngPath = path.join(outDir, 'icon.png');
const icoPath = path.join(outDir, 'icon.ico');
if (process.argv.includes('--if-missing') && existsSync(pngPath) && existsSync(icoPath)) {
  console.log('build/icon.png and build/icon.ico exist — leaving them unchanged');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const png512 = encodePng(render(512), 512, 512);
writeFileSync(pngPath, png512);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(
  ICO_SIZES.map((size) => {
    const rgba = render(size);
    return { size, data: size >= 256 ? encodePng(rgba, size, size) : encodeDib(rgba, size) };
  }),
);
writeFileSync(icoPath, ico);

console.log(`build/icon.png  ${verifyPng(readFileSync(pngPath), 512)}`);
console.log(`build/icon.ico  ${verifyIco(readFileSync(icoPath), ICO_SIZES)}`);
