/**
 * GST return periods.
 *
 *   month key   'MMYYYY'      e.g. '042026' → 1-Apr-2026 … 30-Apr-2026, fp '042026'
 *   quarter key 'YYYY-YY-Qn'  e.g. '2026-27-Q1' → Apr–Jun 2026, fp '062026' (last month, as GSTN expects)
 *
 * The GST financial year is always April–March, whatever the company's books year.
 */
import { addMonths, endOfMonth, formatDate, isValidDate, MONTH_NAMES, parts, toIso } from '../../../shared/dates.ts';
import type { GstPeriodInput, GstPeriodsResult, ReturnPeriod, ReturnPeriodRef } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { getCompanyProfile, getConfig } from '../company/service.ts';

const MONTH_KEY = /^(0[1-9]|1[0-2])(\d{4})$/;
const QUARTER_KEY = /^(\d{4})-(\d{2})-Q([1-4])$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** GST financial year label ('2026-27') of a date. */
export function gstFy(iso: string): string {
  const { y, m } = parts(iso);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

/** First and last day of a GST financial year label ('2026-27'). Null when malformed. */
export function fyRange(fy: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) return null;
  const start = Number(m[1]);
  if (String(start + 1).slice(-2) !== m[2]) return null;
  return { from: toIso(start, 4, 1), to: toIso(start + 1, 3, 31) };
}

export function monthPeriodKey(iso: string): string {
  const { y, m } = parts(iso);
  return `${pad2(m)}${y}`;
}

/** Quarter key ('2026-27-Q1') of a date. */
export function quarterPeriodKey(iso: string): string {
  const { m } = parts(iso);
  const q = Math.floor(((m - 4 + 12) % 12) / 3) + 1;
  return `${gstFy(iso)}-Q${q}`;
}

function monthRef(y: number, m: number): ReturnPeriodRef & { key: string; fp: string } {
  const from = toIso(y, m, 1);
  return { key: `${pad2(m)}${y}`, kind: 'month', label: `${MONTH_NAMES[m - 1]} ${y}`, from, to: endOfMonth(from), fp: `${pad2(m)}${y}` };
}

function quarterRef(startYear: number, q: number): ReturnPeriodRef & { key: string; fp: string } {
  const from = addMonths(toIso(startYear, 4, 1), (q - 1) * 3);
  const last = addMonths(from, 2);
  const lp = parts(last);
  const fy = `${startYear}-${String(startYear + 1).slice(-2)}`;
  const m1 = MONTH_NAMES[parts(from).m - 1];
  const m3 = MONTH_NAMES[lp.m - 1];
  return {
    key: `${fy}-Q${q}`,
    kind: 'quarter',
    label: `Q${q} (${m1}–${m3}) ${fy}`,
    from,
    to: endOfMonth(last),
    fp: `${pad2(lp.m)}${lp.y}`,
  };
}

/** Parse a period key; null when it is not a valid month or quarter key. */
export function parsePeriodKey(key: string): (ReturnPeriodRef & { key: string; fp: string }) | null {
  const k = key.trim();
  const mm = MONTH_KEY.exec(k);
  if (mm) {
    const y = Number(mm[2]);
    if (y < 2017 || y > 2200) return null;
    return monthRef(y, Number(mm[1]));
  }
  const qm = QUARTER_KEY.exec(k);
  if (qm) {
    const startYear = Number(qm[1]);
    if (String(startYear + 1).slice(-2) !== qm[2] || startYear < 2017 || startYear > 2200) return null;
    return quarterRef(startYear, Number(qm[3]));
  }
  return null;
}

const PERIOD_HELP = "Choose a return period such as '042026' (April 2026) or '2026-27-Q1', or give a from/to date range";

/** Resolve { period } or { from, to } into a period reference. Throws VALIDATION for bad input. */
export function resolvePeriod(input: GstPeriodInput): ReturnPeriodRef {
  if (input.period !== undefined && input.period !== null && input.period !== '') {
    const p = parsePeriodKey(input.period);
    if (!p) throw validation([{ path: 'period', message: `Unknown return period "${input.period}". ${PERIOD_HELP}` }]);
    return p;
  }
  if (input.from && input.to) {
    if (!isValidDate(input.from)) throw validation([{ path: 'from', message: 'From date is not a valid date' }]);
    if (!isValidDate(input.to)) throw validation([{ path: 'to', message: 'To date is not a valid date' }]);
    if (input.from > input.to) throw validation([{ path: 'to', message: 'The To date is before the From date' }]);
    return {
      key: null,
      kind: 'range',
      label: `${formatDate(input.from)} to ${formatDate(input.to)}`,
      from: input.from,
      to: input.to,
      fp: null,
    };
  }
  throw validation([{ path: 'period', message: PERIOD_HELP }]);
}

/** A period that has a GSTN `fp` (month or quarter) — JSON exports need one. */
export function requireReturnPeriod(input: GstPeriodInput): ReturnPeriodRef & { key: string; fp: string } {
  const p = resolvePeriod(input);
  if (p.key === null || p.fp === null) {
    throw validation([{ path: 'period', message: 'Return files are made for a month or a quarter — choose a return period, not a date range' }]);
  }
  return p as ReturnPeriodRef & { key: string; fp: string };
}

/** Months (as month keys) inside a period, in order. */
export function monthsOf(p: { from: string; to: string }): Array<ReturnPeriodRef & { key: string; fp: string }> {
  const out: Array<ReturnPeriodRef & { key: string; fp: string }> = [];
  let cur = toIso(parts(p.from).y, parts(p.from).m, 1);
  while (cur <= p.to) {
    const { y, m } = parts(cur);
    out.push(monthRef(y, m));
    cur = addMonths(cur, 1);
  }
  return out;
}

const OUTWARD_SQL = `(v.base_type IN ('sales','credit_note') OR (v.base_type = 'debit_note' AND v.gst_nature IS NOT NULL
  AND v.gst_nature NOT LIKE 'inward%' AND v.gst_nature NOT LIKE 'import%'))`;

/**
 * Return periods from the books beginning (or the first GST document, if earlier) up to the period
 * of the working date (or the last document, if later), newest first, with document counts.
 */
export function listPeriods(db: Db, today: string): GstPeriodsResult {
  const cfg = getConfig(db);
  const profile = getCompanyProfile(db);
  const counts = db.all<{ ym: string; outward: number; inward: number }>(
    `SELECT substr(v.date, 1, 7) AS ym,
            SUM(CASE WHEN ${OUTWARD_SQL} THEN 1 ELSE 0 END) AS outward,
            SUM(CASE WHEN ${OUTWARD_SQL} THEN 0 ELSE 1 END) AS inward
       FROM vouchers v
      WHERE v.base_type IN ('sales','purchase','credit_note','debit_note') AND ${BOOKS_FILTER('v')}
      GROUP BY ym`,
    { today },
  );
  const byMonth = new Map(counts.map((c) => [c.ym, c]));
  let first = profile.booksFrom;
  let last = today;
  for (const c of counts) {
    const d = `${c.ym}-01`;
    if (d < first) first = d;
    if (d > last) last = d;
  }
  if (first > last) first = last;

  const monthly: ReturnPeriod[] = [];
  const todayMonth = monthPeriodKey(today);
  for (const m of monthsOf({ from: first, to: last })) {
    const c = byMonth.get(m.from.slice(0, 7));
    const outwardCount = c?.outward ?? 0;
    const inwardCount = c?.inward ?? 0;
    monthly.push({
      ...m,
      kind: 'month',
      fy: gstFy(m.from),
      outwardCount,
      inwardCount,
      hasData: outwardCount + inwardCount > 0,
      isCurrent: m.key === todayMonth,
    });
  }

  const quarterly = cfg.gst.filingFrequency === 'quarterly';
  const periods: ReturnPeriod[] = [...monthly];
  if (quarterly) {
    const quarters = new Map<string, ReturnPeriod>();
    for (const m of monthly) {
      const qk = quarterPeriodKey(m.from);
      const q = quarters.get(qk);
      if (q) {
        q.outwardCount += m.outwardCount;
        q.inwardCount += m.inwardCount;
        q.hasData = q.hasData || m.hasData;
        q.isCurrent = q.isCurrent || m.isCurrent;
      } else {
        const ref = parsePeriodKey(qk) as ReturnPeriodRef & { key: string; fp: string };
        quarters.set(qk, { ...ref, kind: 'quarter', fy: gstFy(ref.from), outwardCount: m.outwardCount, inwardCount: m.inwardCount, hasData: m.hasData, isCurrent: m.isCurrent });
      }
    }
    periods.push(...quarters.values());
  }
  // Newest first; a quarter sorts right after its last month.
  periods.sort((a, b) => (a.to === b.to ? (a.kind === 'quarter' ? -1 : 1) : a.to < b.to ? 1 : -1));

  const current = quarterly ? quarterPeriodKey(today) : todayMonth;
  const prevDate = quarterly ? addMonths(toIso(parts(today).y, parts(today).m, 1), -3) : addMonths(toIso(parts(today).y, parts(today).m, 1), -1);
  const suggested = quarterly ? quarterPeriodKey(prevDate) : monthPeriodKey(prevDate);
  return { filingFrequency: cfg.gst.filingFrequency, periods, current, suggested };
}
