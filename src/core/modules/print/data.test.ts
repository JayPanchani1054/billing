/**
 * Print data for every document kind, built from vouchers posted through the real vouchers service.
 * Company: Maharashtra (27), 15-Apr-2026, round-off to the nearest rupee (F12 default).
 * Masters (vouchers testkit): rice 5% HSN 1006, mixer 18% HSN 8509, acme (27, B2B), blr (29),
 * export (overseas), supplier (27), freight (income, absorbed into goods by value), bank (HDFC).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrintLine, PrintVoucherData } from '../../../shared/types/print.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { saveConfig } from '../company/service.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { buildBatch, buildPrintDataFor, instrumentText, invoiceTotals, rupeesText, upiUri } from './data.ts';

const DATE = '2026-04-15';

function sale(k: Kit, extra: Partial<VoucherInput> = {}): number {
  return save(k, {
    voucherTypeId: k.vt.sales,
    date: DATE,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [
      { itemId: k.I.rice, qty: 10, rate: 50 },
      { itemId: k.I.mixer, qty: 2, rate: 150, discountPct: 10 },
    ],
    ...extra,
  }).id;
}

function row(k: Kit, id: number): { total_amount: number; taxable_amount: number; tax_amount: number; round_off: number } {
  return k.t.db.get('SELECT total_amount, taxable_amount, tax_amount, round_off FROM vouchers WHERE id = :id', { id }) as {
    total_amount: number;
    taxable_amount: number;
    tax_amount: number;
    round_off: number;
  };
}

const sumOf = (lines: readonly PrintLine[], f: (l: PrintLine) => number): number => lines.reduce((a, l) => a + f(l), 0);

/** Invariants every invoice-layout document must satisfy. */
function assertTies(d: PrintVoucherData): void {
  const t = d.totals;
  assert.equal(sumOf(d.lines, (l) => l.amount), t.taxable, 'Σ line amounts = taxable');
  assert.equal(sumOf(d.lines, (l) => l.taxableValue), t.taxable, 'Σ taxable values = taxable');
  assert.equal(t.taxable + t.tax + t.charges + t.roundOff, t.grandTotal, 'taxable + tax + charges + round off = total');
  assert.equal(t.cgst + t.sgst + t.igst + t.cess, t.tax);
  if (d.taxByRate.length > 0) assert.equal(d.taxByRate.reduce((a, r) => a + r.taxableValue, 0), t.taxable, 'rate summary ties');
  if (d.taxByHsn.length > 0) {
    assert.equal(d.taxByHsn.reduce((a, r) => a + r.taxableValue, 0), t.taxable, 'HSN summary taxable ties');
    assert.equal(d.taxByHsn.reduce((a, r) => a + r.tax, 0), t.tax + t.reverseChargeTax, 'HSN summary tax ties');
  }
}

describe('print.voucherData — sales invoices', () => {
  it('intra-state B2B tax invoice: lines, CGST/SGST, round off, words, ties to the voucher', () => {
    const k = setupKit();
    const id = sale(k);
    const d = buildPrintDataFor(k.t.ctx, id);
    // Rice 10 × 50 = 500.00 @5% → CGST 12.50 + SGST 12.50
    // Mixer 2 × 150 = 300.00 − 10% (30.00) = 270.00 @18% → CGST 24.30 + SGST 24.30
    // Taxable 770.00 + tax 73.60 = 843.60 → rounded to 844.00 (round off +0.40)
    assert.equal(d.layout, 'invoice');
    assert.equal(d.kind, 'tax_invoice');
    assert.equal(d.title, 'Tax Invoice');
    assert.equal(d.number, '1');
    assert.equal(d.partyLabel, 'Buyer (Bill to)');
    assert.equal(d.party?.name, 'Acme Traders');
    assert.equal(d.party?.stateName, 'Maharashtra');
    assert.equal(d.consigneeSameAsParty, true);
    assert.deepEqual(d.placeOfSupply, { code: '27', name: 'Maharashtra', label: '27-Maharashtra' });
    assert.equal(d.reverseCharge, false);
    assert.deepEqual(d.gst, { showTax: true, taxMode: 'cgst_sgst', interState: false, sgstLabel: 'SGST', nature: 'b2b' });
    assert.equal(d.lines.length, 2);
    const [rice, mixer] = d.lines;
    assert.deepEqual(
      [rice.sl, rice.name, rice.hsnSac, rice.qty, rice.unit, rice.rate, rice.amount, rice.gstRate, rice.cgst, rice.sgst],
      [1, 'Rice Bag', '1006', 10, 'Nos', 50, 50000, 5, 1250, 1250],
    );
    assert.deepEqual([mixer.discountPct, mixer.discount, mixer.amount, mixer.cgst, mixer.sgst], [10, 3000, 27000, 2430, 2430]);
    assert.deepEqual(
      { taxable: d.totals.taxable, cgst: d.totals.cgst, sgst: d.totals.sgst, igst: d.totals.igst, tax: d.totals.tax, roundOff: d.totals.roundOff, grand: d.totals.grandTotal, discount: d.totals.discount, qty: d.totals.qty },
      { taxable: 77000, cgst: 3680, sgst: 3680, igst: 0, tax: 7360, roundOff: 40, grand: 84400, discount: 3000, qty: 12 },
    );
    const r = row(k, id);
    assert.equal(d.totals.grandTotal, r.total_amount);
    assert.equal(d.totals.taxable, r.taxable_amount);
    assert.equal(d.totals.tax, r.tax_amount);
    assert.equal(d.totals.roundOff, r.round_off);
    assert.equal(d.amountInWords, 'Rupees Eight Hundred Forty Four Only');
    assert.equal(d.taxInWords, 'Rupees Seventy Three and Sixty Paise Only');
    assert.deepEqual(
      d.taxByRate.map((x) => [x.rate, x.taxableValue, x.cgst, x.sgst]),
      [
        [5, 50000, 1250, 1250],
        [18, 27000, 2430, 2430],
      ],
    );
    assert.deepEqual(
      d.taxByHsn.map((x) => [x.hsnSac, x.qty, x.taxableValue, x.tax]),
      [
        ['1006', 10, 50000, 2500],
        ['8509', 2, 27000, 4860],
      ],
    );
    assert.equal(d.copyLabels.duplicate, 'Duplicate for Transporter');
    assert.match(d.declaration ?? '', /actual price of the goods/);
    assert.equal(d.signatoryLabel, 'Authorised Signatory');
    // Bill-wise default: 30 credit days → due 15-May-2026.
    assert.deepEqual(d.references, [{ label: 'Payment Due', value: '15-May-2026' }]);
    assert.deepEqual(d.warnings, []);
    assertTies(d);
    k.t.close();
  });

  it('inter-state → IGST and place of supply of the buyer', () => {
    const k = setupKit();
    const id = sale(k, { partyLedgerId: k.L.blr, items: [{ itemId: k.I.rice, qty: 10, rate: 50 }] });
    const d = buildPrintDataFor(k.t.ctx, id);
    // 500.00 @5% IGST = 25.00 → 525.00 (no rounding needed)
    assert.equal(d.gst.taxMode, 'igst');
    assert.equal(d.gst.interState, true);
    assert.equal(d.placeOfSupply?.label, '29-Karnataka');
    assert.deepEqual([d.totals.igst, d.totals.cgst, d.totals.roundOff, d.totals.grandTotal], [2500, 0, 0, 52500]);
    assert.equal(d.lines[0].igst, 2500);
    assertTies(d);
    k.t.close();
  });

  it('export under LUT and with payment of IGST → Export Invoice with the endorsement', () => {
    const k = setupKit();
    const lut = buildPrintDataFor(k.t.ctx, sale(k, { partyLedgerId: k.L.export, items: [{ itemId: k.I.mixer, qty: 1, rate: 150 }] }));
    assert.equal(lut.kind, 'export_invoice');
    assert.equal(lut.title, 'Export Invoice');
    assert.equal(lut.endorsement, 'Supply meant for export under LUT without payment of IGST');
    assert.equal(lut.placeOfSupply?.code, '96');
    // Zero-rated under LUT: 150.00, no tax.
    assert.deepEqual([lut.totals.taxable, lut.totals.tax, lut.totals.grandTotal], [15000, 0, 15000]);
    const wpay = buildPrintDataFor(
      k.t.ctx,
      sale(k, { partyLedgerId: k.L.export, items: [{ itemId: k.I.mixer, qty: 1, rate: 150 }], exportDetails: { withPayment: true, shippingBillNo: 'SB-9', portCode: 'INNSA1' } }),
    );
    assert.equal(wpay.endorsement, 'Supply meant for export with payment of IGST');
    // 150.00 @18% IGST = 27.00 → 177.00
    assert.deepEqual([wpay.totals.igst, wpay.totals.grandTotal], [2700, 17700]);
    assert.deepEqual(wpay.references, [
      { label: 'Shipping Bill No.', value: 'SB-9' },
      { label: 'Port Code', value: 'INNSA1' },
    ]);
    assertTies(wpay);
    k.t.close();
  });

  it('exempt lines → Bill of Supply; taxed and exempt together → Invoice-cum-Bill of Supply', () => {
    const k = setupKit();
    const veg = k.t.addStockItem({ name: 'Fresh Vegetables', taxability: 'exempt', hsnSac: '0702', openingQty: 50, openingRate: 20 });
    const bos = buildPrintDataFor(k.t.ctx, sale(k, { items: [{ itemId: veg, qty: 5, rate: 20 }] }));
    assert.equal(bos.kind, 'bill_of_supply');
    assert.equal(bos.title, 'Bill of Supply');
    assert.deepEqual([bos.totals.taxable, bos.totals.tax, bos.totals.grandTotal], [10000, 0, 10000]);
    const mixed = buildPrintDataFor(k.t.ctx, sale(k, { items: [{ itemId: veg, qty: 5, rate: 20 }, { itemId: k.I.rice, qty: 10, rate: 50 }] }));
    // 100.00 exempt + 500.00 @5% (CGST 12.50 + SGST 12.50) = 625.00
    assert.equal(mixed.kind, 'invoice_cum_bill_of_supply');
    assert.equal(mixed.title, 'Invoice-cum-Bill of Supply');
    assert.equal(mixed.totals.grandTotal, 62500);
    assert.deepEqual(
      mixed.taxByRate.map((r) => [r.taxability, r.rate, r.taxableValue, r.tax]),
      [
        ['taxable', 5, 50000, 2500],
        ['exempt', 0, 10000, 0],
      ],
    );
    assertTies(mixed);
    k.t.close();
  });

  it('composition dealer → Bill of Supply, no tax columns, composition note', () => {
    const k = setupKit({ registrationType: 'composition' });
    const d = buildPrintDataFor(k.t.ctx, sale(k, { items: [{ itemId: k.I.rice, qty: 10, rate: 50 }] }));
    assert.equal(d.title, 'Bill of Supply');
    assert.deepEqual(d.notes, ['Composition taxable person, not eligible to collect tax on supplies']);
    assert.equal(d.gst.showTax, false);
    assert.deepEqual(d.taxByRate, []);
    assert.deepEqual([d.totals.tax, d.totals.grandTotal], [0, 50000]);
    assert.equal(d.company.gstRegistrationType, 'composition');
    k.t.close();
  });

  it('company not registered under GST → Invoice without GST details', () => {
    const k = setupKit({ gst: false });
    const d = buildPrintDataFor(k.t.ctx, sale(k, { items: [{ itemId: k.I.rice, qty: 3, rate: 33.33 }] }));
    // 3 × 33.33 = 99.99 → rounded to 100.00 (round off +0.01)
    assert.equal(d.title, 'Invoice');
    assert.equal(d.gst.showTax, false);
    assert.equal(d.company.gstin, null);
    assert.deepEqual(d.taxByHsn, []);
    assert.deepEqual([d.totals.taxable, d.totals.roundOff, d.totals.grandTotal], [9999, 1, 10000]);
    assert.equal(d.amountInWords, 'Rupees One Hundred Only');
    assertTies(d);
    k.t.close();
  });

  it('absorbed freight is listed with its amount and taken out of the goods lines so the Amount column adds up', () => {
    const k = setupKit();
    const id = sale(k, { ledgers: [{ ledgerId: k.L.freight, amount: 10000 }] });
    const d = buildPrintDataFor(k.t.ctx, id);
    // Freight 100.00 shared by value over 500.00 and 270.00: 64.94 / 35.06.
    // Taxable: rice 564.94 (@5% → 14.12 + 14.12), mixer 305.06 (@18% → 27.46 + 27.46).
    // 870.00 + 83.16 = 953.16 → 953.00 (round off −0.16)
    const freight = d.lines.find((l) => l.name === 'Freight Outward');
    assert.ok(freight);
    assert.equal(freight.absorbed, true);
    assert.deepEqual([freight.amount, freight.taxableValue], [10000, 0]);
    assert.deepEqual(d.lines.filter((l) => l.kind === 'item').map((l) => [l.amount, l.taxableValue]), [
      [50000, 56494],
      [27000, 30506],
    ]);
    assert.deepEqual([d.totals.taxable, d.totals.tax, d.totals.roundOff, d.totals.grandTotal], [87000, 8316, -16, 95300]);
    assertTies(d);
    k.t.close();
  });

  it('non-GST discount after tax is a charge row (negative)', () => {
    const k = setupKit();
    const d = buildPrintDataFor(k.t.ctx, sale(k, { items: [{ itemId: k.I.rice, qty: 10, rate: 50 }], ledgers: [{ ledgerId: k.L.discount, amount: -2500 }] }));
    // 500.00 + 25.00 tax − 25.00 discount = 500.00
    assert.deepEqual(d.charges, [{ name: 'Discount Allowed', amount: -2500 }]);
    assert.deepEqual([d.totals.charges, d.totals.grandTotal], [-2500, 50000]);
    assertTies(d);
    k.t.close();
  });

  it('masters changed after saving → printed from the books with a warning, still tying to the voucher', () => {
    const k = setupKit();
    const id = sale(k, { ledgers: [{ ledgerId: k.L.freight, amount: 10000 }] });
    k.t.db.run("UPDATE gst_rate_history SET rate = 28 WHERE entity_type = 'stock_item' AND entity_id = :id", { id: k.I.mixer });
    k.t.db.run('UPDATE stock_items SET gst_rate = 28 WHERE id = :id', { id: k.I.mixer });
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /Masters changed after this voucher was saved/);
    // Same figures as when saved (see the absorbed-freight test).
    assert.deepEqual([d.totals.taxable, d.totals.tax, d.totals.roundOff, d.totals.grandTotal], [87000, 8316, -16, 95300]);
    assert.equal(d.lines.find((l) => l.name === 'Mixer Grinder')?.gstRate, 18);
    const freight = d.lines.find((l) => l.absorbed);
    assert.equal(freight?.amount, 10000);
    assertTies(d);
    k.t.close();
  });

  it('imported invoice without entry detail prints from the books', () => {
    const k = setupKit();
    const id = sale(k, { ledgers: [{ ledgerId: k.L.freight, amount: 10000 }] });
    k.t.db.run('UPDATE vouchers SET meta = NULL WHERE id = :id', { id });
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.layout, 'invoice');
    assert.equal(d.title, 'Tax Invoice');
    // Same figures as the absorbed-freight test: 870.00 taxable, 83.16 tax, −0.16 round off, 953.00.
    assert.deepEqual([d.totals.taxable, d.totals.tax, d.totals.roundOff, d.totals.grandTotal], [87000, 8316, -16, 95300]);
    assert.equal(d.lines.find((l) => l.absorbed)?.name, 'Freight Outward');
    assert.deepEqual(d.warnings, []);
    assertTies(d);
    k.t.close();
  });

  it('an inactive party or item does not stop printing an old invoice', () => {
    const k = setupKit();
    const id = sale(k);
    k.t.db.run('UPDATE ledgers SET is_active = 0 WHERE id = :id', { id: k.L.acme });
    k.t.db.run('UPDATE stock_items SET is_active = 0 WHERE id = :id', { id: k.I.rice });
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.totals.grandTotal, 84400);
    assert.equal(d.lines.length, 2);
    assertTies(d);
    k.t.close();
  });

  it('bank details and UPI QR link from F12 › Invoice printing', () => {
    const k = setupKit();
    saveConfig(k.t.ctx, { invoice: { showUpiQr: true, upiId: 'shop@okhdfcbank', bankLedgerId: k.L.bank, terms: 'Goods once sold will not be taken back.' } });
    const d = buildPrintDataFor(k.t.ctx, sale(k));
    assert.equal(d.bank?.accountNo, '50100012345678');
    assert.equal(d.bank?.ifsc, 'HDFC0000001');
    assert.equal(d.bank?.ledgerName, 'HDFC Bank');
    assert.equal(d.upi?.uri, 'upi://pay?pa=shop%40okhdfcbank&pn=Test%20Traders%20Pvt%20Ltd&am=844.00&cu=INR&tn=Tax%20Invoice%201');
    assert.equal(d.terms, 'Goods once sold will not be taken back.');
    // Bank details switched off → none.
    const off = buildPrintDataFor(k.t.ctx, d.id, { showBankDetails: false, showUpiQr: false });
    assert.equal(off.bank, null);
    assert.equal(off.upi, null);
    k.t.close();
  });

  it('cancelled and optional vouchers are marked', () => {
    const k = setupKit();
    const id = sale(k);
    cancelVoucher(k.t.ctx, id, 'Wrong party');
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.status.cancelled, true);
    assert.equal(d.status.cancelReason, 'Wrong party');
    assert.match(d.warnings[0], /cancelled \(Wrong party\)/);
    assert.equal(d.lines.length, 2);
    assert.equal(d.upi, null);
    const opt = buildPrintDataFor(k.t.ctx, sale(k, { isOptional: true }));
    assert.equal(opt.status.optional, true);
    assert.match(opt.warnings[0], /optional voucher/);
    k.t.close();
  });

  it('e-invoice IRN / ack / signed QR, e-way bill and dispatch references', () => {
    const k = setupKit();
    const id = sale(k, { dispatch: { through: 'VRL Logistics', vehicleNo: 'mh12ab1234', lrNo: 'LR-55', lrDate: '2026-04-15' }, orderDetails: { buyersOrderNo: 'PO-42', orderDate: '2026-04-10' } });
    k.t.db.run(
      `UPDATE vouchers SET irn = 'a1b2c3', irn_ack_no = '112610000000001', irn_ack_date = '2026-04-15 10:30:00', irn_signed_qr = 'eyJhbGciOi.signed',
              eway_bill_no = '321009876543', eway_bill_date = '2026-04-15', eway_valid_upto = '2026-04-16' WHERE id = :id`,
      { id },
    );
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.deepEqual(d.einvoice, { irn: 'a1b2c3', ackNo: '112610000000001', ackDate: '2026-04-15 10:30:00', signedQr: 'eyJhbGciOi.signed' });
    assert.deepEqual(d.ewayBill, { number: '321009876543', date: '2026-04-15', validUpto: '2026-04-16' });
    assert.deepEqual(d.references, [
      { label: "Buyer's Order No.", value: 'PO-42' },
      { label: 'Order Date', value: '10-Apr-2026' },
      { label: 'Dispatched through', value: 'VRL Logistics' },
      { label: 'Vehicle No.', value: 'MH12AB1234' },
      { label: 'LR / RR No.', value: 'LR-55 dated 15-Apr-2026' },
      { label: 'Payment Due', value: '15-May-2026' },
    ]);
    k.t.close();
  });

  it('separate consignee (ship-to) with its own state', () => {
    const k = setupKit();
    const d = buildPrintDataFor(k.t.ctx, sale(k, { consignee: { name: 'Acme Warehouse', address: 'Plot 4, Hosur Road', stateCode: '29', pincode: '560068' } }));
    assert.equal(d.consigneeSameAsParty, false);
    assert.equal(d.consignee?.name, 'Acme Warehouse');
    assert.equal(d.consignee?.stateName, 'Karnataka');
    k.t.close();
  });
});

describe('print.voucherData — notes, purchases, orders, challans', () => {
  it('credit note carries the original invoice reference', () => {
    const k = setupKit();
    sale(k);
    const id = save(k, {
      voucherTypeId: k.vt.credit_note,
      date: DATE,
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      originalInvoiceNo: '1',
      originalInvoiceDate: DATE,
      noteReason: 'Sales return',
      items: [{ itemId: k.I.rice, qty: 2, rate: 50 }],
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    // 2 × 50 = 100.00 @5% → 2.50 + 2.50 = 105.00
    assert.equal(d.kind, 'credit_note');
    assert.equal(d.title, 'Credit Note');
    assert.deepEqual(d.originalInvoice, { number: '1', date: DATE, reason: 'Sales return' });
    assert.equal(d.totals.grandTotal, 10500);
    assert.equal(d.totals.grandTotal, row(k, id).total_amount);
    assert.equal(d.declaration, null);
    assert.equal(d.partyLabel, 'Buyer (Bill to)');
    assertTies(d);
    k.t.close();
  });

  it('debit note follows its party: customer → outward, supplier → inward', () => {
    const k = setupKit();
    const toCustomer = buildPrintDataFor(
      k.t.ctx,
      save(k, { voucherTypeId: k.vt.debit_note, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 1, rate: 50 }] }).id,
    );
    assert.equal(toCustomer.title, 'Debit Note');
    assert.equal(toCustomer.partyLabel, 'Buyer (Bill to)');
    assert.equal(toCustomer.copyLabels.original, 'Original for Recipient');
    const toSupplier = buildPrintDataFor(
      k.t.ctx,
      save(k, { voucherTypeId: k.vt.debit_note, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 1, rate: 50 }] }).id,
    );
    assert.equal(toSupplier.partyLabel, 'Supplier (Bill from)');
    assert.equal(toSupplier.copyLabels.original, 'Original');
    // 50.00 @5% → 1.25 + 1.25 = 52.50 → 53.00 (round off +0.50)
    assert.equal(toSupplier.totals.grandTotal, 5300);
    assertTies(toSupplier);
    k.t.close();
  });

  it('purchase → Purchase Voucher with the supplier invoice number', () => {
    const k = setupKit();
    const id = save(k, {
      voucherTypeId: k.vt.purchase,
      date: DATE,
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      referenceNo: 'SUP-77',
      referenceDate: '2026-04-14',
      items: [{ itemId: k.I.rice, qty: 10, rate: 40 }],
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    // 400.00 @5% input → 10.00 + 10.00 = 420.00
    assert.equal(d.title, 'Purchase Voucher');
    assert.equal(d.partyLabel, 'Supplier (Bill from)');
    assert.equal(d.referenceNo, 'SUP-77');
    assert.equal(d.declaration, null);
    assert.equal(d.bank, null);
    assert.deepEqual([d.totals.cgst, d.totals.sgst, d.totals.grandTotal], [1000, 1000, 42000]);
    assertTies(d);
    k.t.close();
  });

  it('reverse-charge purchase from an unregistered supplier → Self Invoice, tax shown apart from the total', () => {
    const k = setupKit();
    const carrier = k.t.addLedger({ name: 'Local Carrier', group: 'SUNDRY_CREDITORS', stateCode: '27' });
    const id = save(k, {
      voucherTypeId: k.vt.purchase,
      date: DATE,
      mode: 'accounting_invoice',
      partyLedgerId: carrier,
      reverseCharge: true,
      ledgers: [{ ledgerId: k.L.gtaFreight, amount: 100000 }],
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    // GTA 1,000.00 @5% under reverse charge: CGST 25.00 + SGST 25.00 payable by us, not to the carrier.
    assert.equal(d.kind, 'self_invoice');
    assert.equal(d.reverseCharge, true);
    assert.deepEqual([d.totals.taxable, d.totals.tax, d.totals.reverseChargeTax, d.totals.grandTotal], [100000, 0, 5000, 100000]);
    assert.equal(d.lines[0].taxPayable, false);
    assert.equal(d.totals.grandTotal, row(k, id).total_amount);
    assertTies(d);
    k.t.close();
  });

  it('sales order entered with prices → invoice layout titled Sales Order', () => {
    const k = setupKit({ features: { orderProcessing: true } });
    const id = save(k, { voucherTypeId: k.vt.sales_order, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 4, rate: 50 }] }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    // 200.00 @5% → 5.00 + 5.00 = 210.00
    assert.equal(d.layout, 'invoice');
    assert.equal(d.title, 'Sales Order');
    assert.equal(d.totals.grandTotal, 21000);
    assert.deepEqual(d.warnings, []);
    assertTies(d);
    k.t.close();
  });

  it('purchase order ships to the company unless a consignee is given', () => {
    const k = setupKit({ features: { orderProcessing: true } });
    const id = save(k, { voucherTypeId: k.vt.purchase_order, date: DATE, mode: 'inventory', partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 4, rate: 40 }] }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.title, 'Purchase Order');
    assert.equal(d.layout, 'inventory');
    assert.equal(d.partyLabel, 'Supplier');
    assert.equal(d.consignee?.name, 'Test Traders Pvt Ltd');
    assert.equal(d.consigneeSameAsParty, false);
    // 4 × 40 = 160.00
    assert.equal(d.totals.grandTotal, 16000);
    k.t.close();
  });

  it('delivery note entered as quantities → Delivery Challan (Rule 55 copies)', () => {
    const k = setupKit({ features: { trackingNumbers: true } });
    const id = save(k, { voucherTypeId: k.vt.delivery_note, date: DATE, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 5, rate: 50 }, { itemId: k.I.mixer, qty: 1, rate: 150 }] }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.layout, 'inventory');
    assert.equal(d.kind, 'delivery_challan');
    assert.equal(d.copyLabels.original, 'Original for Consignee');
    assert.deepEqual(d.lines.map((l) => [l.name, l.hsnSac, l.qty, l.amount]), [
      ['Rice Bag', '1006', 5, 25000],
      ['Mixer Grinder', '8509', 1, 15000],
    ]);
    // 250.00 + 150.00
    assert.equal(d.totals.grandTotal, 40000);
    assert.equal(d.totals.qty, 6);
    assert.equal(d.amountInWords, 'Rupees Four Hundred Only');
    k.t.close();
  });

  it('stock journal splits consumption and production', () => {
    const k = setupKit();
    const id = save(k, {
      voucherTypeId: k.vt.stock_journal,
      date: DATE,
      mode: 'inventory',
      items: [
        { itemId: k.I.rice, qty: 2, rate: 50, isConsumption: true },
        { itemId: k.I.mixer, qty: 1, rate: 120 },
      ],
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.title, 'Stock Journal');
    assert.deepEqual(d.lines.map((l) => l.section), ['consumption', 'production']);
    // Production side: 1 × 120.00
    assert.equal(d.totals.grandTotal, 12000);
    k.t.close();
  });
});

describe('print.voucherData — accounting vouchers', () => {
  it('payment voucher: entries, instrument, bills, amount in words', () => {
    const k = setupKit();
    const id = save(k, {
      voucherTypeId: k.vt.payment,
      date: DATE,
      mode: 'ledger',
      narration: 'Advance for April supplies',
      ledgers: [
        { ledgerId: k.L.supplier, amount: 100000 },
        { ledgerId: k.L.bank, amount: -100000, instrument: { type: 'cheque', number: '004512', date: '2026-04-14' } },
      ],
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.layout, 'voucher');
    assert.equal(d.title, 'Payment Voucher');
    assert.equal(d.narration, 'Advance for April supplies');
    assert.deepEqual(
      d.entries.map((e) => [e.ledgerName, e.debit, e.credit, e.isCashBank]),
      [
        ['Supreme Suppliers', 100000, 0, false],
        ['HDFC Bank', 0, 100000, true],
      ],
    );
    assert.equal(d.entries[1].instrument, 'Cheque 004512 dated 14-Apr-2026');
    assert.deepEqual(d.entries[0].bills, ['On Account: 1,000.00 Dr']);
    assert.equal(d.totals.grandTotal, 100000);
    assert.equal(d.amountInWords, 'Rupees One Thousand Only');
    assert.equal(d.placeOfSupply, null);
    assert.deepEqual(d.lines, []);
    k.t.close();
  });

  it('receipt, contra and journal titles', () => {
    const k = setupKit();
    const rc = save(k, { voucherTypeId: k.vt.receipt, date: DATE, mode: 'ledger', ledgers: [{ ledgerId: k.L.cash, amount: 50000 }, { ledgerId: k.L.acme, amount: -50000 }] }).id;
    const ct = save(k, { voucherTypeId: k.vt.contra, date: DATE, mode: 'ledger', ledgers: [{ ledgerId: k.L.bank, amount: 20000 }, { ledgerId: k.L.cash, amount: -20000 }] }).id;
    const jv = save(k, { voucherTypeId: k.vt.journal, date: DATE, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 30000 }, { ledgerId: k.L.capital, amount: -30000 }] }).id;
    const [r, c, j] = buildBatch(k.t.ctx, [rc, ct, jv]).documents;
    assert.deepEqual([r.title, c.title, j.title], ['Receipt Voucher', 'Contra Voucher', 'Journal Voucher']);
    assert.equal(r.partyLabel, 'Received from');
    assert.deepEqual([r.totals.grandTotal, c.totals.grandTotal, j.totals.grandTotal], [50000, 20000, 30000]);
    assert.equal(c.amountInWords, 'Rupees Two Hundred Only');
    k.t.close();
  });
});

describe('print options, navigation and batch', () => {
  it('voucher-type print title / template and preview overrides', () => {
    const k = setupKit();
    k.t.db.run('UPDATE voucher_types SET config = :c WHERE id = :id', {
      id: k.vt.sales,
      c: JSON.stringify({ printTitle: 'Retail Invoice', printTemplate: 'classic', terms: 'Subject to Pune jurisdiction' }),
    });
    const id = sale(k);
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.title, 'Retail Invoice');
    assert.equal(d.defaultTemplate, 'classic');
    assert.equal(d.terms, 'Subject to Pune jurisdiction');
    const o = buildPrintDataFor(k.t.ctx, id, { template: 'compact', declaration: 'Thank you for your business', copies: ['original', 'duplicate'] });
    assert.equal(o.defaultTemplate, 'compact');
    assert.equal(o.declaration, 'Thank you for your business');
    assert.deepEqual(o.options.copies, ['original', 'duplicate']);
    k.t.close();
  });

  it('previous / next voucher of the same type', () => {
    const k = setupKit();
    const a = sale(k);
    const b = sale(k);
    const pay = save(k, { voucherTypeId: k.vt.payment, date: DATE, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 1000 }, { ledgerId: k.L.cash, amount: -1000 }] }).id;
    assert.deepEqual(buildPrintDataFor(k.t.ctx, a).navigation, { prevId: null, nextId: b });
    assert.deepEqual(buildPrintDataFor(k.t.ctx, b).navigation, { prevId: a, nextId: null });
    assert.deepEqual(buildPrintDataFor(k.t.ctx, pay).navigation, { prevId: null, nextId: null });
    k.t.close();
  });

  it('batch keeps order, skips duplicates and reports deleted vouchers', () => {
    const k = setupKit();
    const a = sale(k);
    const b = sale(k);
    const out = buildBatch(k.t.ctx, [b, a, b, 9999]);
    assert.deepEqual(out.documents.map((d) => d.id), [b, a]);
    assert.deepEqual(out.notFound, [9999]);
    k.t.close();
  });

  it('unknown voucher → NOT_FOUND', () => {
    const k = setupKit();
    assert.throws(() => buildPrintDataFor(k.t.ctx, 424242), (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND');
    k.t.close();
  });
});

describe('helpers', () => {
  it('rupeesText uses integer arithmetic', () => {
    assert.equal(rupeesText(118050), '1180.50');
    assert.equal(rupeesText(5), '0.05');
    assert.equal(rupeesText(-100), '-1.00');
    assert.equal(rupeesText(900719925474099), '9007199254740.99');
  });
  it('upiUri encodes every value and omits a zero amount', () => {
    assert.equal(
      upiUri({ id: 'a.b@okicici', payeeName: 'Shah & Sons', amount: 100, note: 'Inv 1/26?x=y' }),
      'upi://pay?pa=a.b%40okicici&pn=Shah%20%26%20Sons&am=1.00&cu=INR&tn=Inv%201%2F26%3Fx%3Dy',
    );
    assert.equal(upiUri({ id: 'x@y', payeeName: 'P', amount: 0, note: '' }), 'upi://pay?pa=x%40y&pn=P&cu=INR');
  });
  it('instrumentText', () => {
    assert.equal(instrumentText({ type: 'neft', number: 'UTR123', bankName: 'SBI', favouring: 'Acme' }), 'NEFT UTR123, SBI, favouring Acme');
    assert.equal(instrumentText(null), null);
  });
  it('invoiceTotals keeps reverse-charge tax out of the total', () => {
    const base: PrintLine = {
      sl: 1, kind: 'ledger', name: 'X', description: null, hsnSac: null, batch: null, qty: null, unit: null, qtyDecimals: 0, rate: null,
      discountPct: 0, discount: 0, amount: 1000, taxableValue: 1000, taxability: 'taxable', gstRate: 18, cessRate: 0,
      cgst: 90, sgst: 90, igst: 0, cess: 0, tax: 180, taxPayable: false, absorbed: false, reverseCharge: true, section: null,
    };
    const t = invoiceTotals([base], [], 0);
    assert.deepEqual([t.tax, t.reverseChargeTax, t.grandTotal], [0, 180, 1000]);
  });
});
