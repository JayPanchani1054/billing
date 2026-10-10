/**
 * Gateway menu entries and Go To results of the vouchers module (pure; tested in menu.test.ts).
 */
import { PREDEFINED_VOUCHER_TYPES } from '../../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { CompanyFeatures } from '../../../../shared/settings.ts';
import type { VoucherListRow } from '../../../../shared/types/vouchers.ts';

export interface VoucherMenuEntry {
  label: string;
  baseType: VoucherBaseType;
  hotkey?: string;
  feature?: keyof CompanyFeatures;
  order: number;
  description: string;
  keywords: string[];
}

const DESCRIPTIONS: Readonly<Partial<Record<VoucherBaseType, { text: string; keywords: string[] }>>> = {
  sales: { text: 'GST tax invoice or bill of supply to a customer', keywords: ['invoice', 'bill', 'tax invoice', 'sale'] },
  purchase: { text: "Record a supplier's bill", keywords: ['bill', 'supplier invoice', 'buy'] },
  receipt: { text: 'Money received from a customer or anyone else', keywords: ['collection', 'money in'] },
  payment: { text: 'Money paid to a supplier or for an expense', keywords: ['expense', 'money out', 'pay'] },
  contra: { text: 'Cash deposit, withdrawal or transfer between banks', keywords: ['deposit', 'withdrawal', 'transfer'] },
  journal: { text: 'Adjustments that do not involve cash or bank', keywords: ['adjustment', 'jv'] },
  credit_note: { text: 'Sales return or discount after a sale', keywords: ['sales return', 'cn'] },
  debit_note: { text: 'Purchase return or supplier price change', keywords: ['purchase return', 'dn'] },
  sales_order: { text: 'Order received from a customer', keywords: ['so', 'customer order'] },
  purchase_order: { text: 'Order placed with a supplier', keywords: ['po'] },
  delivery_note: { text: 'Goods sent out before the invoice (challan)', keywords: ['challan', 'dispatch'] },
  receipt_note: { text: 'Goods received before the bill (GRN)', keywords: ['grn', 'inward'] },
  rejection_in: { text: 'Goods returned by a customer, before the credit note', keywords: ['returns in'] },
  rejection_out: { text: 'Goods returned to a supplier, before the debit note', keywords: ['returns out'] },
  stock_journal: { text: 'Move stock between godowns or record manufacturing', keywords: ['transfer', 'manufacturing', 'production'] },
  physical_stock: { text: 'Enter counted stock to correct the books', keywords: ['stock count', 'verification'] },
  memorandum: { text: 'Provisional entry that does not touch the books', keywords: ['memo'] },
  reversing_journal: { text: 'Journal that applies only up to a date', keywords: ['reversing'] },
  quotation: { text: 'Price offer to a customer — no books, own numbering; convert it to an order or invoice', keywords: ['quote', 'estimate', 'offer', 'tender'] },
  proforma: { text: 'Proforma invoice for advance payment — not a tax invoice; convert it to a sales invoice', keywords: ['pro forma', 'pi', 'advance', 'estimate'] },
};

/** Base types the Transactions section lists, in the conventional order. */
const MENU_ORDER: readonly VoucherBaseType[] = [
  'sales',
  'purchase',
  'receipt',
  'payment',
  'contra',
  'journal',
  'credit_note',
  'debit_note',
  'sales_order',
  'purchase_order',
  'delivery_note',
  'receipt_note',
  'rejection_in',
  'rejection_out',
  'stock_journal',
  'physical_stock',
  'memorandum',
  'quotation',
  'proforma',
];

/**
 * Menu entries for voucher entry. `featureOf` is the shell's VOUCHER_FEATURE map (orders need Order
 * processing, rejections need Rejection notes, stock documents need Inventory).
 */
export function voucherMenuEntries(featureOf: Readonly<Partial<Record<VoucherBaseType, keyof CompanyFeatures>>>): VoucherMenuEntry[] {
  return MENU_ORDER.map((b, i) => {
    const t = PREDEFINED_VOUCHER_TYPES.find((p) => p.baseType === b);
    const d = DESCRIPTIONS[b];
    const e: VoucherMenuEntry = {
      label: t?.name ?? b,
      baseType: b,
      order: 10 + i,
      description: d?.text ?? '',
      keywords: [...(d?.keywords ?? []), 'voucher', 'entry'],
    };
    if (t?.hotkey && t.hotkey !== 'F10') e.hotkey = t.hotkey;
    const f = featureOf[b];
    if (f) e.feature = f;
    return e;
  });
}

export interface VoucherGotoItem {
  id: string;
  label: string;
  group: string;
  description: string;
  keywords: string[];
  screen: string;
  params: { id: number };
}

/** Go To results for vouchers: open in alteration, or the read-only view when cancelled or its e-invoice is generated. */
export function voucherGotoItems(rows: readonly VoucherListRow[]): VoucherGotoItem[] {
  return rows.map((r) => {
    const status = r.isCancelled ? 'Cancelled' : r.isOptional ? 'Optional' : '';
    return {
      id: `voucher-doc:${r.id}`,
      label: `${r.voucherTypeName} ${r.number ?? '(no number)'}`,
      group: 'Vouchers',
      description: [formatDate(r.date), r.partyName ?? '', r.isCancelled ? '' : `₹ ${formatMoney(Math.abs(r.amount))}`, status].filter(Boolean).join(' · '),
      keywords: [r.number ?? '', r.partyName ?? '', r.referenceNo ?? ''].filter(Boolean),
      screen: r.isCancelled || r.irnStatus === 'generated' ? 'vouchers.view' : 'vouchers.entry',
      params: { id: r.id },
    };
  });
}
