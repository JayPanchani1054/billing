/**
 * Document kind, title, statutory endorsements, copy labels and party labels — pure rules, tested in
 * titles.test.ts. References: CGST Rules 46 (tax invoice, export endorsement), 46A (invoice-cum-bill
 * of supply), 48 (copies), 49 (bill of supply), 53 (credit/debit notes), 55 (delivery challan).
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { GstNature } from '../../../shared/types/gst.ts';
import type { PrintCopyLabels, PrintDocKind, PrintLayout } from '../../../shared/types/print.ts';

export type CompanyGstStatus = 'regular' | 'composition' | 'unregistered';

export interface DocKindInput {
  baseType: VoucherBaseType;
  layout: PrintLayout;
  /** Company GST status for this document ('unregistered' when the GST feature is off). */
  companyGst: CompanyGstStatus;
  /** GST direction of the document (a Debit Note to a customer is outward). */
  direction: 'outward' | 'inward';
  nature: GstNature | null;
  /** At least one line is taxable at a rate above 0%. */
  hasTaxedLine: boolean;
  /** At least one line is exempt, nil-rated, non-GST or taxable at 0% (other than export/SEZ zero-rating). */
  hasUntaxedLine: boolean;
  /** Export / SEZ supply with payment of IGST. */
  exportWithPayment: boolean;
  /** Party GST registration type ('unregistered', 'overseas', …), null when unknown. */
  partyRegistration: string | null;
}

export interface DocTitle {
  kind: PrintDocKind;
  title: string;
  endorsement: string | null;
  notes: string[];
}

const VOUCHER_TITLES: Partial<Record<VoucherBaseType, [PrintDocKind, string]>> = {
  payment: ['payment_voucher', 'Payment Voucher'],
  receipt: ['receipt_voucher', 'Receipt Voucher'],
  journal: ['journal_voucher', 'Journal Voucher'],
  contra: ['contra_voucher', 'Contra Voucher'],
  memorandum: ['memorandum', 'Memorandum Voucher'],
  reversing_journal: ['reversing_journal', 'Reversing Journal'],
  stock_journal: ['stock_journal', 'Stock Journal'],
  physical_stock: ['physical_stock', 'Physical Stock Verification'],
  sales_order: ['sales_order', 'Sales Order'],
  purchase_order: ['purchase_order', 'Purchase Order'],
  delivery_note: ['delivery_challan', 'Delivery Challan'],
  receipt_note: ['receipt_note', 'Receipt Note'],
  rejection_in: ['rejection_in', 'Rejections In'],
  rejection_out: ['rejection_out', 'Rejections Out'],
  credit_note: ['credit_note', 'Credit Note'],
  debit_note: ['debit_note', 'Debit Note'],
  quotation: ['quotation', 'Quotation'],
};

export const EXPORT_LUT_ENDORSEMENT = 'Supply meant for export under LUT without payment of IGST';
export const EXPORT_WPAY_ENDORSEMENT = 'Supply meant for export with payment of IGST';
export const SEZ_LUT_ENDORSEMENT = 'Supply meant for SEZ unit / developer for authorised operations under LUT without payment of IGST';
export const SEZ_WPAY_ENDORSEMENT = 'Supply meant for SEZ unit / developer for authorised operations with payment of IGST';
export const COMPOSITION_NOTE = 'Composition taxable person, not eligible to collect tax on supplies';
export const REVERSE_CHARGE_NOTE = 'Tax on this supply is payable by the recipient under reverse charge';
/** A proforma invoice is an offer / request for advance, not a supply document (CGST Rule 46 invoices only). */
export const PROFORMA_ENDORSEMENT = 'This is not a tax invoice';

/** Document kind and title. `printTitle` (voucher type › Print title) replaces non-statutory titles only. */
export function documentTitle(input: DocKindInput, printTitle?: string | null): DocTitle {
  const notes: string[] = [];
  const custom = typeof printTitle === 'string' && printTitle.trim() !== '' ? printTitle.trim() : null;
  const pick = (kind: PrintDocKind, title: string, endorsement: string | null = null, overridable = true): DocTitle => ({
    kind,
    title: overridable && custom ? custom : title,
    endorsement,
    notes,
  });
  const { baseType: base, companyGst } = input;

  if (input.layout === 'voucher' && (base === 'sales' || base === 'purchase')) {
    return base === 'sales' ? pick('sales_voucher', 'Sales Voucher') : pick('purchase_voucher', 'Purchase Voucher');
  }

  if (base === 'sales') {
    if (companyGst === 'unregistered') return pick('invoice', 'Invoice');
    if (companyGst === 'composition') {
      notes.push(COMPOSITION_NOTE);
      return pick('bill_of_supply', 'Bill of Supply', null, false);
    }
    const n = input.nature;
    if (n === 'export_lut' || n === 'export_wpay') {
      const lut = n === 'export_lut' && !input.exportWithPayment;
      return pick('export_invoice', 'Export Invoice', lut ? EXPORT_LUT_ENDORSEMENT : EXPORT_WPAY_ENDORSEMENT, false);
    }
    if (n === 'sez_lut' || n === 'sez_wpay') {
      const lut = n === 'sez_lut' && !input.exportWithPayment;
      return pick('sez_invoice', 'Tax Invoice', lut ? SEZ_LUT_ENDORSEMENT : SEZ_WPAY_ENDORSEMENT, false);
    }
    if (n === 'deemed_export') return pick('tax_invoice', 'Tax Invoice', 'Supply under deemed export', false);
    if (!input.hasTaxedLine) return pick('bill_of_supply', 'Bill of Supply', null, false);
    if (input.hasUntaxedLine) return pick('invoice_cum_bill_of_supply', 'Invoice-cum-Bill of Supply', null, false);
    return pick('tax_invoice', 'Tax Invoice');
  }

  if (base === 'purchase') {
    const unregisteredSupplier = input.partyRegistration === null || input.partyRegistration === 'unregistered' || input.partyRegistration === 'consumer';
    if (companyGst !== 'unregistered' && input.nature === 'inward_rcm' && unregisteredSupplier) {
      notes.push(REVERSE_CHARGE_NOTE);
      return pick('self_invoice', 'Self Invoice', null, false);
    }
    return pick('purchase_voucher', 'Purchase Voucher');
  }

  // A custom print title may replace "Proforma Invoice", never the endorsement.
  if (base === 'proforma') return pick('proforma_invoice', 'Proforma Invoice', PROFORMA_ENDORSEMENT);
  const fixed = VOUCHER_TITLES[base];
  if (!fixed) return pick('journal_voucher', 'Voucher');
  const [kind, title] = fixed;
  // Statutory titles (Rule 53 notes, Rule 55 challan) are not replaced by a custom print title.
  const statutory = kind === 'credit_note' || kind === 'debit_note' || kind === 'delivery_challan';
  if (companyGst === 'composition' && (kind === 'credit_note' || kind === 'debit_note') && input.direction === 'outward') {
    notes.push(COMPOSITION_NOTE);
  }
  return pick(kind, title, null, !statutory);
}

/** Copy labels (Rule 48 for invoices of goods / services, Rule 55 for delivery challans). */
export function copyLabels(kind: PrintDocKind, outward: boolean, hasGoods: boolean): PrintCopyLabels {
  if (kind === 'delivery_challan') {
    return { original: 'Original for Consignee', duplicate: 'Duplicate for Transporter', triplicate: 'Triplicate for Consigner' };
  }
  const invoiceKinds: readonly PrintDocKind[] = [
    'tax_invoice',
    'bill_of_supply',
    'invoice_cum_bill_of_supply',
    'invoice',
    'export_invoice',
    'sez_invoice',
    'credit_note',
    'debit_note',
  ];
  if (outward && invoiceKinds.includes(kind)) {
    return hasGoods
      ? { original: 'Original for Recipient', duplicate: 'Duplicate for Transporter', triplicate: 'Triplicate for Supplier' }
      : { original: 'Original for Recipient', duplicate: 'Duplicate for Supplier', triplicate: 'Triplicate' };
  }
  return { original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' };
}

/** Labels for the party and ship-to boxes. */
export function partyLabels(base: VoucherBaseType, direction: 'outward' | 'inward'): { party: string; consignee: string } {
  switch (base) {
    case 'payment':
      return { party: 'Paid to', consignee: 'Ship to' };
    case 'receipt':
      return { party: 'Received from', consignee: 'Ship to' };
    case 'purchase_order':
      return { party: 'Supplier', consignee: 'Ship to' };
    case 'delivery_note':
      return { party: 'Buyer (Bill to)', consignee: 'Consignee (Ship to)' };
    case 'stock_journal':
    case 'physical_stock':
    case 'journal':
    case 'contra':
    case 'memorandum':
    case 'reversing_journal':
      return { party: 'Party', consignee: 'Ship to' };
    default:
      return direction === 'outward'
        ? { party: 'Buyer (Bill to)', consignee: 'Consignee (Ship to)' }
        : { party: 'Supplier (Bill from)', consignee: 'Ship to' };
  }
}

/** Natural direction of a base type (a debit note follows its party; see data.ts). */
export function baseDirection(base: VoucherBaseType): 'outward' | 'inward' {
  return base === 'purchase' || base === 'purchase_order' || base === 'receipt_note' || base === 'rejection_out' || base === 'debit_note' || base === 'payment'
    ? 'inward'
    : 'outward';
}

/** Kinds that carry the seller's declaration, bank details and UPI QR (documents asking the buyer to pay). */
export function isSalesDocument(kind: PrintDocKind): boolean {
  return (
    kind === 'tax_invoice' ||
    kind === 'bill_of_supply' ||
    kind === 'invoice_cum_bill_of_supply' ||
    kind === 'invoice' ||
    kind === 'export_invoice' ||
    kind === 'sez_invoice'
  );
}
