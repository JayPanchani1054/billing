#!/usr/bin/env node
// Procedurally draws the Pevqori brand images and writes:
//   build/icon.png              512×512 RGBA PNG (electron-builder / Linux / docs)
//   build/icon.ico              Windows icon: 16–128 px as 32-bit BMP entries + 256 px as an embedded PNG
//   build/installerSidebar.bmp  164×314 24-bit BMP: installer/uninstaller welcome + finish pages
//   build/installerHeader.bmp   150×57 24-bit BMP: installer page header
// Icon: rounded square with an indigo → deep-blue diagonal gradient, a faint ledger page with a margin
// rule, and a white ₹ glyph built from simple shapes (bars, half-ring bowl, diagonal leg).
// Installer bitmaps: slate-950 background, the icon as the brand mark and a "Pevqori" wordmark whose
// letters are drawn from the same simple shapes (no font file, so the output is identical everywhere).
// Uses only node:* modules (zlib for PNG deflate; CRC32 implemented here). Deterministic: the same
// script always writes the same bytes (src/main/make-icon.test.ts compares the committed bitmaps).
//
//   node scripts/make-icon.mjs              (re)generate every file
//   node scripts/make-icon.mjs --if-missing only the groups (icon / installer bitmaps) with a missing file
//                                           (CI; keeps a hand-made icon)
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

/** x² by multiplication: exact IEEE-754 on every engine (no Math.pow), so the output bytes never vary. */
const sq = (v) => v * v;

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
  const d = sq(x - BOWL.cx) + sq(y - BOWL.cy);
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
export function render(size) {
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

export function encodePng(rgba, width, height) {
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

export function encodeIco(images) {
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

export function verifyPng(buf, expected) {
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

export function verifyIco(buf, sizes) {
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


// ───────────────────────────── installer bitmaps ─────────────────────────────

/** slate-950 #020617 — the installer canvas (docs/ARCHITECTURE.md "Visual language"). */
export const INSTALLER_BG = [2, 6, 23];
/** The wordmark colour: white, like the ₹ in the icon. */
const INK = [255, 255, 255];

export const SIDEBAR = { width: 164, height: 314 };
export const HEADER = { width: 150, height: 57 };

// Wordmark glyphs on a font-unit grid: y grows UP from the baseline, x-height 10, cap height 14,
// descender 4, stroke 2.2. Each glyph is a point test plus its advance width.
const S = 2.2;
const XH = 10;
const CAP = 14;

function annulus(x, y, cx, cy, R, r) {
  const d = sq(x - cx) + sq(y - cy);
  return d <= R * R && d >= r * r;
}

function box(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function capsule(x, y, ax, ay, bx, by, hw) {
  return inCapsule(x, y, { ax, ay, bx, by, hw });
}

const RING_R = XH / 2;
const RING_r = RING_R - S;
const ring = (x, y) => annulus(x, y, RING_R, RING_R, RING_R, RING_r);

/** @type {Record<string, { width: number; inside: (x: number, y: number) => boolean }>} */
const GLYPHS = {
  P: {
    width: 8.6,
    inside: (x, y) =>
      box(x, y, 0, 0, S, CAP) || // stem
      box(x, y, 0, CAP - S, 4.6, CAP) || // top bar
      box(x, y, 0, 6, 4.6, 6 + S) || // middle bar
      (x >= 4.6 && annulus(x, y, 4.6, 10.1, 4, 4 - S)), // bowl
  },
  e: {
    width: XH,
    inside: (x, y) => {
      if (box(x, y, 0.4, 4.3, XH - 0.4, 4.3 + 0.85 * S)) return true; // crossbar
      if (!ring(x, y)) return false;
      const a = Math.atan2(y - RING_R, x - RING_R);
      return !(a > -0.85 && a < -0.05); // the opening, lower right
    },
  },
  v: {
    width: 9.4,
    inside: (x, y) => y >= 0 && y <= XH && (capsule(x, y, 1.1, XH - 1.1, 4.7, 1.1, S / 2) || capsule(x, y, 8.3, XH - 1.1, 4.7, 1.1, S / 2)),
  },
  q: {
    width: XH,
    inside: (x, y) => ring(x, y) || box(x, y, XH - S, -4, XH, XH - 1.2),
  },
  o: { width: XH, inside: (x, y) => ring(x, y) },
  r: {
    width: 6.6,
    inside: (x, y) => box(x, y, 0, 0, S, XH) || (y >= 6 && x >= S - 0.1 && x <= 6.6 && annulus(x, y, S + 3.4, 6, 4, 4 - S)),
  },
  i: {
    width: S,
    inside: (x, y) => box(x, y, 0, 0, S, XH) || sq(x - S / 2) + sq(y - 12.7) <= 1.4 * 1.4,
  },
};
const WORD = 'Pevqori';
const TRACKING = 1.5;
/** Font units: the wordmark spans x 0…WORD_WIDTH and y −4 (descender) … 14 (cap height). */
export const WORD_WIDTH = [...WORD].reduce((w, ch) => w + GLYPHS[ch].width, 0) + TRACKING * (WORD.length - 1);

function inWord(x, y) {
  let x0 = 0;
  for (const ch of WORD) {
    const g = GLYPHS[ch];
    if (x >= x0 - 0.5 && x <= x0 + g.width + 0.5) {
      if (g.inside(x - x0, y)) return true;
    }
    x0 += g.width + TRACKING;
  }
  return false;
}

/** A width × height RGB canvas (top-down rows, 3 bytes per pixel) filled with `bg`. */
function canvas(width, height, bg) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) px.set(bg, i * 3);
  return { width, height, px };
}

/** Composite the icon (straight-alpha RGBA from render()) at (left, top). */
function drawIcon(c, size, left, top) {
  const rgba = render(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const a = rgba[s + 3] / 255;
      if (a === 0) continue;
      const d = ((top + y) * c.width + left + x) * 3;
      for (let k = 0; k < 3; k++) c.px[d + k] = Math.round(rgba[s + k] * a + c.px[d + k] * (1 - a));
    }
  }
}

/** Draw the wordmark with its left edge at `left`, baseline at `baseline` (px), `scale` px per font unit. */
function drawWord(c, left, baseline, scale) {
  const n = 4;
  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(c.width, Math.ceil(left + WORD_WIDTH * scale));
  const y0 = Math.max(0, Math.floor(baseline - (CAP + 0.5) * scale));
  const y1 = Math.min(c.height, Math.ceil(baseline + 4.5 * scale));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const fx = (px + (sx + 0.5) / n - left) / scale;
          const fy = (baseline - (py + (sy + 0.5) / n)) / scale;
          if (inWord(fx, fy)) hits++;
        }
      }
      if (hits === 0) continue;
      const a = hits / (n * n);
      const d = (py * c.width + px) * 3;
      for (let k = 0; k < 3; k++) c.px[d + k] = Math.round(INK[k] * a + c.px[d + k] * (1 - a));
    }
  }
}

/** Installer sidebar (welcome / finish pages): brand mark centred above the wordmark. */
export function renderInstallerSidebar() {
  const { width, height } = SIDEBAR;
  const c = canvas(width, height, INSTALLER_BG);
  const icon = 80;
  drawIcon(c, icon, Math.round((width - icon) / 2), 84);
  const scale = 1.75;
  drawWord(c, Math.round((width - WORD_WIDTH * scale) / 2), 84 + icon + 26 + CAP * scale, scale);
  return c;
}

/** Installer header (inner pages): brand mark at the left, wordmark beside it. */
export function renderInstallerHeader() {
  const { width, height } = HEADER;
  const c = canvas(width, height, INSTALLER_BG);
  const icon = 37;
  const top = Math.round((height - icon) / 2);
  drawIcon(c, icon, 10, top);
  const left = 10 + icon + 8;
  const scale = Math.min(1.3, (width - left - 8) / WORD_WIDTH);
  drawWord(c, left, Math.round(height / 2 + (CAP * scale) / 2), scale);
  return c;
}

// ───────────────────────────── BMP writer ─────────────────────────────

/**
 * 24-bit uncompressed Windows BMP (BITMAPFILEHEADER + 40-byte BITMAPINFOHEADER, bottom-up rows padded
 * to 4 bytes, BGR) — the format the installer's MUI pages load.
 */
export function encodeBmp({ width, height, px }) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = stride * height;
  const buf = Buffer.alloc(54 + imageSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2); // file size
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // biSize
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive: bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(2835, 38); // 72 dpi
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = row + x * 3;
      buf[d] = px[s + 2];
      buf[d + 1] = px[s + 1];
      buf[d + 2] = px[s];
    }
  }
  return buf;
}

/** Checks a BMP's headers; returns a summary line or throws. */
export function verifyBmp(buf, width, height) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('BMP signature mismatch');
  if (buf.readUInt32LE(2) !== buf.length) throw new Error('BMP file size field mismatch');
  if (buf.readUInt32LE(14) !== 40) throw new Error('BMP is not BITMAPINFOHEADER (v3)');
  const w = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  if (w !== width || h !== height) throw new Error(`BMP is ${w}×${h}, expected ${width}×${height}`);
  if (buf.readUInt16LE(28) !== 24 || buf.readUInt32LE(30) !== 0) throw new Error('BMP is not 24-bit uncompressed');
  const offset = buf.readUInt32LE(10);
  if (offset + Math.ceil((w * 3) / 4) * 4 * h !== buf.length) throw new Error('BMP pixel data size mismatch');
  return `${w}×${h} 24-bit BMP, ${buf.length} bytes`;
}

// ───────────────────────────── main ─────────────────────────────

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function iconFiles() {
  return {
    png: encodePng(render(512), 512, 512),
    ico: encodeIco(
      ICO_SIZES.map((size) => {
        const rgba = render(size);
        return { size, data: size >= 256 ? encodePng(rgba, size, size) : encodeDib(rgba, size) };
      }),
    ),
  };
}

export function installerFiles() {
  return { sidebar: encodeBmp(renderInstallerSidebar()), header: encodeBmp(renderInstallerHeader()) };
}

function main() {
  const ifMissing = process.argv.includes('--if-missing');
  const pngPath = path.join(outDir, 'icon.png');
  const icoPath = path.join(outDir, 'icon.ico');
  const sidebarPath = path.join(outDir, 'installerSidebar.bmp');
  const headerPath = path.join(outDir, 'installerHeader.bmp');
  mkdirSync(outDir, { recursive: true });

  if (ifMissing && existsSync(pngPath) && existsSync(icoPath)) {
    console.log('build/icon.png and build/icon.ico exist — leaving them unchanged');
  } else {
    const { png, ico } = iconFiles();
    writeFileSync(pngPath, png);
    writeFileSync(icoPath, ico);
    console.log(`build/icon.png  ${verifyPng(readFileSync(pngPath), 512)}`);
    console.log(`build/icon.ico  ${verifyIco(readFileSync(icoPath), ICO_SIZES)}`);
  }

  if (ifMissing && existsSync(sidebarPath) && existsSync(headerPath)) {
    console.log('build/installerSidebar.bmp and build/installerHeader.bmp exist — leaving them unchanged');
  } else {
    const { sidebar, header } = installerFiles();
    writeFileSync(sidebarPath, sidebar);
    writeFileSync(headerPath, header);
    console.log(`build/installerSidebar.bmp  ${verifyBmp(readFileSync(sidebarPath), SIDEBAR.width, SIDEBAR.height)}`);
    console.log(`build/installerHeader.bmp   ${verifyBmp(readFileSync(headerPath), HEADER.width, HEADER.height)}`);
  }
}

// Run only as a script (`node scripts/make-icon.mjs`), not when a test imports the module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
