/**
 * The manufacturing graphs and stats (SPEC-21 §5, WP-L1). Pure — no React — so "graph total = table
 * total" is tested in node (charts.test.ts). Money is integer paise.
 *
 *   productionChart  'mfg.production'       column by month of the cost of production (label: the best month)
 *   jobWorkChart     'mfg.jobWork.pending'  share, ordinal by lateness: later · due within 30 days · overdue
 *                                           (none with "only overdue / due soon", Ctrl+3)
 *   jobWorkStat      'mfg.jobWork.pending'  "Overdue N · Due within 30 days M"
 *   itc04Stat        'mfg.itc04'            no graph (a statutory form) — "Table 4 N lines · Tables 5A–5C M lines"
 */
import type { Itc04Result, PendingJobWorkResult, PendingJobWorkRow, ProductionRegisterResult } from '../../../../shared/types/mfg.ts';
import { byMonth, compactValue, enoughData, foldMonths, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';

/** One figure of a toolbar-row stat (ui/StatLine.tsx): paise, or ready-made text. */
export interface StatItem {
  label: string;
  value: number | string;
  tone?: 'warning' | 'danger';
  title?: string;
}

// ───────────────────────────── Production Register ─────────────────────────────

/**
 * Cost of production by month of the register's rows (Σ = the table's Cost of production total).
 * Longer periods fold into quarters or years (`foldMonths`). `runningMonth` ('YYYY-MM', the working
 * date's month): a period that runs past it (the usual whole financial year) stops there — no empty
 * future months — unless a later (post-dated) row exists, and the running month is drawn as "so far".
 */
export function productionChart(res: Pick<ProductionRegisterResult, 'from' | 'to' | 'rows'>, runningMonth?: string): ChartSpec | null {
  const fromMonth = res.from.slice(0, 7);
  let end = res.to.slice(0, 7);
  if (runningMonth && runningMonth >= fromMonth && runningMonth < end) {
    let lastRow = '';
    for (const r of res.rows) if (r.date.slice(0, 7) > lastRow) lastRow = r.date.slice(0, 7);
    end = lastRow > runningMonth ? lastRow : runningMonth;
  }
  const { months, values } = byMonth(res.rows, (r) => r.date, (r) => r.productValue, fromMonth, end);
  const folded = foldMonths(months, values);
  const partialLast = folded.grain === 'month' && months.length > 0 && months[months.length - 1] === runningMonth;
  const total = folded.values.reduce((a, b) => a + b, 0);
  const spec: ChartSpec = {
    kind: 'column',
    title: `Cost of production by ${folded.grain}`,
    takeaway: '',
    categories: folded.categories,
    xKind: 'time',
    series: [{ name: 'Cost of production', values: folded.values }],
    label: 'max',
    ...(partialLast ? { partialLast: true } : {}),
    total,
  };
  spec.takeaway = take.max(spec);
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── Pending job work ─────────────────────────────

/** Lateness buckets, oldest last; "No time limit" (moulds, dies, principals' goods …) is context. */
export const LATENESS: ReadonlyArray<{ status: PendingJobWorkRow['status']; label: string }> = [
  { status: 'no_limit', label: 'No time limit' },
  { status: 'ok', label: 'Later' },
  { status: 'due_soon', label: 'Due within 30 days' },
  { status: 'overdue', label: 'Overdue' },
];

/**
 * Pending value by return status (Σ = the table's Value total). Share bar: "No time limit" grey (only
 * when such goods are pending), then Later o1 · Due within 30 days o3 · Overdue o5 — the colour stays
 * with the status even when a bucket is empty. Null with `onlyAlerts` (the table then lists only the
 * late part, so the whole is not shown).
 */
export function jobWorkChart(res: Pick<PendingJobWorkResult, 'rows'>, direction: 'out' | 'in', onlyAlerts: boolean): ChartSpec | null {
  if (onlyAlerts) return null;
  const by = new Map<string, number>(LATENESS.map((b) => [b.status, 0]));
  let total = 0;
  for (const r of res.rows) {
    by.set(r.status, (by.get(r.status) ?? 0) + r.pendingValue);
    total += r.pendingValue;
  }
  const buckets = LATENESS.filter((b) => b.status !== 'no_limit' || (by.get('no_limit') ?? 0) !== 0);
  const overdue = by.get('overdue') ?? 0;
  const soon = by.get('due_soon') ?? 0;
  const base = `${compactValue(total)} ${direction === 'out' ? 'with job workers' : "of principals' goods with us"}`;
  const spec: ChartSpec = {
    kind: 'share',
    title: 'Pending job work by return date',
    takeaway: overdue > 0 ? `Of ${base}, ${compactValue(overdue)} is past the return date` : `Of ${base}, ${compactValue(soon)} is due back within 30 days`,
    categories: buckets.map((b) => b.label),
    series: [{ name: 'Pending value', values: buckets.map((b) => by.get(b.status) ?? 0) }],
    color: 'ordinal',
    greyBefore: buckets.length - 3,
    total,
  };
  return enoughData(spec) ? spec : null;
}

/**
 * "Overdue N · Due within 30 days M" (challan lines; zero items left out). `overdueInBanner`: the
 * screen's s.143 banner already says "N challan lines past the return date" (goods with job workers),
 * so the stat does not say the count twice.
 */
export function jobWorkStat(res: Pick<PendingJobWorkResult, 'counts' | 'overdueValue'>, opts: { overdueInBanner?: boolean } = {}): StatItem[] {
  const items: StatItem[] = [];
  if (res.counts.overdue > 0 && !opts.overdueInBanner) items.push({ label: 'Overdue', value: String(res.counts.overdue), tone: 'danger', title: `Challan lines past the return date (CGST s.143): ${compactValue(res.overdueValue)}` });
  if (res.counts.dueSoon > 0) items.push({ label: 'Due within 30 days', value: String(res.counts.dueSoon), title: 'Challan lines due back within 30 days' });
  return items;
}

/** The s.143 banner shows for our goods with job workers when a line is past its return date. */
export function overdueBannerShown(res: Pick<PendingJobWorkResult, 'counts'>, direction: 'out' | 'in'): boolean {
  return direction === 'out' && res.counts.overdue > 0;
}

// ───────────────────────────── ITC-04 ─────────────────────────────

const lines = (n: number): string => `${n} line${n === 1 ? '' : 's'}`;

/** "Table 4 N lines · Tables 5A–5C M lines" — the size of each part of the return. */
export function itc04Stat(res: Pick<Itc04Result, 'sent' | 'returned'>): StatItem[] {
  return [
    { label: 'Table 4', value: lines(res.sent.length), title: 'Goods sent to job workers' },
    { label: 'Tables 5A–5C', value: lines(res.returned.length), title: 'Goods received back, sent on or sold from the job worker' },
  ];
}
