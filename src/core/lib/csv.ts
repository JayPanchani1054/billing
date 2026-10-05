/**
 * CSV / TSV reading and writing (RFC 4180) for imports (bank statements, masters) and report exports.
 *
 * Reading: quoted fields, "" escapes, embedded CR/LF, CRLF/LF/CR line ends, BOM stripped, optional delimiter
 * sniffing. Writing: RFC 4180 quoting, CRLF line ends, optional BOM, and CSV/formula-injection protection
 * (OWASP): a text cell starting with = + - @ TAB or CR is prefixed with a single quote so spreadsheet apps show
 * it as text instead of evaluating it. Real numbers (typeof 'number') are never altered.
 */
import { FileFormatError, positionAt, stripBom } from './text.ts';

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface ParseCsvOptions {
  /** Field separator; 'auto' sniffs it from the first lines. Default ','. */
  delimiter?: CsvDelimiter | 'auto';
  /** Stop after this many rows (counted after skipping empty rows) — use for previews and as a memory cap. */
  maxRows?: number;
  /** Drop rows whose fields are all empty (blank lines, ",,,," separators). Default false. */
  skipEmptyRows?: boolean;
}

export type CsvValue = string | number | boolean | null | undefined;

export interface ToCsvOptions {
  /** Field separator (default ','). Must not contain a quote, CR or LF. */
  delimiter?: string;
  /** Prefix U+FEFF so Excel detects UTF-8 (encode with TextEncoder or encodeUtf8WithBom). Default false. */
  bom?: boolean;
  /** Neutralise spreadsheet formulas in text cells (default true). */
  neutraliseFormulas?: boolean;
  /** Line terminator (default CRLF, as RFC 4180 and Excel expect). */
  newline?: '\r\n' | '\n';
}

const DELIMITERS: readonly CsvDelimiter[] = [',', '\t', ';', '|'];
const QUOTE = 34;
const LF = 10;
const CR = 13;

function assertDelimiter(d: string): void {
  if (d.length !== 1 || d === '"' || d === '\r' || d === '\n') {
    throw new TypeError(`Invalid CSV delimiter ${JSON.stringify(d)}`);
  }
}

/**
 * Guess the delimiter from up to the first 10 non-empty lines (64 KB): the candidate whose per-line count
 * (outside quotes) is the most consistent wins; ties go to more columns, then to , TAB ; | order. Default ','.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const lineCounts: number[][] = [];
  const cur = [0, 0, 0, 0];
  let lineHasContent = false;
  let inQuotes = false;
  const limit = Math.min(text.length, 65536);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const flush = (): void => {
    if (lineHasContent) lineCounts.push(cur.slice());
    cur.fill(0);
    lineHasContent = false;
  };
  for (; i < limit && lineCounts.length < 10; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      inQuotes = !inQuotes;
      lineHasContent = true;
      continue;
    }
    if (inQuotes) continue;
    if (c === LF || c === CR) {
      flush();
      continue;
    }
    lineHasContent = true;
    const k = c === 44 ? 0 : c === 9 ? 1 : c === 59 ? 2 : c === 124 ? 3 : -1;
    if (k >= 0) cur[k]++;
  }
  // A final unterminated line counts only if we saw the whole text (otherwise it may be cut mid-line).
  if (i >= text.length || lineCounts.length === 0) flush();

  let best: CsvDelimiter = ',';
  let bestScore = 0;
  let bestCols = 0;
  for (let k = 0; k < DELIMITERS.length; k++) {
    const freq = new Map<number, number>();
    for (const counts of lineCounts) {
      const n = counts[k];
      if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    let mode = 0;
    let modeFreq = 0;
    for (const [n, f] of freq) {
      if (f > modeFreq || (f === modeFreq && n > mode)) {
        mode = n;
        modeFreq = f;
      }
    }
    if (mode === 0) continue;
    const score = modeFreq / lineCounts.length;
    if (score > bestScore || (score === bestScore && mode > bestCols)) {
      best = DELIMITERS[k];
      bestScore = score;
      bestCols = mode;
    }
  }
  return best;
}

function isEmptyRow(row: readonly string[]): boolean {
  for (const f of row) if (f !== '') return false;
  return true;
}

/**
 * Parse CSV text into rows of string fields. An unterminated quoted field throws FileFormatError with the
 * line/column of its opening quote. A trailing newline does not produce an extra row.
 */
export function parseCsv(input: string, opts: ParseCsvOptions = {}): string[][] {
  const text = stripBom(input);
  const delimiter = opts.delimiter === undefined ? ',' : opts.delimiter === 'auto' ? sniffDelimiter(text) : opts.delimiter;
  assertDelimiter(delimiter);
  const d = delimiter.charCodeAt(0);
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const skipEmpty = opts.skipEmptyRows === true;
  const rows: string[][] = [];
  const len = text.length;
  if (len === 0 || maxRows <= 0) return rows;

  let row: string[] = [];
  let pos = 0;
  for (;;) {
    let field: string;
    if (text.charCodeAt(pos) === QUOTE) {
      const open = pos;
      let start = pos + 1;
      field = '';
      for (;;) {
        const q = text.indexOf('"', start);
        if (q === -1) throw new FileFormatError('csv', 'Unterminated quoted field', positionAt(text, open));
        if (text.charCodeAt(q + 1) === QUOTE) {
          field += text.slice(start, q + 1);
          start = q + 2;
          continue;
        }
        field += text.slice(start, q);
        pos = q + 1;
        break;
      }
      // Lenient: characters between the closing quote and the next separator are kept ("ab"cd → abcd).
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === d || c === LF || c === CR) break;
        i++;
      }
      if (i > pos) field += text.slice(pos, i);
      pos = i;
    } else {
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === d || c === LF || c === CR) break;
        i++;
      }
      field = text.slice(pos, i);
      pos = i;
    }
    row.push(field);

    if (pos >= len) {
      if (!(skipEmpty && isEmptyRow(row))) rows.push(row);
      break;
    }
    const c = text.charCodeAt(pos);
    if (c === d) {
      pos++;
      continue;
    }
    pos += c === CR && text.charCodeAt(pos + 1) === LF ? 2 : 1;
    if (!(skipEmpty && isEmptyRow(row))) rows.push(row);
    row = [];
    if (rows.length >= maxRows || pos >= len) break;
  }
  return rows.length > maxRows ? rows.slice(0, maxRows) : rows;
}

/** Characters that make Excel/LibreOffice/Sheets treat a cell as a formula (OWASP CSV injection list). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Prefix a single quote to text that a spreadsheet would otherwise evaluate as a formula. */
export function neutraliseFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function csvCell(value: CsvValue, delimiter: string, neutralise: boolean): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'TRUE' : 'FALSE';
  else {
    s = String(value);
    if (neutralise) s = neutraliseFormula(s);
  }
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialise rows to CSV text (RFC 4180 quoting, CRLF, trailing newline). */
export function toCsv(rows: readonly (readonly CsvValue[])[], opts: ToCsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ',';
  if (delimiter.length === 0 || /["\r\n]/.test(delimiter)) {
    throw new TypeError(`Invalid CSV delimiter ${JSON.stringify(delimiter)}`);
  }
  const neutralise = opts.neutraliseFormulas !== false;
  const newline = opts.newline ?? '\r\n';
  const lines: string[] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells: string[] = new Array(row.length);
    for (let c = 0; c < row.length; c++) cells[c] = csvCell(row[c], delimiter, neutralise);
    lines[r] = cells.join(delimiter);
  }
  const body = lines.length ? lines.join(newline) + newline : '';
  return opts.bom ? `﻿${body}` : body;
}

/** Header normalisation for column mapping: trim, collapse all whitespace (incl. NBSP), lower-case. */
export function normaliseHeader(header: unknown): string {
  if (header === null || header === undefined) return '';
  return String(header).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Unique object keys for a header row: normalised headers; blanks become `column N` (1-based) and duplicates get
 * a numeric suffix (`amount`, `amount 2`).
 */
export function headerKeys(header: readonly unknown[]): string[] {
  const keys: string[] = [];
  const used = new Set<string>();
  for (let j = 0; j < header.length; j++) keys.push(uniqueKey(normaliseHeader(header[j]) || `column ${j + 1}`, used));
  return keys;
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base} ${n}`;
  used.add(key);
  return key;
}

function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Turn rows into records keyed by normalised header (see headerKeys). Rows above `headerRow` (0-based,
 * default 0) are ignored, blank rows are skipped, missing cells are null and cells beyond the header get
 * `column N` keys. Records are plain objects built with own properties only (a "__proto__" header is safe).
 */
export function rowsToObjects<T>(
  rows: readonly (readonly T[])[],
  opts: { headerRow?: number } = {},
): Record<string, T | null>[] {
  const headerRow = opts.headerRow ?? 0;
  const header = rows[headerRow];
  if (!header) return [];
  const keys = headerKeys(header);
  const used = new Set(keys);
  const out: Record<string, T | null>[] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every(isBlankCell)) continue;
    while (keys.length < row.length) keys.push(uniqueKey(`column ${keys.length + 1}`, used));
    const entries: [string, T | null][] = new Array(keys.length);
    for (let j = 0; j < keys.length; j++) entries[j] = [keys[j], j < row.length && row[j] !== undefined ? row[j] : null];
    out.push(Object.fromEntries(entries) as Record<string, T | null>);
  }
  return out;
}
