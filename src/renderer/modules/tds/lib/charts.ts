/**
 * The graphs and stats of the TDS / TCS reports (SPEC-21 §5, WP-K2). Pure — no React — so the
 * "graph total = table total" and stat rules are tested in node (charts.test.ts). Money is paise.
 *
 *   tds.computation  bar (inline when each section is one table row) "Not yet deposited, by section"
 *   tds.outstanding  column, problem colour: months with an overdue balance in slot 2, the rest grey
 *   tds.challans     column, problem colour: months with a late challan in slot 2, on time grey
 *   tds.receivable   bar (inline on short tables) of |difference| per customer; none when all match
 *   tds.return       meter "Deposited ₹A of tax ₹B" (both > 0)
 *   tds.exceptions, tds.lines, masters: no graph (an exceptions stat only)
 *
 * A builder returns null when the data cannot carry its graph (`enoughData`) — then the screen shows
 * no strip and registers no Ctrl+J.
 */
import type { TdsChallanRegister, TdsComputationResult, TdsExceptionRow, TdsOutstandingResult, TdsReceivableResult, TdsReturnData } from '../../../../shared/types/tds.ts';
import { INLINE_MAX_ROWS, compactValue, enoughData, foldMonths, foldTop, monthRange, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';

/** One item of a report's StatLine (structurally `StatLineItem`; a number value is exact paise). */
export interface StatItem {
  label: string;
  value: number | string;
  tone?: 'warning' | 'danger';
  title?: string;
  /** The line's one link item (none of these builders makes one). */
  link?: boolean;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** The graph, or null when it has too little to say. */
function gated(spec: ChartSpec): ChartSpec | null {
  return enoughData(spec) ? spec : null;
}

/**
 * Bar categories for a table: when every category is exactly one table row and there are ≤ 7 of
 * them, all rows (zeros too) in table order, so `inlineBars(spec, rows)` draws them inside the table;
 * otherwise the non-zero categories, Top 6 + Other (Σ preserved).
 */
function barCategories(groups: ReadonlyArray<{ name: string; value: number }>, tableRows: number): { categories: string[]; values: number[] } {
  if (groups.length === tableRows && tableRows <= INLINE_MAX_ROWS) return { categories: groups.map((g) => g.name), values: groups.map((g) => g.value) };
  return foldTop(
    groups.filter((g) => g.value !== 0),
    6,
    (g) => g.value,
    (g) => g.name,
  );
}

/** Largest category's share of the total, as a takeaway ("194C holds 62 % of what is not yet deposited"). */
function shareTakeaway(categories: readonly string[], values: readonly number[], of: string): string {
  const total = sum(values.map(Math.abs));
  let best = -1;
  values.forEach((v, i) => {
    if (best < 0 || Math.abs(v) > Math.abs(values[best])) best = i;
  });
  if (best < 0 || total === 0) return '';
  return take.share(categories[best], (Math.abs(values[best]) / total) * 100, of);
}

/** Months (folded to quarters / years past 13) with a per-month flag OR-ed into the folded category. */
function monthColumns(byMonth: ReadonlyMap<string, { value: number; flag: boolean }>, from: string, to: string): { months: string[]; categories: string[]; values: number[]; flags: boolean[]; grain: 'month' | 'quarter' | 'year' } {
  const months = monthRange(from, to);
  const raw = months.map((m) => byMonth.get(m)?.value ?? 0);
  const flagged = months.map((m) => (byMonth.get(m)?.flag ? 1 : 0));
  const folded = foldMonths(months, raw);
  const flags = foldMonths(months, flagged).values.map((n) => n > 0);
  return { months, categories: folded.categories, values: folded.values, flags, grain: folded.grain };
}

function firstLast(keys: Iterable<string>): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const k of keys) {
    if (first === null || k < first) first = k;
    if (last === null || k > last) last = k;
  }
  return first !== null && last !== null ? { first, last } : null;
}

// ───────────────────────────── Computation ─────────────────────────────

/**
 * tds.computation — what is deducted / collected and not yet deposited (Balance = deducted −
 * deposited), by section. Σ drawn === `totals.balance` (the table's Balance total).
 */
export function computationChart(d: TdsComputationResult): ChartSpec | null {
  const bySection = new Map<string, number>();
  for (const r of d.rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + r.balance);
  const groups = [...bySection].map(([name, value]) => ({ name, value }));
  const { categories, values } = barCategories(groups, d.rows.length);
  return gated({
    kind: 'bar',
    title: 'Not yet deposited, by section',
    takeaway: shareTakeaway(categories, values, 'what is not yet deposited'),
    categories,
    series: [{ name: 'Not yet deposited', values }],
    label: 'tips',
    total: sum(values),
  });
}

// ───────────────────────────── Outstanding ─────────────────────────────

/**
 * tds.outstanding — the balance left to deposit by month of deduction; months with an overdue
 * balance in the problem colour, the rest grey. Σ drawn === `totals.balance`. `onMonth` (Enter on a
 * column) opens the lines of that month — monthly grain only.
 */
export function outstandingChart(d: TdsOutstandingResult, onMonth?: (month: string) => void): ChartSpec | null {
  const byMonth = new Map<string, { value: number; flag: boolean }>();
  for (const r of d.rows) {
    const cur = byMonth.get(r.period) ?? { value: 0, flag: false };
    byMonth.set(r.period, { value: cur.value + r.balance, flag: cur.flag || (r.status === 'overdue' && r.balance > 0) });
  }
  const span = firstLast(byMonth.keys());
  if (!span) return null;
  const m = monthColumns(byMonth, span.first, span.last);
  const emphasis = m.flags.flatMap((f, i) => (f ? [i] : []));
  const unit = `${m.grain}s`;
  const withBalance = m.values.filter((v) => v !== 0).length;
  const takeaway =
    emphasis.length === 0
      ? `Nothing overdue — every balance is still within its due date`
      : `Overdue in ${emphasis.length} of ${withBalance} ${unit} with a balance; oldest ${m.categories[emphasis[0]]}`;
  const activate = onMonth && m.grain === 'month' ? (i: number) => onMonth(m.months[i]) : undefined;
  return gated({
    kind: 'column',
    title: 'Left to deposit, by month',
    takeaway,
    categories: m.categories,
    series: [{ name: 'Left to deposit', values: m.values }],
    color: 'problem',
    emphasis,
    label: 'max',
    total: sum(m.values),
    activate,
  });
}

/**
 * tds.outstanding stat: the interest still to pay (interest − interest paid), only when > 0 and
 * not already the table's Interest total (it is, while no interest has been paid).
 */
export function outstandingStat(d: TdsOutstandingResult): StatItem[] {
  const due = d.totals.interest - d.totals.interestPaid;
  if (due <= 0 || d.totals.interestPaid === 0) return [];
  return [{ label: 'Interest to pay', value: due, tone: 'warning', title: `Interest ${d.kind === 'tds' ? 'u/s 201(1A)(ii)' : 'u/s 206C(7)'} not yet paid with a challan` }];
}

// ───────────────────────────── Challan register ─────────────────────────────

/**
 * tds.challans — challans paid per deposit month over the period; months with a late challan in
 * the problem colour, on time grey. Σ drawn === Σ `rows[].total` (the table's Total).
 */
export function challansChart(d: TdsChallanRegister, from: string, to: string): ChartSpec | null {
  const byMonth = new Map<string, { value: number; flag: boolean }>();
  for (const r of d.rows) {
    const key = r.depositDate.slice(0, 7);
    const cur = byMonth.get(key) ?? { value: 0, flag: false };
    byMonth.set(key, { value: cur.value + r.total, flag: cur.flag || r.late });
  }
  const span = firstLast([...byMonth.keys(), from.slice(0, 7), to.slice(0, 7)]);
  if (!span || byMonth.size === 0) return null;
  const m = monthColumns(byMonth, span.first, span.last);
  const emphasis = m.flags.flatMap((f, i) => (f ? [i] : []));
  const paid = m.values.filter((v) => v !== 0).length;
  const takeaway =
    emphasis.length === 0
      ? `Every challan deposited on time`
      : `Late in ${emphasis.length} of ${paid} ${m.grain}s with a deposit; last late ${m.categories[emphasis[emphasis.length - 1]]}`;
  return gated({
    kind: 'column',
    title: 'Deposited, by month',
    takeaway,
    categories: m.categories,
    series: [{ name: 'Deposited', values: m.values }],
    color: 'problem',
    emphasis,
    label: 'max',
    total: sum(m.values),
  });
}

// ───────────────────────────── 26AS ─────────────────────────────

/**
 * tds.receivable — how far the books and Form 26AS are apart, per customer (|difference|; a matched
 * row is 0). None when every row matches. Σ drawn === Σ |rows[].difference| — the table's Difference
 * column read without its sign (equal to |totals.difference| when every gap is on one side).
 */
export function receivableChart(d: TdsReceivableResult): ChartSpec | null {
  if (!d.rows.some((r) => r.status !== 'matched' && r.difference !== 0)) return null;
  const groups = d.rows.map((r) => ({ name: r.partyName, value: r.status === 'matched' ? 0 : Math.abs(r.difference) }));
  const { categories, values } = barCategories(groups, d.rows.length);
  return gated({
    kind: 'bar',
    title: 'Difference from 26AS, by customer',
    takeaway: shareTakeaway(categories, values, 'the difference'),
    categories,
    series: [{ name: 'Difference', values }],
    label: 'tips',
    total: sum(values),
  });
}

/** tds.receivable stat: the check result, only when there is something and every row matches. */
export function receivableStat(d: TdsReceivableResult): StatItem[] {
  if (d.rows.length === 0 || d.rows.some((r) => r.status !== 'matched')) return [];
  // The words are the value: below 1200 px the stat line hides its labels (they move to the tooltip),
  // and a bare "✓" would say nothing. No label, so no title either (the tooltip would start with " · ").
  return [{ label: '', value: 'Books agree with 26AS ✓' }];
}

// ───────────────────────────── Quarterly return ─────────────────────────────

/**
 * tds.return — is the quarter's tax covered by challans? A meter "Deposited ₹A of tax ₹B", drawn
 * only when both are above 0. The whole (`max`, the drawn total) === `totals.tax` (the Tax total).
 */
export function returnChart(d: TdsReturnData): ChartSpec | null {
  const { tax, deposited } = d.totals;
  if (!(tax > 0 && deposited > 0)) return null;
  return gated({
    kind: 'meter',
    title: 'Deposited against the tax',
    takeaway: `Deposited ${compactValue(deposited)} of tax ${compactValue(tax)}`,
    categories: ['Deposited'],
    series: [{ name: 'Deposited', values: [deposited] }],
    max: tax,
    total: tax,
  });
}

/** tds.return stat: the tax challans do not cover yet (words when nothing is deposited at all). */
export function returnStat(d: TdsReturnData): StatItem[] {
  const { tax, deposited } = d.totals;
  if (tax <= 0 || deposited >= tax) return [];
  if (deposited <= 0) return [{ label: '', value: 'No challan yet', tone: 'warning' }];
  return [{ label: 'Not covered', value: tax - deposited, tone: 'warning', title: 'Tax of the quarter not yet deposited with a challan' }];
}

// ───────────────────────────── Exceptions ─────────────────────────────

/**
 * tds.exceptions stat: the shortfall (tax not deducted / short deducted) and its estimated interest.
 * The table lists them per voucher without a total row — this line is their one total.
 */
export function exceptionsStat(rows: readonly TdsExceptionRow[]): StatItem[] {
  const shortfall = sum(rows.map((r) => r.shortfall));
  const interest = sum(rows.map((r) => r.interest));
  const out: StatItem[] = [];
  if (shortfall > 0) out.push({ label: 'Shortfall', value: shortfall, tone: 'danger', title: 'Tax not deducted or short deducted' });
  if (interest > 0) out.push({ label: 'Interest', value: interest, title: 'Estimated interest u/s 201(1A)(i) on the shortfall' });
  return out;
}
