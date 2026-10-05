/**
 * Invoice postings (sales / purchase / credit note / debit note) with hand-verified GST arithmetic.
 * Company: Maharashtra (27) unless stated. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { pendingBills } from './bills.ts';
import { previewVoucher, saveVoucher } from './service.ts';
import {
  bills,
  entryMap,
  entrySum,
  gstLines,
  header,
  purchaseInput,
  ruleDetails,
  salesInput,
  save,
  setupKit,
  stockOf,
  throwsApp,
} from './testkit.ts';

describe('sales invoices', () => {
  it('intra-state 5% + 18% items, freight apportioned by value, round off', () => {
    const k = setupKit();
    // Rice 10 × ₹100 = ₹1,000.00 @5%; Mixer 5 × ₹200 = ₹1,000.00 @18%; freight ₹100 split by value 50 : 50.
    // Taxable: rice 1,050.00, mixer 1,050.00 (= 2,100.00).
    // Rice CGST = SGST = 2.5% × 1,050.00 = 26.25; Mixer CGST = SGST = 9% × 1,050.00 = 94.50.
    // CGST = SGST = 120.75 → tax 241.50 → 2,341.50 → rounded to 2,342.00 (round off +0.50).
    // Party Dr 2,342.00 = Sales Cr 2,000.00 + Freight Cr 100.00 + CGST 120.75 + SGST 120.75 + Round Off Cr 0.50.
    const res = save(k, salesInput(k, {
      items: [
        { itemId: k.I.rice, qty: 10, rate: 100 },
        { itemId: k.I.mixer, qty: 5, rate: 200 },
      ],
      ledgers: [{ ledgerId: k.L.freight, amount: 10000 }],
    }));
    assert.equal(res.number, '1');
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 234200,
      Sales: -200000,
      'Freight Outward': -10000,
      'Output CGST': -12075,
      'Output SGST/UTGST': -12075,
      'Round Off': -50,
    });
    assert.equal(entrySum(k, res.id), 0);
    assert.deepEqual(res.totals, { debit: 234200, credit: 234200, taxable: 210000, tax: 24150, roundOff: 50, grandTotal: 234200 });

    const g = gstLines(k, res.id);
    assert.equal(g.length, 2, 'freight is absorbed: no gst_line of its own');
    assert.deepEqual(
      g.map((l) => [l.item_id, l.hsn_sac, l.uqc, l.qty, l.rate, l.taxable_value, l.igst, l.cgst, l.sgst, l.itc_eligibility]),
      [
        [k.I.rice, '1006', 'NOS', 10, 5, 105000, 0, 2625, 2625, null],
        [k.I.mixer, '8509', 'NOS', 5, 18, 105000, 0, 9450, 9450, null],
      ],
    );
    const h = header(k, res.id);
    assert.equal(h.gst_nature, 'b2b');
    assert.equal(h.place_of_supply, '27');
    assert.equal(h.total_amount, 234200);
    assert.equal(h.taxable_amount, 210000);
    assert.equal(h.tax_amount, 24150);
    assert.equal(h.round_off, 50);
    assert.equal(h.invoice_mode, 'item');
    assert.equal(h.party_gstin, makeGstin('27', testPan(1)));
    // Stock out; inventory value = taxable value (incl. the freight share).
    assert.equal(stockOf(k, k.I.rice), 90);
    assert.equal(stockOf(k, k.I.mixer), 45);
    const inv = k.t.db.all<{ qty: number; amount: number; tracking_ref: string | null }>('SELECT qty, amount, tracking_ref FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id: res.id });
    assert.deepEqual(inv.map((r) => [r.qty, r.amount]), [[-10, 105000], [-5, 105000]]);
    // Bill-wise: new ref named after the voucher number, due in 30 days.
    assert.deepEqual(bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount, b.due_date]), [['new', '1', 234200, '2026-05-15']]);
    k.t.close();
  });

  it('inter-state sale charges IGST', () => {
    const k = setupKit();
    // Mixer 5 × ₹200 = ₹1,000.00; IGST 18% = ₹180.00; total ₹1,180.00.
    const res = save(k, salesInput(k, { partyLedgerId: k.L.blr }));
    assert.deepEqual(entryMap(k, res.id), { 'Bangalore Retail': 118000, Sales: -100000, 'Output IGST': -18000 });
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].igst, g[0].cgst, g[0].sgst], [18000, 0, 0]);
    assert.equal(header(k, res.id).place_of_supply, '29');
    assert.equal(header(k, res.id).gst_nature, 'b2b');
    k.t.close();
  });

  it('UT company (Chandigarh) charges CGST + UTGST on intra-UT supplies', () => {
    const k = setupKit({ stateCode: '04' });
    // Mixer 5 × ₹200 = ₹1,000.00; CGST 9% = 90.00 + UTGST 9% = 90.00 → ₹1,180.00.
    const p = previewVoucher(k.t.ctx, salesInput(k));
    assert.equal(p.computation?.taxMode, 'cgst_utgst');
    const res = save(k, salesInput(k));
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 118000, Sales: -100000, 'Output CGST': -9000, 'Output SGST/UTGST': -9000 });
    assert.equal(header(k, res.id).place_of_supply, '04');
    k.t.close();
  });

  it('B2C sale to an unregistered buyer (b2cs) with paise round off', () => {
    const k = setupKit();
    // Rice 3 × ₹33.33 = ₹99.99; CGST = SGST = round(9999 × 2.5%) = round(249.975) = 2.50.
    // 99.99 + 5.00 = 104.99 → rounded to 105.00 (round off +0.01).
    const res = save(k, salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: k.I.rice, qty: 3, rate: 33.33 }] }));
    assert.deepEqual(entryMap(k, res.id), {
      'Walk-in Customer': 10500,
      Sales: -9999,
      'Output CGST': -250,
      'Output SGST/UTGST': -250,
      'Round Off': -1,
    });
    assert.equal(header(k, res.id).gst_nature, 'b2cs');
    assert.equal(res.warnings.length, 0);
    k.t.close();
  });

  it('inter-state B2C above ₹1,00,000 is B2CL; at or below is B2CS', () => {
    const k = setupKit();
    const mysore = k.t.addLedger({ name: 'Mysore Buyer', group: 'SUNDRY_DEBTORS', stateCode: '29' });
    // 1 × ₹1,00,000 + IGST 18% ₹18,000 = ₹1,18,000 > ₹1,00,000 → b2cl.
    const big = save(k, salesInput(k, { partyLedgerId: mysore, items: [{ itemId: k.I.mixer, qty: 1, rate: 100000 }] }));
    assert.equal(header(k, big.id).gst_nature, 'b2cl');
    assert.deepEqual(entryMap(k, big.id), { 'Mysore Buyer': 11800000, Sales: -10000000, 'Output IGST': -1800000 });
    // ₹84,745.76 + 18% (15,254.24) = ₹1,00,000.00 exactly → not above the threshold → b2cs.
    const small = save(k, salesInput(k, { partyLedgerId: mysore, items: [{ itemId: k.I.mixer, qty: 1, rate: 84745.76 }] }));
    assert.equal(header(k, small.id).total_amount, 10000000);
    assert.equal(header(k, small.id).gst_nature, 'b2cs');
    k.t.close();
  });

  it('export under LUT: no tax, zero-rated, POS 96', () => {
    const k = setupKit();
    const res = save(k, salesInput(k, {
      partyLedgerId: k.L.export,
      exportDetails: { shippingBillNo: 'SB-1001', shippingBillDate: '2026-04-15', portCode: 'INBOM4' },
    }));
    assert.deepEqual(entryMap(k, res.id), { 'Global Imports LLC': 100000, Sales: -100000 });
    const h = header(k, res.id);
    assert.equal(h.gst_nature, 'export_lut');
    assert.equal(h.place_of_supply, '96');
    assert.deepEqual(JSON.parse(String(h.export_details)), { shippingBillNo: 'SB-1001', shippingBillDate: '2026-04-15', portCode: 'INBOM4', lut: true });
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].rate, g[0].taxable_value, g[0].igst], [18, 100000, 0]);
    k.t.close();
  });

  it('export with payment of IGST', () => {
    const k = setupKit();
    // ₹1,000.00 + IGST 18% = ₹1,180.00 payable by the buyer.
    const res = save(k, salesInput(k, { partyLedgerId: k.L.export, exportDetails: { withPayment: true } }));
    assert.deepEqual(entryMap(k, res.id), { 'Global Imports LLC': 118000, Sales: -100000, 'Output IGST': -18000 });
    assert.equal(header(k, res.id).gst_nature, 'export_wpay');
    k.t.close();
  });

  it('SEZ supply in the same state is inter-state (IGST); LUT → no tax', () => {
    const k = setupKit();
    const wp = save(k, salesInput(k, { partyLedgerId: k.L.sez, exportDetails: { withPayment: true } }));
    assert.deepEqual(entryMap(k, wp.id), { 'SEZ Unit One': 118000, Sales: -100000, 'Output IGST': -18000 });
    assert.equal(header(k, wp.id).gst_nature, 'sez_wpay');
    const lut = save(k, salesInput(k, { partyLedgerId: k.L.sez }));
    assert.deepEqual(entryMap(k, lut.id), { 'SEZ Unit One': 100000, Sales: -100000 });
    assert.equal(header(k, lut.id).gst_nature, 'sez_lut');
    k.t.close();
  });

  it('non-GST discount ledger is applied after tax', () => {
    const k = setupKit();
    // ₹1,000.00 + CGST 90 + SGST 90 = ₹1,180.00 − discount ₹10.00 = ₹1,170.00.
    const res = save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.discount, amount: -1000 }] }));
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 117000,
      Sales: -100000,
      'Discount Allowed': 1000,
      'Output CGST': -9000,
      'Output SGST/UTGST': -9000,
    });
    assert.equal(header(k, res.id).taxable_amount, 100000);
    assert.equal(header(k, res.id).total_amount, 117000);
    k.t.close();
  });

  it('tax-inclusive rate is back-calculated', () => {
    const k = setupKit();
    // 1 × ₹118 incl. 18%: taxable = 11800 × 100/118 = 10000; CGST = SGST = 900; total 11800.
    const res = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 118, rateInclusiveOfTax: true }] }));
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 11800, Sales: -10000, 'Output CGST': -900, 'Output SGST/UTGST': -900 });
    const inv = k.t.db.get<{ rate: number; amount: number }>('SELECT rate, amount FROM inventory_entries WHERE voucher_id = :id', { id: res.id });
    assert.deepEqual(inv, { rate: 100, amount: 10000 });
    k.t.close();
  });

  it('accounting-invoice service sale with SAC 998311 @18%', () => {
    const k = setupKit();
    // ₹50,000.00 consultancy: CGST 9% = 4,500.00, SGST 4,500.00 → ₹59,000.00.
    const res = save(k, {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      ledgers: [{ ledgerId: k.L.consult, amount: 5000000 }],
    });
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 5900000,
      'Consultancy Income': -5000000,
      'Output CGST': -450000,
      'Output SGST/UTGST': -450000,
    });
    const g = gstLines(k, res.id);
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].ledger_id, g[0].hsn_sac, g[0].supply_type, g[0].uqc, g[0].qty, g[0].cgst], [k.L.consult, '998311', 'services', 'NA', null, 450000]);
    assert.equal(header(k, res.id).invoice_mode, 'accounting');
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id', { id: res.id }), 0);
    k.t.close();
  });

  it('item with no GST rate anywhere → gst_missing_rate warning (needs confirmation)', () => {
    const k = setupKit();
    const input = salesInput(k, { items: [{ itemId: k.I.noRate, qty: 1, rate: 10 }] });
    const err = throwsApp(() => saveVoucher(k.t.ctx, input), 'BUSINESS_RULE', /Please confirm/);
    const d = ruleDetails(err);
    assert.equal(d.needsConfirmation, true);
    assert.ok(d.warnings.some((w) => w.code === 'gst_missing_rate' && w.path === 'items[0]'));
    assert.ok(d.warnings.some((w) => w.code === 'gst_missing_hsn'), 'B2B line without HSN is flagged too');
    const res = saveVoucher(k.t.ctx, { ...input, acknowledgeWarnings: true });
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 1000, Sales: -1000 });
    k.t.close();
  });

  it('registered buyer without GSTIN → gst_missing_gstin warning', () => {
    const k = setupKit();
    const noGstin = k.t.addLedger({ name: 'Registered No GSTIN', group: 'SUNDRY_DEBTORS', registrationType: 'regular' });
    const p = previewVoucher(k.t.ctx, salesInput(k, { partyLedgerId: noGstin }));
    assert.ok(p.warnings.some((w) => w.code === 'gst_missing_gstin' && !w.blocking));
    k.t.close();
  });

  it('GST tax ledgers cannot be entered on an invoice', () => {
    const k = setupKit();
    throwsApp(() => save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.OUTPUT_CGST, amount: 100 }] })), 'BUSINESS_RULE', /GST tax ledger/);
    k.t.close();
  });

  it('invoice needs a party and at least one item', () => {
    const k = setupKit();
    throwsApp(() => save(k, salesInput(k, { partyLedgerId: undefined })), 'BUSINESS_RULE', /customer ledger/);
    throwsApp(() => save(k, salesInput(k, { items: [] })), 'BUSINESS_RULE', /at least one stock item/);
    k.t.close();
  });

  it('cash sale: party is the Cash ledger (no bill-wise)', () => {
    const k = setupKit();
    const res = save(k, salesInput(k, { partyLedgerId: k.L.cash }));
    assert.deepEqual(entryMap(k, res.id), { Cash: 118000, Sales: -100000, 'Output CGST': -9000, 'Output SGST/UTGST': -9000 });
    assert.equal(bills(k, res.id).length, 0);
    assert.equal(header(k, res.id).gst_nature, 'b2cs');
    k.t.close();
  });

  it('preview totals equal saved totals', () => {
    const k = setupKit();
    const input = salesInput(k, {
      items: [
        { itemId: k.I.rice, qty: 7, rate: 41.5, discountPct: 2.5 },
        { itemId: k.I.mixer, qty: 3, rate: 999.99 },
      ],
      ledgers: [{ ledgerId: k.L.freight, amount: 4567 }, { ledgerId: k.L.discount, amount: -333 }],
    });
    const p = previewVoucher(k.t.ctx, input);
    const res = save(k, input);
    assert.deepEqual(res.totals, p.totals);
    assert.equal(p.number, res.number);
    const saved = k.t.db.all<{ ledger_id: number; amount: number }>('SELECT ledger_id, amount FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id: res.id });
    assert.deepEqual(saved.map((e) => [e.ledger_id, e.amount]), p.entries.map((e) => [e.ledgerId, e.amount]));
    assert.equal(p.entries.reduce((a, e) => a + e.amount, 0), 0);
    assert.equal(p.computation?.totals.grandTotal, res.totals.grandTotal);
    k.t.close();
  });
});

describe('credit notes', () => {
  it('credit note with items (stock in) against the original invoice', () => {
    const k = setupKit();
    // Invoice 1: Mixer 5 × ₹200 = 1,000 + CGST 90 + SGST 90 = ₹1,180.00 → bill '1' Dr 118000.
    const inv = save(k, salesInput(k));
    assert.equal(inv.number, '1');
    // Return 1 × ₹200 = 200 + CGST 18 + SGST 18 = ₹236.00.
    const cn = save(k, {
      voucherTypeId: k.vt.credit_note,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      originalInvoiceNo: '1',
      originalInvoiceDate: k.t.today,
      noteReason: 'Sales return',
      items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }],
    });
    assert.deepEqual(entryMap(k, cn.id), { 'Acme Traders': -23600, Sales: 20000, 'Output CGST': 1800, 'Output SGST/UTGST': 1800 });
    assert.deepEqual(bills(k, cn.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['against', '1', -23600]]);
    assert.equal(stockOf(k, k.I.mixer), 50 - 5 + 1);
    const h = header(k, cn.id);
    assert.equal(h.gst_nature, 'b2b');
    assert.equal(h.original_invoice_no, '1');
    const pend = pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today);
    assert.deepEqual(pend.map((b) => [b.billName, b.amount]), [['1', 118000 - 23600]]);
    k.t.close();
  });
});

describe('notes & modes', () => {
  it('credit note larger than the pending bill: against the bill + new reference for the rest', () => {
    const k = setupKit();
    // Invoice 1: rice 2 × ₹100 = 200 + CGST 5 + SGST 5 = ₹210.00.
    save(k, salesInput(k, { items: [{ itemId: k.I.rice, qty: 2, rate: 100 }] }));
    // Credit note for ₹500.00 + 18% = ₹590.00 in accounting mode (rate difference on consultancy).
    const cn = save(k, {
      voucherTypeId: k.vt.credit_note,
      date: k.t.today,
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      originalInvoiceNo: '1',
      ledgers: [{ ledgerId: k.L.consult, amount: 50000 }],
    });
    assert.deepEqual(entryMap(k, cn.id), { 'Acme Traders': -59000, 'Consultancy Income': 50000, 'Output CGST': 4500, 'Output SGST/UTGST': 4500 });
    assert.deepEqual(bills(k, cn.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['against', '1', -21000], ['new', '1', -38000]]);
    k.t.close();
  });

  it('sales in ledger mode posts lines as entered and warns that GST is not reported', () => {
    const k = setupKit();
    const res = save(k, {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.acme, amount: 11800 },
        { ledgerId: k.L.sales, amount: -10000 },
        { ledgerId: k.L.OUTPUT_IGST, amount: -1800 },
      ],
    });
    assert.ok(res.warnings.some((w) => w.code === 'gst_ledger_lines'));
    assert.equal(gstLines(k, res.id).length, 0);
    assert.equal(header(k, res.id).party_ledger_id, k.L.acme);
    assert.deepEqual(bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['new', '1', 11800]]);
    const roles = k.t.db.all<{ role: string; gst_duty_head: string | null }>('SELECT role, gst_duty_head FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id: res.id });
    assert.deepEqual(roles.map((r) => [r.role, r.gst_duty_head]), [['party', null], ['sales', null], ['tax', 'IGST']]);
    k.t.close();
  });

  it('e-invoice feature marks B2B invoices pending; B2C ones are not', () => {
    const k = setupKit({ features: { einvoice: true } });
    const b2b = save(k, salesInput(k));
    const b2c = save(k, salesInput(k, { partyLedgerId: k.L.walkin }));
    assert.equal(header(k, b2b.id).irn_status, 'pending');
    assert.equal(header(k, b2c.id).irn_status, null);
    // An invoice with a generated IRN can no longer be altered or deleted.
    k.t.db.run(`UPDATE vouchers SET irn_status = 'generated' WHERE id = :id`, { id: b2b.id });
    throwsApp(() => save(k, { ...salesInput(k), id: b2b.id }), 'BUSINESS_RULE', /IRN/);
    k.t.close();
  });

  it('a mode the base type does not support is refused', () => {
    const k = setupKit();
    throwsApp(() => save(k, { voucherTypeId: k.vt.payment, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [] }), 'BUSINESS_RULE', /cannot be entered in item invoice mode/);
    throwsApp(() => save(k, salesInput(k, { date: '2026-03-31' })), 'BUSINESS_RULE', /before the books beginning date/);
    k.t.close();
  });
});

describe('purchases', () => {
  it('purchase with ITC: input CGST/SGST, supplier bill named after the supplier invoice', () => {
    const k = setupKit();
    // Rice 20 × ₹80 = ₹1,600.00; CGST 2.5% = 40.00, SGST 40.00 → ₹1,680.00.
    const res = save(k, purchaseInput(k));
    assert.deepEqual(entryMap(k, res.id), { Purchase: 160000, 'Input CGST': 4000, 'Input SGST/UTGST': 4000, 'Supreme Suppliers': -168000 });
    assert.deepEqual(bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount, b.due_date]), [['new', 'SUP-101', -168000, '2026-05-30']]);
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].cgst, g[0].sgst, g[0].itc_eligibility], [4000, 4000, 'inputs']);
    assert.equal(header(k, res.id).gst_nature, 'inward_b2b');
    assert.equal(stockOf(k, k.I.rice), 120);
    k.t.close();
  });

  it('reverse charge purchase: party gets taxable only; Dr input tax / Cr RCM liability', () => {
    const k = setupKit();
    // GTA freight ₹10,000.00 @5% RCM: CGST 2.5% = 250.00, SGST 250.00 — payable by us, not to the supplier.
    const res = save(k, {
      voucherTypeId: k.vt.purchase,
      date: k.t.today,
      mode: 'accounting_invoice',
      partyLedgerId: k.L.gta,
      referenceNo: 'GTA-9',
      reverseCharge: true,
      ledgers: [{ ledgerId: k.L.gtaFreight, amount: 1000000 }],
    });
    assert.deepEqual(entryMap(k, res.id), {
      'Speedy Transport': -1000000,
      'Freight Inward (GTA)': 1000000,
      'Input CGST': 25000,
      'Input SGST/UTGST': 25000,
      'CGST Payable (Reverse Charge)': -25000,
      'SGST Payable (Reverse Charge)': -25000,
    });
    const h = header(k, res.id);
    assert.equal(h.gst_nature, 'inward_rcm');
    assert.equal(h.is_reverse_charge, 1);
    assert.equal(h.total_amount, 1000000);
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].is_reverse_charge, g[0].itc_eligibility, g[0].supply_type, g[0].cgst], [1, 'input_services', 'services', 25000]);
    k.t.close();
  });

  it('import of services: IGST under reverse charge', () => {
    const k = setupKit();
    const foreign = k.t.addLedger({ name: 'Cloud Inc USA', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { state_code: null } });
    const saas = k.t.addLedger({ name: 'Software Subscription', group: 'INDIRECT_EXPENSES', gstRate: 18, hsnSac: '997331', supplyType: 'services' });
    // ₹1,000.00 @18% IGST (RCM) = 180.00.
    const res = save(k, { voucherTypeId: k.vt.purchase, date: k.t.today, mode: 'accounting_invoice', partyLedgerId: foreign, referenceNo: 'INV-77', ledgers: [{ ledgerId: saas, amount: 100000 }] });
    assert.deepEqual(entryMap(k, res.id), {
      'Cloud Inc USA': -100000,
      'Software Subscription': 100000,
      'Input IGST': 18000,
      'IGST Payable (Reverse Charge)': -18000,
    });
    assert.equal(header(k, res.id).gst_nature, 'import_services');
    k.t.close();
  });

  it('import of goods: IGST recorded in gst_lines, not posted (paid at customs)', () => {
    const k = setupKit();
    const foreign = k.t.addLedger({ name: 'Shenzhen Exports', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { state_code: null } });
    // Rice 10 × ₹100 = ₹1,000.00; IGST 5% = 50.00 computed but not payable to the supplier.
    const res = save(k, purchaseInput(k, { partyLedgerId: foreign, items: [{ itemId: k.I.rice, qty: 10, rate: 100 }] }));
    assert.deepEqual(entryMap(k, res.id), { Purchase: 100000, 'Shenzhen Exports': -100000 });
    const g = gstLines(k, res.id);
    assert.equal(g[0].igst, 5000);
    assert.equal(header(k, res.id).gst_nature, 'import_goods');
    k.t.close();
  });

  it('purchase from an unregistered supplier carries no tax', () => {
    const k = setupKit();
    const local = k.t.addLedger({ name: 'Local Vendor', group: 'SUNDRY_CREDITORS' });
    const res = save(k, purchaseInput(k, { partyLedgerId: local, referenceNo: undefined }));
    assert.deepEqual(entryMap(k, res.id), { Purchase: 160000, 'Local Vendor': -160000 });
    assert.equal(header(k, res.id).gst_nature, 'inward_unregistered');
    k.t.close();
  });

  it('composition company: supplier tax is not claimable and is added to the purchase cost', () => {
    const k = setupKit({ registrationType: 'composition' });
    // ₹1,600.00 + CGST 40 + SGST 40 = ₹1,680.00, all debited to Purchase.
    const res = save(k, purchaseInput(k));
    assert.deepEqual(entryMap(k, res.id), { Purchase: 168000, 'Supreme Suppliers': -168000 });
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].cgst, g[0].sgst, g[0].itc_eligibility], [4000, 4000, 'ineligible']);
    assert.equal(k.t.db.value('SELECT amount FROM inventory_entries WHERE voucher_id = :id', { id: res.id }), 168000, 'stock carried at cost incl. tax');
    // Composition dealers issue bills of supply: no tax on sales.
    const sale = save(k, salesInput(k));
    assert.deepEqual(entryMap(k, sale.id), { 'Acme Traders': 100000, Sales: -100000 });
    assert.equal(header(k, sale.id).gst_nature, 'composition_outward');
    k.t.close();
  });

  it('ineligible ITC (blocked credit) is added to the expense ledger', () => {
    const k = setupKit();
    const welfare = k.t.addLedger({ name: 'Staff Welfare', group: 'INDIRECT_EXPENSES', gstRate: 18, hsnSac: '996331', supplyType: 'services', itcEligibility: 'ineligible' });
    // ₹100.00 + CGST 9.00 + SGST 9.00 = ₹118.00 → all to Staff Welfare.
    const res = save(k, { voucherTypeId: k.vt.purchase, date: k.t.today, mode: 'accounting_invoice', partyLedgerId: k.L.supplier, referenceNo: 'CAT-1', ledgers: [{ ledgerId: welfare, amount: 10000 }] });
    assert.deepEqual(entryMap(k, res.id), { 'Supreme Suppliers': -11800, 'Staff Welfare': 11800 });
    assert.equal(gstLines(k, res.id)[0].itc_eligibility, 'ineligible');
    k.t.close();
  });

  it('purchase from a registered supplier requires the supplier invoice number', () => {
    const k = setupKit();
    const err = throwsApp(() => save(k, purchaseInput(k, { referenceNo: undefined })), 'BUSINESS_RULE', /Supplier invoice number is required/);
    assert.equal(ruleDetails(err).needsConfirmation, undefined);
    k.t.close();
  });

  it('debit note (purchase return) mirrors the purchase and settles the supplier bill', () => {
    const k = setupKit();
    save(k, purchaseInput(k));
    // Return rice 5 × ₹80 = ₹400.00 + CGST 10 + SGST 10 = ₹420.00.
    const dn = save(k, {
      voucherTypeId: k.vt.debit_note,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      originalInvoiceNo: 'SUP-101',
      items: [{ itemId: k.I.rice, qty: 5, rate: 80 }],
    });
    assert.deepEqual(entryMap(k, dn.id), { 'Supreme Suppliers': 42000, Purchase: -40000, 'Input CGST': -1000, 'Input SGST/UTGST': -1000 });
    assert.deepEqual(bills(k, dn.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['against', 'SUP-101', 42000]]);
    assert.equal(stockOf(k, k.I.rice), 100 + 20 - 5);
    const pend = pendingBills(k.t.db, k.L.supplier, k.t.today, k.t.today);
    assert.deepEqual(pend.map((b) => [b.billName, b.amount]), [['SUP-101', -168000 + 42000]]);
    k.t.close();
  });
});

describe('non-GST company', () => {
  it('posts invoices without tax and writes no gst_lines', () => {
    const k = setupKit({ gst: false });
    const res = save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.freight, amount: 5000 }] }));
    // ₹1,000.00 + freight ₹50.00 (absorbed into the item's value) = ₹1,050.00.
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 105000, Sales: -100000, 'Freight Outward': -5000 });
    assert.equal(gstLines(k, res.id).length, 0);
    assert.equal(header(k, res.id).gst_nature, null);
    k.t.close();
  });
});
