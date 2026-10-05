/**
 * Cell-level parsing for bank statements: dates in the many formats Indian banks use, amounts with Indian
 * grouping and Cr/Dr suffixes, and text normalisation used by header matching, dedupe hashes and the matcher.
 * Pure functions (no DB).
 */
import { isValidDate, toIso } from '../../../shared/dates.ts';
import { parseAmount, rupeesToPaise, type Paise } from '../../../shared/money.ts';
import { serialToDate } from '../../lib/xlsx.ts';

export type Cell = string | number | boolean | null;
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 'Apr', 'APRIL', 'Sept' → 4; anything else → 0. */
function monthFromName(tok: string): number {
  const t = tok.toLowerCase();
  if (t.length < 3) return 0;
  const idx = MONTHS.indexOf(t.slice(0, 3));
  if (idx < 0) return 0;
  // Must be a prefix of the full month name ('marching' is not March).
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][idx];
  return full.startsWith(t) || (idx === 8 && t === 'sept') ? idx + 1 : 0;
}

/** Two-digit years: banks only print recent dates, so 00–69 → 20xx, 70–99 → 19xx. */
function fullYear(raw: string): number {
  const n = Number(raw);
  if (raw.length >= 3) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function build(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200) return null;
  const iso = toIso(y, m, d);
  return isValidDate(iso) ? iso : null;
}

/** Excel serials only in a plausible statement range (1955 … 2119) so a stray number is not read as a date. */
const SERIAL_MIN = 20_000;
const SERIAL_MAX = 80_000;

/** Remove a trailing time ('10:20', '10:20:30', '10:20 AM', 'T10:20:30Z') from a date cell. */
function stripTime(s: string): string {
  return s
    .replace(/T\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i, '')
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$/i, '')
    .trim();
}

/**
 * Parse a statement date cell. Accepts:
 *   dd/mm/yyyy dd-mm-yyyy dd.mm.yyyy dd/mm/yy dd-mm-yy (or mm/dd with order 'mdy'), yyyy-mm-dd, yyyy/mm/dd,
 *   dd-MMM-yyyy dd-MMM-yy 'd MMM yyyy' dd/MMM/yyyy 'MMM d, yyyy', ddmmyyyy / yyyymmdd, Excel serial numbers,
 *   any of these followed by a time. Returns ISO 'YYYY-MM-DD' or null.
 */
export function parseStatementDate(cell: Cell, order: DateOrder = 'dmy'): string | null {
  if (cell === null || typeof cell === 'boolean') return null;
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell) || cell < SERIAL_MIN || cell > SERIAL_MAX) return null;
    return serialToDate(Math.floor(cell));
  }
  const s = stripTime(cell.trim());
  if (s === '' || s.length > 40) return null;

  // ISO-like year first.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  // Numeric day-month-year (or month-day-year).
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]);
    return order === 'mdy' ? build(y, a, b) : build(y, b, a);
  }

  // Compact 8 digits: ddmmyyyy or yyyymmdd (whichever is a real date; ddmmyyyy preferred for Indian banks).
  m = /^(\d{8})$/.exec(s);
  if (m) {
    const t = m[1];
    return build(Number(t.slice(4)), Number(t.slice(2, 4)), Number(t.slice(0, 2))) ?? build(Number(t.slice(0, 4)), Number(t.slice(4, 6)), Number(t.slice(6)));
  }

  // Day + month name + year: '01-Apr-2026', '1 Apr 26', '01/APR/2026', '1st April, 2026'.
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([A-Za-z]{3,9})\.?[\s\-/.,]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = monthFromName(m[2]);
    return mon ? build(fullYear(m[3]), mon, Number(m[1])) : null;
  }

  // Month name + day + year: 'Apr 01, 2026', 'April 1 2026'.
  m = /^([A-Za-z]{3,9})\.?[\s\-/.]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-/.]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = monthFromName(m[1]);
    return mon ? build(fullYear(m[3]), mon, Number(m[2])) : null;
  }
  return null;
}

/**
 * Decide day/month order from a column of date cells: a first part above 12 proves dd/mm, a second part
 * above 12 proves mm/dd. Indian banks use dd/mm, so that is the default when nothing proves otherwise.
 */
export function detectDateOrder(cells: readonly Cell[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const c of cells) {
    if (typeof c !== 'string') continue;
    const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(c);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && a <= 31 && b <= 12) dmy++;
    else if (b > 12 && b <= 31 && a <= 12) mdy++;
  }
  return mdy > 0 && dmy === 0 ? 'mdy' : 'dmy';
}

export interface ParsedAmount {
  /** Paise as written: negative for '-12.00' / '(12.00)' / '12.00-'. The Dr/Cr suffix does NOT change the sign. */
  value: Paise;
  /** Suffix or prefix found in the cell ('1,000.00 Cr', 'Dr 50'). */
  drCr: 'dr' | 'cr' | null;
}

const BLANK_AMOUNT = /^(-+|—|–|nil|n\/?a|null)$/i;

/**
 * Parse an amount cell: '1,23,456.78', '1,23,456.78 Cr', '500.00Dr', 'Dr 500', '(1,234.00)', '1234.00-',
 * '₹ 1,234', 'INR 1,234.00', numbers from XLSX. Blank, '-', 'NIL' → null (no amount).
 * Returns undefined when the cell has text that is not an amount (reported as unreadable).
 */
export function parseStatementAmount(cell: Cell): ParsedAmount | null | undefined {
  if (cell === null || typeof cell === 'boolean') return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? { value: rupeesToPaise(cell), drCr: null } : undefined;
  let s = cell.replace(/[   ]/g, ' ').trim();
  if (s === '' || BLANK_AMOUNT.test(s)) return null;
  if (s.length > 64) return undefined;
  let drCr: 'dr' | 'cr' | null = null;
  const suffix = /\(?\s*(dr|cr)\.?\s*\)?$/i.exec(s);
  if (suffix && suffix.index > 0) {
    drCr = suffix[1].toLowerCase() as 'dr' | 'cr';
    s = s.slice(0, suffix.index).trim();
  } else {
    const prefix = /^(dr|cr)\.?\s+/i.exec(s);
    if (prefix) {
      drCr = prefix[1].toLowerCase() as 'dr' | 'cr';
      s = s.slice(prefix[0].length).trim();
    }
  }
  let negate = false;
  if (s.endsWith('-') && !s.startsWith('-')) {
    negate = true;
    s = s.slice(0, -1).trim();
  }
  const p = parseAmount(s);
  if (p === null) return undefined;
  const value = negate ? -p : p;
  return { value: value === 0 ? 0 : value, drCr };
}

/** A Dr/Cr indicator cell: 'Dr', 'D', 'DEBIT', 'Withdrawal' → 'dr'; 'Cr', 'C', 'CREDIT', 'Deposit' → 'cr'. */
export function parseDrCrIndicator(cell: Cell): 'dr' | 'cr' | null {
  if (typeof cell !== 'string') return null;
  const s = cell.trim().toLowerCase().replace(/\.$/, '');
  if (/^(dr|d|debit|db|withdrawal|wdl|w)$/.test(s)) return 'dr';
  if (/^(cr|c|credit|deposit|dep)$/.test(s)) return 'cr';
  return null;
}

/** Cell → display text: trimmed, whitespace collapsed (numbers kept as typed by the sheet). */
export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isInteger(cell) ? String(cell) : String(cell);
  return String(cell).replace(/\s+/g, ' ').trim();
}

/** Reference cell → text; placeholders such as '-', '0', '000000', 'NA' become ''. */
export function cleanReference(cell: Cell | undefined): string {
  const t = cellText(cell);
  if (t === '' || /^(-+|0+|n\/?a|nil|null|none)$/i.test(t)) return '';
  return t.length > 100 ? t.slice(0, 100) : t;
}

/** Uppercase alphanumeric tokens: 'NEFT-ACME TRAD/UTR123' → ['NEFT','ACME','TRAD','UTR123']. */
export function tokens(text: string): string[] {
  return text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/** Uppercase with everything except letters and digits removed (dedupe hashes, substring search). */
export function squash(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/** Whole days from a to b (b − a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
