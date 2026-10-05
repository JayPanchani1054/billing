/**
 * Value parsing for GST portal files and return periods. Pure functions, no DB.
 *
 *   parsePortalAmount(12345.5)        → 1234550 paise   ('1,23,456.50', '₹ 50', '' → 0; 'abc' → null)
 *   parsePortalDate('05-04-2026')     → '2026-04-05'    (dd-mm-yyyy, dd/mm/yyyy, dd-MMM-yy(yy), ISO, Excel serials)
 *   parseStateCode('27-Maharashtra')  → '27'            (codes, names, portal alpha codes)
 *   parseSupplierPeriod("Apr'26")     → '042026'
 *   periodRange('042026')             → { from: '2026-04-01', to: '2026-04-30' }
 */
import { addMonths, endOfMonth, isValidDate, MONTH_NAMES, parts, toIso } from '../../../shared/dates.ts';
import { findState, getState, normalizeStateCode } from '../../../shared/gst/index.ts';
import { parseAmount, rupeesToPaise } from '../../../shared/money.ts';
import { serialToDate } from '../../lib/xlsx.ts';

// ───────────────────────────── Amounts ─────────────────────────────

/** Rupees as on the portal (JSON number or text) → paise. Absent/empty → 0; not a number → null. */
export function parsePortalAmount(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > 9e12) return null;
    return rupeesToPaise(v);
  }
  if (typeof v === 'boolean') return null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '');
  if (s === '' || s === '-') return 0;
  return parseAmount(s);
}

/** Tax rate (percent) as on the portal; null when not a number. */
export function parseRate(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/%/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 1000) / 1000;
}

// ───────────────────────────── Dates ─────────────────────────────

const MONTH_INDEX = new Map<string, number>(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((m, i) => [m, i + 1]),
);

function monthFromName(name: string): number | null {
  const k = name.trim().toLowerCase().slice(0, 3);
  if (name.trim().length < 3) return null;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const m = MONTH_INDEX.get(k);
  if (m === undefined) return null;
  // 'sept' and full names are fine; reject words that merely start with a month ('marching').
  const lower = name.trim().toLowerCase().replace(/\.$/, '');
  return full[m - 1].startsWith(lower) || lower === 'sept' ? m : null;
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

function build(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const iso = toIso(y, m, d);
  return isValidDate(iso) ? iso : null;
}

/**
 * Portal / Excel date → ISO. Accepts 'dd-mm-yyyy', 'dd/mm/yyyy', 'dd.mm.yyyy', 'dd-mm-yy', 'dd-MMM-yyyy',
 * 'dd-MMM-yy', 'dd MMM yyyy', 'yyyy-mm-dd' (with or without time) and Excel date serials. Null otherwise.
 */
export function parsePortalDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 20_000 || v > 80_000) return null;
    return serialToDate(Math.floor(v));
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
  if (m) return build(fullYear(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[-/.\s]+([A-Za-z]{3,9}\.?)[-/.,\s]+(\d{4}|\d{2})$/.exec(s);
  if (m) {
    const mon = monthFromName(m[2]);
    return mon === null ? null : build(fullYear(m[3]), mon, Number(m[1]));
  }
  if (/^\d{5}(?:\.\d+)?$/.test(s)) return parsePortalDate(Number(s));
  return null;
}

// ───────────────────────────── States ─────────────────────────────

/** Place of supply as on the portal ('27', 27, '27-Maharashtra', 'Maharashtra', 'MH') → '27'; null when unknown. */
export function parseStateCode(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    const code = normalizeStateCode(v);
    return code && getState(code) ? code : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const lead = /^(\d{1,2})(?:\s*[-–:.)]\s*.*)?$/.exec(s);
  if (lead) {
    const code = normalizeStateCode(lead[1]);
    return getState(code) ? code : null;
  }
  return findState(s)?.code ?? null;
}

// ───────────────────────────── Flags ─────────────────────────────

/** 'Y', 'Yes', 'true', true → true; 'N', 'No', '', null → false. */
export function parseYes(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v !== 'string') return false;
  return /^(y|yes|true|1)$/i.test(v.trim());
}

/** 2B ITC availability: 'Y'/'Yes'/'T' (temporary) → true, 'N'/'No' → false, absent → null. */
export function parseItcAvailability(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '') return null;
  if (s === 'y' || s === 'yes' || s === 't' || s.startsWith('temp')) return true;
  if (s === 'n' || s === 'no') return false;
  return null;
}

/** GSTR-2B reasons for "ITC not available". */
export const ITC_REASONS: Readonly<Record<string, string>> = {
  P: 'Place of supply is in the supplier’s state while you are registered in another state (POS rule)',
  C: 'Supplier filed the return after the time limit (section 16(4))',
  IMS: 'Rejected or kept pending in the Invoice Management System',
};

// ───────────────────────────── Return periods ─────────────────────────────

const MONTH_PERIOD = /^(0[1-9]|1[0-2])(\d{4})$/;
const QUARTER_KEY = /^(\d{4})-(\d{2})-Q([1-4])$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'MMYYYY' with a month 01–12 and a year in the GST era (2017–2099). */
export function isMonthPeriod(p: string | null | undefined): p is string {
  const m = MONTH_PERIOD.exec(p ?? '');
  return m !== null && Number(m[2]) >= 2017 && Number(m[2]) <= 2099;
}

export function periodOfDate(iso: string): string {
  const { y, m } = parts(iso);
  return `${pad2(m)}${y}`;
}

export function periodRange(p: string): { from: string; to: string } {
  const from = toIso(Number(p.slice(2)), Number(p.slice(0, 2)), 1);
  return { from, to: endOfMonth(from) };
}

/** Shift a month period by n months ('042026', −1 → '032026'). */
export function shiftPeriod(p: string, n: number): string {
  return periodOfDate(addMonths(periodRange(p).from, n));
}

/** 'April 2026' */
export function periodLabel(p: string): string {
  if (!isMonthPeriod(p)) return p;
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${full[Number(p.slice(0, 2)) - 1]} ${p.slice(2)}`;
}

/** 'Apr-2026' (compact, for file names and tables). */
export function periodShort(p: string): string {
  if (!isMonthPeriod(p)) return p;
  return `${MONTH_NAMES[Number(p.slice(0, 2)) - 1]}-${p.slice(2)}`;
}

export interface ResolvedPeriod {
  /** Storage key of the return (MMYYYY; for a quarter, its last month as GSTN files it). */
  key: string;
  from: string;
  to: string;
  label: string;
  quarter: boolean;
}

/**
 * Resolve a reconciliation period. Every source takes 'MMYYYY'; GSTR-1 also takes a quarter key
 * ('2026-27-Q1' → books Apr–Jun 2026, portal file fp '062026'). Null when malformed.
 */
export function resolveReconPeriod(p: string, allowQuarter: boolean): ResolvedPeriod | null {
  const s = (p ?? '').trim();
  if (isMonthPeriod(s)) return { key: s, ...periodRange(s), label: periodLabel(s), quarter: false };
  const q = allowQuarter ? QUARTER_KEY.exec(s) : null;
  if (q) {
    const start = Number(q[1]);
    if (String(start + 1).slice(-2) !== q[2] || start < 2017) return null;
    const from = addMonths(toIso(start, 4, 1), (Number(q[3]) - 1) * 3);
    const last = addMonths(from, 2);
    return { key: periodOfDate(last), from, to: endOfMonth(last), label: `Q${q[3]} ${start}-${q[2]}`, quarter: true };
  }
  return null;
}

/**
 * Supplier filing period as printed by the portal → 'MMYYYY': '042026', '04-2026', '2026-04', "Apr'26",
 * 'Apr-26', 'Apr-2026', 'April 2026'. Null when not recognised.
 */
export function parseSupplierPeriod(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (isMonthPeriod(s)) return s;
  let m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return isMonthPeriod(`${pad2(Number(m[1]))}${m[2]}`) ? `${pad2(Number(m[1]))}${m[2]}` : null;
  m = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (m) return isMonthPeriod(`${pad2(Number(m[2]))}${m[1]}`) ? `${pad2(Number(m[2]))}${m[1]}` : null;
  m = /^([A-Za-z]{3,9})\.?[\s'’\-/,]*(\d{4}|\d{2})$/.exec(s);
  if (m) {
    const mon = monthFromName(m[1]);
    if (mon === null) return null;
    const p = `${pad2(mon)}${fullYear(m[2])}`;
    return isMonthPeriod(p) ? p : null;
  }
  return null;
}

/** Month name + GST financial year ('April', '2026-27') → '042026'; Jan–Mar fall in the second year. */
export function periodFromFyMonth(month: string, fy: string): string | null {
  const mon = monthFromName(month);
  const m = /^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/.exec(fy.trim());
  if (mon === null || !m) return null;
  const start = Number(m[1]);
  const year = mon >= 4 ? start : start + 1;
  const p = `${pad2(mon)}${year}`;
  return isMonthPeriod(p) ? p : null;
}
