/**
 * Calendar helpers on ISO 'YYYY-MM-DD' strings. Pure, timezone-independent (UTC arithmetic on
 * calendar dates). Indian financial year runs April → March by default.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTH_NAMES = MONTHS;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function toIso(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

export function isValidDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const { y, m, d } = parts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Local calendar date of a Date (defaults to now) as ISO. */
export function todayLocal(now: Date = new Date()): string {
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(iso: string, n: number): string {
  const { y, m, d } = parts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addMonths(iso: string, n: number): string {
  const { y, m, d } = parts(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toIso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** b − a in days. */
export function diffDays(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export const compareDates = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const minDate = (a: string, b: string): string => (a <= b ? a : b);
export const maxDate = (a: string, b: string): string => (a >= b ? a : b);
export const isWithin = (d: string, from: string, to: string): boolean => d >= from && d <= to;

export function startOfMonth(iso: string): string {
  const { y, m } = parts(iso);
  return toIso(y, m, 1);
}

export function endOfMonth(iso: string): string {
  const { y, m } = parts(iso);
  return toIso(y, m, daysInMonth(y, m));
}

/** '2026-10' */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Month keys from `from` to `to` inclusive: ['2026-04', '2026-05', …] */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = startOfMonth(from);
  while (cur <= to) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

export interface FinancialYear {
  start: string;
  end: string;
  /** '2026-27' */
  label: string;
}

/** Financial year containing `iso` (April start by default). */
export function financialYear(iso: string, startMonth = 4): FinancialYear {
  const { y, m } = parts(iso);
  const startYear = m >= startMonth ? y : y - 1;
  const start = toIso(startYear, startMonth, 1);
  const end = addDays(addMonths(start, 12), -1);
  const endYear = parts(end).y;
  const label = startMonth === 1 ? String(startYear) : `${startYear}-${String(endYear).slice(-2)}`;
  return { start, end, label };
}

/** GST return period 'MMYYYY' for a date: '2026-10-05' → '102026'. */
export function returnPeriod(iso: string): string {
  const { y, m } = parts(iso);
  return `${pad(m)}${y}`;
}

/** 'MMYYYY' → { from, to } */
export function returnPeriodRange(period: string): { from: string; to: string } {
  const m = Number(period.slice(0, 2));
  const y = Number(period.slice(2));
  const from = toIso(y, m, 1);
  return { from, to: endOfMonth(from) };
}

/** Quarter of the financial year (1–4) for April-start FY. */
export function fyQuarter(iso: string, startMonth = 4): 1 | 2 | 3 | 4 {
  const { m } = parts(iso);
  const offset = (m - startMonth + 12) % 12;
  return (Math.floor(offset / 3) + 1) as 1 | 2 | 3 | 4;
}

export type DateStyle = 'DD-MM-YYYY' | 'DD-MMM-YYYY' | 'D-MMM-YY' | 'DD/MM/YYYY';

/** '2026-10-05' → '05-Oct-2026' (default), '05-10-2026', '5-Oct-26', '05/10/2026'. */
export function formatDate(iso: string | null | undefined, style: DateStyle = 'DD-MMM-YYYY'): string {
  if (!iso || !isValidDate(iso)) return '';
  const { y, m, d } = parts(iso);
  switch (style) {
    case 'DD-MM-YYYY':
      return `${pad(d)}-${pad(m)}-${y}`;
    case 'DD/MM/YYYY':
      return `${pad(d)}/${pad(m)}/${y}`;
    case 'D-MMM-YY':
      return `${d}-${MONTHS[m - 1]}-${String(y).slice(-2)}`;
    default:
      return `${pad(d)}-${MONTHS[m - 1]}-${y}`;
  }
}

/** 'Oct 2026' */
export function formatMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const FULL_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/** Year for a 2-digit `yy` closest to `refYear` (window refYear − 50 … refYear + 49). */
function nearestCentury(yy: number, refYear: number): number {
  let y = Math.floor(refYear / 100) * 100 + yy;
  if (y > refYear + 49) y -= 100;
  else if (y < refYear - 50) y += 100;
  return y;
}

/**
 * Tally-style forgiving date entry, resolved against a reference date (the current working date):
 *   '5'          → 5th of reference month/year
 *   '5-10' '5/10' '5.10' → 5 Oct of reference year
 *   '5-10-26' '5/10/2026' '05102026' '051026' '2026/10/5'   (2-digit years: nearest century)
 *   '5-Oct' '5 oct 2026' 'Oct 5' '1 sept 2026'
 *   'today' 't', 'yesterday' 'y'
 * Returns ISO or null when it cannot be understood.
 */
export function parseDateInput(input: string, reference: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'today' || s === 't') return reference;
  if (s === 'yesterday' || s === 'y') return addDays(reference, -1);
  const ref = parts(reference);

  // A month token must be a prefix (≥ 3 letters) of the month's full name: 'oct', 'sept', 'october' —
  // not merely start with one ('junk' is not June, 'marching' is not March).
  const monthIdx = (tok: string): number => (tok.length >= 3 ? FULL_MONTHS.findIndex((mm) => mm.startsWith(tok)) + 1 : 0);
  // Two-digit years resolve to the century that puts them nearest the working date
  // (within −50 … +49 years): with a 2026 working date '26' → 2026, '75' → 2075, '99' → 1999.
  const fixYear = (yy: number, raw: string): number => (raw.length <= 2 ? nearestCentury(yy, ref.y) : yy);
  const build = (y: number, m: number, d: number): string | null => {
    const iso = toIso(y, m, d);
    return isValidDate(iso) ? iso : null;
  };

  if (/^\d{8}$/.test(s)) return build(Number(s.slice(4)), Number(s.slice(2, 4)), Number(s.slice(0, 2)));
  if (/^\d{6}$/.test(s)) return build(fixYear(Number(s.slice(4)), s.slice(4)), Number(s.slice(2, 4)), Number(s.slice(0, 2)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidDate(s) ? s : null;

  const tokens = s.split(/[\s\-/.,]+/).filter(Boolean);
  if (tokens.length > 3) return null;
  if (tokens.length === 1 && /^\d{1,2}$/.test(tokens[0])) return build(ref.y, ref.m, Number(tokens[0]));

  if (tokens.length >= 2) {
    const [a, b, c] = tokens;
    // A third token must be a 2- or 4-digit year; anything else is rejected, never silently ignored.
    const year = c === undefined ? ref.y : /^(\d{2}|\d{4})$/.test(c) ? fixYear(Number(c), c) : null;
    // yyyy-m-d ('2026/10/5')
    if (/^\d{4}$/.test(a) && c !== undefined && /^\d{1,2}$/.test(b) && /^\d{1,2}$/.test(c)) {
      return build(Number(a), Number(b), Number(c));
    }
    if (year === null) return null;
    // d-mon[-y]
    if (/^\d{1,2}$/.test(a) && /^[a-z]{3,}$/.test(b) && monthIdx(b) > 0) return build(year, monthIdx(b), Number(a));
    // mon-d[-y]
    if (/^[a-z]{3,}$/.test(a) && monthIdx(a) > 0 && /^\d{1,2}$/.test(b)) return build(year, monthIdx(a), Number(b));
    // d-m[-y]
    if (/^\d{1,2}$/.test(a) && /^\d{1,2}$/.test(b)) return build(year, Number(b), Number(a));
  }
  return null;
}
