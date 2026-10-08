/**
 * Day Book / voucher list presentation (pure; tested in daybook.test.ts).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
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
  // Cancelled vouchers keep their number but carry no amount (Tally shows them blank).
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

/** Screen for opening a voucher from a register: alteration (Tally), else the read-only view. */
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
