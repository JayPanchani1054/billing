/**
 * Day Book / voucher list presentation (pure; tested in daybook.test.ts). The voucher view's document
 * model is in voucherView.ts: this file is part of the start-up bundle (the Day Book and the Go To
 * provider are eager), the view is not.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { VoucherListRow } from '../../../../shared/types/vouchers.ts';
import { dayBookSide } from './kinds.ts';

export interface DayBookRow {
  id: number;
  date: string;
  particulars: string;
  /** Status words appended to the particulars (shown as badges). */
  flags: string[];
  typeName: string;
  baseType: VoucherBaseType;
  number: string;
  debit: Paise;
  credit: Paise;
  narration: string | null;
  isCancelled: boolean;
  isOptional: boolean;
  /** An e-invoice (IRN) was generated: the voucher can no longer be altered or deleted (cancel only). */
  irnGenerated: boolean;
}

export function toDayBookRow(r: VoucherListRow): DayBookRow {
  const side = dayBookSide(r.baseType);
  const flags: string[] = [];
  if (r.isCancelled) flags.push('Cancelled');
  if (r.isOptional) flags.push('Optional');
  if (r.isPostDated) flags.push('Post-dated');
  // Cancelled vouchers keep their number but carry no amount (shown blank).
  const amount = r.isCancelled ? 0 : Math.abs(r.amount);
  return {
    id: r.id,
    date: r.date,
    particulars: r.partyName ?? r.narration ?? '',
    flags,
    typeName: r.voucherTypeName,
    baseType: r.baseType,
    number: r.number ?? '',
    debit: side === 'dr' ? amount : 0,
    credit: side === 'cr' ? amount : 0,
    narration: r.narration,
    isCancelled: r.isCancelled,
    isOptional: r.isOptional,
    irnGenerated: r.irnStatus === 'generated',
  };
}

/** Totals exclude optional and cancelled vouchers (they are not in the books). */
export function dayBookTotals(rows: readonly DayBookRow[]): { debit: Paise; credit: Paise } {
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    if (r.isCancelled || r.isOptional) continue;
    debit += r.debit;
    credit += r.credit;
  }
  return { debit, credit };
}

export interface TypeChip {
  id: string;
  label: string;
  baseTypes: readonly VoucherBaseType[];
}

/** Filter chips of the Day Book (feature-aware chips are filtered by the screen). */
export const DAYBOOK_CHIPS: readonly TypeChip[] = [
  { id: 'sales', label: 'Sales', baseTypes: ['sales'] },
  { id: 'purchase', label: 'Purchase', baseTypes: ['purchase'] },
  { id: 'receipt', label: 'Receipt', baseTypes: ['receipt'] },
  { id: 'payment', label: 'Payment', baseTypes: ['payment'] },
  { id: 'contra', label: 'Contra', baseTypes: ['contra'] },
  { id: 'journal', label: 'Journal', baseTypes: ['journal'] },
  { id: 'notes', label: 'Credit / Debit Notes', baseTypes: ['credit_note', 'debit_note'] },
  { id: 'orders', label: 'Orders', baseTypes: ['sales_order', 'purchase_order'] },
  { id: 'stock', label: 'Stock', baseTypes: ['delivery_note', 'receipt_note', 'rejection_in', 'rejection_out', 'stock_journal', 'physical_stock'] },
  { id: 'memo', label: 'Memo', baseTypes: ['memorandum', 'reversing_journal'] },
];

/** Base types for the selected chips (undefined = all). */
export function baseTypesOf(selected: readonly string[]): VoucherBaseType[] | undefined {
  if (selected.length === 0) return undefined;
  const out: VoucherBaseType[] = [];
  for (const c of DAYBOOK_CHIPS) if (selected.includes(c.id)) out.push(...c.baseTypes);
  return out.length ? out : undefined;
}

export function toggleChip(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Export rows: Date | Particulars | Vch Type | Vch No. | Debit | Credit (paise, ISO dates). */
export function dayBookExportRows(rows: readonly DayBookRow[]): Array<Array<string | number | null>> {
  return rows.map((r) => [r.date, r.flags.length ? `${r.particulars} (${r.flags.join(', ')})` : r.particulars, r.typeName, r.number, r.debit || null, r.credit || null]);
}

/** Export totals row (same rule as the screen: optional and cancelled vouchers are not counted). */
export function dayBookExportTotals(rows: readonly DayBookRow[]): Array<string | number | null> {
  const t = dayBookTotals(rows);
  return ['', 'Total (optional and cancelled vouchers not counted)', '', '', t.debit, t.credit];
}

/** Screen for opening a voucher from a register: alteration, else the read-only view. */
export function openTarget(r: Pick<DayBookRow, 'isCancelled' | 'irnGenerated'>, canAlter: boolean): 'vouchers.entry' | 'vouchers.view' {
  return r.isCancelled || r.irnGenerated || !canAlter ? 'vouchers.view' : 'vouchers.entry';
}

/** Row to highlight after `id` is deleted: the next one, else the previous one. */
export function keyAfterRemoval(rows: readonly DayBookRow[], id: number): string | null {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const next = rows[i + 1] ?? rows[i - 1];
  return next ? String(next.id) : null;
}

/** The list route accepts at most 100 characters of search text. */
export const SEARCH_MAX = 100;
export const searchText = (s: string): string => s.trim().slice(0, SEARCH_MAX);

// ───────────────────────────── Day Book 2.1 (SPEC-21 §1.6) ─────────────────────────────

export interface DayRange {
  from: string;
  to: string;
}

/**
 * One date input or two: one while the Day Book shows one day (the default: the working date); From – To
 * once the range spans more than one day, or when a range was asked for (Alt+F2, More › "Date range…")
 * so the To date can be typed.
 */
export function dayBookDates(range: DayRange, rangeMode: boolean): 'single' | 'range' {
  return rangeMode || range.from !== range.to ? 'range' : 'single';
}

/** The range is exactly the period (More › "Whole period" shows ✓). */
export function isWholePeriod(range: DayRange, period: DayRange): boolean {
  return range.from === period.from && range.to === period.to;
}

/** The "Voucher types" menu button's label: "All vouchers", "Sales, Receipt" (one or two types) or "3 types". */
export function typesLabel(selected: readonly string[], chips: readonly TypeChip[] = DAYBOOK_CHIPS): string {
  const labels = chips.filter((c) => selected.includes(c.id)).map((c) => c.label);
  if (labels.length === 0) return 'All vouchers';
  return labels.length <= 2 ? labels.join(', ') : `${labels.length} types`;
}

/** "1 voucher", "6 vouchers", "1,234 vouchers" (the toolbar row's count). */
export function voucherCount(n: number): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? 'voucher' : 'vouchers'}`;
}

/** The one-line empty state and its one link. */
export function dayBookEmpty(o: { filtered: boolean; range: DayRange; wholePeriod: boolean }): { title: string; link: 'clear' | 'whole' | null } {
  if (o.filtered) return { title: 'No vouchers match', link: 'clear' };
  const title = o.range.from === o.range.to ? `No vouchers on ${formatDate(o.range.from, 'D-MMM-YY')}` : 'No vouchers in this period';
  return { title, link: o.wholePeriod ? null : 'whole' };
}
