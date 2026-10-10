// scripts/make-icon.mjs: the installer bitmaps (electron-builder.yml nsis.installerSidebar /
// installerHeader) are generated, never hand-made — checked here for format, size, palette and that the
// committed files are exactly what the generator writes. Plain Node: the script is imported, not run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Canvas {
  width: number;
  height: number;
  px: Buffer;
}
interface MakeIcon {
  INSTALLER_BG: number[];
  SIDEBAR: { width: number; height: number };
  HEADER: { width: number; height: number };
  WORD_WIDTH: number;
  renderInstallerSidebar(): Canvas;
  renderInstallerHeader(): Canvas;
  encodeBmp(c: Canvas): Buffer;
  verifyBmp(buf: Buffer, width: number, height: number): string;
  installerFiles(): { sidebar: Buffer; header: Buffer };
  iconFiles(): { png: Buffer; ico: Buffer };
}
const load = async (): Promise<MakeIcon> => (await import(pathToFileURL(path.join(root, 'scripts/make-icon.mjs')).href)) as MakeIcon;

/** Pixel (x, y from the top) of a 24-bit bottom-up BMP as [r, g, b]. */
function bmpPixel(buf: Buffer, x: number, y: number): number[] {
  const w = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  const stride = Math.ceil((w * 3) / 4) * 4;
  const o = buf.readUInt32LE(10) + (h - 1 - y) * stride + x * 3;
  return [buf[o + 2], buf[o + 1], buf[o]];
}

/** Count of pixels matching `test` in a 24-bit BMP. */
function countPixels(buf: Buffer, test: (rgb: number[]) => boolean): number {
  const w = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (test(bmpPixel(buf, x, y))) n++;
  return n;
}

describe('installer bitmaps (scripts/make-icon.mjs)', () => {
  it('importing the script does not write anything (it runs only from the command line)', async () => {
    const before = fs.statSync(path.join(root, 'build/icon.png')).mtimeMs;
    await load();
    assert.equal(fs.statSync(path.join(root, 'build/icon.png')).mtimeMs, before);
  });

  it('writes 24-bit uncompressed BMPs of the sizes the installer pages use (164×314 sidebar, 150×57 header)', async () => {
    const m = await load();
    assert.deepEqual(m.SIDEBAR, { width: 164, height: 314 });
    assert.deepEqual(m.HEADER, { width: 150, height: 57 });
    const { sidebar, header } = m.installerFiles();
    for (const [buf, { width, height }] of [
      [sidebar, m.SIDEBAR],
      [header, m.HEADER],
    ] as const) {
      assert.equal(buf.toString('ascii', 0, 2), 'BM');
      assert.equal(buf.readUInt32LE(2), buf.length, 'file size field');
      assert.equal(buf.readUInt32LE(10), 54, 'pixel data right after the headers');
      assert.equal(buf.readUInt32LE(14), 40, 'BITMAPINFOHEADER');
      assert.equal(buf.readInt32LE(18), width);
      assert.equal(buf.readInt32LE(22), height, 'positive height: bottom-up rows');
      assert.equal(buf.readUInt16LE(26), 1, 'one plane');
      assert.equal(buf.readUInt16LE(28), 24, '24 bits per pixel');
      assert.equal(buf.readUInt32LE(30), 0, 'BI_RGB (uncompressed)');
      const stride = Math.ceil((width * 3) / 4) * 4;
      assert.equal(buf.readUInt32LE(34), stride * height, 'image size with 4-byte row padding');
      assert.equal(buf.length, 54 + stride * height);
      assert.match(m.verifyBmp(buf, width, height), new RegExp(`^${width}×${height} 24-bit BMP`));
    }
  });

  it('verifyBmp rejects a wrong size, depth or truncated file', async () => {
    const m = await load();
    const { header } = m.installerFiles();
    assert.throws(() => m.verifyBmp(header, 151, 57), /expected 151×57/);
    const eight = Buffer.from(header);
    eight.writeUInt16LE(8, 28);
    assert.throws(() => m.verifyBmp(eight, 150, 57), /not 24-bit/);
    assert.throws(() => m.verifyBmp(header.subarray(0, header.length - 1), 150, 57), /file size/);
    assert.throws(() => m.verifyBmp(Buffer.concat([Buffer.from('XX'), header.subarray(2)]), 150, 57), /signature/);
  });

  it('slate-950 canvas with the indigo brand mark and the white wordmark', async () => {
    const m = await load();
    assert.deepEqual(m.INSTALLER_BG, [2, 6, 23]);
    const { sidebar, header } = m.installerFiles();
    for (const buf of [sidebar, header]) {
      const w = buf.readInt32LE(18);
      const h = buf.readInt32LE(22);
      for (const [x, y] of [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ]) {
        assert.deepEqual(bmpPixel(buf, x, y), [2, 6, 23], `corner ${x},${y} is the background`);
      }
      const indigo = countPixels(buf, ([r, g, b]) => b > 120 && b > r + 40 && b > g + 40);
      const white = countPixels(buf, ([r, g, b]) => r > 240 && g > 240 && b > 240);
      assert.ok(indigo > 300, `brand mark present (${indigo} indigo pixels)`);
      assert.ok(white > 150, `wordmark and ₹ present (${white} white pixels)`);
    }
    // The wordmark sits below the brand mark on the sidebar (rows 170–240 hold white, neutral pixels).
    const isInk = ([r, g, b]: number[]): boolean => r > 240 && g > 240 && b > 240;
    const inkRows = Array.from({ length: 70 }, (_, i) => 170 + i).filter((y) => Array.from({ length: 164 }, (_, x) => bmpPixel(sidebar, x, y)).some(isInk));
    assert.ok(inkRows.length >= 20, `sidebar wordmark under the brand mark (${inkRows.length} rows)`);
    assert.ok(m.WORD_WIDTH > 50 && m.WORD_WIDTH < 80);
  });

  it('is deterministic, and the committed bitmaps are exactly the generator’s output', async () => {
    const m = await load();
    const a = m.installerFiles();
    const b = m.installerFiles();
    assert.ok(a.sidebar.equals(b.sidebar) && a.header.equals(b.header));
    assert.ok(fs.readFileSync(path.join(root, 'build/installerSidebar.bmp')).equals(a.sidebar), 'build/installerSidebar.bmp: run node scripts/make-icon.mjs');
    assert.ok(fs.readFileSync(path.join(root, 'build/installerHeader.bmp')).equals(a.header), 'build/installerHeader.bmp: run node scripts/make-icon.mjs');
  });
});
