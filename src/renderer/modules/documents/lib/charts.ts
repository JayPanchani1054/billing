/**
 * The documents module's graphs and stats (SPEC-21 §5, WP-L1). Pure — no React — so the "graph total =
 * table total" rule is tested in node (charts.test.ts). Money is integer paise.
 *
 *   billsPendingChart   'documents.billsPending'     column, ordinal by age (0–7 days grey, then o1 o3 o5)
 *   budgetVarianceChart 'documents.budget.variance'  bar (inline in the table when it is the table's ≤ 7
 *                                                   rows), polarity: under budget slot 1, over budget slot 2
 *   quotationsStat      'documents.quotations'       no graph — "Open ₹x · Conversion y %"
 *   recurringDueStat    'documents.recurring.due'    no graph — "To post ₹x"
 */
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { BillsPendingKind, BillsPendingRow, BudgetVarianceRow, DocumentListResult, DocumentStatus, RecurringDueRow } from '../../../../shared/types/documents.ts';
import { clipTakeaway, compactValue, enoughData, foldTop, statRepeatsTotal, take } from '../../../ui/lib/chartCore.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { AGE_BUCKETS, ageBucket } from './model.ts';

/** One figure of a toolbar-row stat (rendered by ui/StatLine.tsx): paise, or ready-made text. */
export interface StatItem {
  label: string;
  value: Paise | string;
  tone?: 'warning' | 'danger';
  title?: string;
}

/** The money values of a stat, for the D24 rule (`statRepeatsTotal`). */
export function statMoneyValues(items: readonly StatItem[]): number[] {
  return items.flatMap((i) => (typeof i.value === 'number' ? [i.value] : []));
}

// ───────────────────────────── Bills pending ─────────────────────────────

/**
 * Unbilled value by age of the rows the table shows (Σ = the table's Pending value total). Grey for
 * 0–7 days (a challan a few days old is normal), then the ordinal ramp: the older, the darker.
 */
export function billsPendingChart(rows: readonly BillsPendingRow[], kind: BillsPendingKind): ChartSpec | null {
  const values = AGE_BUCKETS.map(() => 0);
  let total = 0;
  for (const r of rows) {
    values[AGE_BUCKETS.indexOf(ageBucket(r.ageDays))] += r.pendingValue;
    total += r.pendingValue;
  }
  const older = total - values[0];
  const spec: ChartSpec = {
    kind: 'column',
    title: kind === 'sales' ? 'Unbilled challans by age' : 'Bills awaited by age',
    takeaway: take.ordinal(compactValue(older), `${compactValue(total)} ${kind === 'sales' ? 'unbilled' : 'awaiting bills'}`, '7 days'),
    categories: [...AGE_BUCKETS],
    series: [{ name: 'Pending value', values }],
    color: 'ordinal',
    greyBefore: 1,
    label: 'max',
    total,
  };
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── Budget variance ─────────────────────────────

/**
 * A variance line as the graph draws it, from the budget's own side: + under (or on) budget, − over
 * budget; |value| = |variance| of the row. Null for a line the graph leaves out: one already inside
 * another line's figure (`inTotal === false`) and one with no budget (variance % "—").
 */
export function varianceBarValue(r: Pick<BudgetVarianceRow, 'variance' | 'variancePct' | 'overBudget' | 'inTotal'>): number | null {
  if (r.inTotal === false || r.variancePct === null) return null;
  const v = Math.abs(r.variance);
  return r.overBudget ? -v : v;
}

const varianceFormat = {
  tick: (v: number): string => (v === 0 ? '0' : `${compactValue(Math.abs(v))} ${v < 0 ? 'over' : 'under'}`),
  full: (v: number): string => (v === 0 ? 'On budget' : `₹${formatMoney(Math.abs(v))} ${v < 0 ? 'over budget' : 'under budget'}`),
};

/**
 * Over and under budget by line (Top 6 + Other by |variance|). Total = Σ drawn values — each row's
 * |variance| signed by over/under: for an expense (Dr) budget that is −(the table's variance total).
 */
export function budgetVarianceChart(rows: readonly BudgetVarianceRow[]): ChartSpec | null {
  const lines = rows.filter((r) => varianceBarValue(r) !== null);
  const folded = foldTop(lines, 6, (r) => varianceBarValue(r) ?? 0, (r) => r.name, 'Other lines');
  const over = lines.filter((r) => (varianceBarValue(r) ?? 0) < 0);
  let worst: BudgetVarianceRow | null = null;
  for (const r of over) if (!worst || Math.abs(r.variance) > Math.abs(worst.variance)) worst = r;
  const takeaway = worst
    ? clipTakeaway(`${over.length} of ${lines.length} lines over budget; most: ${worst.name} ${compactValue(Math.abs(worst.variance))}`)
    : `All ${lines.length} lines within budget`;
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Over and under budget',
    takeaway,
    categories: folded.categories,
    series: [{ name: 'Variance', values: folded.values }],
    color: 'polarity',
    label: 'tips',
    valueFormat: varianceFormat,
    total: folded.values.reduce((a, b) => a + b, 0),
  };
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── Quotation register ─────────────────────────────

/**
 * What the register's total row shows for a status filter: the whole register ("All statuses") or
 * only the documents of the chosen status — the same rows the table lists.
 */
export function quotationsShown(summary: DocumentListResult['summary'], status: DocumentStatus | 'all'): { count: number; value: Paise } {
  return status === 'all' ? { count: summary.count, value: summary.value } : summary.byStatus[status];
}

/**
 * "Open ₹x · Conversion y %": the value still to be won (open + accepted) and the conversion rate.
 * The open value is left out when it is the visible total row (every listed document still open —
 * the total says it already, D24) or zero.
 */
export function quotationsStat(summary: DocumentListResult['summary'], status: DocumentStatus | 'all' = 'all'): StatItem[] {
  const open = summary.byStatus.open.value + summary.byStatus.accepted.value;
  const items: StatItem[] = [];
  if (open !== 0 && !statRepeatsTotal([open], [quotationsShown(summary, status).value])) items.push({ label: 'Open', value: open, title: 'Open and accepted, not yet converted' });
  if (summary.conversionRatePct !== null) items.push({ label: 'Conversion', value: `${summary.conversionRatePct} %`, title: `${summary.byStatus.converted.count} of the documents converted (cancelled ones not counted)` });
  return items;
}

// ───────────────────────────── Due recurring vouchers ─────────────────────────────

/** Amount (before tax) of the ticked occurrences, with this posting's changed amounts. */
export function tickedTotal(rows: readonly RecurringDueRow[], selected: ReadonlySet<string>, overrides: Readonly<Record<string, number | null>>): Paise {
  return rows.filter((r) => selected.has(r.key)).reduce((a, r) => a + (overrides[r.key] ?? r.amount ?? 0), 0);
}

/** "To post ₹x" — the ticked amount; the table's footer counts the lines and shows no amount. */
export function recurringDueStat(rows: readonly RecurringDueRow[], selected: ReadonlySet<string>, overrides: Readonly<Record<string, number | null>>): StatItem[] {
  const total = tickedTotal(rows, selected, overrides);
  return total === 0 ? [] : [{ label: 'To post', value: total, title: 'Before tax, the ticked vouchers' }];
}
