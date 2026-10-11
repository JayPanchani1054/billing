/**
 * The graphs and stat lines of the stock reports (2.1, SPEC-21 §5 "Outstanding and stock", D24, D26).
 * Pure — no React — so every builder's "graph total = table total" is tested in node (charts.test.ts).
 * A builder returns null when the data cannot carry the graph (Quantities only, < 3 non-zero
 * categories / points): the screen then shows no strip and no Ctrl+J.
 *
 *   stock.summary        bar of the level-0 rows by closing value (inline in the table for ≤ 7 rows)
 *   stock.categories     the same by category, "Not categorised" grey (emphasis)
 *   stock.ageing         columns by age bucket, ordinal (always value; Alt+Q changes the table only)
 *   stock.item           line of the running closing quantity, in the item's unit (detail class)
 *   stock.profitability  bar of gross profit: top 6 + up to 3 loss items + Other (polarity)
 *   stock.godowns        bar of the level-0 godowns by value
 *   stock.movement       bar of the parties by value (one colour for both sides)
 *   pendingOrders · batches · negative · reorder: no graph — a stat in words instead.
 *
 * Money is paise. Colour follows meaning (D29): slot 1 = the value measured; slot 2 only for a negative
 * (negative stock, a loss) through 'polarity'; grey for context ("Not categorised"); the ordinal ramp
 * for age.
 */
import type {
  BatchSummaryResult,
  GodownSummaryResult,
  GodownSummaryRow,
  MovementPartyRow,
  NegativeStockRow,
  PendingOrdersResult,
  ProfitabilityResult,
  ProfitabilityRow,
  ReorderStatusResult,
  StockAgeingResult,
  StockItemVouchersResult,
  StockMovementResult,
  StockSummaryResult,
  StockSummaryRow,
} from '../../../../shared/types/stock.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { clipTakeaway, compactValue, decimate, drawnTotal, enoughData, INLINE_MAX_ROWS, inlineBars, MAX_LINE_POINTS, OTHER_LABEL, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartColor, ChartSpec, ValueFormat } from '../../../ui/lib/chartSpec.ts';
import { qtyText } from './model.ts';
import type { MovementTreeRow } from './model.ts';

// ───────────────────────────── Folding ─────────────────────────────

/** Rows of a bar strip before "Other" (Top 6 + Other, §5 legend "T6+O"). */
export const BAR_TOP = 6;

/**
 * The `k` first items by `before` (a strict order; ties keep input order), in that order — one pass with a
 * k-long insertion list instead of sorting every row (a report can have thousands of items).
 */
function firstK<T>(items: readonly T[], k: number, before: (a: T, b: T) => boolean): T[] {
  const out: T[] = [];
  if (k <= 0) return out;
  for (const it of items) {
    if (out.length === k && !before(it, out[k - 1])) continue;
    let i = out.length < k ? out.length : k - 1;
    if (out.length < k) out.push(it);
    while (i > 0 && before(it, out[i - 1])) {
      out[i] = out[i - 1];
      i--;
    }
    out[i] = it;
  }
  return out;
}

/** One bar of a folded bar graph: the rows it stands for (one row, or every row of "Other"). */
export interface BarSlot<T> {
  label: string;
  value: number;
  /** The source row of a named bar; null for "Other". */
  row: T | null;
}

/**
 * The bars of a "bar↹" graph (D26). Up to 7 rows: one bar per row, in table order — the categories
 * are the table's rows, so the screen draws them inline. More rows: the non-zero ones by |value|
 * (ties keep table order), the top 6 by name and the rest as "Other" (a single leftover row keeps its
 * name, as `foldTop` does). Σ of the values is preserved exactly.
 */
export function barSlots<T>(rows: readonly T[], value: (r: T) => number, label: (r: T) => string, top: number = BAR_TOP): BarSlot<T>[] {
  if (rows.length <= INLINE_MAX_ROWS) return rows.map((r) => ({ label: label(r), value: value(r), row: r }));
  const nonZero = rows.map((r, i) => ({ r, v: value(r), i })).filter((x) => x.v !== 0);
  const fold = nonZero.length > top + 1;
  const head = firstK(nonZero, fold ? top : nonZero.length, (a, b) => Math.abs(a.v) > Math.abs(b.v));
  const out: BarSlot<T>[] = head.map((x) => ({ label: label(x.r), value: x.v, row: x.r }));
  if (fold) {
    const names = new Set(out.map((s) => s.label));
    const kept = new Set(head.map((x) => x.i));
    const rest = nonZero.reduce((s, x) => (kept.has(x.i) ? s : s + x.v), 0);
    out.push({ label: names.has(OTHER_LABEL) ? `${OTHER_LABEL} (${nonZero.length - top})` : OTHER_LABEL, value: rest, row: null });
  }
  return out;
}

/** A spec with its `total` set to what it draws (the builders' tests compare it with the table's total). */
function withTotal(spec: Omit<ChartSpec, 'total'>): ChartSpec {
  const s: ChartSpec = { ...spec, total: 0 };
  return { ...s, total: drawnTotal(s) };
}

/** null unless the spec has enough data to draw (D26). */
function gate(spec: ChartSpec): ChartSpec | null {
  return enoughData(spec) ? spec : null;
}

/** Whole-number percentage of `part` in `whole` (0 when the whole is not positive). */
function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** "Wood Primer 1L holds 70 % of stock value" — the largest positive bar against the positive whole. */
function shareTakeaway<T>(slots: readonly BarSlot<T>[], of: string): string {
  const positive = slots.filter((s) => s.value > 0);
  const whole = positive.reduce((a, s) => a + s.value, 0);
  const named = positive.filter((s) => s.row !== null).sort((a, b) => b.value - a.value)[0];
  if (!named) return clipTakeaway(`${compactValue(whole)} of ${of}`);
  return take.share(named.label, pct(named.value, whole), of);
}

/** Bars of a value that can go below zero (negative stock): slot 1, or 'polarity' when a bar is negative. */
function signColor(values: readonly number[], otherwise: ChartColor = 'series'): ChartColor {
  return values.some((v) => v < 0) ? 'polarity' : otherwise;
}

/**
 * The table rows a "bar↹" graph sits on: inline bars are drawn when the graph has one bar per row
 * (≤ 7 rows, nothing folded). The kit's rule (`inlineBars`, D26) — a count check, so a screen can call it
 * on every render without folding the rows again.
 */
export function inlineRows(spec: ChartSpec | null, rowCount: number): boolean {
  return inlineBars(spec, rowCount);
}

// ───────────────────────────── Stock Summary / Categories ─────────────────────────────

/** The level-0 rows of a summary (the rows its total adds up). */
export function summaryTopRows(d: StockSummaryResult): StockSummaryRow[] {
  return d.rows.filter((r) => r.parentKey === null);
}

/**
 * stock.summary / stock.categories — "Where money is locked in stock": one bar per level-0 row by its
 * closing value (Top 6 + Other beyond 7 rows). Categories mode greys "Not categorised" (key 'c:none').
 * null in Quantities only (no values) and with fewer than 3 non-zero rows. Enter = Enter on the row.
 */
export function stockSummaryChart(d: StockSummaryResult, mode: 'group' | 'category' = 'group', open?: (row: StockSummaryRow) => void): ChartSpec | null {
  if (!d.valuesShown) return null;
  const slots = barSlots(summaryTopRows(d), (r) => r.closing.value, (r) => r.name);
  const values = slots.map((s) => s.value);
  const emphasis = mode === 'category' ? slots.map((s, i) => (s.row?.key === 'c:none' ? -1 : i)).filter((i) => i >= 0) : [];
  const color = signColor(values, mode === 'category' && emphasis.length < slots.length ? 'emphasis' : 'series');
  return gate(
    withTotal({
      kind: 'bar',
      title: mode === 'category' ? 'Stock value by category' : 'Where money is locked in stock',
      takeaway: shareTakeaway(slots, 'stock value'),
      categories: slots.map((s) => s.label),
      series: [{ name: 'Closing value', values }],
      color,
      ...(color === 'emphasis' ? { emphasis } : {}),
      label: slots.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
      activate: open ? (i) => {
        const row = slots[i]?.row;
        if (row) open(row);
      } : undefined,
    }),
  );
}

/** Whether the summary's graph is drawn inside the table (one bar per level-0 row, ≤ 7 rows). */
export function stockSummaryInline(d: StockSummaryResult, spec: ChartSpec | null): boolean {
  return !!spec && inlineRows(spec, summaryTopRows(d).length);
}

/** The inline bar of a summary row (DataTable column `bar`): the level-0 rows only — the rows the total adds up. */
export function summaryBarValue(r: StockSummaryRow): number | null {
  return r.parentKey === null ? r.closing.value : null;
}

// ───────────────────────────── Stock Ageing ─────────────────────────────

/** The bound the takeaway counts from: the middle bound of the preset (90 of 30/60/90/180, 45 of 15/30/45/60, 180 of 90/180/365). */
export function ageingThreshold(d: StockAgeingResult): number | null {
  const bounds = d.buckets.map((b) => b.toDays).filter((t): t is number => t !== null);
  return bounds.length ? bounds[Math.floor(bounds.length / 2)] : null;
}

/**
 * stock.ageing — "How much stock is old?": one column per age bucket of the value on hand (always
 * value; Alt+Q switches the table only), the ordinal ramp from the youngest to the oldest bucket.
 * Takeaway: "Of ₹3.94 L in stock, ₹1.21 L is over 90 days".
 */
export function stockAgeingChart(d: StockAgeingResult): ChartSpec | null {
  if (d.rows.length === 0 || d.buckets.length === 0 || d.buckets.length > 5) return null;
  const values = d.buckets.map((_, i) => d.totals.buckets[i] ?? 0);
  if (values.some((v) => v < 0)) return null; // an age profile of negative value says nothing
  const threshold = ageingThreshold(d);
  const whole = values.reduce((a, v) => a + v, 0);
  const old = threshold === null ? 0 : d.buckets.reduce((a, b, i) => (b.fromDays > threshold ? a + values[i] : a), 0);
  const base = `${compactValue(whole)} in stock`;
  const takeaway = threshold === null ? clipTakeaway(base) : old > 0 ? take.ordinal(compactValue(old), base, `${threshold} days`) : clipTakeaway(`None of ${base} is over ${threshold} days`);
  return gate(
    withTotal({
      kind: 'column',
      title: 'Stock value by age',
      takeaway,
      categories: d.buckets.map((b) => b.label),
      series: [{ name: 'Value', values }],
      color: 'ordinal',
      label: 'max',
    }),
  );
}

// ───────────────────────────── Stock Item Vouchers ─────────────────────────────

/** Quantities in the item's unit: ticks "1.2 L", tooltips "1,25,000 Nos". */
export function qtyFormat(unit: string): Extract<ValueFormat, object> {
  return { tick: (v) => compactValue(v, 'number'), full: (v) => qtyText(v, unit) || '0' };
}

/** '10-Oct' (the year only when the period spans two calendar years). */
function dayLabel(date: string, withYear: boolean): string {
  const s = formatDate(date, 'D-MMM-YY');
  return withYear ? s : s.slice(0, -3);
}

/**
 * stock.item — "Is this item running down?": the running closing quantity in the item's unit — the
 * opening on the first day, the closing at the end of every day with a voucher, and the period's
 * closing on its last day — on a zero baseline. Needs ≥ 3 points. Its total (the last point) is the
 * footer's closing quantity.
 */
export function stockItemChart(d: StockItemVouchersResult): ChartSpec | null {
  if (d.item.isService) return null;
  const byDay = new Map<string, number>();
  byDay.set(d.from, d.opening.qty);
  for (const r of d.rows) if (r.date >= d.from && r.date <= d.to) byDay.set(r.date, r.closing.qty);
  byDay.set(d.to, d.closing.qty);
  const days = [...byDay.keys()].sort();
  if (days.length < 3) return null;
  const withYear = d.from.slice(0, 4) !== d.to.slice(0, 4);
  let points = days.map((day, i) => ({ x: i, y: byDay.get(day) ?? 0 }));
  if (points.length > MAX_LINE_POINTS) points = decimate(points, MAX_LINE_POINTS);
  const unit = d.item.unit;
  // The change is measured from the opening balance (a voucher on the first day would otherwise hide
  // that day's movement: the first point is the closing at the end of the day).
  const last = points[points.length - 1].y;
  const diff = last - d.opening.qty;
  const since = dayLabel(d.from, withYear);
  const delta = diff === 0 ? `unchanged since ${since}` : `${diff > 0 ? 'up' : 'down'} ${qtyText(Math.abs(diff), unit)} since ${since}`;
  return gate(
    withTotal({
      kind: 'line',
      title: 'Quantity in stock',
      takeaway: take.last(qtyText(last, unit) || `0 ${unit}`, dayLabel(d.to, withYear), delta),
      categories: points.map((p) => dayLabel(days[p.x], withYear)),
      series: [{ name: 'Closing quantity', values: points.map((p) => p.y) }],
      valueFormat: qtyFormat(unit),
      label: 'last',
    }),
  );
}

// ───────────────────────────── Item Profitability ─────────────────────────────

/** Loss items a profitability strip names besides the top 6 earners (§5: "up to 3 loss items"). */
export const LOSS_ITEMS = 3;

/**
 * The bars of Item Profitability: every row when ≤ 7 (inline); else the top 6 earners, the up-to-3
 * biggest losses and the rest as "Other" (named when it is a single row) — earners first, then Other,
 * then the losses from the smallest to the biggest. Σ preserved.
 */
export function profitabilitySlots(rows: readonly ProfitabilityRow[]): BarSlot<ProfitabilityRow>[] {
  if (rows.length <= INLINE_MAX_ROWS) return rows.map((r) => ({ label: r.name, value: r.grossProfit, row: r }));
  const indexed = rows.map((r, i) => ({ r, i }));
  const top = firstK(indexed.filter((x) => x.r.grossProfit > 0), BAR_TOP, (a, b) => a.r.grossProfit > b.r.grossProfit);
  const worst = firstK(indexed.filter((x) => x.r.grossProfit < 0), LOSS_ITEMS, (a, b) => a.r.grossProfit < b.r.grossProfit);
  const kept = new Set([...top, ...worst].map((x) => x.i));
  const rest = indexed.filter((x) => !kept.has(x.i) && x.r.grossProfit !== 0);
  const slot = (x: { r: ProfitabilityRow }): BarSlot<ProfitabilityRow> => ({ label: x.r.name, value: x.r.grossProfit, row: x.r });
  const out = top.map(slot);
  if (rest.length === 1) out.push(slot(rest[0]));
  else if (rest.length > 1) out.push({ label: out.some((s) => s.label === OTHER_LABEL) || worst.some((x) => x.r.name === OTHER_LABEL) ? `${OTHER_LABEL} (${rest.length})` : OTHER_LABEL, value: rest.reduce((a, x) => a + x.r.grossProfit, 0), row: null });
  out.push(...[...worst].reverse().map(slot));
  return out;
}

/**
 * stock.profitability — "Which items make or lose money?": gross profit per item, earners in slot 1
 * and losses in slot 2 (polarity). Enter = the item's vouchers.
 */
export function profitabilityChart(d: ProfitabilityResult, open?: (row: ProfitabilityRow) => void): ChartSpec | null {
  const slots = profitabilitySlots(d.rows);
  const losers = d.rows.filter((r) => r.grossProfit < 0).length;
  const best = slots.filter((s) => s.row !== null && s.value > 0).sort((a, b) => b.value - a.value)[0];
  const whole = d.rows.reduce((a, r) => a + Math.max(0, r.grossProfit), 0);
  const earner = best ? `${best.label} earns ${pct(best.value, whole)} % of gross profit` : '';
  const takeaway = clipTakeaway(losers > 0 ? `${losers} item${losers === 1 ? '' : 's'} sold at a loss${earner ? `; ${earner}` : ''}` : earner || 'No item earned a gross profit');
  return gate(
    withTotal({
      kind: 'bar',
      title: 'Gross profit by item',
      takeaway,
      categories: slots.map((s) => s.label),
      series: [{ name: 'Gross profit', values: slots.map((s) => s.value) }],
      color: 'polarity',
      label: slots.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
      activate: open ? (i) => {
        const row = slots[i]?.row;
        if (row) open(row);
      } : undefined,
    }),
  );
}

export function profitabilityInline(d: ProfitabilityResult, spec: ChartSpec | null): boolean {
  return !!spec && inlineRows(spec, d.rows.length);
}

// ───────────────────────────── Godown Summary ─────────────────────────────

export function godownTopRows(d: GodownSummaryResult): GodownSummaryRow[] {
  return d.rows.filter((r) => r.kind === 'godown' && r.parentKey === null);
}

/** stock.godowns — "Where is stock lying?": one bar per top-level godown by value (its sub-godowns included). */
export function godownsChart(d: GodownSummaryResult, open?: (row: GodownSummaryRow) => void): ChartSpec | null {
  const slots = barSlots(godownTopRows(d), (r) => r.value, (r) => r.name);
  const values = slots.map((s) => s.value);
  return gate(
    withTotal({
      kind: 'bar',
      title: 'Stock value by godown',
      takeaway: shareTakeaway(slots, 'stock value'),
      categories: slots.map((s) => s.label),
      series: [{ name: 'Value', values }],
      color: signColor(values),
      label: slots.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
      activate: open ? (i) => {
        const row = slots[i]?.row;
        if (row) open(row);
      } : undefined,
    }),
  );
}

export function godownsInline(d: GodownSummaryResult, spec: ChartSpec | null): boolean {
  return !!spec && inlineRows(spec, godownTopRows(d).length);
}

/** The inline bar of a godown-summary row: the top-level godowns only (items and sub-godowns are inside them). */
export function godownBarValue(r: GodownSummaryRow): number | null {
  return r.kind === 'godown' && r.parentKey === null ? r.value : null;
}

// ───────────────────────────── Movement Analysis ─────────────────────────────

/**
 * stock.movement — "Biggest buyers / suppliers of this stock": one bar per party by value, slot 1 on
 * both sides (the Inward / Outward switch never recolours). Enter = the party's ledger.
 */
export function movementChart(d: StockMovementResult, side: 'inward' | 'outward', open?: (row: MovementPartyRow) => void): ChartSpec | null {
  const parties = d[side].rows;
  const slots = barSlots(parties, (r) => r.value, (r) => r.partyName);
  const values = slots.map((s) => s.value);
  const positive = slots.filter((s) => s.value > 0);
  const whole = positive.reduce((a, s) => a + s.value, 0);
  const top = positive.filter((s) => s.row !== null).sort((a, b) => b.value - a.value)[0];
  const takeaway = top ? clipTakeaway(side === 'outward' ? `${top.label} took ${pct(top.value, whole)} % of the value sent out` : `${top.label} supplied ${pct(top.value, whole)} % of the value received`) : '';
  if (!takeaway) return null;
  return gate(
    withTotal({
      kind: 'bar',
      title: side === 'outward' ? 'Biggest buyers' : 'Biggest suppliers',
      takeaway,
      categories: slots.map((s) => s.label),
      series: [{ name: 'Value', values }],
      color: signColor(values),
      label: slots.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
      activate: open ? (i) => {
        const row = slots[i]?.row;
        if (row) open(row);
      } : undefined,
    }),
  );
}

export function movementInline(d: StockMovementResult, side: 'inward' | 'outward', spec: ChartSpec | null): boolean {
  return !!spec && inlineRows(spec, d[side].rows.length);
}

/** The inline bar of a movement row: the parties only (their items are inside them). */
export function movementBarValue(r: MovementTreeRow): number | null {
  return r.kind === 'party' ? r.value : null;
}

// ───────────────────────────── Stats (screens without a graph) ─────────────────────────────

/** One item of a stock report's stat line (ui/StatLine): `count` is the number the words state. */
export interface StockStatItem {
  label: string;
  value: string;
  tone?: 'warning' | 'danger';
  count: number;
}

const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** stock.pendingOrders — "N overdue" (lines past their due date); nothing when none is late. */
export function pendingOrdersStat(d: PendingOrdersResult): StockStatItem[] {
  const n = d.totals.overdueLines;
  return n > 0 ? [{ label: 'Overdue', value: plural(n, 'line'), tone: 'danger', count: n }] : [];
}

/** stock.batches — "Expired N · Expiring in 30 days M" (zero parts dropped). */
export function batchesStat(d: BatchSummaryResult): StockStatItem[] {
  const expired = d.rows.filter((r) => r.status === 'expired').length;
  const expiring = d.rows.filter((r) => r.status === 'expiring').length;
  const out: StockStatItem[] = [];
  if (expired > 0) out.push({ label: 'Expired', value: plural(expired, 'batch', 'batches'), tone: 'danger', count: expired });
  if (expiring > 0) out.push({ label: `Expiring in ${d.windowDays} days`, value: plural(expiring, 'batch', 'batches'), tone: 'warning', count: expiring });
  return out;
}

/** stock.negative — "N items below zero"; nothing when every item is at zero or more (the empty state says so). */
export function negativeStat(rows: readonly NegativeStockRow[]): StockStatItem[] {
  return rows.length > 0 ? [{ label: 'Below zero', value: plural(rows.length, 'item'), tone: 'danger', count: rows.length }] : [];
}

/** stock.reorder — "Order now: N of M items" (M = items with a reorder level). */
export function reorderStat(d: ReorderStatusResult): StockStatItem[] {
  const n = d.rows.filter((r) => r.suggestedQty > 0).length;
  return n > 0 ? [{ label: 'Order now', value: `${n} of ${plural(d.itemsWithLevel, 'item')}`, count: n }] : [];
}
