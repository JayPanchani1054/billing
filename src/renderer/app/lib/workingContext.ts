/**
 * Working date (F2) and reporting period (Alt+F2) — pure rules and persistence (tested in
 * workingContext.test.ts).
 *
 * - The working date defaults to today, never earlier than the books beginning date. A date the
 *   user picks is remembered for the rest of that calendar day (tomorrow starts at "today" again,
 *   so nobody keeps entering vouchers on yesterday's date by mistake).
 * - The period defaults to the current financial year up to today, starting no earlier than the
 *   books beginning date, and is remembered per company until changed.
 */
import { addDays, addMonths, endOfMonth, financialYear, formatDate, isValidDate, maxDate, parts, startOfMonth, toIso } from '../../../shared/dates.ts';

export interface Period {
  from: string;
  to: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function clampWorkingDate(date: string, booksFrom: string): string {
  if (!isValidDate(date)) return booksFrom;
  return date < booksFrom ? booksFrom : date;
}

/** Keep `from` ≥ books beginning and `to` ≥ `from` (dates swapped when entered backwards). */
export function clampPeriod(p: Period, booksFrom: string): Period {
  let from = isValidDate(p.from) ? p.from : booksFrom;
  let to = isValidDate(p.to) ? p.to : from;
  if (to < from) [from, to] = [to, from];
  from = maxDate(from, booksFrom);
  to = maxDate(to, from);
  return { from, to };
}

export function defaultWorkingDate(today: string, booksFrom: string): string {
  return clampWorkingDate(today, booksFrom);
}

/** Current financial year to date (FY containing the reference date), clamped to the books. */
export function defaultPeriod(today: string, booksFrom: string, fyStartMonth = 4): Period {
  const ref = maxDate(today, booksFrom);
  const fy = financialYear(ref, fyStartMonth);
  return clampPeriod({ from: fy.start, to: ref }, booksFrom);
}

export const STORAGE_PREFIX = 'pevqori.ctx';

export function storageKey(companyId: string, kind: 'date' | 'period'): string {
  return `${STORAGE_PREFIX}.${companyId}.${kind}`;
}

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the setting just isn't remembered.
  }
}

export interface CompanyBooks {
  companyId: string;
  booksFrom: string;
  fyStartMonth: number;
}

export interface WorkingContextState {
  date: string;
  period: Period;
}

/** Load the remembered date/period for a company, falling back to (and clamping by) the defaults. */
export function loadWorkingContext(storage: StorageLike | null, books: CompanyBooks, today: string): WorkingContextState {
  const savedDate = readJson(storage, storageKey(books.companyId, 'date'));
  let date = defaultWorkingDate(today, books.booksFrom);
  if (
    savedDate &&
    typeof savedDate === 'object' &&
    typeof (savedDate as { date?: unknown }).date === 'string' &&
    (savedDate as { setOn?: unknown }).setOn === today
  ) {
    date = clampWorkingDate((savedDate as { date: string }).date, books.booksFrom);
  }

  const savedPeriod = readJson(storage, storageKey(books.companyId, 'period'));
  let period = defaultPeriod(today, books.booksFrom, books.fyStartMonth);
  if (savedPeriod && typeof savedPeriod === 'object') {
    const { from, to } = savedPeriod as { from?: unknown; to?: unknown };
    if (typeof from === 'string' && typeof to === 'string' && isValidDate(from) && isValidDate(to)) {
      period = clampPeriod({ from, to }, books.booksFrom);
    }
  }
  return { date, period };
}

export function saveWorkingDate(storage: StorageLike | null, companyId: string, date: string, today: string): void {
  writeJson(storage, storageKey(companyId, 'date'), { date, setOn: today });
}

export function savePeriod(storage: StorageLike | null, companyId: string, period: Period): void {
  writeJson(storage, storageKey(companyId, 'period'), period);
}

export interface PeriodPreset {
  id: string;
  label: string;
  period: Period;
}

/** Quarter start (calendar quarters aligned to the FY start month). */
function quarterStart(iso: string, fyStartMonth: number): string {
  const { y, m } = parts(iso);
  const offset = (m - fyStartMonth + 12) % 12;
  const back = offset % 3;
  return addMonths(toIso(y, m, 1), -back);
}

/** Common periods relative to the working date, clamped to the books. */
export function periodPresets(reference: string, booksFrom: string, fyStartMonth = 4): PeriodPreset[] {
  const fy = financialYear(reference, fyStartMonth);
  const lastFy = financialYear(addDays(fy.start, -1), fyStartMonth);
  const monthStart = startOfMonth(reference);
  const prevMonth = addMonths(monthStart, -1);
  const qStart = quarterStart(reference, fyStartMonth);
  const prevQStart = addMonths(qStart, -3);
  const raw: PeriodPreset[] = [
    { id: 'today', label: 'Today', period: { from: reference, to: reference } },
    { id: 'month', label: 'This month', period: { from: monthStart, to: endOfMonth(reference) } },
    { id: 'last-month', label: 'Last month', period: { from: prevMonth, to: endOfMonth(prevMonth) } },
    { id: 'quarter', label: 'This quarter', period: { from: qStart, to: endOfMonth(addMonths(qStart, 2)) } },
    { id: 'last-quarter', label: 'Last quarter', period: { from: prevQStart, to: endOfMonth(addMonths(prevQStart, 2)) } },
    { id: 'fy-to-date', label: 'Year to date', period: { from: fy.start, to: reference } },
    { id: 'fy', label: `FY ${fy.label}`, period: { from: fy.start, to: fy.end } },
    { id: 'last-fy', label: `FY ${lastFy.label}`, period: { from: lastFy.start, to: lastFy.end } },
  ];
  return raw.filter((p) => p.period.to >= booksFrom).map((p) => ({ ...p, period: clampPeriod(p.period, booksFrom) }));
}

/** Short human label: 'FY 2026-27', 'Oct 2026', or '1-Apr-26 to 5-Oct-26'. */
export function describePeriod(p: Period, fyStartMonth = 4): string {
  const fy = financialYear(p.from, fyStartMonth);
  if (p.from === fy.start && p.to === fy.end) return `FY ${fy.label}`;
  if (p.from === startOfMonth(p.from) && p.to === endOfMonth(p.from)) {
    return formatDate(p.from, 'DD-MMM-YYYY').slice(3).replace('-', ' ');
  }
  if (p.from === p.to) return formatDate(p.from, 'D-MMM-YY');
  return `${formatDate(p.from, 'D-MMM-YY')} to ${formatDate(p.to, 'D-MMM-YY')}`;
}
