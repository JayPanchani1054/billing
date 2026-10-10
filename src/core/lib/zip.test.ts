import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { FileFormatError } from './text.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, crc32Portable, createZip, readZip, unsafeZipPathReason, ZIP_STREAM_CHUNK, ZipFileWriter } from './zip.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Offset of the central directory (from the EOCD at the end of an archive without comment). */
function centralOffset(zip: Uint8Array): number {
  return dv(zip).getUint32(zip.length - 22 + 16, true);
}

/** Replace every occurrence of `from` with the same-length `to` (used to forge hostile entry names). */
function patchBytes(zip: Uint8Array, from: string, to: string): Uint8Array {
  const a = enc.encode(from);
  const b = enc.encode(to);
  assert.equal(a.length, b.length);
  const out = zip.slice();
  let hits = 0;
  for (let i = 0; i + a.length <= out.length; i++) {
    let match = true;
    for (let j = 0; j < a.length && match; j++) match = out[i + j] === a[j];
    if (match) {
      out.set(b, i);
      hits++;
    }
  }
  assert.ok(hits >= 2, 'name patched in local and central headers');
  return out;
}

function rejects(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof FileFormatError && err.format === 'zip' && re.test(err.message));
}

/** Made by Python's zipfile on an unseekable stream: data descriptors (flag 0x0008), UTF-8 names, both methods. */
const PYTHON_ZIP_BASE64 =
  'UEsDBBQACAgIAMdTgVgAAAAAAAAAAAAAAAAYAAAAZG9jcy/gpLngpL/gpLjgpL7gpKwudHh088gsTkxMUsjOLAFRHqM8KA8AUEsHCK5kEokSAAAAGAEAAFBLAwQUAAgAAAB9v39aAAAAAAAAAAAAAAAACgAAAHN0b3JlZC5iaW4AAQIDBAUGBwgJUEsHCEbXbEUKAAAACgAAAFBLAQIUAxQACAgIAMdTgViuZBKJEgAAABgBAAAYAAAAAAAAAAAAAACAAQAAAABkb2NzL+CkueCkv+CkuOCkvuCkrC50eHRQSwECFAMUAAgAAAB9v39aRtdsRQoAAAAKAAAACgAAAAAAAAAAAAAAgAFYAAAAc3RvcmVkLmJpblBLBQYAAAAAAgACAH4AAACaAAAAAAA=';

describe('crc32', () => {
  it('matches the standard check value and supports continuation', () => {
    const data = enc.encode('123456789');
    assert.equal(crc32(data), 0xcbf43926);
    assert.equal(crc32Portable(data), 0xcbf43926);
    assert.equal(crc32Portable(new Uint8Array(0)), 0);
    const rnd = new Uint8Array(randomBytes(10_000));
    assert.equal(crc32Portable(rnd), crc32(rnd));
    assert.equal(crc32Portable(rnd.subarray(5000), crc32Portable(rnd.subarray(0, 5000))), crc32(rnd));
  });
});

describe('createZip / readZip round trip', () => {
  it('round-trips deflated, stored, empty, unicode-named and directory entries', () => {
    const text = 'Hisaab kitaab '.repeat(500);
    const random = new Uint8Array(randomBytes(4096));
    const date = new Date(2024, 3, 1, 10, 30, 14);
    const zip = createZip([
      { name: 'docs/', data: '' },
      { name: 'docs/हिसाब ₹.txt', data: text, date },
      { name: 'random.bin', data: random },
      { name: 'forced-stored.txt', data: text, compress: false },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    // Local header of the first file entry carries the UTF-8 flag.
    assert.equal(dv(zip).getUint16(6, true) & 0x0800, 0x0800);
    const archive = readZip(zip);
    assert.deepEqual(archive.list(), ['docs/', 'docs/हिसाब ₹.txt', 'random.bin', 'forced-stored.txt', 'empty.txt']);
    const info = Object.fromEntries(archive.entries.map((e) => [e.name, e]));
    assert.equal(info['docs/'].isDirectory, true);
    assert.equal(info['docs/हिसाब ₹.txt'].method, 8, 'compressible data is deflated');
    assert.ok(info['docs/हिसाब ₹.txt'].compressedSize < 200);
    assert.equal(info['random.bin'].method, 0, 'incompressible data is stored');
    assert.equal(info['forced-stored.txt'].method, 0);
    assert.equal(info['docs/हिसाब ₹.txt'].date.getTime(), date.getTime());
    assert.equal(archive.readText('docs/हिसाब ₹.txt'), text);
    assert.deepEqual(archive.read('random.bin'), random);
    assert.equal(dec.decode(archive.read('forced-stored.txt')), text);
    assert.equal(archive.read('empty.txt').length, 0);
    assert.equal(archive.read('docs/').length, 0);
  });

  it('looks names up exactly, then case-insensitively; missing entries throw', () => {
    const archive = readZip(createZip([{ name: '[Content_Types].xml', data: '<Types/>' }]));
    assert.equal(archive.has('[content_types].xml'), true);
    assert.equal(archive.readText('[CONTENT_TYPES].XML'), '<Types/>');
    assert.equal(archive.has('nope'), false);
    rejects(() => archive.read('nope'), /not found/);
  });

  it('stores DOS timestamps with 2-second resolution and clamps pre-1980 dates', () => {
    const archive = readZip(
      createZip([
        { name: 'a', data: 'x', date: new Date(2025, 2, 31, 23, 59, 59) },
        { name: 'b', data: 'x', date: new Date(1970, 0, 1) },
      ]),
    );
    assert.equal(archive.entries[0].date.getTime(), new Date(2025, 2, 31, 23, 59, 58).getTime());
    assert.equal(archive.entries[1].date.getTime(), new Date(1980, 0, 1).getTime());
  });

  it('reads archives written by other tools (data descriptors, UTF-8 names)', () => {
    const archive = readZip(new Uint8Array(Buffer.from(PYTHON_ZIP_BASE64, 'base64')));
    assert.deepEqual(archive.list(), ['docs/हिसाब.txt', 'stored.bin']);
    assert.equal(archive.readText('docs/हिसाब.txt'), 'Hisaab kitaab '.repeat(20));
    assert.deepEqual([...archive.read('stored.bin')], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(archive.entries[1].date.getTime(), new Date(2025, 2, 31, 23, 59, 58).getTime());
  });

  it('rejects invalid or duplicate names when writing', () => {
    assert.throws(() => createZip([{ name: '../evil', data: 'x' }]), TypeError);
    assert.throws(() => createZip([{ name: '/abs', data: 'x' }]), TypeError);
    assert.throws(() => createZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /Duplicate/);
    assert.throws(() => createZip([{ name: 'dir/', data: 'x' }]), /cannot have data/);
  });
});

describe('readZip security', () => {
  it('rejects zip-slip names: "..", absolute, drive letters, backslashes, NUL', () => {
    const cases: [string, RegExp][] = [
      ['../../etc/passwd', /"\.\." path segment/],
      ['a/../../b/c.txt', /"\.\." path segment/],
      ['..\\..\\win.ini', /"\.\." path segment/],
      ['/etc/cron.d/job', /absolute path/],
      ['\\\\server\\share', /absolute path/],
      ['C:/Windows/x.dll', /drive letter/],
    ];
    for (const [evil, re] of cases) {
      const placeholder = 'Q'.repeat(enc.encode(evil).length);
      const zip = patchBytes(createZip([{ name: placeholder, data: 'pwned' }]), placeholder, evil);
      rejects(() => readZip(zip), re);
    }
    assert.match(unsafeZipPathReason('a\0b') ?? '', /NUL/);
    assert.equal(unsafeZipPathReason('xl/worksheets/sheet1.xml'), null);
    assert.equal(unsafeZipPathReason('a..b/..c'), null);
  });

  it('verifies CRC-32 of every extracted entry', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello world', compress: false }]);
    const corrupt = zip.slice();
    corrupt[30 + 'a.txt'.length] ^= 0xff; // flip a data byte
    rejects(() => readZip(corrupt).read('a.txt'), /CRC-32 mismatch/);
    const deflated = createZip([{ name: 'b.txt', data: 'abc'.repeat(100) }]);
    const badCrc = deflated.slice();
    dv(badCrc).setUint32(centralOffset(badCrc) + 16, 0x12345678, true);
    rejects(() => readZip(badCrc).read('b.txt'), /CRC-32 mismatch/);
  });

  it('rejects zip bombs by compression ratio and by total size', () => {
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const bomb = createZip([{ name: 'zeros.bin', data: zeros }]);
    assert.ok(bomb.length < 100_000);
    rejects(() => readZip(bomb), /compression ratio above 200:1/);
    // Explicitly raised limits allow it.
    assert.equal(readZip(bomb, { maxRatio: 10_000 }).read('zeros.bin').length, zeros.length);
    const two = createZip([
      { name: 'a', data: new Uint8Array(1000) },
      { name: 'b', data: new Uint8Array(1000) },
    ]);
    rejects(() => readZip(two, { maxTotalUncompressed: 1500 }), /expands to more than/);
    const many = createZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
    rejects(() => readZip(many, { maxEntries: 10 }), /11 entries; the limit is 10/);
  });

  it('never inflates beyond the declared size (lying headers)', () => {
    const zip = createZip([{ name: 'big.txt', data: 'A'.repeat(100_000) }]);
    const lying = zip.slice();
    dv(lying).setUint32(centralOffset(lying) + 24, 10, true); // claim 10 bytes uncompressed
    rejects(() => readZip(lying).read('big.txt'), /inflates beyond its declared size/);
  });

  it('rejects encrypted entries, ZIP64, unknown methods and duplicates', () => {
    const zip = createZip([{ name: 'a.txt', data: 'secret' }]);
    const encrypted = zip.slice();
    dv(encrypted).setUint16(centralOffset(encrypted) + 8, 0x0801, true);
    rejects(() => readZip(encrypted), /encrypted/);
    const zip64 = zip.slice();
    dv(zip64).setUint16(zip64.length - 22 + 8, 0xffff, true);
    dv(zip64).setUint16(zip64.length - 22 + 10, 0xffff, true);
    rejects(() => readZip(zip64), /ZIP64/);
    const lzma = zip.slice();
    dv(lzma).setUint16(centralOffset(lzma) + 10, 14, true);
    rejects(() => readZip(lzma), /unsupported compression method 14/);
    const dup = patchBytes(createZip([{ name: 'a.txt', data: '1' }, { name: 'b.txt', data: '2' }]), 'b.txt', 'a.txt');
    rejects(() => readZip(dup), /Duplicate ZIP entry/);
  });

  it('gives clear errors for non-ZIP, truncated and legacy Office files', () => {
    rejects(() => readZip(enc.encode('Date,Narration,Amount\n01-04-2024,NEFT,1250.00\n')), /end of central directory not found/);
    rejects(() => readZip(new Uint8Array(5)), /too small/);
    rejects(() => readZip(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(600)])), /\.xls/);
    const zip = createZip([{ name: 'a.txt', data: 'abc'.repeat(1000) }]);
    const truncated = zip.slice(0, 40);
    rejects(() => readZip(truncated), /ZIP/);
    const badOffset = zip.slice();
    dv(badOffset).setUint32(centralOffset(badOffset) + 42, 5, true);
    rejects(() => readZip(badOffset).read('a.txt'), /local header not found/);
  });
});

describe('ZipFileWriter (streamed to a file, constant memory)', () => {
  const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-zipw-')), 'out.zip');

  it('entries larger than one chunk (strings and bytes mixed) read back intact with matching CRC', () => {
    const file = tmp();
    const w = new ZipFileWriter(file);
    const binary = randomBytes(ZIP_STREAM_CHUNK * 2 + 123); // incompressible: several deflate blocks
    let text = '';
    w.beginEntry('big.txt');
    for (let i = 0; i < 40_000; i++) {
      const line = `line ${i} — ₹${i},00 नमस्ते\r\n`;
      text += line;
      w.write(line);
    }
    w.endEntry();
    w.beginEntry('bin/data.bin');
    w.write(binary.subarray(0, 1000));
    w.write('');
    w.write(binary.subarray(1000));
    w.endEntry();
    w.addEntry('empty.txt', '');
    const size = w.finish();
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, size);
    const zip = readZip(new Uint8Array(bytes), { maxRatio: 10_000 });
    assert.deepEqual(zip.list(), ['big.txt', 'bin/data.bin', 'empty.txt']);
    assert.equal(zip.readText('big.txt'), text);
    assert.ok(Buffer.from(zip.read('bin/data.bin')).equals(binary));
    assert.equal(zip.read('empty.txt').length, 0);
    const big = zip.entries.find((e) => e.name === 'big.txt');
    assert.equal(big?.crc32, crc32(new TextEncoder().encode(text)));
    assert.ok((big?.compressedSize ?? 0) < (big?.size ?? 0) / 3, 'text is deflated');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('refuses unsafe or duplicate names, never overwrites a file, and abort() deletes the partial file', () => {
    const file = tmp();
    const w = new ZipFileWriter(file);
    assert.throws(() => w.beginEntry('../evil.txt'), TypeError);
    w.addEntry('a.txt', 'x');
    assert.throws(() => w.beginEntry('a.txt'), /Duplicate/);
    assert.throws(() => new ZipFileWriter(file), /EEXIST/);
    w.abort();
    assert.equal(fs.existsSync(file), false);
    w.abort(); // idempotent
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
