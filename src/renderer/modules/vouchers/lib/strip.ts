/**
 * Voucher entry 2.1 (SPEC-21 D13, D15, D19) — pure, tested in strip.test.ts:
 *
 * - `totalsStrip`: the sticky totals strip of an invoice — Taxable · each tax head by name (CGST + SGST /
 *   UTGST, or IGST, then Cess) · Other charges (non-GST lines after tax, e.g. TCS) · Round off (when ≠ 0) ·
 *   Total ₹. Reverse-charge tax is one muted item outside the total (it is not payable to the party). The
 *   drawn items always add up to the Total, and the Total is the invoice's `grandTotal`.
 * - `stripTooltip` / `stripNotes`: what moved off the screen — "Intra-state · GSTR-1: B2C small" and the
 *   amount in words in the Total's tooltip; engine notes and the server figure as a second muted line.
 * - `partyLine`: the one muted line under the party ("Cur bal 54,356.00 Cr · Overdue 14,644.00 (190 d) ·
 *   Limit exceeded · Unregistered").
 * - `acceptMessage`: "Accept?" reads the amount back, in figures and in words.
 *
 * Read-only presentation of figures the GST engine already computed: nothing here changes what is posted.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { diffDays } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import { amountInWords } from '../../../../shared/words.ts';
import type { PendingBill } from '../../../../shared/types/vouchers.ts';
import type { TaxBreakupRow } from './masters.ts';

export interface StripItem {
  key: string;
  label: string;
  amount: Paise;
  /** Shown, but not part of the Total (reverse-charge tax). */
  muted?: boolean;
}

export interface TotalsStrip {
  items: StripItem[];
  total: Paise;
}

const HEAD_ORDER = ['CGST', 'SGST', 'UTGST', 'IGST', 'Cess'] as const;

/** "CGST @ 9%" / "Cess (reverse charge)" → "CGST" / "Cess". */
function headOf(label: string): string {
  return label.replace(/ \(reverse charge\)$/, '').split(' @')[0].trim();
}

/** The strip's items, left to right, and the Total (= the invoice's grand total). */
export function totalsStrip(o: { taxable: Paise; tax: readonly TaxBreakupRow[]; outside: Paise; roundOff: Paise; grandTotal: Paise; /** A company without GST says "Value", not "Taxable". */ gst?: boolean }): TotalsStrip {
  const heads = new Map<string, Paise>();
  let reverse = 0;
  for (const t of o.tax) {
    if (t.key.startsWith('rc:')) {
      reverse += t.amount;
      continue;
    }
    const h = headOf(t.label);
    heads.set(h, (heads.get(h) ?? 0) + t.amount);
  }
  const rank = (h: string): number => {
    const i = (HEAD_ORDER as readonly string[]).indexOf(h);
    return i < 0 ? HEAD_ORDER.length : i;
  };
  const items: StripItem[] = [{ key: 'taxable', label: o.gst === false ? 'Value' : 'Taxable', amount: o.taxable }];
  for (const [h, amount] of [...heads].sort((a, b) => rank(a[0]) - rank(b[0]))) if (amount !== 0) items.push({ key: `tax:${h}`, label: h, amount });
  if (o.outside !== 0) items.push({ key: 'outside', label: 'Other charges', amount: o.outside });
  if (o.roundOff !== 0) items.push({ key: 'ro', label: 'Round off', amount: o.roundOff });
  if (reverse !== 0) items.push({ key: 'rc', label: 'Reverse charge tax', amount: reverse, muted: true });
  return { items, total: o.grandTotal };
}

/** Sum of the drawn, counted items — equals `total` whenever the computation is consistent (tested). */
export function stripSum(s: TotalsStrip): Paise {
  return s.items.reduce((a, i) => (i.muted ? a : a + i.amount), 0);
}

/** "1,000.00", "(−) 10.00" for a deduction. */
export function stripAmount(p: Paise): string {
  return p < 0 ? `(−) ${formatMoney(-p)}` : formatMoney(p);
}

export const NATURE_LABEL: Readonly<Record<string, string>> = {
  b2b: 'B2B',
  b2cl: 'B2C large',
  b2cs: 'B2C small',
  export_wp: 'Export with IGST',
  export_wop: 'Export under LUT',
  sez_wp: 'SEZ with IGST',
  sez_wop: 'SEZ under LUT',
  deemed_export: 'Deemed export',
  nil_exempt: 'Nil / exempt',
  non_gst: 'Non-GST',
};

export function natureLabel(n: string): string {
  return NATURE_LABEL[n] ?? n.replace(/_/g, ' ');
}

/**
 * The Total's tooltip: "Intra-state · GSTR-1: B2C small" (GST documents) and the amount in words
 * (rupee invoices with a positive total). One line each.
 */
export function stripTooltip(o: { gst: { interState: boolean; nature: string; reverseCharge: boolean } | null; total: Paise; words: boolean }): string {
  const lines: string[] = [];
  if (o.gst) lines.push(`${o.gst.interState ? 'Inter-state' : 'Intra-state'} · GSTR-1: ${natureLabel(o.gst.nature)}${o.gst.reverseCharge ? ' · Reverse charge' : ''}`);
  if (o.words && o.total > 0) lines.push(amountInWords(o.total));
  return lines.join('\n');
}

/** The engine's note on an empty invoice: shown only after a save attempt (D18). */
export const NO_LINES_NOTE = 'Invoice has no lines';

/**
 * The strip's second muted line: the GST engine's notes (without "Invoice has no lines" until a save was
 * attempted) and, when the server's check differs, what the books will record.
 */
export function stripNotes(o: { warnings: readonly string[]; saveAttempted: boolean; serverTotal: Paise | null; total: Paise }): string[] {
  const out = o.warnings.filter((w) => o.saveAttempted || w !== NO_LINES_NOTE);
  if (o.serverTotal !== null && o.serverTotal !== o.total) out.push(`The books will record ₹ ${formatMoney(o.serverTotal)} (checked with the saved masters).`);
  return out;
}

export interface PartyLineSegment {
  key: 'balance' | 'overdue' | 'limit' | 'unregistered';
  text: string;
  /** Danger text (overdue, limit exceeded). */
  danger?: boolean;
}

/** Bill-wise overdue on the party's own side: receivable (Dr) bills for a customer, payable (Cr) for a supplier. */
export function overdueOf(bills: readonly PendingBill[], date: string, side: 'dr' | 'cr'): { amount: Paise; days: number } {
  let amount = 0;
  let days = 0;
  for (const b of bills) {
    if (!b.dueDate || b.dueDate >= date) continue;
    if (side === 'dr' ? b.amount <= 0 : b.amount >= 0) continue;
    amount += Math.abs(b.amount);
    days = Math.max(days, diffDays(b.dueDate, date));
  }
  return { amount, days };
}

/** Invoices and notes post the party; orders, quotations and stock documents do not. */
const POSTS_PARTY: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['sales', 'purchase', 'credit_note', 'debit_note']);

/**
 * The one line under the party (D15). Sales / purchase side: current balance, then (when > 0) the overdue
 * amount with the age of the oldest overdue bill, "Limit exceeded" when this voucher would take the party
 * over its credit limit, and "Unregistered" for a purchase from a supplier without a GSTIN (the reverse
 * charge / input credit cue). Receipt / payment: the balance only (the side column lists the bills).
 */
export function partyLine(o: {
  baseType: VoucherBaseType;
  date: string;
  /** Sales side (customer, Dr) or purchase side (supplier, Cr). */
  side: 'dr' | 'cr';
  party: { balance: Paise; creditLimit: Paise | null; gstin: string | null; pendingBills: readonly PendingBill[] };
  /** What this voucher adds to the party's Dr balance (sales: +grand total). */
  voucherEffect: Paise;
}): PartyLineSegment[] {
  const out: PartyLineSegment[] = [{ key: 'balance', text: `Cur bal ${formatDrCr(o.party.balance, { keepZero: true })}` }];
  if (o.baseType === 'receipt' || o.baseType === 'payment' || o.baseType === 'contra' || o.baseType === 'journal') return out;
  const od = overdueOf(o.party.pendingBills, o.date, o.side);
  if (od.amount > 0) out.push({ key: 'overdue', text: `Overdue ${formatMoney(od.amount)} (${od.days} d)`, danger: true });
  const limit = o.party.creditLimit;
  if (POSTS_PARTY.has(o.baseType) && limit !== null && limit > 0 && o.voucherEffect > 0 && o.party.balance + o.voucherEffect > limit) out.push({ key: 'limit', text: 'Limit exceeded', danger: true });
  if (o.baseType === 'purchase' && !(o.party.gstin ?? '').trim()) out.push({ key: 'unregistered', text: 'Unregistered' });
  return out;
}

/**
 * "Accept this voucher?" (D19): the amount read back in figures and words.
 *   invoice  → "Sales for ₹ 27,140.00 (Rupees Twenty Seven Thousand One Hundred Forty Only) to Asha Retail."
 *   foreign  → "Sales for $ 2,000.00 to Acme Inc." (`totalText` given; no rupee words)
 *   ledger   → "Receipt: Dr ₹ 50,000.00 = Cr ₹ 50,000.00 (Rupees Fifty Thousand Only)."
 *   stock    → "Delivery Note with 3 item line(s)."
 */
export function acceptMessage(o: {
  typeName: string;
  kind: 'invoice' | 'ledger' | 'stock';
  total: Paise;
  /** A foreign-currency invoice total, already formatted. */
  totalText?: string | null;
  partyName?: string | null;
  debit?: Paise;
  credit?: Paise;
  itemLines?: number;
}): string {
  if (o.kind === 'invoice') {
    const amount = o.totalText ? o.totalText : `₹ ${formatMoney(o.total)}${o.total > 0 ? ` (${amountInWords(o.total)})` : ''}`;
    const text = `${o.typeName} for ${amount}${o.partyName ? ` to ${o.partyName}` : ''}`;
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  if (o.kind === 'ledger') {
    const dr = o.debit ?? 0;
    const cr = o.credit || dr;
    return `${o.typeName}: Dr ₹ ${formatMoney(dr)} = Cr ₹ ${formatMoney(cr)}${dr > 0 && dr === cr ? ` (${amountInWords(dr)})` : ''}.`;
  }
  return `${o.typeName} with ${o.itemLines ?? 0} item line(s).`;
}
