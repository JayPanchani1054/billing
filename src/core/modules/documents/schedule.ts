/**
 * Recurring-voucher schedule arithmetic — pure, no database (tested in schedule.test.ts).
 *
 * Month-based frequencies step `months` (1, 3, 6, 12) from the START DATE'S MONTH: occurrence n falls in
 * month (start month + n × step) on `dayOfMonth` (0 = last day of the month; a day past the end of a
 * short month falls on that month's last day: 31 → 30-Apr, 29/28-Feb). Without a day of month the start
 * date's day is used. An occurrence earlier than the start date is skipped (start 15-Apr, day 1 → first
 * occurrence 1-May for monthly; 1-Jul for quarterly). Its period key is 'YYYY-MM'.
 *
 * every_n_days: start, start + N, start + 2N, …; period key = the date.
 *
 * The end date is inclusive.
 */
import { addDays, daysInMonth, diffDays, MONTH_NAMES, parts, toIso } from '../../../shared/dates.ts';
import type { RecurringFrequency, RecurringSchedule } from '../../../shared/types/documents.ts';

export interface Occurrence {
  periodKey: string;
  date: string;
}

const MONTHS: Record<Exclude<RecurringFrequency, 'every_n_days'>, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

/** Day `dom` (0 = last) of month m (1-12) of year y, clamped to the month's length. */
export function dayIn(y: number, m: number, dom: number): string {
  const last = daysInMonth(y, m);
  return toIso(y, m, dom === 0 ? last : Math.min(dom, last));
}

/** The n-th occurrence (n ≥ 0) of a schedule, ignoring start/end bounds (month-based may precede the start). */
export function nthOccurrence(s: RecurringSchedule, n: number): Occurrence {
  if (s.frequency === 'every_n_days') {
    const step = Math.max(1, Math.trunc(s.intervalDays ?? 1));
    const date = addDays(s.startDate, n * step);
    return { periodKey: date, date };
  }
  const step = MONTHS[s.frequency];
  const start = parts(s.startDate);
  const idx = start.y * 12 + (start.m - 1) + n * step;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const dom = s.dayOfMonth === null || s.dayOfMonth === undefined ? start.d : s.dayOfMonth;
  return { periodKey: `${y}-${String(m).padStart(2, '0')}`, date: dayIn(y, m, dom) };
}

/**
 * Occurrences with start ≤ date ≤ min(end, until), in date order, at most `limit` of them (`truncated`
 * when more exist). `fromDate` skips occurrences before it (cheaply, without enumerating them all).
 */
export function occurrences(
  s: RecurringSchedule,
  q: { until: string; fromDate?: string; limit?: number },
): { list: Occurrence[]; truncated: boolean } {
  const limit = q.limit ?? 1000;
  const end = s.endDate && s.endDate < q.until ? s.endDate : q.until;
  const out: Occurrence[] = [];
  let n = firstIndexOnOrAfter(s, q.fromDate && q.fromDate > s.startDate ? q.fromDate : s.startDate);
  for (; ; n++) {
    const o = nthOccurrence(s, n);
    if (o.date > end) return { list: out, truncated: false };
    if (o.date < s.startDate || (q.fromDate !== undefined && o.date < q.fromDate)) continue;
    if (out.length >= limit) return { list: out, truncated: true };
    out.push(o);
  }
}

/** Smallest n whose occurrence date is ≥ `date` (or the month-based occurrence index just before it). */
function firstIndexOnOrAfter(s: RecurringSchedule, date: string): number {
  if (date <= s.startDate) return 0;
  if (s.frequency === 'every_n_days') {
    const step = Math.max(1, Math.trunc(s.intervalDays ?? 1));
    const days = diffDays(s.startDate, date);
    return Math.max(0, Math.floor(days / step));
  }
  const step = MONTHS[s.frequency];
  const a = parts(s.startDate);
  const b = parts(date);
  const months = (b.y - a.y) * 12 + (b.m - a.m);
  // One step back: the occurrence of that month may fall before `date` (it is then skipped by the caller's bound check).
  return Math.max(0, Math.floor(months / step) - 1);
}

/**
 * Would replacing schedule `a` by `b` change which occurrences exist (and so their period keys)? True when
 * the frequency changes, for every-N-days when the interval changes or the start moves by other than a
 * whole number of intervals, and for quarterly / half-yearly / yearly when the start month moves by other
 * than a whole number of steps (a change of phase). A new day of the month or a new start / end on the
 * same grid keeps the keys ('YYYY-MM' months, or the same dates) — nothing already posted can fall due again.
 */
export function scheduleShifts(a: RecurringSchedule, b: RecurringSchedule): boolean {
  if (a.frequency !== b.frequency) return true;
  if (a.frequency === 'every_n_days') {
    const ia = Math.max(1, Math.trunc(a.intervalDays ?? 1));
    const ib = Math.max(1, Math.trunc(b.intervalDays ?? 1));
    return ia !== ib || diffDays(a.startDate, b.startDate) % ia !== 0;
  }
  const step = MONTHS[a.frequency];
  if (step === 1) return false;
  const pa = parts(a.startDate);
  const pb = parts(b.startDate);
  return (pa.y * 12 + pa.m - (pb.y * 12 + pb.m)) % step !== 0;
}

/**
 * Occurrences on or before `until` that are not in `done`, oldest first, at most `max` (`truncated` when
 * more exist). Walks the schedule in windows from the start, so a long run of dealt-with occurrences
 * (a daily template over years) never hides the ones after it.
 */
export function undoneOccurrences(s: RecurringSchedule, done: { has(key: string): boolean }, until: string, max: number): { list: Occurrence[]; truncated: boolean } {
  const out: Occurrence[] = [];
  let fromDate: string | undefined;
  for (;;) {
    const { list, truncated } = occurrences(s, { until, ...(fromDate !== undefined ? { fromDate } : {}), limit: 500 });
    for (const o of list) {
      if (done.has(o.periodKey)) continue;
      if (out.length >= max) return { list: out, truncated: true };
      out.push(o);
    }
    if (!truncated || list.length === 0) return { list: out, truncated: false };
    fromDate = addDays(list[list.length - 1].date, 1);
  }
}

/** Readable period label for narration placeholders: 'Oct 2026' (month-based) or the date (every N days). */
export function periodLabel(o: Occurrence): string {
  if (o.periodKey.length === 7) {
    const [y, m] = o.periodKey.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  const { y, m, d } = parts(o.date);
  return `${String(d).padStart(2, '0')}-${MONTH_NAMES[m - 1]}-${y}`;
}

/** Does `periodKey` belong to this schedule (shape and, for every-N-days, alignment)? */
export function isScheduleKey(s: RecurringSchedule, periodKey: string): boolean {
  if (s.frequency === 'every_n_days') return /^\d{4}-\d{2}-\d{2}$/.test(periodKey);
  return /^\d{4}-\d{2}$/.test(periodKey);
}

/** Occurrence of a period key, or null when the key is not one of the schedule's occurrences. */
export function occurrenceOf(s: RecurringSchedule, periodKey: string): Occurrence | null {
  if (!isScheduleKey(s, periodKey)) return null;
  const from = s.frequency === 'every_n_days' ? periodKey : `${periodKey}-01`;
  const until = s.frequency === 'every_n_days' ? periodKey : `${periodKey}-31`;
  const { list } = occurrences(s, { fromDate: from, until: until > (s.endDate ?? '9999-12-31') ? (s.endDate ?? until) : until, limit: 5 });
  return list.find((o) => o.periodKey === periodKey) ?? null;
}
