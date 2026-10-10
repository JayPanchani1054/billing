/**
 * Pure presentation logic for the reports screens: drill-down targets, periods, amount text,
 * Horizontal-statement pairing and export tables. Tested in model.test.ts.
 */
import { sideBudget, type BudgetByKey } from './overlay.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { addDays, daysInMonth, endOfMonth, financialYear, formatMonth, parts } from '../../../../shared/dates.ts';
import { formatIndianNumber, formatMoney, formatPercent } from '../../../../shared/format.ts';
import type { GroupSummaryBasis, RatioItem, ReportRowKind, StatementLine, TbRow, VerticalLine } from '../../../../shared/types/reports.ts';
import { indentLabel } from './tree.ts';

// ───────────────────────────── Periods ─────────────────────────────

export interface Range {
  from: string;
  to: string;
}

/** A drilled-down screen's own period (params) when complete and valid, else null (use the global one). */
export function paramsPeriod(params: { from?: unknown; to?: unknown } | undefined): Range | null {
  const from = params?.from;
  const to = params?.to;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return null;
  return { from, to };
}

/** Same calendar date a year earlier (29-Feb → 28-Feb). */
export function sameDayLastYear(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(y - 1, m))).padStart(2, '0')}`;
}

/** Comparative date for a Balance Sheet: the same date last year (a month end stays a month end). */
export function balanceSheetCompareDate(asOf: string): string {
  const prev = sameDayLastYear(asOf);
  return asOf === endOfMonth(asOf) ? endOfMonth(prev) : prev;
}

/** Start of the financial year containing `date`, never before the books beginning. */
export function yearStartFor(date: string, fyStartMonth: number, booksFrom: string): string {
  const s = financialYear(date, fyStartMonth).start;
  return s < booksFrom ? booksFrom : s;
}

/** 'Apr 2026' from '2026-04'. */
export function monthLabel(month: string): string {
  return formatMonth(month);
}

// ───────────────────────────── Drill-down ─────────────────────────────

export interface DrillTarget {
  screen: string;
  params: Record<string, unknown>;
}

export interface DrillRow {
  key: string;
  kind: ReportRowKind;
  id: number | null;
}

export interface DrillOptions {
  /** Balance Sheet: start of the financial year (the P&L A/c line opens the P&L from here). */
  yearStart?: string;
  /**
   * 'profitLoss' when drilling from the Profit & Loss statement (or a summary opened from it): the
   * Group Summary then shows income/expense groups for the period only, agreeing with the P&L line.
   */
  basis?: GroupSummaryBasis;
}

/**
 * Where Enter on a report row goes: group → Group Summary, ledger → Ledger Vouchers, stock → Stock
 * Summary, the Balance Sheet's Profit & Loss A/c → the P&L of the year so far. Other rows (totals,
 * gross/net profit, opening difference) have no drill-down.
 */
export function drillForRow(row: DrillRow, period: Range, opts: DrillOptions = {}): DrillTarget | null {
  switch (row.kind) {
    case 'group':
      if (row.id === null) return null;
      return {
        screen: 'reports.groupSummary',
        params: { groupId: row.id, from: period.from, to: period.to, ...(opts.basis === 'profitLoss' ? { basis: 'profitLoss' } : {}) },
      };
    case 'ledger':
      return row.id === null ? null : { screen: 'reports.ledger', params: { ledgerId: row.id, from: period.from, to: period.to } };
    case 'stock':
      return { screen: 'stock.summary', params: { from: period.from, to: period.to } };
    case 'profit_loss':
    case 'pl_part':
      return { screen: 'reports.profitLoss', params: { from: opts.yearStart ?? period.from, to: period.to } };
    default:
      return null;
  }
}

/** Voucher drill: Enter opens the voucher, Alt+A (alter) opens it in the entry screen. */
export function voucherTarget(voucherId: number, baseType: VoucherBaseType | null, alter = false): DrillTarget {
  return alter
    ? { screen: 'vouchers.entry', params: baseType ? { id: voucherId, baseType } : { id: voucherId } }
    : { screen: 'vouchers.view', params: { id: voucherId } };
}

/**
 * The row an action such as Alt+A (alter voucher) applies to: the table's highlighted row, but only
 * while it is still one of the rows on screen (after a change of ledger, tab or period it is not).
 */
export function currentRow<T>(cursor: T | null, rows: readonly T[] | null | undefined, key: (row: T) => string | number): T | null {
  if (cursor === null || !rows) return null;
  const k = key(cursor);
  return rows.find((r) => key(r) === k) ?? null;
}

// ───────────────────────────── Amount text ─────────────────────────────

/** Side-natural statement amount: negative shown in accounting brackets, never a bare minus. */
export function statementAmountText(v: number | null | undefined, blankZero = false): string {
  if (v === null || v === undefined) return '';
  if (v === 0) return blankZero ? '' : formatMoney(0);
  return v < 0 ? `(${formatMoney(-v)})` : formatMoney(v);
}

/** Human text for a ratio-analysis value. */
export function ratioText(item: Pick<RatioItem, 'unit' | 'value'>): string {
  const v = item.value;
  if (v === null) return '—';
  switch (item.unit) {
    case 'amount':
      return statementAmountText(v);
    case 'ratio':
      return `${formatIndianNumber(v, 2)} : 1`;
    case 'times':
      return `${formatIndianNumber(v, 2)} times`;
    case 'percent':
      return formatPercent(v);
    case 'days':
      return `${formatIndianNumber(v, 0)} ${Math.abs(v) === 1 ? 'day' : 'days'}`;
    default:
      return String(v);
  }
}

// ───────────────────────────── Horizontal statements ─────────────────────────────

/** Pair two visible line lists row by row (two-column layout); the shorter side is padded. */
export function pairLines<A, B>(left: readonly A[], right: readonly B[]): Array<[A | null, B | null]> {
  const n = Math.max(left.length, right.length);
  const out: Array<[A | null, B | null]> = [];
  for (let i = 0; i < n; i++) out.push([left[i] ?? null, right[i] ?? null]);
  return out;
}

export interface ExportTable {
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'drcr' | 'date' | 'number' | 'percent'; width?: number }>;
  rows: Array<Array<string | number | null>>;
  totals?: Array<string | number | null>;
  levels?: number[];
  landscape?: boolean;
  subtitle?: string;
}

export interface StatementSection {
  /** Section caption shown above its rows in the export (e.g. 'Trading Account'), optional. */
  caption?: string;
  left: readonly StatementLine[];
  right: readonly StatementLine[];
  total: number;
  compareTotal: number | null;
}

/** Export of a horizontal statement: Particulars | Amount [| Compare] for each side, pairs of rows. */
export function statementExport(
  sides: { left: string; right: string },
  sections: readonly StatementSection[],
  compareLabel: string | null,
  /** (additive) Budget column per side (lib/overlay.ts): `leftDrNatural` true for a P&L (expenses left), false for a Balance Sheet. */
  budget?: { byKey: BudgetByKey; leftDrNatural: boolean; name: string } | null,
): ExportTable {
  const withCmp = compareLabel !== null;
  const withBud = !!budget;
  const half = (label: string) => [
    { header: label, kind: 'text' as const, width: 34 },
    { header: 'Amount', kind: 'amount' as const, width: 16 },
    ...(withCmp ? [{ header: compareLabel ?? '', kind: 'amount' as const, width: 16 }] : []),
    ...(withBud ? [{ header: `Budget (${budget?.name ?? ''})`, kind: 'amount' as const, width: 16 }] : []),
  ];
  const cells = (l: StatementLine | null, left: boolean): Array<string | number | null> =>
    l
      ? [indentLabel(l.name, l.level), l.amount, ...(withCmp ? [l.compare] : []), ...(withBud ? [sideBudget(budget?.byKey, l.key, left === budget?.leftDrNatural)] : [])]
      : ['', null, ...(withCmp ? [null] : []), ...(withBud ? [null] : [])];
  const rows: Array<Array<string | number | null>> = [];
  const pad = withBud ? [null] : [];
  for (const s of sections) {
    if (s.caption) rows.push([s.caption, null, ...(withCmp ? [null] : []), ...pad, '', null, ...(withCmp ? [null] : []), ...pad]);
    for (const [l, r] of pairLines(s.left, s.right)) rows.push([...cells(l, true), ...cells(r, false)]);
    rows.push(['Total', s.total, ...(withCmp ? [s.compareTotal] : []), ...pad, 'Total', s.total, ...(withCmp ? [s.compareTotal] : []), ...pad]);
  }
  return { columns: [...half(sides.left), ...half(sides.right)], rows, landscape: true };
}

/** Export of the Schedule III-style vertical P&L. */
export function verticalExport(lines: readonly VerticalLine[], compareLabel: string | null): ExportTable {
  const withCmp = compareLabel !== null;
  return {
    columns: [
      { header: 'Particulars', kind: 'text', width: 48 },
      { header: 'Amount', kind: 'amount', width: 18 },
      ...(withCmp ? [{ header: compareLabel ?? '', kind: 'amount' as const, width: 18 }] : []),
    ],
    rows: lines.map((l) => [l.label, l.amount, ...(withCmp ? [l.compare] : [])]),
    levels: lines.map((l) => l.level),
  };
}

export interface TbColumnsShown {
  opening: boolean;
  transactions: boolean;
}

/** Trial-Balance style export (also Group Summary / Cash-Bank): rows in the order given (visible rows). */
export function tbExport(rows: readonly TbRow[], shown: TbColumnsShown): ExportTable {
  const columns: ExportTable['columns'] = [{ header: 'Particulars', kind: 'text', width: 40 }];
  if (shown.opening) columns.push({ header: 'Opening', kind: 'drcr', width: 18 });
  if (shown.transactions) columns.push({ header: 'Debit', kind: 'amount', width: 16 }, { header: 'Credit', kind: 'amount', width: 16 });
  columns.push({ header: 'Closing Dr', kind: 'amount', width: 16 }, { header: 'Closing Cr', kind: 'amount', width: 16 });
  const line = (r: Pick<TbRow, 'name' | 'opening' | 'debit' | 'credit' | 'closing'>): Array<string | number | null> => [
    r.name,
    ...(shown.opening ? [r.opening] : []),
    ...(shown.transactions ? [r.debit || null, r.credit || null] : []),
    r.closing > 0 ? r.closing : null,
    r.closing < 0 ? -r.closing : null,
  ];
  const t = tbTotals(rows);
  return {
    columns,
    rows: rows.map(line),
    levels: rows.map((r) => r.level),
    totals: ['Grand Total', ...(shown.opening ? [null] : []), ...(shown.transactions ? [t.debit, t.credit] : []), t.closingDebit, t.closingCredit],
    landscape: shown.opening && shown.transactions,
  };
}

/** Column totals over the top-level rows (Dr / Cr closing columns split by sign). */
export function tbTotals(rows: readonly Pick<TbRow, 'level' | 'debit' | 'credit' | 'closing'>[]): { debit: number; credit: number; closingDebit: number; closingCredit: number } {
  const t = { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 };
  for (const r of rows) {
    if (r.level !== 0) continue;
    t.debit += r.debit;
    t.credit += r.credit;
    if (r.closing > 0) t.closingDebit += r.closing;
    else t.closingCredit -= r.closing;
  }
  return t;
}

// ───────────────────────────── Registers ─────────────────────────────

export interface RegisterChoice {
  baseType: VoucherBaseType;
  label: string;
}

/** Registers offered in the menu and on the register screen, in the conventional order. */
export const REGISTERS: readonly RegisterChoice[] = [
  { baseType: 'sales', label: 'Sales Register' },
  { baseType: 'purchase', label: 'Purchase Register' },
  { baseType: 'receipt', label: 'Receipt Register' },
  { baseType: 'payment', label: 'Payment Register' },
  { baseType: 'contra', label: 'Contra Register' },
  { baseType: 'journal', label: 'Journal Register' },
  { baseType: 'credit_note', label: 'Credit Note Register' },
  { baseType: 'debit_note', label: 'Debit Note Register' },
];

/** Last day of a month slice for drill-down (clipped to the period end). */
export function monthRange(month: string, period: Range): Range {
  const first = `${month}-01`;
  const last = endOfMonth(first);
  return { from: first < period.from ? period.from : first, to: last > period.to ? period.to : last };
}

/** Days between two ISO dates inclusive. */
export function daysBetween(from: string, to: string): number {
  let n = 1;
  let d = from;
  while (d < to && n < 4000) {
    d = addDays(d, 1);
    n++;
  }
  return n;
}
