/**
 * Dependency-free .xlsx (Office Open XML SpreadsheetML) writer and reader.
 *
 * Writer — report exports: shared strings (deduplicated), bold/indent styles, Indian-grouped amount format
 * (12,34,567.00), integer / percent / dd-mmm-yyyy date formats, title lines above a bold header row, frozen
 * header, auto-filter and column widths. XlsxStreamWriter writes very large exports row by row (inline strings,
 * constant memory). SECURITY: text is only ever written as a shared or inline string (never as a
 * formula, so "=HYPERLINK(…)" from a party name stays inert text), XML-invalid control characters are stripped,
 * names/attributes are escaped, and literal `_xHHHH_` sequences are escaped so Excel cannot reinterpret them.
 * Text that a spreadsheet could take for a formula (starting with = + - @ TAB CR, not a plain number —
 * shared/csvSafe.ts) also gets a `quotePrefix` style, so it stays text even when the user edits the cell
 * (the value itself is unchanged, so our importer reads it back exactly).
 *
 * Reader — imports (bank statements, masters, GST portal Excel files): resolves workbook.xml + relationships,
 * shared strings (incl. rich-text runs, ignoring phonetic runs), inline strings, numbers, booleans, errors (null),
 * sparse cells via the `r` attribute, and converts date-formatted serials to 'YYYY-MM-DD' (1900 system with the
 * Lotus leap-year bug, or 1904). Reads files produced by Excel, LibreOffice, Google Sheets and writeXlsx.
 * The ZIP layer enforces zip-bomb / zip-slip guards; sheet XML is streamed through the SAX parser.
 */
import { FileFormatError, decodeText } from './text.ts';
import { createZip, readZip } from './zip.ts';
import type { ReadZipOptions, ZipArchive, ZipFileWriter, ZipInputEntry } from './zip.ts';
import { needsFormulaGuard } from '../../shared/csvSafe.ts';
import { XML_DECLARATION, escapeAttr, escapeXml, localName, parseXml, saxParse, stripInvalidXmlChars } from './xml.ts';
import type { XmlElement } from './xml.ts';

export type XlsxKind = 'text' | 'number' | 'amount' | 'date' | 'percent' | 'integer';
export type XlsxValue = string | number | boolean | null;

export interface XlsxCellObject {
  v: XlsxValue;
  kind?: XlsxKind;
  bold?: boolean;
  /** Indent level 0–15 (e.g. ledger under group in a trial balance). */
  indent?: number;
}

/**
 * A cell: plain value or an object with formatting. Kinds:
 *  - text: always a string cell (numbers are converted with String()).
 *  - number: General format. amount: Indian grouping with 2 decimals (value in rupees, not paise).
 *  - integer: '0'. percent: '0.00%' (value is a fraction: 0.18 → 18.00%).
 *  - date: 'YYYY-MM-DD' string (or an Excel serial number) shown as dd-mmm-yyyy.
 * Strings given for numeric kinds are written as numbers only when they are plain decimals ("-12.50").
 * null, undefined and '' produce an empty cell.
 */
export type XlsxCell = XlsxValue | undefined | XlsxCellObject;

export interface XlsxColumn {
  header: string;
  /** Width in characters; computed from the content when omitted. */
  width?: number;
  /** Default kind for the cells of this column. */
  kind?: XlsxKind;
}

export interface XlsxSheet {
  /** Sanitised: []:*?/\ replaced by '_', ≤ 31 characters, unique (case-insensitive). */
  name: string;
  columns?: XlsxColumn[];
  rows: XlsxCell[][];
  /** Freeze panes below the header row. */
  freezeHeader?: boolean;
  /** Excel auto-filter on the header row. */
  autoFilter?: boolean;
  /** Lines above the header (company, report name, period), followed by one blank row. */
  title?: string[];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  creator?: string;
  /** Document timestamp (default now). */
  created?: Date;
}

export interface ReadXlsxOptions {
  /** Read at most this many rows per sheet (rows are counted from the top of the sheet). */
  maxRows?: number;
  /**
   * Maximum cells materialised across the workbook, counting the null padding of sparse rows (default 20 000 000).
   * Guards against tiny files that place cells far apart (e.g. one cell at XFD in every row) to exhaust memory.
   */
  maxCells?: number;
  /** Override the ZIP safety limits. */
  zip?: ReadZipOptions;
}

export interface XlsxReadSheet {
  name: string;
  /** rows[i] is spreadsheet row i+1; gaps are null; trailing empty cells/rows are omitted. */
  rows: XlsxValue[][];
}

export interface XlsxReadResult {
  sheets: XlsxReadSheet[];
}

export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;
export const DEFAULT_MAX_CELLS = 20_000_000;
const MAX_CELL_TEXT = 32_767;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Indian grouping (12,34,56,789.00) for positives; the negative variant keeps grouping and the minus sign. */
export const AMOUNT_FORMAT = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
export const AMOUNT_FORMAT_NEGATIVE = '[<=-10000000]-##\\,##\\,##\\,##0.00;[<=-100000]-##\\,##\\,##0.00;##,##0.00';
export const DATE_FORMAT = 'dd-mmm-yyyy';

const FMT_GENERAL = 0;
const FMT_INTEGER = 1; // built-in "0"
const FMT_PERCENT = 10; // built-in "0.00%"
const FMT_AMOUNT = 164;
const FMT_AMOUNT_NEG = 165;
const FMT_DATE = 166;

const FONT_REGULAR = 0;
const FONT_BOLD = 1;
const FONT_TITLE = 2;

// ───────────────────────────── Shared helpers ─────────────────────────────

/** 0-based column index → letters (0 → A, 25 → Z, 26 → AA, 16383 → XFD). */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Letters of a cell reference ('BC12' → 54) as a 0-based column index; -1 when there are none. */
function columnIndexOfRef(ref: string): number {
  let n = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    let c = ref.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
    if (n > MAX_COLUMNS) return MAX_COLUMNS;
  }
  return i === 0 ? -1 : n - 1;
}

function rowNumberOfRef(ref: string): number {
  const m = /[0-9]+$/.exec(ref);
  return m ? parseInt(m[0], 10) : NaN;
}

const DAY_MS = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const MAX_SERIAL = 2_958_465; // 9999-12-31

/** 'YYYY-MM-DD' → Excel 1900-system serial (Lotus bug: serials < 61 are one lower). null if invalid/out of range. */
export function dateToSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let serial = Math.round((t - EPOCH_1900) / DAY_MS);
  if (serial < 61) serial -= 1;
  return serial >= 1 && serial <= MAX_SERIAL ? serial : null;
}

/**
 * Excel serial → 'YYYY-MM-DD' (time of day dropped). 1900 system honours Excel's fictitious 1900-02-29
 * (serial 60, returned as '1900-02-29' exactly as Excel displays it); `date1904` uses the Mac epoch.
 * null when the serial is not a representable date (e.g. a time-only value < 1).
 */
export function serialToDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  let days = Math.floor(serial);
  let t: number;
  if (date1904) {
    if (days < 0 || days + 1462 > MAX_SERIAL) return null;
    t = EPOCH_1904 + days * DAY_MS;
  } else {
    if (days < 1 || days > MAX_SERIAL) return null;
    if (days === 60) return '1900-02-29';
    if (days < 60) days += 1;
    t = EPOCH_1900 + days * DAY_MS;
  }
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return `${String(y).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Built-in number formats that display dates/times (ECMA-376 §18.8.30 plus East-Asian locale ids). */
function isBuiltinDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
}

/** True when a custom number format code displays a date (d/m/y tokens outside quotes, escapes and [..]). */
export function isDateFormatCode(code: string): boolean {
  const firstSection = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0];
  if (/^\s*general\s*$/i.test(firstSection)) return false;
  return /[dmy]/i.test(firstSection);
}

// ───────────────────────────── Writer ─────────────────────────────

/** Sanitise and de-duplicate sheet names exactly as writeXlsx does. */
export function sanitizeSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => sanitizeSheetName(n, used));
}

function cutTo(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function cleanSheetName(s: string): string {
  return s.replace(/^'+|'+$/g, '').trim();
}

function sanitizeSheetName(raw: string, used: Set<string>): string {
  let base = stripInvalidXmlChars(String(raw ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[[\]:*?/\\]/g, '_');
  base = cleanSheetName(cleanSheetName(base));
  if (!base) base = 'Sheet';
  if (base.toLowerCase() === 'history') base = 'History_';
  base = cleanSheetName(cutTo(base, 31)) || 'Sheet';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = cutTo(base, 31 - suffix.length).trimEnd() + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

interface ResolvedCell {
  v: XlsxValue | undefined;
  kind: XlsxKind | undefined;
  bold: boolean;
  indent: number;
}

function resolveCell(cell: XlsxCell, columnKind: XlsxKind | undefined): ResolvedCell {
  if (cell !== null && typeof cell === 'object') {
    const indent = Number.isFinite(cell.indent) ? Math.max(0, Math.min(15, Math.trunc(cell.indent as number))) : 0;
    return { v: cell.v, kind: cell.kind ?? columnKind, bold: cell.bold === true, indent };
  }
  return { v: cell, kind: columnKind, bold: false, indent: 0 };
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Text as it goes into sharedStrings: invalid chars stripped, length capped, literal _xHHHH_ escaped. */
function xlsxText(s: string): string {
  let t = cutTo(stripInvalidXmlChars(s), MAX_CELL_TEXT);
  if (t.indexOf('_x') !== -1) t = t.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');
  return t;
}

interface StyleSpec {
  numFmtId: number;
  fontId: number;
  indent: number;
  align: '' | 'left' | 'right';
  /** Excel "quote prefix" (formula-injection guard): the cell shows its text verbatim and stays text if edited. */
  quote?: boolean;
}

function createStyles(): { id(spec: StyleSpec): number; xml(): string } {
  const specs: StyleSpec[] = [{ numFmtId: FMT_GENERAL, fontId: FONT_REGULAR, indent: 0, align: '' }];
  const index = new Map<number, number>([[0, 0]]);
  return {
    id(spec) {
      // numFmtId < 1024, fontId < 4, indent < 16, align < 3 → one small integer key (hot path: once per cell).
      const key = (((spec.numFmtId * 4 + spec.fontId) * 16 + spec.indent) * 3 + (spec.align === '' ? 0 : spec.align === 'left' ? 1 : 2)) * 2 + (spec.quote ? 1 : 0);
      let id = index.get(key);
      if (id === undefined) {
        id = specs.length;
        specs.push(spec);
        index.set(key, id);
      }
      return id;
    },
    xml() {
      const font = (bold: boolean, size: number): string =>
        `<font>${bold ? '<b/>' : ''}<sz val="${size}"/><name val="Calibri"/><family val="2"/></font>`;
      const xfs = specs.map((s) => {
        const attrs =
          `numFmtId="${s.numFmtId}" fontId="${s.fontId}" fillId="0" borderId="0" xfId="0"` +
          (s.numFmtId !== FMT_GENERAL ? ' applyNumberFormat="1"' : '') +
          (s.fontId !== FONT_REGULAR ? ' applyFont="1"' : '') +
          (s.quote ? ' quotePrefix="1"' : '');
        if (!s.align) return `<xf ${attrs}/>`;
        const indent = s.indent > 0 ? ` indent="${s.indent}"` : '';
        return `<xf ${attrs} applyAlignment="1"><alignment horizontal="${s.align}"${indent}/></xf>`;
      });
      return (
        XML_DECLARATION +
        `<styleSheet xmlns="${NS_MAIN}">` +
        `<numFmts count="3">` +
        `<numFmt numFmtId="${FMT_AMOUNT}" formatCode="${escapeAttr(AMOUNT_FORMAT)}"/>` +
        `<numFmt numFmtId="${FMT_AMOUNT_NEG}" formatCode="${escapeAttr(AMOUNT_FORMAT_NEGATIVE)}"/>` +
        `<numFmt numFmtId="${FMT_DATE}" formatCode="${escapeAttr(DATE_FORMAT)}"/>` +
        `</numFmts>` +
        `<fonts count="3">${font(false, 11)}${font(true, 11)}${font(true, 14)}</fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
        `</styleSheet>`
      );
    },
  };
}

function createSharedStrings(): { index(s: string): number; xml(): string } {
  const map = new Map<string, number>();
  const list: string[] = [];
  let count = 0;
  return {
    index(s) {
      count++;
      let i = map.get(s);
      if (i === undefined) {
        i = list.length;
        list.push(s);
        map.set(s, i);
      }
      return i;
    },
    xml() {
      const parts: string[] = [XML_DECLARATION, `<sst xmlns="${NS_MAIN}" count="${count}" uniqueCount="${list.length}">`];
      for (const s of list) {
        const preserve = s !== s.trim() || /[\n\t]| {2}/.test(s) ? ' xml:space="preserve"' : '';
        parts.push(`<si><t${preserve}>${escapeXml(s)}</t></si>`);
      }
      parts.push('</sst>');
      return parts.join('');
    },
  };
}

const NUMERIC_KINDS: ReadonlySet<XlsxKind | undefined> = new Set<XlsxKind | undefined>(['number', 'amount', 'integer', 'percent']);

function numberText(n: number): string {
  return Object.is(n, -0) ? '0' : String(n);
}

function estimateWidth(v: XlsxValue | undefined, kind: XlsxKind | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 5;
  if (kind === 'date') return 11;
  if (typeof v === 'number') {
    if (kind === 'amount') {
      const digits = Math.trunc(Math.abs(v)).toString().length;
      return digits + 3 + (digits > 3 ? 1 + Math.floor((digits - 4) / 2) : 0) + (v < 0 ? 1 : 0);
    }
    if (kind === 'percent') return (v * 100).toFixed(2).length + 1;
    return numberText(v).length;
  }
  let max = 0;
  for (const line of v.split('\n')) max = Math.max(max, line.length);
  return max;
}

type CellXml = (ref: string, cell: XlsxCell, columnKind: XlsxKind | undefined, col: number, fontOverride?: number) => string;

/**
 * Cell → `<c>` XML (shared by writeXlsx and XlsxStreamWriter). Tracks content widths in `widths`;
 * text cells are emitted by `textCell` (shared string or inline string) with the style id.
 */
function createCellXml(styles: ReturnType<typeof createStyles>, widths: number[], textCell: (ref: string, style: number, text: string) => string): CellXml {
  const serials = new Map<string, number | null>(); // report dates repeat a lot
  const serialOf = (iso: string): number | null => {
    let n = serials.get(iso);
    if (n === undefined) {
      n = dateToSerial(iso);
      serials.set(iso, n);
    }
    return n;
  };
  return (ref: string, cell: XlsxCell, columnKind: XlsxKind | undefined, col: number, fontOverride?: number): string => {
    const r = resolveCell(cell, columnKind);
    let v = r.v;
    if (v === null || v === undefined || v === '') return '';
    let kind = r.kind;
    const fontId = fontOverride ?? (r.bold ? FONT_BOLD : FONT_REGULAR);
    if (typeof v === 'boolean') {
      if (col < widths.length) widths[col] = Math.max(widths[col], 5);
      const s = styles.id({ numFmtId: FMT_GENERAL, fontId, indent: r.indent, align: r.indent ? 'left' : '' });
      return `<c r="${ref}"${s ? ` s="${s}"` : ''} t="b"><v>${v ? 1 : 0}</v></c>`;
    }
    let num: number | null = null;
    let numFmtId = FMT_GENERAL;
    if (kind === 'date') {
      if (typeof v === 'number') num = Number.isFinite(v) ? v : null;
      else num = serialOf(v.trim());
      if (num !== null) numFmtId = FMT_DATE;
    } else if (kind !== 'text' && (typeof v === 'number' || NUMERIC_KINDS.has(kind))) {
      if (typeof v === 'number') num = Number.isFinite(v) ? v : null;
      else if (PLAIN_DECIMAL.test(v.trim())) num = Number(v.trim());
      if (num === null && typeof v === 'number') return '';
      if (num !== null) {
        numFmtId =
          kind === 'amount' ? (num < 0 ? FMT_AMOUNT_NEG : FMT_AMOUNT)
          : kind === 'integer' ? FMT_INTEGER
          : kind === 'percent' ? FMT_PERCENT
          : FMT_GENERAL;
      }
    }
    if (num !== null) {
      if (col < widths.length) widths[col] = Math.max(widths[col], estimateWidth(num, kind ?? 'number'));
      const s = styles.id({ numFmtId, fontId, indent: r.indent, align: r.indent ? 'right' : '' });
      return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${numberText(num)}</v></c>`;
    }
    // Text (also numbers forced to 'text' and values that did not parse for their kind).
    if (typeof v === 'number') v = numberText(v);
    kind = 'text';
    const text = xlsxText(v);
    if (text === '') return '';
    if (col < widths.length) widths[col] = Math.max(widths[col], estimateWidth(text, kind));
    const s = styles.id({ numFmtId: FMT_GENERAL, fontId, indent: r.indent, align: r.indent ? 'left' : '', quote: needsFormulaGuard(text) });
    return textCell(ref, s, text);
  };
}

interface WrittenSheet {
  name: string;
  xml: string;
  filterRange: string | null;
}

function buildSheet(
  sheet: XlsxSheet,
  name: string,
  index: number,
  styles: ReturnType<typeof createStyles>,
  sst: ReturnType<typeof createSharedStrings>,
): WrittenSheet {
  const columns = sheet.columns ?? [];
  const title = sheet.title ?? [];
  const hasHeader = columns.length > 0;
  const headerRowNum = hasHeader ? (title.length > 0 ? title.length + 2 : 1) : 0;
  const firstDataRow = hasHeader ? headerRowNum + 1 : title.length > 0 ? title.length + 2 : 1;
  const lastRowNum = Math.max(firstDataRow + sheet.rows.length - 1, headerRowNum, title.length);
  if (lastRowNum > MAX_ROWS) throw new RangeError(`Sheet ${JSON.stringify(name)} has more than ${MAX_ROWS} rows`);

  let colCount = columns.length;
  for (const row of sheet.rows) if (row.length > colCount) colCount = row.length;
  if (colCount > MAX_COLUMNS) throw new RangeError(`Sheet ${JSON.stringify(name)} has more than ${MAX_COLUMNS} columns`);
  const colNames: string[] = [];
  for (let c = 0; c < Math.max(colCount, 1); c++) colNames.push(columnName(c));

  const widths: number[] = new Array(colCount).fill(0);
  const out: string[] = [];
  const cellXml = createCellXml(styles, widths, (ref, st, text) => `<c r="${ref}"${st ? ` s="${st}"` : ''} t="s"><v>${sst.index(text)}</v></c>`);

  // Title lines (first one larger), then a blank row.
  for (let t = 0; t < title.length; t++) {
    const rowNum = t + 1;
    const ref = `A${rowNum}`;
    const c = cellXml(ref, { v: title[t], kind: 'text' }, undefined, colCount, t === 0 ? FONT_TITLE : FONT_BOLD);
    out.push(c ? `<row r="${rowNum}">${c}</row>` : '');
  }
  if (hasHeader) {
    let cells = '';
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const header = xlsxText(String(col.header ?? ''));
      if (c < widths.length) widths[c] = Math.max(widths[c], header.length + 2);
      if (!header) continue;
      const align = NUMERIC_KINDS.has(col.kind) ? 'right' : '';
      const s = styles.id({ numFmtId: FMT_GENERAL, fontId: FONT_BOLD, indent: 0, align, quote: needsFormulaGuard(header) });
      cells += `<c r="${colNames[c]}${headerRowNum}" s="${s}" t="s"><v>${sst.index(header)}</v></c>`;
    }
    out.push(`<row r="${headerRowNum}">${cells}</row>`);
  }
  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const rowNum = firstDataRow + i;
    let cells = '';
    for (let c = 0; c < row.length; c++) {
      cells += cellXml(`${colNames[c]}${rowNum}`, row[c], columns[c]?.kind, c);
    }
    if (cells) out.push(`<row r="${rowNum}">${cells}</row>`);
  }

  const lastCol = colNames[Math.max(colCount, 1) - 1];
  const dimension = lastRowNum > 0 && colCount > 0 ? `A1:${lastCol}${lastRowNum}` : 'A1';
  let views = `<sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}`;
  if (sheet.freezeHeader && hasHeader) {
    const top = `A${headerRowNum + 1}`;
    views +=
      `><pane ySplit="${headerRowNum}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="${top}" sqref="${top}"/></sheetView>`;
  } else {
    views += '/>';
  }
  let cols = '';
  for (let c = 0; c < colCount; c++) {
    const given = columns[c]?.width;
    const width = given !== undefined && Number.isFinite(given) && given > 0
      ? Math.min(given, 255)
      : Math.max(8, Math.min(60, widths[c] + 2));
    cols += `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
  }
  const filterRange = sheet.autoFilter && hasHeader ? `A${headerRowNum}:${lastCol}${Math.max(lastRowNum, headerRowNum)}` : null;
  const xml =
    XML_DECLARATION +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews>${views}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${out.join('')}</sheetData>` +
    (filterRange ? `<autoFilter ref="${filterRange}"/>` : '') +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;
  return { name, xml, filterRange };
}

function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Every package part except the worksheets (content types, rels, doc props, workbook, styles and —
 * when `sstXml` is given — shared strings). `written` lists the sheets in order.
 */
function packageParts(
  written: ReadonlyArray<{ name: string; filterRange: string | null }>,
  stylesXml: string,
  sstXml: string | null,
  created: Date,
  creator: string,
): ZipInputEntry[] {
  const sheetEntries = written
    .map((s, i) => `<sheet name="${escapeAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const definedNames = written
    .map((s, i) => {
      if (!s.filterRange) return '';
      const [from, to] = s.filterRange.split(':');
      const abs = (ref: string): string => ref.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
      const quoted = `'${s.name.replace(/'/g, "''")}'`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(`${quoted}!${abs(from)}:${abs(to)}`)}</definedName>`;
    })
    .join('');
  const workbookXml =
    XML_DECLARATION +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<workbookPr/>` +
    `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="0"/></bookViews>` +
    `<sheets>${sheetEntries}</sheets>` +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
    `</workbook>`;

  const n = written.length;
  const workbookRels =
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    written.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_BASE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${n + 1}" Type="${REL_BASE}/styles" Target="styles.xml"/>` +
    (sstXml !== null ? `<Relationship Id="rId${n + 2}" Type="${REL_BASE}/sharedStrings" Target="sharedStrings.xml"/>` : '') +
    `</Relationships>`;

  const contentTypes =
    XML_DECLARATION +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    written
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    (sstXml !== null ? `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` : '') +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;

  const rootRels =
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_BASE}/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  const stamp = isoSeconds(created);
  const coreXml =
    XML_DECLARATION +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:creator>${escapeXml(creator)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    `</cp:coreProperties>`;

  const appXml =
    XML_DECLARATION +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Pevqori</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
    `<HeadingPairs><vt:vector size="2" baseType="variant">` +
    `<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${n}</vt:i4></vt:variant>` +
    `</vt:vector></HeadingPairs>` +
    `<TitlesOfParts><vt:vector size="${n}" baseType="lpstr">` +
    written.map((s) => `<vt:lpstr>${escapeXml(s.name)}</vt:lpstr>`).join('') +
    `</vt:vector></TitlesOfParts>` +
    `<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion>` +
    `</Properties>`;

  return [
    { name: '[Content_Types].xml', data: contentTypes, date: created },
    { name: '_rels/.rels', data: rootRels, date: created },
    { name: 'docProps/core.xml', data: coreXml, date: created },
    { name: 'docProps/app.xml', data: appXml, date: created },
    { name: 'xl/workbook.xml', data: workbookXml, date: created },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels, date: created },
    { name: 'xl/styles.xml', data: stylesXml, date: created },
    ...(sstXml !== null ? [{ name: 'xl/sharedStrings.xml', data: sstXml, date: created }] : []),
  ];
}

/** Build an .xlsx workbook. Throws RangeError for sheets beyond Excel's row/column limits. */
export function writeXlsx(workbook: XlsxWorkbook): Uint8Array {
  const sheets = workbook.sheets.length > 0 ? workbook.sheets : [{ name: 'Sheet1', rows: [] }];
  const names = sanitizeSheetNames(sheets.map((s) => s.name));
  const styles = createStyles();
  const sst = createSharedStrings();
  const written = sheets.map((s, i) => buildSheet(s, names[i], i, styles, sst));
  const created = workbook.created ?? new Date();
  const creator = workbook.creator ?? 'Pevqori';
  const entries: ZipInputEntry[] = [
    ...packageParts(written, styles.xml(), sst.xml(), created, creator),
    ...written.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml, date: created })),
  ];
  return createZip(entries);
}

// ───────────────────────────── Streaming writer ─────────────────────────────

export interface XlsxStreamSheet {
  name: string;
  /** Header row; widths come from `width` or the header text (content is not measured when streaming). */
  columns: XlsxColumn[];
  freezeHeader?: boolean;
  autoFilter?: boolean;
}

/** Text cell as an inline string (no shared-strings table is kept in memory). */
function inlineTextCell(ref: string, style: number, text: string): string {
  const preserve = text !== text.trim() || /[\n\t]| {2}/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`;
}

/**
 * .xlsx written row by row straight into a ZipFileWriter, for exports too large to build in memory
 * (writeXlsx keeps every row, the shared-strings table and the sheet XML in memory at once). Memory is
 * bounded by one row plus the ZIP writer's chunk. Same cell rules and styles as writeXlsx, with these
 * differences: text is written as inline strings (still never as formulas), column widths are not
 * measured from the content, and there are no title lines. Usage: beginSheet → addRow… → endSheet,
 * repeated, then finish(); the caller then finishes (or aborts) the ZipFileWriter.
 */
export class XlsxStreamWriter {
  private readonly zip: ZipFileWriter;
  private readonly created: Date;
  private readonly creator: string;
  private readonly styles = createStyles();
  private readonly sheets: Array<{ name: string; filterRange: string | null }> = [];
  private readonly usedNames = new Set<string>();
  private open: { name: string; cols: number; colNames: string[]; columns: XlsxColumn[]; rowNum: number; autoFilter: boolean; cellXml: CellXml } | null = null;

  constructor(zip: ZipFileWriter, opts: { creator?: string; created?: Date } = {}) {
    this.zip = zip;
    this.created = opts.created ?? new Date();
    this.creator = opts.creator ?? 'Pevqori';
  }

  beginSheet(sheet: XlsxStreamSheet): void {
    if (this.open) throw new Error('XlsxStreamWriter: the previous sheet is still open');
    const name = sanitizeSheetName(sheet.name, this.usedNames);
    const columns = sheet.columns;
    const cols = columns.length;
    if (cols > MAX_COLUMNS) throw new RangeError(`Sheet ${JSON.stringify(name)} has more than ${MAX_COLUMNS} columns`);
    const colNames: string[] = [];
    for (let c = 0; c < Math.max(cols, 1); c++) colNames.push(columnName(c));
    const index = this.sheets.length;
    this.zip.beginEntry(`xl/worksheets/sheet${index + 1}.xml`, this.created);
    const hasHeader = cols > 0;
    let views = `<sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}`;
    views += sheet.freezeHeader && hasHeader
      ? `><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
      : '/>';
    let colXml = '';
    for (let c = 0; c < cols; c++) {
      const given = columns[c].width;
      const width = given !== undefined && Number.isFinite(given) && given > 0 ? Math.min(given, 255) : Math.max(8, Math.min(60, xlsxText(String(columns[c].header ?? '')).length + 4));
      colXml += `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
    }
    this.zip.write(
      XML_DECLARATION +
        `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
        `<sheetViews>${views}</sheetViews>` +
        `<sheetFormatPr defaultRowHeight="15"/>` +
        (colXml ? `<cols>${colXml}</cols>` : '') +
        `<sheetData>`,
    );
    const cellXml = createCellXml(this.styles, [], inlineTextCell);
    let rowNum = 0;
    if (hasHeader) {
      let cells = '';
      for (let c = 0; c < cols; c++) {
        const header = xlsxText(String(columns[c].header ?? ''));
        if (!header) continue;
        const st = this.styles.id({ numFmtId: FMT_GENERAL, fontId: FONT_BOLD, indent: 0, align: NUMERIC_KINDS.has(columns[c].kind) ? 'right' : '', quote: needsFormulaGuard(header) });
        cells += inlineTextCell(`${colNames[c]}1`, st, header);
      }
      rowNum = 1;
      this.zip.write(`<row r="1">${cells}</row>`);
    }
    this.open = { name, cols, colNames, columns, rowNum, autoFilter: sheet.autoFilter === true && hasHeader, cellXml };
  }

  /** Rows written to the open sheet so far (header included). */
  get rowCount(): number {
    return this.open?.rowNum ?? 0;
  }

  addRow(cells: readonly XlsxCell[]): void {
    const o = this.open;
    if (!o) throw new Error('XlsxStreamWriter: no sheet is open');
    if (o.rowNum >= MAX_ROWS) throw new RangeError(`Sheet ${JSON.stringify(o.name)} has more than ${MAX_ROWS} rows`);
    o.rowNum++;
    while (o.colNames.length < cells.length && o.colNames.length < MAX_COLUMNS) o.colNames.push(columnName(o.colNames.length));
    let xml = '';
    const n = Math.min(cells.length, MAX_COLUMNS);
    for (let c = 0; c < n; c++) xml += o.cellXml(`${o.colNames[c]}${o.rowNum}`, cells[c], o.columns[c]?.kind, c);
    if (xml) this.zip.write(`<row r="${o.rowNum}">${xml}</row>`);
  }

  endSheet(): void {
    const o = this.open;
    if (!o) throw new Error('XlsxStreamWriter: no sheet is open');
    const lastCol = o.colNames[Math.max(o.cols, 1) - 1];
    const filterRange = o.autoFilter ? `A1:${lastCol}${Math.max(o.rowNum, 1)}` : null;
    this.zip.write(
      `</sheetData>` +
        (filterRange ? `<autoFilter ref="${filterRange}"/>` : '') +
        `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
        `</worksheet>`,
    );
    this.zip.endEntry();
    this.sheets.push({ name: o.name, filterRange });
    this.open = null;
  }

  /** Write the remaining package parts (after the last sheet). */
  finish(): void {
    if (this.open) this.endSheet();
    if (this.sheets.length === 0) {
      this.beginSheet({ name: 'Sheet1', columns: [] });
      this.endSheet();
    }
    for (const part of packageParts(this.sheets, this.styles.xml(), null, this.created, this.creator)) this.zip.addEntry(part.name, part.data, part.date);
  }
}

// ───────────────────────────── Reader ─────────────────────────────

const xlsxError = (message: string): FileFormatError => new FileFormatError('xlsx', message);

/** SAX passes over sheet/sharedStrings parts: memory is bounded by the ZIP limits, so allow many elements. */
const SAX_LIMITS = { maxDepth: 64, maxNodes: 200_000_000 };

function partText(zip: ZipArchive, path: string): string {
  try {
    return zip.readText(path);
  } catch (err) {
    // A part larger than V8's maximum string length cannot be decoded at all.
    if (err instanceof RangeError) throw xlsxError(`${path} is too large to read`);
    throw err;
  }
}

function partXml(zip: ZipArchive, path: string): XmlElement {
  try {
    return parseXml(partText(zip, path));
  } catch (err) {
    if (err instanceof FileFormatError && err.format === 'xml') throw xlsxError(`Invalid XML in ${path}: ${err.message}`);
    throw err;
  }
}

function saxPart(zip: ZipArchive, path: string, handlers: Parameters<typeof saxParse>[1]): void {
  try {
    saxParse(partText(zip, path), handlers, SAX_LIMITS);
  } catch (err) {
    if (err instanceof FileFormatError && err.format === 'xml') throw xlsxError(`Invalid XML in ${path}: ${err.message}`);
    throw err;
  }
}

function kids(el: XmlElement | undefined, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (!el) return out;
  for (const c of el.children) if (typeof c !== 'string' && localName(c.name) === local) out.push(c);
  return out;
}

/** Attribute by local name (any prefix), e.g. 'r:id' / 'relationships:id' for local 'id' when `prefixed`. */
function attrByLocal(el: XmlElement, local: string, prefixed: boolean): string | undefined {
  for (const key of Object.keys(el.attrs)) {
    const hasPrefix = key.includes(':');
    if (hasPrefix === prefixed && localName(key) === local) return el.attrs[key];
  }
  return undefined;
}

function normalisePartPath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

interface Relationship {
  type: string;
  target: string;
}

/** Relationships of `partPath` (e.g. xl/workbook.xml → xl/_rels/workbook.xml.rels), targets resolved to part names. */
function readRels(zip: ZipArchive, partPath: string): Map<string, Relationship> {
  const slash = partPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : partPath.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${partPath.slice(slash + 1)}.rels`;
  const rels = new Map<string, Relationship>();
  if (!zip.has(relsPath)) return rels;
  for (const rel of kids(partXml(zip, relsPath), 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target || rel.attrs.TargetMode === 'External') continue;
    const decoded = safeDecodeUri(target);
    const resolved = decoded.startsWith('/') ? normalisePartPath(decoded) : normalisePartPath(dir + decoded);
    rels.set(id, { type: rel.attrs.Type ?? '', target: resolved });
  }
  return rels;
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function findRel(rels: Map<string, Relationship>, typeSuffix: string): Relationship | undefined {
  for (const rel of rels.values()) if (rel.type.endsWith(typeSuffix)) return rel;
  return undefined;
}

/** Decode OOXML `_xHHHH_` escapes (used by Excel for control characters; `_x005F_` is a literal '_'). */
function decodeOoxmlEscapes(s: string): string {
  return s.indexOf('_x') === -1 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function readSharedStrings(zip: ZipArchive, path: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let inT = false;
  let phonetic = 0;
  let parts: string[] = [];
  saxPart(zip, path, {
    open(name) {
      const n = localName(name);
      if (n === 'si') {
        inSi = true;
        parts = [];
      } else if (n === 'rPh') phonetic++;
      else if (n === 't' && inSi && phonetic === 0) inT = true;
    },
    close(name) {
      const n = localName(name);
      if (n === 'si') {
        out.push(decodeOoxmlEscapes(parts.join('')));
        inSi = false;
      } else if (n === 'rPh') phonetic--;
      else if (n === 't') inT = false;
    },
    text(t) {
      if (inT) parts.push(t);
    },
  });
  return out;
}

/** For each cellXfs index: does its number format display a date? */
function readDateStyles(zip: ZipArchive, path: string): boolean[] {
  const root = partXml(zip, path);
  const custom = new Map<number, string>();
  for (const numFmts of kids(root, 'numFmts')) {
    for (const f of kids(numFmts, 'numFmt')) {
      const id = Number(f.attrs.numFmtId);
      if (Number.isInteger(id)) custom.set(id, f.attrs.formatCode ?? '');
    }
  }
  const out: boolean[] = [];
  for (const xfs of kids(root, 'cellXfs')) {
    for (const xf of kids(xfs, 'xf')) {
      const id = Number(xf.attrs.numFmtId ?? 0);
      const code = custom.get(id);
      out.push(code !== undefined ? isDateFormatCode(code) : isBuiltinDateFormat(id));
    }
  }
  return out;
}

const STOP = Symbol('stop');

interface CellBudget {
  remaining: number;
  readonly max: number;
}

function readSheetRows(
  zip: ZipArchive,
  path: string,
  sst: readonly string[],
  dateStyles: readonly boolean[],
  date1904: boolean,
  maxRows: number,
  budget: CellBudget,
): XlsxValue[][] {
  const rows: XlsxValue[][] = [];
  let rowIdx = -1;
  let colIdx = -1;
  let type = 'n';
  let style = 0;
  let inV = false;
  let inIs = false;
  let inIsT = false;
  let phonetic = 0;
  let vText = '';
  let isText = '';

  const put = (r: number, c: number, value: XlsxValue): void => {
    const row = rows[r] ?? [];
    budget.remaining -= Math.max(0, r + 1 - rows.length) + Math.max(0, c + 1 - row.length);
    if (budget.remaining < 0) throw xlsxError(`The workbook has more than ${budget.max} cells; refusing to load it`);
    while (rows.length <= r) rows.push(rows.length === r ? row : []);
    while (row.length < c) row.push(null);
    row[c] = value;
  };

  const cellValue = (): XlsxValue => {
    switch (type) {
      case 's': {
        const i = Number(vText.trim());
        return Number.isInteger(i) && i >= 0 && i < sst.length ? sst[i] : null;
      }
      case 'str':
        return vText === '' ? null : decodeOoxmlEscapes(vText);
      case 'inlineStr':
        return inlineOrV();
      case 'b': {
        const t = vText.trim().toLowerCase();
        return t === '' ? null : t === '1' || t === 'true';
      }
      case 'e':
        return null;
      case 'd': {
        const t = vText.trim();
        if (t === '') return null;
        return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
      }
      default: {
        const t = vText.trim();
        if (t === '') return isText !== '' ? decodeOoxmlEscapes(isText) : null;
        const n = Number(t);
        if (!Number.isFinite(n)) return t;
        if (dateStyles[style]) {
          const d = serialToDate(n, date1904);
          if (d !== null) return d;
        }
        return n;
      }
    }
  };
  const inlineOrV = (): XlsxValue => {
    if (isText !== '') return decodeOoxmlEscapes(isText);
    return vText === '' ? null : decodeOoxmlEscapes(vText);
  };

  try {
    saxPart(zip, path, {
      open(name, attrs) {
        switch (localName(name)) {
          case 'row': {
            const r = Number(attrs.r);
            rowIdx = Number.isInteger(r) && r >= 1 ? r - 1 : rowIdx + 1;
            if (rowIdx >= MAX_ROWS) throw xlsxError(`Row ${rowIdx + 1} in ${path} is beyond Excel's row limit`);
            if (rowIdx >= maxRows) throw STOP;
            colIdx = -1;
            break;
          }
          case 'c': {
            const ref = attrs.r;
            if (ref) {
              const c = columnIndexOfRef(ref);
              colIdx = c >= 0 ? c : colIdx + 1;
              const r = rowNumberOfRef(ref);
              if (Number.isInteger(r) && r >= 1) {
                rowIdx = r - 1;
                if (rowIdx >= MAX_ROWS) throw xlsxError(`Cell ${ref} in ${path} is beyond Excel's row limit`);
                if (rowIdx >= maxRows) throw STOP;
              }
            } else {
              colIdx++;
            }
            if (rowIdx < 0) rowIdx = 0;
            if (colIdx >= MAX_COLUMNS) throw xlsxError(`Cell ${ref ?? ''} in ${path} is beyond Excel's column limit`);
            type = attrs.t ?? 'n';
            style = attrs.s ? Number(attrs.s) : 0;
            vText = '';
            isText = '';
            break;
          }
          case 'v':
            inV = true;
            break;
          case 'is':
            inIs = true;
            break;
          case 'rPh':
            phonetic++;
            break;
          case 't':
            if (inIs && phonetic === 0) inIsT = true;
            break;
        }
      },
      text(t) {
        if (inV) vText += t;
        else if (inIsT) isText += t;
      },
      close(name) {
        switch (localName(name)) {
          case 'v':
            inV = false;
            break;
          case 't':
            inIsT = false;
            break;
          case 'is':
            inIs = false;
            break;
          case 'rPh':
            phonetic--;
            break;
          case 'c': {
            const value = cellValue();
            if (value !== null) put(rowIdx, colIdx, value);
            break;
          }
        }
      },
    });
  } catch (err) {
    if (err !== STOP) throw err;
  }
  return rows;
}

function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, 512)).text.trimStart();
  return head.startsWith('<');
}

/** Read every worksheet of an .xlsx file into rows of plain values. Throws FileFormatError for invalid files. */
export function readXlsx(bytes: Uint8Array, opts: ReadXlsxOptions = {}): XlsxReadResult {
  let zip: ZipArchive;
  try {
    zip = readZip(bytes, opts.zip);
  } catch (err) {
    // Many bank/portal "Excel" downloads are really HTML tables or SpreadsheetML 2003 XML with an .xls(x) name.
    if (err instanceof FileFormatError && /^Not a ZIP archive/.test(err.message) && looksLikeMarkup(bytes)) {
      throw xlsxError(
        'This file is an HTML/XML table saved with an Excel extension, not a real .xlsx workbook. ' +
          'Open it in Excel and save it as .xlsx, or export it as CSV.',
      );
    }
    throw err;
  }
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  const budget: CellBudget = { remaining: maxCells, max: maxCells };

  if (zip.has('mimetype') && /opendocument/.test(zip.readText('mimetype'))) {
    throw xlsxError('OpenDocument spreadsheets (.ods) are not supported; save the file as .xlsx');
  }
  const rootRels = readRels(zip, '');
  const wbPath = findRel(rootRels, '/officeDocument')?.target ?? 'xl/workbook.xml';
  if (/\.bin$/i.test(wbPath) || zip.has('xl/workbook.bin')) {
    throw xlsxError('Binary workbooks (.xlsb) are not supported; save the file as .xlsx');
  }
  if (!zip.has(wbPath)) throw xlsxError('Not an Excel workbook: the workbook part is missing');

  const workbook = partXml(zip, wbPath);
  if (localName(workbook.name) !== 'workbook') throw xlsxError(`Not an Excel workbook: unexpected root <${workbook.name}>`);
  const wbRels = readRels(zip, wbPath);
  const pr = kids(workbook, 'workbookPr')[0];
  const date1904 = pr !== undefined && (pr.attrs.date1904 === '1' || pr.attrs.date1904 === 'true');

  const wbDir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : '';
  const sstPath = findRel(wbRels, '/sharedStrings')?.target ?? `${wbDir}sharedStrings.xml`;
  const stylesPath = findRel(wbRels, '/styles')?.target ?? `${wbDir}styles.xml`;
  const sst = zip.has(sstPath) ? readSharedStrings(zip, sstPath) : [];
  const dateStyles = zip.has(stylesPath) ? readDateStyles(zip, stylesPath) : [];

  const sheets: XlsxReadSheet[] = [];
  const sheetEls = kids(kids(workbook, 'sheets')[0], 'sheet');
  for (let i = 0; i < sheetEls.length; i++) {
    const el = sheetEls[i];
    const name = el.attrs.name ?? `Sheet${i + 1}`;
    const rid = attrByLocal(el, 'id', true);
    const rel = rid !== undefined ? wbRels.get(rid) : undefined;
    let path: string | undefined;
    if (rel) {
      if (!rel.type.endsWith('/worksheet')) continue; // chartsheet, dialogsheet, macro sheet
      path = rel.target;
    } else {
      const guess = `${wbDir}worksheets/sheet${i + 1}.xml`;
      if (zip.has(guess)) path = guess;
    }
    if (!path || !zip.has(path)) throw xlsxError(`Worksheet "${name}" is missing from the workbook package`);
    sheets.push({ name, rows: readSheetRows(zip, path, sst, dateStyles, date1904, maxRows, budget) });
  }
  return { sheets };
}
