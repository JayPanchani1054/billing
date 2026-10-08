/**
 * What each voucher base type looks like on the entry screen — pure data mirrored from the posting
 * engine (src/core/modules/vouchers/posting.ts ALLOWED_MODES / STOCK_DIRECTION / PARTY_REQUIRED) so
 * the screen can lay itself out before the server is asked anything.
 */
import { GST_BASE_TYPES, PREDEFINED_VOUCHER_TYPES } from '../../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type { TrackingKind, VoucherMode } from '../../../../shared/types/vouchers.ts';

export const ALLOWED_MODES: Readonly<Record<VoucherBaseType, readonly VoucherMode[]>> = {
  sales: ['item_invoice', 'accounting_invoice', 'ledger'],
  purchase: ['item_invoice', 'accounting_invoice', 'ledger'],
  credit_note: ['item_invoice', 'accounting_invoice', 'ledger'],
  debit_note: ['item_invoice', 'accounting_invoice', 'ledger'],
  payment: ['ledger'],
  receipt: ['ledger'],
  contra: ['ledger'],
  journal: ['ledger'],
  memorandum: ['ledger'],
  reversing_journal: ['ledger'],
  sales_order: ['item_invoice', 'inventory'],
  purchase_order: ['item_invoice', 'inventory'],
  delivery_note: ['item_invoice', 'inventory'],
  receipt_note: ['item_invoice', 'inventory'],
  rejection_in: ['item_invoice', 'inventory'],
  rejection_out: ['item_invoice', 'inventory'],
  stock_journal: ['inventory'],
  physical_stock: ['inventory'],
};

const PARTY_REQUIRED = new Set<VoucherBaseType>(['sales_order', 'purchase_order', 'delivery_note', 'receipt_note', 'rejection_in', 'rejection_out']);
const ORDERS = new Set<VoucherBaseType>(['sales_order', 'purchase_order']);
const NOTES = new Set<VoucherBaseType>(['delivery_note', 'receipt_note', 'rejection_in', 'rejection_out']);
const OUTWARD = new Set<VoucherBaseType>(['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in']);
const ACCOUNTING = new Set<VoucherBaseType>(['sales', 'purchase', 'payment', 'receipt', 'contra', 'journal', 'credit_note', 'debit_note']);

export const isGstBase = (b: VoucherBaseType): boolean => GST_BASE_TYPES.includes(b);
export const isInvoiceMode = (m: VoucherMode): boolean => m === 'item_invoice' || m === 'accounting_invoice';
export const isOrder = (b: VoucherBaseType): boolean => ORDERS.has(b);
export const isNote = (b: VoucherBaseType): boolean => NOTES.has(b);
/** Posts to the books when regular (memorandum / reversing journals balance but never post). */
export const postsToBooks = (b: VoucherBaseType): boolean => ACCOUNTING.has(b);

/** Party ledger needed: invoice modes, orders, notes and rejections. */
export function partyRequired(b: VoucherBaseType, mode: VoucherMode): boolean {
  return isInvoiceMode(mode) || PARTY_REQUIRED.has(b);
}

/** Party field shown at all (ledger-mode vouchers have their parties among the lines). */
export function showsParty(b: VoucherBaseType, mode: VoucherMode): boolean {
  return mode !== 'ledger' && partyRequired(b, mode);
}

/** Default GST direction of the voucher type (a Debit Note to a customer turns outward — PartyContext.gstDirection). */
export function defaultDirection(b: VoucherBaseType): 'outward' | 'inward' {
  return OUTWARD.has(b) ? 'outward' : 'inward';
}

/** Party sign of an invoice: +1 party Dr (sales, debit note), −1 party Cr (purchase, credit note). */
export function partySign(b: VoucherBaseType): 1 | -1 {
  return b === 'sales' || b === 'debit_note' ? 1 : -1;
}

/**
 * Tally single-entry layout ("Account" at the top + particulars): which side the Account line takes.
 * Payment / Contra: the account (cash/bank) is credited, particulars debited. Receipt: the reverse.
 * Other ledger vouchers only have the double-entry layout.
 */
export function singleEntryAccountSide(b: VoucherBaseType): 'dr' | 'cr' | null {
  if (b === 'payment' || b === 'contra') return 'cr';
  if (b === 'receipt') return 'dr';
  return null;
}

/** Documents an invoice/note of this type may be filled from (vouchers.trackingRefs kinds). */
export function trackingKinds(b: VoucherBaseType, features: { trackingNumbers: boolean; orderProcessing: boolean }): TrackingKind[] {
  const out: TrackingKind[] = [];
  if (b === 'sales') {
    if (features.trackingNumbers) out.push('delivery');
    if (features.orderProcessing) out.push('sales_order');
  } else if (b === 'purchase') {
    if (features.trackingNumbers) out.push('receipt');
    if (features.orderProcessing) out.push('purchase_order');
  } else if (b === 'delivery_note') {
    if (features.orderProcessing) out.push('sales_order');
  } else if (b === 'receipt_note') {
    if (features.orderProcessing) out.push('purchase_order');
  }
  return out;
}

export const TRACKING_KIND_LABEL: Readonly<Record<TrackingKind, string>> = {
  delivery: 'Delivery Notes',
  receipt: 'Receipt Notes',
  sales_order: 'Sales Orders',
  purchase_order: 'Purchase Orders',
};

/** 'Sales', 'Credit Note' … from the predefined voucher types. */
export function baseTypeLabel(b: VoucherBaseType): string {
  return PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === b)?.name ?? b.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function baseTypeHotkey(b: VoucherBaseType): string | undefined {
  return PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === b)?.hotkey;
}

/** Label of the item/stock column header for a base type. */
export function qtyLabel(b: VoucherBaseType): string {
  return b === 'physical_stock' ? 'Counted qty' : 'Quantity';
}

export const MODE_LABEL: Readonly<Record<VoucherMode, string>> = {
  item_invoice: 'Item invoice',
  accounting_invoice: 'Accounting invoice',
  ledger: 'As voucher (Dr/Cr)',
  inventory: 'Stock only',
};

/** Pick a default voucher type for a base type: an active predefined type first, then any active one. */
export function defaultTypeFor<T extends { id: number; baseType: VoucherBaseType; isActive: boolean; isPredefined: boolean }>(
  types: readonly T[],
  base: VoucherBaseType,
): T | null {
  const active = types.filter((t) => t.baseType === base && t.isActive);
  return active.find((t) => t.isPredefined) ?? active[0] ?? null;
}

/**
 * Day Book column a voucher's amount goes in (Tally: the side of the first particulars line).
 * Sales / debit note: party Dr → Debit. Purchase / credit note: party Cr → Credit. Payment / contra /
 * journal: the particulars are debited → Debit. Receipt: credited → Credit. Stock documents follow the
 * direction of the goods (outward like a sale → Debit, inward → Credit).
 */
export function dayBookSide(b: VoucherBaseType): 'dr' | 'cr' {
  switch (b) {
    case 'purchase':
    case 'credit_note':
    case 'receipt':
    case 'purchase_order':
    case 'receipt_note':
    case 'rejection_in':
      return 'cr';
    default:
      return 'dr';
  }
}
