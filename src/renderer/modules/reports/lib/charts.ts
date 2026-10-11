/**
 * The graphs of the reports module (2.1, SPEC-21 §5 "Reports module", §4.1): one pure builder per
 * catalogue row, each `xxxChart(result, …): ChartSpec | null`, plus the two words the reports say
 * instead of a graph (the Trial Balance check, the P&L's net word). Pure — no React — so
 * charts.test.ts proves "graph total = table total" and every null gate in node.
 *
 * A builder returns null when the data cannot carry the graph (`enoughData`: ≥ 3 non-zero categories or
 * ≥ 3 line points, or a §5 gate); the screen then shows no strip and registers no graph key. Money stays
 * integer paise; folds preserve the sum (ui/lib/chartSpec.ts). Colour follows meaning (D29): slot 1 is
 * the measured thing, slot 2 only the negative pole (loss, overdrawn, cash out), never red/green.
 */
import type {
  CashBankResult,
  CashFlowResult,
  CostCentresResult,
  GroupSummaryResult,
  LedgerReportResult,
  MonthlySummaryResult,
  ProfitTrendResult,
  RegisterResult,
  TrialBalanceResult,
} from '../../../../shared/types/reports.ts';
import { endOfMonth, formatDate } from '../../../../shared/dates.ts';
import { formatDrCr } from '../../../../shared/format.ts';
import { clipTakeaway, compactValue, decimate, enoughData, foldMonths, foldTop, fyLabel, INLINE_MAX_ROWS, MAX_LINE_POINTS, monthName, quarterLabel, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec, ValueFormat } from '../../../ui/lib/chartSpec.ts';
import { statMoney } from '../../../ui/lib/statLine.ts';

/** A date range a graph category stands for (Enter on it opens the same report as Enter on its row). */
export interface DrillRange {
  from: string;
  to: string;
}

type Grain = 'month' | 'quarter' | 'year';

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const grainWord = (g: Grain): string => (g === 'month' ? 'month' : g === 'quarter' ? 'quarter' : 'year');
/** Only a spec the kit can draw: null below the minimum data (D26). */
const drawable = (spec: ChartSpec): ChartSpec | null => (enoughData(spec) ? spec : null);

/**
 * Report months folded to the grain the period reads best at (`foldMonths`: ≤ 13 months monthly, then
 * quarters, then financial years — Σ preserved), with the date range of every category.
 */
export function foldMonthRows(rows: readonly { month: string; from: string; to: string }[], values: readonly number[]): { categories: string[]; values: number[]; grain: Grain; ranges: DrillRange[] } {
  const f = foldMonths(
    rows.map((r) => r.month),
    values,
  );
  const ranges: DrillRange[] = [];
  if (f.grain === 'month') {
    for (const r of rows) ranges.push({ from: r.from, to: r.to });
  } else {
    const key = f.grain === 'quarter' ? quarterLabel : fyLabel;
    let last = '';
    for (const r of rows) {
      const k = key(r.month);
      if (k !== last) ranges.push({ from: r.from, to: r.to });
      else ranges[ranges.length - 1].to = r.to;
      last = k;
    }
  }
  return { ...f, ranges };
}

/** The index of the largest value (first on ties), or -1. */
function argMax(values: readonly number[], pick: (v: number) => number = (v) => v): number {
  let best = -1;
  values.forEach((v, i) => {
    if (best < 0 || pick(v) > pick(values[best])) best = i;
  });
  return best;
}

// ───────────────────────────── Profit & Loss ─────────────────────────────

/** Why the P&L shows no monthly graph although it has months (About this report says it). */
export type ProfitTrendGate = 'compare' | 'stock' | null;

/**
 * The P&L's gate (§5 reports.profitLoss): none in Compare mode (two periods, one graph would mislead) and
 * none when stock is not valued each month while the period has purchases (each purchase would show as a
 * loss in its month).
 */
export function profitTrendGate(t: ProfitTrendResult | null | undefined, compare: boolean): ProfitTrendGate {
  if (compare) return 'compare';
  if (t && !t.inventoryIntegrated && t.months.some((m) => m.purchases !== 0)) return 'stock';
  return null;
}

/**
 * "Net profit by month" (reports.profitLoss): polarity columns — profit slot 1 above the zero line, loss
 * slot 2 below it — with the axis captions "Profit ↑" / "Loss ↓"; Enter on a month opens the P&L of that
 * month. Total = Σ months = the P&L's net profit (core tie-out). Null with < 3 months or under a gate.
 */
export function profitTrendChart(t: ProfitTrendResult | null | undefined, opts: { compare?: boolean; activate?: (range: DrillRange) => void } = {}): ChartSpec | null {
  if (!t || t.months.length < 3 || profitTrendGate(t, !!opts.compare) !== null) return null;
  const f = foldMonthRows(
    t.months,
    t.months.map((m) => m.netProfit),
  );
  const losses = f.values.filter((v) => v < 0).length;
  const profits = f.values.filter((v) => v > 0).length;
  let best = '';
  if (profits > 0) {
    const i = argMax(f.values);
    best = `best ${f.categories[i]} (${compactValue(f.values[i])})`;
  } else if (losses > 0) {
    // Every non-zero period lost money: the closing phrase names the smallest loss.
    const i = argMax(f.values, (v) => (v < 0 ? v : -Infinity));
    best = `smallest in ${f.categories[i]} (${compactValue(Math.abs(f.values[i]))})`;
  }
  const activate = opts.activate;
  return drawable({
    kind: 'column',
    title: `Net profit by ${grainWord(f.grain)}`,
    takeaway: take.polarity(losses, f.categories.length, best, f.grain),
    categories: f.categories,
    series: [{ name: 'Net profit', values: f.values }],
    color: 'polarity',
    axisCaptions: { up: 'Profit ↑', down: 'Loss ↓' },
    label: 'max',
    total: sum(f.values),
    activate: activate ? (i) => activate(f.ranges[i]) : undefined,
  });
}

/**
 * The P&L's one state word in the title row: "Net profit ₹1,29,038" / "Net loss ₹3,43,160.32" (exact,
 * the Net row's figure — allow-listed in chartCatalogue.ts: that row often sits below the fold).
 */
export function profitLossWord(netProfit: number): { text: string; loss: boolean } {
  return { text: `${netProfit < 0 ? 'Net loss' : 'Net profit'} ${statMoney(Math.abs(netProfit))}`, loss: netProfit < 0 };
}

// ───────────────────────────── Registers ─────────────────────────────

const TAXABLE_REGISTERS = new Set(['sales', 'purchase', 'credit_note', 'debit_note']);
const REGISTER_NOUN: Readonly<Record<string, string>> = {
  sales: 'Sales',
  purchase: 'Purchases',
  credit_note: 'Credit notes',
  debit_note: 'Debit notes',
  receipt: 'Receipts',
  payment: 'Payments',
  contra: 'Contra',
  journal: 'Journals',
};

/** What a register's graph measures (§5): taxable value for sales, purchases and notes; the amount otherwise. */
export function registerMeasure(r: Pick<RegisterResult, 'baseType'>): 'taxable' | 'amount' {
  return r.baseType !== null && TAXABLE_REGISTERS.has(r.baseType) ? 'taxable' : 'amount';
}

/** The last month of the end date's quarter / financial year ('YYYY-MM-DD' of its first day). */
function grainEnd(to: string, grain: Grain): string {
  if (grain === 'month') return endOfMonth(to);
  const y = Number(to.slice(0, 4));
  const m = Number(to.slice(5, 7));
  const end = grain === 'quarter' ? (m <= 3 ? 3 : m <= 6 ? 6 : m <= 9 ? 9 : 12) : 3;
  const year = grain === 'year' && m > 3 ? y + 1 : y;
  return endOfMonth(`${year}-${String(end).padStart(2, '0')}-01`);
}

/**
 * "Sales before GST, by month" (reports.register, months view): one series, the largest month labelled,
 * the running (cut) last month drawn as "so far". Enter on a month = Enter on its row (the month's
 * vouchers). Total = Σ months = the register's total (taxable or amount).
 */
export function registerChart(r: RegisterResult | null | undefined, opts: { activate?: (range: DrillRange) => void } = {}): ChartSpec | null {
  if (!r || r.months.length === 0) return null;
  const measure = registerMeasure(r);
  const f = foldMonthRows(
    r.months,
    r.months.map((m) => (measure === 'taxable' ? m.taxable : m.amount)),
  );
  // A register without a noun of its own (a voucher type's register): its title without "Register".
  const noun = (r.baseType !== null ? REGISTER_NOUN[r.baseType] : undefined) ?? r.title.replace(/ Register$/, '');
  const by = `by ${grainWord(f.grain)}`;
  const partialLast = r.to < grainEnd(r.to, f.grain);
  const activate = opts.activate;
  const spec: ChartSpec = {
    kind: 'column',
    title: measure === 'taxable' ? `${noun} before GST, ${by}` : `${noun} ${by}`,
    takeaway: '',
    categories: f.categories,
    series: [{ name: measure === 'taxable' ? 'Taxable value' : 'Amount', values: f.values }],
    partialLast,
    label: 'max',
    total: sum(f.values),
    activate: activate ? (i) => activate(f.ranges[i]) : undefined,
  };
  return drawable({ ...spec, takeaway: take.max(spec) });
}

// ───────────────────────────── Cash / bank books ─────────────────────────────

/** A cash or bank account in credit — the plain word the closing cell carries (no banner). */
export function isOverdrawn(row: { kind: string; closing: number }): boolean {
  return row.kind === 'ledger' && row.closing < 0;
}

/**
 * "Closing balance by account" (reports.cashBank): one bar per cash/bank ledger, an overdrawn one (Cr)
 * left of zero in slot 2. Drawn inline in the table when there are ≤ 7 ledgers; none with fewer than 3.
 * Total = Σ ledgers = the book's total closing.
 */
export function cashBankChart(d: CashBankResult | null | undefined): ChartSpec | null {
  if (!d) return null;
  const ledgers = d.rows.filter((r) => r.kind === 'ledger');
  if (ledgers.length < 3) return null;
  const f = foldTop(
    ledgers,
    6,
    (r) => r.closing,
    (r) => r.name,
  );
  const over = ledgers.filter(isOverdrawn);
  const total = sum(f.values);
  let takeaway: string;
  if (over.length > 0) {
    const worst = over.reduce((a, b) => (b.closing < a.closing ? b : a));
    takeaway = clipTakeaway(over.length === 1 ? `${worst.name} is overdrawn by ${compactValue(-worst.closing)}` : `${over.length} accounts are overdrawn; ${worst.name} by ${compactValue(-worst.closing)}`);
  } else {
    const i = argMax(f.values);
    takeaway = total > 0 ? take.share(f.categories[i], (f.values[i] / total) * 100, 'cash and bank') : '';
  }
  return drawable({
    kind: 'bar',
    title: 'Closing balance by account',
    takeaway,
    categories: f.categories,
    series: [{ name: 'Closing balance', values: f.values }],
    color: 'polarity',
    label: f.categories.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
    total,
  });
}

/** How many table rows the Cash/Bank bars sit on (one per ledger) — for `inlineBars`. */
export function cashBankBarRows(d: CashBankResult | null | undefined): number {
  return d ? d.rows.filter((r) => r.kind === 'ledger').length : 0;
}

// ───────────────────────────── Ledger and monthly summary (detail class) ─────────────────────────────

/** +1 when the account's balance reads naturally as Dr, −1 as Cr (the side its balance sits on). */
function naturalSign(closing: number, opening: number): 1 | -1 {
  return closing < 0 || (closing === 0 && opening < 0) ? -1 : 1;
}

/** Money on the account's natural side: ticks compact, tooltips exact with Dr / Cr. */
function sideFormat(sign: 1 | -1): ValueFormat {
  return { tick: (v) => compactValue(v), full: (v) => formatDrCr(v * sign, { keepZero: true }) };
}

function balanceTakeaway(values: readonly number[], lastLabel: string, firstLabel: string, sign: 1 | -1): string {
  const last = values[values.length - 1];
  const delta = last - values[0];
  const side = (v: number) => `${compactValue(Math.abs(v))} ${v * sign < 0 ? 'Cr' : 'Dr'}`;
  const move = delta === 0 ? '' : `${delta > 0 ? 'up' : 'down'} ${compactValue(Math.abs(delta))} since ${firstLabel}`;
  return take.last(side(last), lastLabel, move);
}

/** A line of balances (opening first), decimated to the kit's point cap. */
function balanceLine(title: string, points: readonly { label: string; value: number }[], sign: 1 | -1, firstLabel: string, activate?: (i: number) => void): ChartSpec | null {
  if (points.length < 3) return null;
  const kept = decimate(
    points.map((p, i) => ({ x: i, y: p.value })),
    MAX_LINE_POINTS,
  );
  const categories = kept.map((p) => points[p.x].label);
  const values = kept.map((p) => p.y);
  return drawable({
    kind: 'line',
    title,
    takeaway: balanceTakeaway(values, categories[categories.length - 1], firstLabel, sign),
    categories,
    series: [{ name: 'Balance', values }],
    label: 'last',
    valueFormat: sideFormat(sign),
    total: values[values.length - 1],
    activate: activate ? (i) => activate(kept[i].x) : undefined,
  });
}

/**
 * "Balance by date" (reports.ledger, detail class): the running balance on the account's natural side,
 * one point per voucher date (its last balance), the opening first; the last point is the table's
 * closing balance. A truncated ledger (more vouchers than the list shows) draws the month-end balances of
 * `monthly` instead (reports.monthlySummary {ledgerId}); without them, no graph.
 */
export function ledgerChart(d: LedgerReportResult | null | undefined, monthly?: MonthlySummaryResult | null): ChartSpec | null {
  if (!d) return null;
  const sign = naturalSign(d.closing, d.opening);
  const opening = { label: 'Opening', value: d.opening * sign };
  const firstLabel = formatDate(d.from, 'D-MMM-YY');
  if (d.truncated) {
    if (!monthly) return null;
    return balanceLine(
      'Balance by month',
      [opening, ...monthly.rows.map((r) => ({ label: `${monthName(r.month)} ${r.month.slice(2, 4)}`, value: r.closing * sign }))],
      sign,
      firstLabel,
    );
  }
  const byDate = new Map<string, number>();
  for (const r of d.rows) byDate.set(r.date, r.balance);
  return balanceLine(
    'Balance by date',
    [opening, ...[...byDate].map(([date, balance]) => ({ label: formatDate(date, 'D-MMM-YY'), value: balance * sign }))],
    sign,
    firstLabel,
  );
}

/**
 * reports.monthlySummary (detail class): an income / expense subject (`isNominal`) → columns of each
 * month's net movement on its natural side (total = the period's net movement); an asset / liability (or
 * old data without the flag) → a line of month-end balances, opening first (total = the closing).
 * Enter on a month opens that month (the same as Enter on its row).
 */
export function monthlySummaryChart(d: MonthlySummaryResult | null | undefined, opts: { activate?: (range: DrillRange) => void } = {}): ChartSpec | null {
  if (!d || d.rows.length === 0) return null;
  const activate = opts.activate;
  if (d.subject.isNominal === true) {
    const net = d.rows.map((r) => r.debit - r.credit);
    const sign: 1 | -1 = d.totals.debit - d.totals.credit < 0 ? -1 : 1;
    const f = foldMonthRows(
      d.rows,
      net.map((v) => v * sign),
    );
    const spec: ChartSpec = {
      kind: 'column',
      title: `Net movement by ${grainWord(f.grain)}`,
      takeaway: '',
      categories: f.categories,
      series: [{ name: sign > 0 ? 'Net debit' : 'Net credit', values: f.values }],
      label: 'max',
      valueFormat: 'inr',
      total: sum(f.values),
      activate: activate ? (i) => activate(f.ranges[i]) : undefined,
    };
    return drawable({ ...spec, takeaway: take.max(spec) });
  }
  const sign = naturalSign(d.closing, d.opening);
  return balanceLine(
    'Month-end balance',
    [{ label: 'Opening', value: d.opening * sign }, ...d.rows.map((r) => ({ label: `${monthName(r.month)} ${r.month.slice(2, 4)}`, value: r.closing * sign }))],
    sign,
    formatDate(d.from, 'D-MMM-YY'),
    activate ? (i) => i > 0 && activate({ from: d.rows[i - 1].from, to: d.rows[i - 1].to }) : undefined,
  );
}

// ───────────────────────────── Group summary ─────────────────────────────

/** +1 for a group whose balance is naturally Dr (assets, expenses), −1 for Cr (liabilities, income). */
export function natureSign(nature: string): 1 | -1 {
  return nature === 'liabilities' || nature === 'income' ? -1 : 1;
}

/** "Holds 70 % of …" for an all-positive split, else the largest by size. */
function largestTakeaway(categories: readonly string[], values: readonly number[], of: string): string {
  const total = sum(values);
  const i = argMax(values, Math.abs);
  if (i < 0) return '';
  if (values.every((v) => v >= 0) && total > 0) return take.share(categories[i], (values[i] / total) * 100, of);
  return clipTakeaway(`${categories[i]} is the largest at ${compactValue(Math.abs(values[i]))}`);
}

/**
 * "Closing balance by account" (reports.groupSummary, summary view, detail class): the group's direct
 * members on its natural side (a member on the other side left of zero, slot 2), Top 6 + Other. Inline
 * in the table with ≤ 7 members. Total = Σ members = the group's closing.
 */
export function groupSummaryChart(d: GroupSummaryResult | null | undefined): ChartSpec | null {
  if (!d) return null;
  const top = d.rows.filter((r) => r.level === 0);
  const sign = natureSign(d.group.nature);
  const f = foldTop(
    top,
    6,
    (r) => r.closing * sign,
    (r) => r.name,
  );
  return drawable({
    kind: 'bar',
    title: 'Closing balance by account',
    takeaway: largestTakeaway(f.categories, f.values, d.group.name),
    categories: f.categories,
    series: [{ name: 'Closing balance', values: f.values }],
    color: 'polarity',
    label: f.categories.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
    total: sum(f.values),
  });
}

// ───────────────────────────── Cash flow ─────────────────────────────

/**
 * "Net cash flow by month" (reports.cashFlow): polarity columns (more in ↑ slot 1, more out ↓ slot 2),
 * captions "In ↑" / "Out ↓"; Enter on a month opens that month. Total = Σ months = the period's net flow.
 */
export function cashFlowChart(d: CashFlowResult | null | undefined, opts: { activate?: (range: DrillRange) => void } = {}): ChartSpec | null {
  if (!d || d.months.length === 0) return null;
  const f = foldMonthRows(
    d.months,
    d.months.map((m) => m.net),
  );
  const unit = `${grainWord(f.grain)}s`;
  const n = f.categories.length;
  const outs = f.values.filter((v) => v < 0).length;
  const ins = f.values.filter((v) => v > 0).length;
  let takeaway: string;
  if (ins === 0 && outs > 0) {
    const i = argMax(f.values, (v) => (v < 0 ? v : -Infinity));
    takeaway = `Net outflow in all ${n} ${unit}; smallest in ${f.categories[i]} (${compactValue(-f.values[i])})`;
  } else {
    const i = argMax(f.values);
    const best = i >= 0 && f.values[i] > 0 ? `; best ${f.categories[i]} (${compactValue(f.values[i])} in)` : '';
    takeaway = `${outs === 0 ? `More in than out in all ${n} ${unit}` : `Net outflow in ${outs} of ${n} ${unit}`}${best}`;
  }
  const activate = opts.activate;
  return drawable({
    kind: 'column',
    title: `Net cash flow by ${grainWord(f.grain)}`,
    takeaway: clipTakeaway(takeaway),
    categories: f.categories,
    series: [{ name: 'Net flow', values: f.values }],
    color: 'polarity',
    axisCaptions: { up: 'In ↑', down: 'Out ↓' },
    label: 'max',
    total: sum(f.values),
    activate: activate ? (i) => activate(f.ranges[i]) : undefined,
  });
}

// ───────────────────────────── Cost centres ─────────────────────────────

/** The category whose centres the graph shows: the given one, else the first. */
export function costCategoryOf(d: CostCentresResult, categoryId?: number): CostCentresResult['rows'][number] | null {
  const cats = d.rows.filter((r) => r.kind === 'category');
  return cats.find((c) => c.id === categoryId) ?? cats[0] ?? null;
}

/** The centres drawn: the direct centres of the chosen category. */
export function costCentresOf(d: CostCentresResult, categoryId?: number): CostCentresResult['rows'] {
  const cat = costCategoryOf(d, categoryId);
  return cat ? d.rows.filter((r) => r.kind === 'centre' && r.parentKey === cat.key) : [];
}

/**
 * "Net by cost centre" (reports.costCentres): the centres of the first (or the given) category by net
 * (Dr = spent, slot 1; Cr left of zero, slot 2), Top 6 + Other; inline in the table with ≤ 7 centres.
 * Total = Σ centres = the category's net.
 */
export function costCentresChart(d: CostCentresResult | null | undefined, categoryId?: number): ChartSpec | null {
  if (!d) return null;
  const cat = costCategoryOf(d, categoryId);
  if (!cat) return null;
  const f = foldTop(
    costCentresOf(d, categoryId),
    6,
    (r) => r.net,
    (r) => r.name,
  );
  return drawable({
    kind: 'bar',
    title: 'Net by cost centre',
    takeaway: largestTakeaway(f.categories, f.values, cat.name),
    categories: f.categories,
    series: [{ name: 'Net', values: f.values }],
    color: 'polarity',
    label: f.categories.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
    total: sum(f.values),
  });
}

// ───────────────────────────── Trial Balance check (a stat, not a graph) ─────────────────────────────

export interface CheckStat {
  label: string;
  value: string;
  /** The amount the stat names (0 when it agrees) — never a visible table total (D24). */
  amount: number;
  tone?: 'danger';
  title: string;
}

/** The Trial Balance's answer: "Agrees ✓", or "Differs by ₹0.32" in the danger tone. */
export function trialBalanceStat(d: Pick<TrialBalanceResult, 'balanced' | 'unbalancedBy'>): CheckStat {
  if (d.balanced && d.unbalancedBy === 0) return { label: '', value: 'Agrees ✓', amount: 0, title: 'Debit and credit totals are equal' };
  const amount = Math.abs(d.unbalancedBy);
  return { label: '', value: `Differs by ${statMoney(amount)}`, amount, tone: 'danger', title: 'Debit and credit totals are not equal' };
}
