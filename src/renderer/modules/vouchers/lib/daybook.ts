/**
 * Day Book / voucher list presentation, and the voucher view's document model (pure; tested in
 * daybook.test.ts).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney, formatPercent } from '../../../../shared/format.ts';
import { isUtgstState } from '../../../../shared/gst/states.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { GstLineView, InstrumentType, LedgerLineInput, PreviewInventoryLine, VoucherDetail, VoucherDetailEntry, VoucherInput, VoucherListRow } from '../../../../shared/types/vouchers.ts';
import { REF_TYPE_LABEL } from './bills.ts';
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

// ───────────────────────────── Voucher view 2.1 (SPEC-21 §1.5, D21) ─────────────────────────────

/** The context run's state words after the date: muted words, and "Cancelled" as the one danger word. */
export function viewStateWords(v: Pick<VoucherDetail, 'isCancelled' | 'isOptional' | 'isPostDated' | 'affectsBooks' | 'irn'>): { danger: string | null; words: string[] } {
  const words: string[] = [];
  if (v.isOptional) words.push('Optional');
  if (v.isPostDated) words.push('Post-dated');
  if (!v.affectsBooks && !v.isCancelled && !v.isOptional) words.push('Not in the books');
  if (v.irn.status) words.push(`e-Invoice ${v.irn.status}`);
  return { danger: v.isCancelled ? 'Cancelled' : null, words };
}

/** The party, once, in one line: "Asha Retail · GSTIN 27AAAPA0002A1Z5". Empty when the voucher has no party. */
export function partyLine(v: Pick<VoucherDetail, 'party' | 'partyLedgerName'>): string {
  const name = v.party.name ?? v.partyLedgerName ?? '';
  if (!name) return '';
  return [name, v.party.gstin ? `GSTIN ${v.party.gstin}` : ''].filter(Boolean).join(' · ');
}

/** The references, in one line: "Ref. PO-551 dt 8-Oct-26 · Against INV-12 dt 2-Oct-26 · e-Way Bill 3410 · Reverse charge". */
export function referenceLine(
  v: Pick<VoucherDetail, 'referenceNo' | 'referenceDate' | 'originalInvoiceNo' | 'originalInvoiceDate' | 'ewayBill' | 'isReverseCharge'>,
): string {
  const dated = (no: string | null, date: string | null, word: string) => (no ? `${word} ${no}${date ? ` dt ${formatDate(date, 'D-MMM-YY')}` : ''}` : '');
  return [
    dated(v.referenceNo, v.referenceDate, 'Ref.'),
    dated(v.originalInvoiceNo, v.originalInvoiceDate, 'Against'),
    v.ewayBill.number ? `e-Way Bill ${v.ewayBill.number}` : '',
    v.isReverseCharge ? 'Reverse charge' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What the view shows: its Particulars — the Accounting entries, or (2.2) the ledger lines as entered of a
 * voucher that posts none (`lines`, viewLineRows: an order's charges, a quotation's lines) — by default
 * without item lines and behind Detailed with them (an invoice's entries, an order's charges); the GST table
 * (Detailed); the totals block (item invoices); and which table takes the focus.
 */
export function viewSections(
  v: Pick<VoucherDetail, 'mode' | 'inventory' | 'entries' | 'gstLines' | 'isCancelled'> & ViewLinesSource,
  detailed: boolean,
): { entries: boolean; lines: boolean; gst: boolean; totals: boolean; focus: 'items' | 'entries' | 'lines' | null } {
  const items = v.inventory.length > 0;
  const particulars = !items || detailed;
  const entries = v.entries.length > 0 && particulars;
  const lines = particulars && enteredLines(v).length > 0;
  return {
    entries,
    lines,
    gst: detailed && v.gstLines.length > 0,
    totals: items && v.mode === 'item_invoice' && !v.isCancelled,
    focus: items ? 'items' : entries ? 'entries' : lines ? 'lines' : null,
  };
}

/** Item columns left out: Godown with one godown, Disc % when none, GST % with one rate, HSN/SAC unless Detailed (and blank ones even then). */
export function hiddenItemColumns(lines: readonly PreviewInventoryLine[], detailed: boolean): string[] {
  const out: string[] = [];
  const distinct = <T>(f: (l: PreviewInventoryLine) => T) => new Set(lines.map(f)).size;
  if (detailed ? lines.every((l) => !l.godownName) : distinct((l) => l.godownName) <= 1) out.push('godownName');
  if (lines.every((l) => !l.discountPct)) out.push('discountPct');
  if (!detailed || lines.every((l) => !l.hsnSac)) out.push('hsnSac');
  const rates = new Set(lines.filter((l) => l.gstRate !== null).map((l) => l.gstRate));
  if (detailed ? rates.size === 0 : rates.size <= 1) out.push('gstRate');
  return out;
}

export interface ViewTotalRow {
  key: string;
  label: string;
  amount: Paise;
  /** The last row ("Total ₹"). */
  grand?: boolean;
  /** Shown muted, not part of the Total: tax the party is not paid (reverse charge, IGST at customs). */
  muted?: boolean;
}

/**
 * The totals block of an item invoice — the same rows as the entry's totals strip (lib/strip.ts):
 * Taxable (Value without GST) · each tax head by name (UTGST in a union territory without a legislature;
 * with its rate when the invoice has one rate) · Other charges (whatever else the invoice adds: non-GST
 * ledgers, TCS) · Round off (when not zero) · Total ₹. Tax the party is not paid — reverse charge, or IGST
 * on an import / SEZ purchase that is paid at customs — is one muted row outside the Total. Every counted
 * row adds up to the last, which is the voucher's amount — the same figure the Day Book and the print show.
 */
export function viewTotals(v: {
  totals: Pick<VoucherDetail['totals'], 'amount' | 'taxable' | 'roundOff'>;
  gstLines: readonly GstLineView[];
  inventory: readonly PreviewInventoryLine[];
  placeOfSupply?: string | null;
}): ViewTotalRow[] {
  const rows: ViewTotalRow[] = [];
  const gst = v.gstLines.length > 0;
  const base = gst ? v.totals.taxable : v.inventory.filter((l) => !l.isConsumption).reduce((s, l) => s + l.amount, 0);
  rows.push({ key: 'base', label: gst ? 'Taxable' : 'Value', amount: base });
  const taxOf = (l: GstLineView): Paise => l.igst + l.cgst + l.sgst + l.cess;
  const paid = v.gstLines.filter((l) => !l.isReverseCharge);
  const reverse = v.gstLines.filter((l) => l.isReverseCharge).reduce((s, l) => s + taxOf(l), 0);
  const rates = new Set(paid.filter((l) => l.taxability === 'taxable' && taxOf(l) !== 0).map((l) => l.rate));
  const rate = rates.size === 1 ? [...rates][0] : null;
  const pct = (r: number | null) => (r !== null ? ` ${formatPercent(r)}` : '');
  const sum = (f: (l: GstLineView) => Paise) => paid.reduce((s, l) => s + f(l), 0);
  const heads: ViewTotalRow[] = [
    { key: 'igst', label: `IGST${pct(rate)}`, amount: sum((l) => l.igst) },
    { key: 'cgst', label: `CGST${pct(rate === null ? null : rate / 2)}`, amount: sum((l) => l.cgst) },
    { key: 'sgst', label: `${isUtgstState(v.placeOfSupply) ? 'UTGST' : 'SGST'}${pct(rate === null ? null : rate / 2)}`, amount: sum((l) => l.sgst) },
    { key: 'cess', label: 'Cess', amount: sum((l) => l.cess) },
  ].filter((h) => h.amount !== 0);
  const headsTotal = heads.reduce((s, h) => s + h.amount, 0);
  let other = v.totals.amount - base - headsTotal - v.totals.roundOff;
  // IGST on an import / SEZ purchase is paid at customs, not to the supplier: the invoice amount leaves
  // out exactly the tax heads (the engine's `payable` rule). Show it beside the Total, not in it.
  const atCustoms = headsTotal !== 0 && other === -headsTotal;
  if (atCustoms) other = 0;
  else rows.push(...heads);
  if (other !== 0) rows.push({ key: 'other', label: 'Other charges', amount: other });
  if (v.totals.roundOff !== 0) rows.push({ key: 'roundOff', label: 'Round off', amount: v.totals.roundOff });
  if (reverse !== 0) rows.push({ key: 'reverse', label: 'Reverse charge tax', amount: reverse, muted: true });
  if (atCustoms) rows.push({ key: 'customs', label: 'Tax paid at customs', amount: headsTotal, muted: true });
  rows.push({ key: 'total', label: 'Total ₹', amount: v.totals.amount, grand: true });
  return rows;
}

// ───────────────────────────── Voucher view 2.2: line descriptions ─────────────────────────────

/**
 * A line's own description as typed on this voucher — an item line's `description`
 * (inventory_entries.description, never the stock item master's) or a Dr / Cr line's `narration` (the
 * narrations the TDS / TCS, GST advance, forex and POS hooks write on their own lines included) — for the
 * muted line under the line's name. Trimmed; line breaks typed inside it are kept (as \n: the view renders
 * it as React text with `white-space: pre-line`); null when there is none.
 */
export function lineDescription(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
}

/** One Dr / Cr line of the view: Particulars (the ledger, then its two muted lines) · Debit · Credit. */
export interface ViewEntryRow {
  key: string;
  name: string;
  /** The line's description (its narration), on a muted line of its own under the name; null when none. */
  description: string | null;
  /** Bills, cost centres, the bank instrument and the bank date in one muted line; '' when none. */
  detail: string;
  debit: Paise;
  credit: Paise;
}

/**
 * The details line under a ledger name: its bills, cost centres, bank instrument and the date it cleared
 * in the bank, joined by ' · '. The line's narration is not part of it (2.2: it is the line's description,
 * shown on a line of its own). `instrumentLabel` names the instrument types (voucher entry's INSTRUMENT_LABEL).
 */
export function entryDetailLine(
  e: Pick<VoucherDetailEntry, 'billAllocations' | 'costAllocations' | 'instrument' | 'bankDate'>,
  instrumentLabel: Readonly<Record<InstrumentType, string>>,
): string {
  const parts: string[] = [];
  for (const b of e.billAllocations) parts.push(`${REF_TYPE_LABEL[b.refType]}${b.billName ? ` ${b.billName}` : ''} ₹ ${formatMoney(Math.abs(b.amount))}${b.dueDate ? ` (due ${formatDate(b.dueDate, 'D-MMM-YY')})` : ''}`);
  for (const c of e.costAllocations) parts.push(`${c.costCentreName ?? 'Cost centre'} ₹ ${formatMoney(Math.abs(c.amount))}`);
  if (e.instrument) {
    const i = e.instrument;
    parts.push([instrumentLabel[i.type], i.number, i.date ? formatDate(i.date, 'D-MMM-YY') : '', i.bankName, i.favouring ? `favouring ${i.favouring}` : ''].filter(Boolean).join(' '));
  }
  if (e.bankDate) parts.push(`Cleared in bank on ${formatDate(e.bankDate, 'D-MMM-YY')}`);
  return parts.join(' · ');
}

/** The view's Dr / Cr lines (signed amounts split into Debit | Credit). */
export function viewEntryRows(entries: readonly VoucherDetailEntry[], instrumentLabel: Readonly<Record<InstrumentType, string>>): ViewEntryRow[] {
  return entries.map((e) => ({
    key: String(e.id),
    name: e.ledgerName,
    description: lineDescription(e.narration),
    detail: entryDetailLine(e, instrumentLabel),
    debit: e.amount > 0 ? e.amount : 0,
    credit: e.amount < 0 ? -e.amount : 0,
  }));
}

// ─────────────── Voucher view 2.2: the Particulars of a voucher that posts no ledger entries ───────────────

/** What the view reads to find them: the entries, the cancelled state and the voucher as entered (vouchers.get). */
export type ViewLinesSource = Pick<VoucherDetail, 'entries' | 'isCancelled'> & { input?: Pick<VoucherInput, 'ledgers'> };

/** A line's ledger until its name has loaded (the entry's pickers show the same). */
export const NAME_PENDING = '…';

/** One Particulars line of a voucher that posts no ledger entries, as entered: Particulars (the ledger, its description under it) · Amount. */
export interface ViewLineRow {
  /** The line's place in input.ledgers: lines without an amount are left out, never renumbered. */
  key: string;
  ledgerId: number;
  name: string;
  /** The line's description (its narration), on a muted line of its own under the name; null when none. */
  description: string | null;
  /** As entered: on an invoice-like document + adds to its value and − deducts (a discount); a Dr / Cr line is Dr + / Cr −. */
  amount: Paise;
}

/**
 * The ledger lines a voucher keeps only as entered (input.ledgers): one that posts no ledger entries — a
 * sales / purchase order, a quotation or proforma, a note or rejection with charges — and is not cancelled (a
 * cancelled voucher keeps its input but shows no lines). Lines without an amount are left out, as on the
 * print. None while the voucher has ledger entries: those are its Particulars, with their own descriptions.
 */
function enteredLines(v: ViewLinesSource): Array<{ line: LedgerLineInput; index: number }> {
  if (v.entries.length > 0 || v.isCancelled) return [];
  return (v.input?.ledgers ?? []).flatMap((line, index) => (line.amount ? [{ line, index }] : []));
}

/** The ledgers the view names for those lines, each once (vouchers/pickers/hooks.ts › useLedgerDetails); none when it shows the entries. */
export function viewLineLedgerIds(v: ViewLinesSource): number[] {
  return [...new Set(enteredLines(v).map(({ line }) => line.ledgerId))];
}

/**
 * Those lines as the view's Particulars, in the order entered (they print from the same input): each ledger
 * as `nameOf` names it (NAME_PENDING until its name is known), the description typed for the line on this
 * voucher under it (lineDescription(narration), as typed) and the amount as entered.
 */
export function viewLineRows(v: ViewLinesSource, nameOf: (ledgerId: number) => string | undefined): ViewLineRow[] {
  return enteredLines(v).map(({ line, index }) => ({
    key: String(index),
    ledgerId: line.ledgerId,
    name: nameOf(line.ledgerId) ?? NAME_PENDING,
    description: lineDescription(line.narration),
    amount: line.amount,
  }));
}
