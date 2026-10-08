import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import {
  COMPOSITION_NOTE,
  copyLabels,
  documentTitle,
  EXPORT_LUT_ENDORSEMENT,
  EXPORT_WPAY_ENDORSEMENT,
  partyLabels,
  SEZ_LUT_ENDORSEMENT,
  SEZ_WPAY_ENDORSEMENT,
  type DocKindInput,
} from './titles.ts';

const sale = (o: Partial<DocKindInput> = {}): DocKindInput => ({
  baseType: 'sales',
  layout: 'invoice',
  companyGst: 'regular',
  direction: 'outward',
  nature: 'b2b',
  hasTaxedLine: true,
  hasUntaxedLine: false,
  exportWithPayment: false,
  partyRegistration: 'regular',
  ...o,
});

describe('documentTitle — sales', () => {
  it('regular dealer, all lines taxed → Tax Invoice', () => {
    assert.deepEqual(documentTitle(sale()), { kind: 'tax_invoice', title: 'Tax Invoice', endorsement: null, notes: [] });
  });
  it('only exempt / nil / non-GST lines → Bill of Supply (Rule 49), custom title ignored', () => {
    const t = documentTitle(sale({ hasTaxedLine: false, hasUntaxedLine: true, nature: 'nil_exempt' }), 'Retail Invoice');
    assert.equal(t.kind, 'bill_of_supply');
    assert.equal(t.title, 'Bill of Supply');
  });
  it('taxed and untaxed lines together → Invoice-cum-Bill of Supply (Rule 46A)', () => {
    const t = documentTitle(sale({ hasUntaxedLine: true }));
    assert.equal(t.kind, 'invoice_cum_bill_of_supply');
    assert.equal(t.title, 'Invoice-cum-Bill of Supply');
  });
  it('composition dealer → Bill of Supply with the composition note', () => {
    const t = documentTitle(sale({ companyGst: 'composition', nature: 'composition_outward' }));
    assert.equal(t.title, 'Bill of Supply');
    assert.deepEqual(t.notes, [COMPOSITION_NOTE]);
  });
  it('unregistered company → Invoice (a custom print title replaces it)', () => {
    assert.equal(documentTitle(sale({ companyGst: 'unregistered', nature: null })).title, 'Invoice');
    assert.equal(documentTitle(sale({ companyGst: 'unregistered', nature: null }), 'Cash Memo').title, 'Cash Memo');
  });
  it('export under LUT / with payment → Export Invoice with the Rule 46 endorsement', () => {
    const lut = documentTitle(sale({ nature: 'export_lut' }), 'My Title');
    assert.equal(lut.kind, 'export_invoice');
    assert.equal(lut.title, 'Export Invoice');
    assert.equal(lut.endorsement, EXPORT_LUT_ENDORSEMENT);
    assert.equal(lut.endorsement, 'Supply meant for export under LUT without payment of IGST');
    const wpay = documentTitle(sale({ nature: 'export_wpay', exportWithPayment: true }));
    assert.equal(wpay.endorsement, EXPORT_WPAY_ENDORSEMENT);
    assert.equal(wpay.endorsement, 'Supply meant for export with payment of IGST');
  });
  it('SEZ supplies → Tax Invoice with the SEZ endorsement', () => {
    assert.equal(documentTitle(sale({ nature: 'sez_lut' })).endorsement, SEZ_LUT_ENDORSEMENT);
    const w = documentTitle(sale({ nature: 'sez_wpay', exportWithPayment: true }));
    assert.equal(w.title, 'Tax Invoice');
    assert.equal(w.endorsement, SEZ_WPAY_ENDORSEMENT);
  });
  it('a custom print title replaces "Tax Invoice"', () => {
    assert.equal(documentTitle(sale(), '  Retail Invoice ').title, 'Retail Invoice');
    assert.equal(documentTitle(sale(), '   ').title, 'Tax Invoice');
  });
  it('ledger-mode sales / purchase → Sales / Purchase Voucher', () => {
    assert.equal(documentTitle(sale({ layout: 'voucher' })).title, 'Sales Voucher');
    assert.equal(documentTitle(sale({ layout: 'voucher', baseType: 'purchase', direction: 'inward' })).title, 'Purchase Voucher');
  });
});

describe('documentTitle — other documents', () => {
  it('purchase → Purchase Voucher; reverse charge from an unregistered supplier → Self Invoice', () => {
    const p = sale({ baseType: 'purchase', direction: 'inward', nature: 'inward_b2b' });
    assert.equal(documentTitle(p).title, 'Purchase Voucher');
    const rcm = documentTitle({ ...p, nature: 'inward_rcm', partyRegistration: 'unregistered' });
    assert.equal(rcm.kind, 'self_invoice');
    assert.equal(rcm.title, 'Self Invoice');
    // RCM from a registered supplier: the supplier issues the invoice.
    assert.equal(documentTitle({ ...p, nature: 'inward_rcm', partyRegistration: 'regular' }).title, 'Purchase Voucher');
  });
  const cases: Array<[VoucherBaseType, string, string]> = [
    ['payment', 'payment_voucher', 'Payment Voucher'],
    ['receipt', 'receipt_voucher', 'Receipt Voucher'],
    ['journal', 'journal_voucher', 'Journal Voucher'],
    ['contra', 'contra_voucher', 'Contra Voucher'],
    ['credit_note', 'credit_note', 'Credit Note'],
    ['debit_note', 'debit_note', 'Debit Note'],
    ['delivery_note', 'delivery_challan', 'Delivery Challan'],
    ['sales_order', 'sales_order', 'Sales Order'],
    ['purchase_order', 'purchase_order', 'Purchase Order'],
    ['receipt_note', 'receipt_note', 'Receipt Note'],
    ['rejection_in', 'rejection_in', 'Rejections In'],
    ['rejection_out', 'rejection_out', 'Rejections Out'],
    ['stock_journal', 'stock_journal', 'Stock Journal'],
    ['physical_stock', 'physical_stock', 'Physical Stock Verification'],
    ['memorandum', 'memorandum', 'Memorandum Voucher'],
    ['reversing_journal', 'reversing_journal', 'Reversing Journal'],
  ];
  for (const [base, kind, title] of cases) {
    it(`${base} → ${title}`, () => {
      const t = documentTitle(sale({ baseType: base, layout: 'voucher', nature: null }));
      assert.equal(t.kind, kind);
      assert.equal(t.title, title);
    });
  }
  it('statutory titles (notes, challan) are not replaced by a custom print title; others are', () => {
    assert.equal(documentTitle(sale({ baseType: 'credit_note' }), 'Sales Return').title, 'Credit Note');
    assert.equal(documentTitle(sale({ baseType: 'delivery_note', layout: 'inventory' }), 'Gate Pass').title, 'Delivery Challan');
    assert.equal(documentTitle(sale({ baseType: 'payment', layout: 'voucher' }), 'Cash Payment').title, 'Cash Payment');
  });
  it('composition dealer notes carry the composition note', () => {
    assert.deepEqual(documentTitle(sale({ baseType: 'credit_note', companyGst: 'composition' })).notes, [COMPOSITION_NOTE]);
  });
});

describe('copyLabels', () => {
  it('goods invoices: recipient / transporter / supplier (Rule 48)', () => {
    assert.deepEqual(copyLabels('tax_invoice', true, true), {
      original: 'Original for Recipient',
      duplicate: 'Duplicate for Transporter',
      triplicate: 'Triplicate for Supplier',
    });
  });
  it('services invoices: recipient / supplier', () => {
    assert.equal(copyLabels('tax_invoice', true, false).duplicate, 'Duplicate for Supplier');
  });
  it('delivery challan: consignee / transporter / consigner (Rule 55)', () => {
    assert.deepEqual(copyLabels('delivery_challan', true, true), {
      original: 'Original for Consignee',
      duplicate: 'Duplicate for Transporter',
      triplicate: 'Triplicate for Consigner',
    });
  });
  it('vouchers and inward documents: plain labels', () => {
    assert.deepEqual(copyLabels('payment_voucher', false, false), { original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' });
    assert.equal(copyLabels('purchase_voucher', false, true).original, 'Original');
  });
});

describe('partyLabels', () => {
  it('names the boxes by document', () => {
    assert.deepEqual(partyLabels('sales', 'outward'), { party: 'Buyer (Bill to)', consignee: 'Consignee (Ship to)' });
    assert.deepEqual(partyLabels('purchase', 'inward'), { party: 'Supplier (Bill from)', consignee: 'Ship to' });
    assert.equal(partyLabels('payment', 'inward').party, 'Paid to');
    assert.equal(partyLabels('receipt', 'outward').party, 'Received from');
    assert.equal(partyLabels('purchase_order', 'inward').party, 'Supplier');
  });
});
