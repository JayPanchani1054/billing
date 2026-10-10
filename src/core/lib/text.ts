/**
 * Text decoding helpers for files the user imports (CSV, accounting XML, GST portal JSON, bank statements)
 * and the shared error type used by every file-format library in core/lib (csv, xml, zip, xlsx).
 *
 * Real-world inputs arrive in a handful of encodings:
 *  - UTF-8 with or without BOM (most tools, GST portal),
 *  - UTF-16LE, very often WITHOUT a BOM (XML exports of accounting programs),
 *  - UTF-16BE (rare),
 *  - Windows-1252 (older Excel "CSV" saves and bank statements with ₹-less symbols such as “smart quotes”).
 *
 * Note: Node's TextDecoder('windows-1252') decodes as ISO-8859-1 (bytes 0x80–0x9F map to C1 controls), so the
 * 0x80–0x9F block is remapped here explicitly to the real Windows-1252 characters (€, “, ”, –, —, …).
 */
import { AppError } from './errors.ts';

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  /** Decoded text with any byte-order mark removed. */
  text: string;
  encoding: TextEncodingName;
  /** True when the input started with a byte-order mark. */
  bom: boolean;
}

export interface FilePosition {
  line: number;
  column: number;
}

/**
 * Raised when an untrusted file (CSV/XML/ZIP/XLSX) is malformed, unsupported or exceeds a safety limit.
 * It is an AppError with code VALIDATION, so the message reaches the user instead of a generic INTERNAL error.
 * `line`/`column` (1-based) are set when the position of the problem is known.
 */
export class FileFormatError extends AppError {
  readonly format: string;
  readonly line?: number;
  readonly column?: number;

  constructor(format: string, message: string, position?: FilePosition) {
    const full = position ? `${message} (line ${position.line}, column ${position.column})` : message;
    super('VALIDATION', full, [{ path: 'file', message: full }]);
    this.name = 'FileFormatError';
    this.format = format;
    if (position) {
      this.line = position.line;
      this.column = position.column;
    }
  }
}

/** 1-based line/column of a UTF-16 code-unit offset in `text` (LF, CRLF and CR all end a line). */
export function positionAt(text: string, offset: number): FilePosition {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      line++;
      lineStart = i + 1;
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10 && i + 1 < end) i++;
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/** Windows-1252 characters for bytes 0x80–0x9F (undefined bytes keep their C1 code point, as in WHATWG). */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const latin1 = new TextDecoder('latin1').decode(bytes);
  return latin1.replace(/[\u0080-\u009f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  if (!bigEndian) return new TextDecoder('utf-16le').decode(bytes);
  // Swap to little-endian ourselves: 'utf-16be' needs full ICU, which not every Node/Electron build ships.
  const swapped = new Uint8Array(bytes.length);
  const even = bytes.length & ~1;
  for (let i = 0; i < even; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  if (even !== bytes.length) swapped[even] = bytes[even];
  return new TextDecoder('utf-16le').decode(swapped);
}

/**
 * Guess UTF-16 without a BOM from NUL-byte distribution in the first 4 KB: ASCII-heavy UTF-16LE text has NULs at
 * odd offsets (`<\0E\0N\0`), UTF-16BE at even offsets. UTF-8 / single-byte text practically never contains NULs.
 */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 2) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul >= pairs * 0.3 && evenNul <= pairs * 0.05) return 'utf-16le';
  if (evenNul >= pairs * 0.3 && oddNul <= pairs * 0.05) return 'utf-16be';
  return null;
}

/**
 * Decode file bytes to a string: BOM first (UTF-8 / UTF-16LE / UTF-16BE), then the UTF-16 NUL heuristic,
 * then strict UTF-8, and finally Windows-1252 when the bytes are not valid UTF-8. Never throws.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8OrLegacy(bytes.subarray(3), true);
  }
  if (b0 === 0xff && b1 === 0xfe) return { text: decodeUtf16(bytes.subarray(2), false), encoding: 'utf-16le', bom: true };
  if (b0 === 0xfe && b1 === 0xff) return { text: decodeUtf16(bytes.subarray(2), true), encoding: 'utf-16be', bom: true };
  const utf16 = sniffUtf16(bytes);
  if (utf16) return { text: decodeUtf16(bytes, utf16 === 'utf-16be'), encoding: utf16, bom: false };
  return decodeUtf8OrLegacy(bytes, false);
}

function decodeUtf8OrLegacy(bytes: Uint8Array, bom: boolean): DecodedText {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf-8', bom };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', bom };
  }
}

/** Remove a leading U+FEFF (byte-order mark) from an already decoded string. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** UTF-8 bytes prefixed with a BOM, so Excel opens CSV files with ₹ and Indian-language names correctly. */
export function encodeUtf8WithBom(text: string): Uint8Array {
  const body = new TextEncoder().encode(stripBom(text));
  const out = new Uint8Array(body.length + 3);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}
