/**
 * Minimal ZIP writer/reader (PKZIP 2.0: stored + deflate) for .xlsx packages and zipped exports/imports.
 *
 * Writer: deflate via zlib.deflateRawSync (falls back to "stored" when deflate does not help), CRC-32,
 * DOS timestamps, UTF-8 name flag (0x0800), central directory and EOCD. No ZIP64 (≤ 65 535 entries, < 4 GB).
 *
 * Reader SECURITY (files are untrusted):
 *  - zip-bomb guards: entry count, total declared uncompressed size, per-entry compression ratio, and inflation
 *    is hard-capped at each entry's declared size (a lying header cannot make us allocate more);
 *  - zip-slip: absolute paths, drive letters, backslash-rooted paths, NUL bytes and '..' segments are rejected;
 *  - encrypted entries, ZIP64, multi-volume archives and unknown compression methods are rejected clearly;
 *  - every extracted entry's size and CRC-32 are verified.
 * Entries are inflated lazily on read(), so listing a large archive is cheap.
 */
import * as zlib from 'node:zlib';
import { FileFormatError, decodeText } from './text.ts';

export interface ZipInputEntry {
  /** Path inside the archive using '/' separators; a trailing '/' makes a directory entry (no data). */
  name: string;
  data: Uint8Array | string;
  /** Modification time (default: now). Stored in DOS format (local time, 2-second resolution, 1980–2107). */
  date?: Date;
  /** Deflate the entry (default true); stored anyway when deflate would not make it smaller. */
  compress?: boolean;
}

export interface ZipEntryInfo {
  name: string;
  /** Uncompressed size in bytes (as declared by the central directory). */
  size: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
  crc32: number;
  date: Date;
  isDirectory: boolean;
}

export interface ReadZipOptions {
  /** Maximum number of entries (default 10 000). */
  maxEntries?: number;
  /** Maximum sum of declared uncompressed sizes in bytes (default 512 MB). */
  maxTotalUncompressed?: number;
  /** Maximum uncompressed/compressed ratio per entry (default 200). */
  maxRatio?: number;
  /** The ratio check applies to entries larger than this many bytes (default 1 MB); tiny entries are harmless. */
  ratioMinSize?: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntryInfo[];
  /** Entry names in archive order (directories end with '/'). */
  list(): string[];
  /** Exact name, or case-insensitive match (OPC part names are case-insensitive). */
  has(name: string): boolean;
  /** Inflate + verify one entry. Throws FileFormatError when missing or corrupt. */
  read(name: string): Uint8Array;
  /** read() + decodeText() (BOM / UTF-16 aware). */
  readText(name: string): string;
}

export const DEFAULT_MAX_ENTRIES = 10_000;
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;
export const DEFAULT_MAX_RATIO = 200;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

// ───────────────────────────── CRC-32 ─────────────────────────────

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** Table-driven CRC-32 (IEEE 802.3, as used by ZIP/PNG/gzip). */
export function crc32Portable(data: Uint8Array, initial = 0): number {
  let c = ~initial;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-32 using zlib's native implementation when the runtime has it (Node ≥ 20.15), else the table version. */
export function crc32(data: Uint8Array, initial = 0): number {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(data, initial) >>> 0 : crc32Portable(data, initial);
}

// ───────────────────────────── Helpers ─────────────────────────────

function toDosDateTime(d: Date): { time: number; date: number } {
  let year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) year = 2107;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function fromDosDateTime(time: number, date: number): Date {
  return new Date(
    1980 + (date >> 9),
    ((date >> 5) & 15) - 1,
    date & 31,
    time >> 11,
    (time >> 5) & 63,
    (time & 31) * 2,
  );
}

/** Why `name` is unsafe as an archive path, or null when it is fine. */
export function unsafeZipPathReason(name: string): string | null {
  if (name.length === 0) return 'the name is empty';
  if (name.includes('\0')) return 'the name contains a NUL character';
  if (name.startsWith('/') || name.startsWith('\\')) return 'it is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'it starts with a drive letter';
  if (name.split(/[\\/]/).some((seg) => seg === '..')) return 'it contains a ".." path segment';
  return null;
}

function shown(name: string): string {
  return JSON.stringify(name.length > 120 ? `${name.slice(0, 117)}...` : name);
}

// ───────────────────────────── Writer ─────────────────────────────

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  method: number;
  crc: number;
  size: number;
  time: number;
  date: number;
  isDirectory: boolean;
  offset: number;
}

/** Build a ZIP archive in memory. Throws TypeError/RangeError for invalid names, duplicates or ZIP64 sizes. */
export function createZip(entries: readonly ZipInputEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError('ZIP archives without ZIP64 hold at most 65 535 entries');
  const encoder = new TextEncoder();
  const now = new Date();
  const seen = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let localSize = 0;
  let centralSize = 0;

  for (const e of entries) {
    const problem = unsafeZipPathReason(e.name);
    if (problem) throw new TypeError(`Invalid ZIP entry name ${shown(e.name)}: ${problem}`);
    if (seen.has(e.name)) throw new TypeError(`Duplicate ZIP entry name ${shown(e.name)}`);
    seen.add(e.name);
    const raw = typeof e.data === 'string' ? encoder.encode(e.data) : e.data;
    const isDirectory = e.name.endsWith('/');
    if (isDirectory && raw.length > 0) throw new TypeError(`Directory entry ${shown(e.name)} cannot have data`);
    if (raw.length > 0xfffffffe) throw new RangeError(`ZIP entry ${shown(e.name)} is too large (ZIP64 is not supported)`);
    let method = 0;
    let data = raw;
    if (e.compress !== false && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }
    const nameBytes = encoder.encode(e.name);
    if (nameBytes.length > 0xffff) throw new RangeError(`ZIP entry name is too long: ${shown(e.name)}`);
    const { time, date } = toDosDateTime(e.date ?? now);
    prepared.push({
      nameBytes,
      data,
      method,
      crc: crc32(raw),
      size: raw.length,
      time,
      date,
      isDirectory,
      offset: localSize,
    });
    localSize += 30 + nameBytes.length + data.length;
    centralSize += 46 + nameBytes.length;
  }
  if (localSize + centralSize > 0xfffffffe) throw new RangeError('ZIP archive is too large (ZIP64 is not supported)');

  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let p = 0;
  for (const e of prepared) {
    dv.setUint32(p, SIG_LOCAL, true);
    dv.setUint16(p + 4, VERSION, true);
    dv.setUint16(p + 6, FLAG_UTF8, true);
    dv.setUint16(p + 8, e.method, true);
    dv.setUint16(p + 10, e.time, true);
    dv.setUint16(p + 12, e.date, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.size, true);
    dv.setUint16(p + 26, e.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }
  const cdOffset = p;
  for (const e of prepared) {
    dv.setUint32(p, SIG_CENTRAL, true);
    dv.setUint16(p + 4, VERSION, true); // made by: MS-DOS/FAT, spec 2.0
    dv.setUint16(p + 6, VERSION, true);
    dv.setUint16(p + 8, FLAG_UTF8, true);
    dv.setUint16(p + 10, e.method, true);
    dv.setUint16(p + 12, e.time, true);
    dv.setUint16(p + 14, e.date, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.size, true);
    dv.setUint16(p + 28, e.nameBytes.length, true);
    dv.setUint16(p + 30, 0, true); // extra
    dv.setUint16(p + 32, 0, true); // comment
    dv.setUint16(p + 34, 0, true); // disk
    dv.setUint16(p + 36, 0, true); // internal attributes
    dv.setUint32(p + 38, e.isDirectory ? 0x10 : 0, true); // external attributes (MS-DOS directory bit)
    dv.setUint32(p + 42, e.offset, true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  }
  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 4, 0, true);
  dv.setUint16(p + 6, 0, true);
  dv.setUint16(p + 8, prepared.length, true);
  dv.setUint16(p + 10, prepared.length, true);
  dv.setUint32(p + 12, p - cdOffset, true);
  dv.setUint32(p + 16, cdOffset, true);
  dv.setUint16(p + 20, 0, true);
  return out;
}

// ───────────────────────────── Reader ─────────────────────────────

interface CentralEntry extends ZipEntryInfo {
  localOffset: number;
}

const zipError = (message: string): FileFormatError => new FileFormatError('zip', message);

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Open a ZIP archive for lazy, verified reading. Throws FileFormatError for malformed or unsafe archives. */
export function readZip(bytes: Uint8Array, opts: ReadZipOptions = {}): ZipArchive {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotal = opts.maxTotalUncompressed ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED;
  const maxRatio = opts.maxRatio ?? DEFAULT_MAX_RATIO;
  const ratioMinSize = opts.ratioMinSize ?? 1024 * 1024;
  const len = bytes.length;

  if (len >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw zipError(
      'This is an Office 97-2003 (.xls) or password-protected file, not a ZIP package. ' +
        'Open it in Excel and save it as an unprotected .xlsx workbook.',
    );
  }
  if (len < 22) throw zipError('Not a ZIP archive: the file is too small');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const lowest = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= lowest; i--) {
    if (bytes[i] === 0x50 && dv.getUint32(i, true) === SIG_EOCD && i + 22 + dv.getUint16(i + 20, true) <= len) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw zipError('Not a ZIP archive: end of central directory not found');

  const diskNo = dv.getUint16(eocd + 4, true);
  const cdDisk = dv.getUint16(eocd + 6, true);
  const entriesOnDisk = dv.getUint16(eocd + 8, true);
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (
    total === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR)
  ) {
    throw zipError('ZIP64 archives are not supported');
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== total) {
    throw zipError('Split (multi-volume) ZIP archives are not supported');
  }
  if (total > maxEntries) throw zipError(`ZIP archive has ${total} entries; the limit is ${maxEntries}`);
  if (cdOffset + cdSize > eocd) throw zipError('Corrupt ZIP archive: central directory is out of bounds');

  const entries: CentralEntry[] = [];
  const byName = new Map<string, CentralEntry>();
  const byLowerName = new Map<string, CentralEntry>();
  let totalUncompressed = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let k = 0; k < total; k++) {
    if (p + 46 > cdEnd || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw zipError('Corrupt ZIP archive: invalid central directory entry');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > cdEnd) throw zipError('Corrupt ZIP archive: entry name is out of bounds');
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & FLAG_UTF8) !== 0);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw zipError(`ZIP entry ${shown(name)} is encrypted; password-protected archives are not supported`);
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError('ZIP64 archives are not supported');
    }
    if (method !== 0 && method !== 8) {
      throw zipError(`ZIP entry ${shown(name)} uses unsupported compression method ${method}`);
    }
    const unsafe = unsafeZipPathReason(name);
    if (unsafe) throw zipError(`Unsafe path in ZIP entry ${shown(name)}: ${unsafe}`);
    if (byName.has(name)) throw zipError(`Duplicate ZIP entry ${shown(name)}`);
    if (method === 0 && compressedSize !== size) throw zipError(`Corrupt ZIP entry ${shown(name)}: size mismatch`);
    totalUncompressed += size;
    if (totalUncompressed > maxTotal) {
      throw zipError(
        `ZIP archive expands to more than ${Math.floor(maxTotal / 1048576)} MB; refusing to extract (possible ZIP bomb)`,
      );
    }
    if (size > ratioMinSize && size / Math.max(compressedSize, 1) > maxRatio) {
      throw zipError(
        `ZIP entry ${shown(name)} has a compression ratio above ${maxRatio}:1; refusing to extract (possible ZIP bomb)`,
      );
    }
    const entry: CentralEntry = {
      name,
      size,
      compressedSize,
      method,
      crc32: crc,
      date: fromDosDateTime(time, date),
      isDirectory: name.endsWith('/'),
      localOffset,
    };
    entries.push(entry);
    byName.set(name, entry);
    const lower = name.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, entry);
  }

  const find = (name: string): CentralEntry | undefined => byName.get(name) ?? byLowerName.get(name.toLowerCase());

  const read = (name: string): Uint8Array => {
    const e = find(name);
    if (!e) throw zipError(`ZIP entry ${shown(name)} not found`);
    if (e.isDirectory) return new Uint8Array(0);
    const at = e.localOffset;
    if (at + 30 > len || dv.getUint32(at, true) !== SIG_LOCAL) {
      throw zipError(`Corrupt ZIP entry ${shown(e.name)}: local header not found`);
    }
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
    const end = start + e.compressedSize;
    if (end > len) throw zipError(`Corrupt ZIP entry ${shown(e.name)}: data is truncated`);
    let out: Uint8Array;
    if (e.method === 0) {
      // Always a copy (Buffer#slice would return a view sharing memory with the archive).
      out = new Uint8Array(bytes.subarray(start, end));
    } else {
      try {
        const buf = zlib.inflateRawSync(bytes.subarray(start, end), { maxOutputLength: Math.max(e.size, 1) });
        out = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ERR_BUFFER_TOO_LARGE') {
          throw zipError(`ZIP entry ${shown(e.name)} inflates beyond its declared size (possible ZIP bomb)`);
        }
        throw zipError(`Corrupt ZIP entry ${shown(e.name)}: ${(err as Error).message}`);
      }
    }
    if (out.length !== e.size) throw zipError(`Corrupt ZIP entry ${shown(e.name)}: size mismatch`);
    if (crc32(out) !== e.crc32) throw zipError(`CRC-32 mismatch in ZIP entry ${shown(e.name)}; the archive is corrupt`);
    return out;
  };

  const publicEntries: ZipEntryInfo[] = entries.map((e) => ({
    name: e.name,
    size: e.size,
    compressedSize: e.compressedSize,
    method: e.method,
    crc32: e.crc32,
    date: e.date,
    isDirectory: e.isDirectory,
  }));

  return {
    entries: publicEntries,
    list: () => entries.map((e) => e.name),
    has: (name) => find(name) !== undefined,
    read,
    readText: (name) => decodeText(read(name)).text,
  };
}
