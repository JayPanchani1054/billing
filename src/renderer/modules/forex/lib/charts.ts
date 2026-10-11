/**
 * The graphs and stats of the multi-currency reports (SPEC-21 §5, WP-K2). Pure — no React — so the
 * "graph total = table total" rules are tested in node (charts.test.ts). Rupee values are paise;
 * foreign amounts are plain numbers in the currency (signed + Dr / − Cr).
 *
 *   forex.outstanding  column, ordinal colour: bills of the chosen side by age (Not due grey, then
 *                      1–30 … over 90 days on the ramp); none for "All" (receivables and payables mixed)
 *   forex.revaluation  bar (inline when each party is one line), polarity: gain slot 1, loss slot 2
 *   forex.ledger       line of the balance in the currency (detail class: folded by default)
 *
 * A builder returns null when the data cannot carry its graph (`enoughData`).
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatForex } from '../../../../shared/forex.ts';
import type { ForexCurrency, ForexLedgerStatement, ForexOutstandingBill, ForexOutstandingResult, ForexRevaluationResult } from '../../../../shared/types/forex.ts';
import { INLINE_MAX_ROWS, MAX_LINE_POINTS, compactValue, decimate, enoughData, foldTop, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec, ValueFormat } from '../../../ui/lib/chartSpec.ts';
import { statMoney } from '../../../ui/lib/statLine.ts';
import { fxDrCr } from './model.ts';

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

function gated(spec: ChartSpec): ChartSpec | null {
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── Outstanding ─────────────────────────────

/** Age buckets of a pending bill (days past its due date). */
export const AGE_BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;

/** Bucket index of a bill: no due date or not yet due → 0 ("Not due"). */
export function ageBucket(overdueDays: number | null): number {
  if (overdueDays === null || overdueDays <= 0) return 0;
  if (overdueDays <= 30) return 1;
  if (overdueDays <= 60) return 2;
  if (overdueDays <= 90) return 3;
  return 4;
}

/**
 * What a bill adds to its side's graph, in rupees: at the closing rate, or as carried when its currency
 * has no rate — oriented to the side (receivable: Dr +; payable: Cr +). A bill on the other side (an
 * advance or an on-account amount: Cr on a receivable, Dr on a payable) gives 0 — it is not an unpaid
 * bill, and reading it without its sign would inflate the graph.
 */
export function billValue(b: Pick<ForexOutstandingBill, 'revaluedAmount' | 'amount'>, side: 'receivable' | 'payable'): number {
  const v = (side === 'payable' ? -1 : 1) * (b.revaluedAmount ?? b.amount);
  return v > 0 ? v : 0;
}

/**
 * forex.outstanding — the unpaid bills of the chosen side by how overdue they are, in rupees at the
 * closing rate (as carried in the books where a currency has no closing rate). Σ drawn === Σ of the
 * side's bill rows ("At closing rate", else "In books"); advances and on-account amounts (bills on the
 * other side) are not drawn. None for "All": receivables and payables are not one amount.
 */
export function outstandingChart(d: ForexOutstandingResult, kind: 'all' | 'receivable' | 'payable'): ChartSpec | null {
  if (kind === 'all') return null;
  const values: number[] = AGE_BUCKETS.map(() => 0);
  for (const p of d.parties) for (const b of p.bills) values[ageBucket(b.overdueDays)] += billValue(b, kind);
  const total = sum(values);
  const overdue = total - values[0];
  const base = `${compactValue(total)} in ${kind === 'receivable' ? 'foreign bills to collect' : 'foreign bills to pay'}`;
  const takeaway = values[4] > 0 ? take.ordinal(compactValue(values[4]), base, '90 days') : overdue > 0 ? `Of ${base}, ${compactValue(overdue)} is overdue` : `None of ${base} is overdue yet`;
  return gated({
    kind: 'column',
    title: kind === 'receivable' ? 'Foreign receivables by age' : 'Foreign payables by age',
    takeaway,
    categories: [...AGE_BUCKETS],
    series: [{ name: kind === 'receivable' ? 'To collect' : 'To pay', values }],
    color: 'ordinal',
    greyBefore: 1,
    label: 'max',
    total,
  });
}

/**
 * forex.outstanding stat: one figure per currency — the net in the currency and the unrealised gain /
 * loss at the closing rate (exact rupees). More than three currencies: the first two and a count.
 */
export function outstandingStat(d: ForexOutstandingResult): StatItem[] {
  const cur = new Map(d.currencies.map((c) => [c.id, c]));
  const items = d.totals.flatMap((t): StatItem[] => {
    const c = cur.get(t.currencyId);
    if (!c || t.forex === 0) return [];
    const net = fxDrCr(t.forex, c);
    const u = t.difference;
    // In brackets, not after " · ": the stat line already joins its items with " · ".
    const tail = u === null ? ' (no closing rate)' : u === 0 ? '' : ` (${statMoney(Math.abs(u))} ${u > 0 ? 'gain' : 'loss'})`;
    return [{ label: c.isoCode ?? c.formalName, value: `${net}${tail}`, tone: u !== null && u < 0 ? 'warning' : undefined, title: `${c.formalName}: net outstanding${u === null ? '' : ', unrealised at the closing rate'}` }];
  });
  if (items.length <= 3) return items;
  return [...items.slice(0, 2), { label: 'More currencies', value: String(items.length - 2), title: items.slice(2).map((i) => `${i.label} ${i.value}`).join(' · ') }];
}

// ───────────────────────────── Revaluation ─────────────────────────────

/**
 * forex.revaluation — the unrealised adjustment per party (+ gain slot 1, − loss slot 2). Drawn
 * inline when every party is one line of the table (≤ 7), else Top 6 + Other. Σ drawn === `net`.
 */
export function revaluationChart(d: ForexRevaluationResult): ChartSpec | null {
  const byLedger = new Map<number, { name: string; value: number }>();
  for (const l of d.lines) {
    const cur = byLedger.get(l.ledgerId) ?? { name: l.ledgerName, value: 0 };
    byLedger.set(l.ledgerId, { name: cur.name, value: cur.value + l.adjustment });
  }
  const groups = [...byLedger.values()];
  const inline = groups.length === d.lines.length && d.lines.length <= INLINE_MAX_ROWS;
  const { categories, values } = inline
    ? { categories: groups.map((g) => g.name), values: groups.map((g) => g.value) }
    : foldTop(
        groups.filter((g) => g.value !== 0),
        6,
        (g) => g.value,
        (g) => g.name,
      );
  // Counted over the parties, never the drawn categories: a folded "Other" is several parties, not one.
  const gains = groups.filter((g) => g.value > 0).length;
  const losses = groups.filter((g) => g.value < 0).length;
  let worst: { name: string; value: number } | null = null;
  for (const g of groups) if (g.value < 0 && (worst === null || g.value < worst.value)) worst = g;
  const n = gains + losses;
  const parties = (k: number): string => `${k} ${k === 1 ? 'party' : 'parties'}`;
  const head = losses === 0 ? `Gain on all ${parties(n)}` : gains === 0 ? `Loss on all ${parties(n)}` : `Gain on ${parties(gains)}, loss on ${losses}`;
  const takeaway = worst ? `${head}; largest loss ${worst.name} (${compactValue(Math.abs(worst.value))})` : head;
  return gated({
    kind: 'bar',
    title: 'Unrealised gain / loss by party',
    takeaway: takeaway.length > 90 ? head : takeaway,
    categories,
    series: [{ name: 'Gain (+) / loss (−)', values }],
    color: 'polarity',
    label: 'tips',
    total: sum(values),
  });
}

// ───────────────────────────── Ledger in the currency ─────────────────────────────

/** Ticks and tooltips in the ledger's currency, with the side in words (never a bare minus). */
export function currencyFormat(c: ForexCurrency): ValueFormat {
  return {
    tick: (v) => `${formatForex(Math.abs(v), 0, c.symbol)}${v < 0 ? ' Cr' : ''}`,
    full: (v) => fxDrCr(v, c) || formatForex(0, c.decimalPlaces, c.symbol),
  };
}

/**
 * forex.ledger — the balance in the currency over the period: the opening, then the balance at the
 * end of each day with vouchers (≥ 3 voucher rows). The last point is the closing balance the table
 * ends on (the drawn total). Long periods are decimated to ≤ 480 points (peaks and troughs kept).
 */
export function ledgerChart(d: ForexLedgerStatement): ChartSpec | null {
  if (d.rows.length < 3) return null;
  const points: Array<{ date: string; balance: number }> = [{ date: d.from, balance: d.openingForex }];
  for (const r of d.rows) {
    const last = points[points.length - 1];
    if (points.length > 1 && last.date === r.date) last.balance = r.forexBalance;
    else points.push({ date: r.date, balance: r.forexBalance });
  }
  const kept = decimate(
    points.map((p, i) => ({ x: i, y: p.balance })),
    MAX_LINE_POINTS,
  ).map((p) => points[p.x]);
  const c = d.currency;
  const values = kept.map((p) => p.balance);
  const closing = values[values.length - 1];
  const change = closing - d.openingForex;
  const f = currencyFormat(c);
  const delta = change === 0 ? `unchanged since ${formatDate(d.from, 'D-MMM-YY')}` : `${change > 0 ? 'up' : 'down'} ${formatForex(Math.abs(change), c.decimalPlaces, c.symbol)} since ${formatDate(d.from, 'D-MMM-YY')}`;
  const code = c.isoCode ?? c.symbol;
  return gated({
    kind: 'line',
    title: `Balance in ${code}`,
    takeaway: take.last(typeof f === 'object' ? f.full(closing) : String(closing), formatDate(kept[kept.length - 1].date, 'D-MMM-YY'), delta),
    categories: kept.map((p, i) => (i === 0 ? `Opening ${formatDate(p.date, 'D-MMM-YY')}` : formatDate(p.date, 'D-MMM-YY'))),
    series: [{ name: `Balance (${code})`, values }],
    valueFormat: f,
    label: 'last',
    total: closing,
  });
}
