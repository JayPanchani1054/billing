/**
 * Return periods for the reconciliation screen (pure). Keys are MMYYYY as on the GST portal.
 *
 *   periodOptionGroups('2025-04-01', '2026-05-20') → [{ label: 'FY 2026-27', options: [May 2026, April 2026] },
 *                                                     { label: 'FY 2025-26', options: [March 2026 … April 2025] }]
 *   defaultPeriod('2026-05-20', '2025-04-01')      → '042026' (GSTR-2B of a month is ready on the 14th of the next)
 *   quarterOf('052026') → '2026-27-Q1'; storageMonth('2026-27-Q1') → '062026' (quarterly GSTR-1, QRMP)
 */
import { addMonths, parts, toIso } from '../../../../shared/dates.ts';

export interface PeriodOption {
  value: string;
  label: string;
}

export interface PeriodOptionGroup {
  label: string;
  options: PeriodOption[];
}

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' → 'MMYYYY'. */
export function periodOf(iso: string): string {
  const { y, m } = parts(iso);
  return `${String(m).padStart(2, '0')}${y}`;
}

const QUARTER = /^(\d{4})-(\d{2})-Q([1-4])$/;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A GSTR-1 quarter key of a quarterly (QRMP) filer: '2026-27-Q1'. */
export function isQuarterKey(key: string | null | undefined): boolean {
  if (typeof key !== 'string') return false;
  const m = QUARTER.exec(key);
  return m !== null && String(Number(m[1]) + 1).slice(-2) === m[2] && Number(m[1]) >= 2017;
}

/** Quarter of a month period: '052026' → '2026-27-Q1', '022027' → '2026-27-Q4'. */
export function quarterOf(month: string): string {
  const m = Number(month.slice(0, 2));
  const y = Number(month.slice(2));
  const start = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}-Q${q}`;
}

/** First and last month of a quarter key ('2026-27-Q1' → ['042026', '062026']). */
export function quarterMonths(key: string): [string, string] {
  const m = QUARTER.exec(key) as RegExpExecArray;
  const first = periodOf(addMonths(toIso(Number(m[1]), 4, 1), (Number(m[3]) - 1) * 3));
  return [first, shiftPeriod(first, 2)];
}

/** The month a period is stored under: a month itself, or a quarter's last month (as GSTN files it). */
export function storageMonth(key: string): string {
  return isQuarterKey(key) ? quarterMonths(key)[1] : key;
}

/** 'MMYYYY' → first day ISO ('042026' → '2026-04-01'); null when malformed. */
export function periodStart(key: string): string | null {
  const m = /^(0[1-9]|1[0-2])(\d{4})$/.exec(key);
  return m ? toIso(Number(m[2]), Number(m[1]), 1) : null;
}

export function isPeriodKey(key: unknown): key is string {
  return typeof key === 'string' && periodStart(key) !== null;
}

/** '042026' → 'April 2026'; '2026-27-Q1' → 'Apr–Jun 2026 (Q1)' (the key itself when malformed). */
export function periodLabel(key: string): string {
  if (isQuarterKey(key)) {
    const [a, b] = quarterMonths(key);
    return `${SHORT_MONTHS[Number(a.slice(0, 2)) - 1]}–${SHORT_MONTHS[Number(b.slice(0, 2)) - 1]} ${b.slice(2)} (${key.slice(-2)})`;
  }
  const start = periodStart(key);
  if (!start) return key;
  return `${FULL_MONTHS[Number(key.slice(0, 2)) - 1]} ${key.slice(2)}`;
}

/** GST financial year of a period: '042026' → '2026-27', '032026' → '2025-26'. */
export function fyOf(key: string): string {
  const m = Number(key.slice(0, 2));
  const y = Number(key.slice(2));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Shift a period by n months. */
export function shiftPeriod(key: string, n: number): string {
  const start = periodStart(key);
  return start ? periodOf(addMonths(start, n)) : key;
}

/**
 * Months from the books beginning (at most `maxMonths` back, never before July 2017) up to the
 * working date's month, newest first, grouped by financial year.
 */
export function periodOptionGroups(booksFrom: string, today: string, maxMonths = 36, withQuarters = false): PeriodOptionGroup[] {
  const last = periodOf(today);
  let first = periodOf(booksFrom > today ? today : booksFrom);
  const floor = shiftPeriod(last, -(maxMonths - 1));
  if (periodStart(first)! < periodStart(floor)!) first = floor;
  if (periodStart(first)! < '2017-07-01') first = '072017';
  const groups: PeriodOptionGroup[] = [];
  for (let k = last; ; k = shiftPeriod(k, -1)) {
    const label = `FY ${fyOf(k)}`;
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) {
      g = { label, options: [] };
      groups.push(g);
    }
    // Quarterly (QRMP) GSTR-1: each quarter is offered above its last month.
    if (withQuarters && Number(k.slice(0, 2)) % 3 === 0) g.options.push({ value: quarterOf(k), label: `Quarter ${periodLabel(quarterOf(k))}` });
    else if (withQuarters && k === last) g.options.push({ value: quarterOf(k), label: `Quarter ${periodLabel(quarterOf(k))}` });
    g.options.push({ value: k, label: periodLabel(k) });
    if (k === first) break;
  }
  return groups;
}

/**
 * The period to open with: the requested one when valid, else the previous month (GSTR-2B for a
 * month is generated on the 14th of the next) — or the current month when the books began this month.
 */
export function defaultPeriod(today: string, booksFrom: string, requested?: string | null, allowQuarter = false): string {
  if (requested && (isPeriodKey(requested) || (allowQuarter && isQuarterKey(requested)))) return requested;
  const current = periodOf(today);
  const previous = shiftPeriod(current, -1);
  return periodStart(previous)! >= periodStart(periodOf(booksFrom))! ? previous : current;
}
