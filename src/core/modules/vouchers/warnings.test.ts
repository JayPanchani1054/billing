/**
 * Regression tests: warning levels. Only material warnings ('confirm') make save ask for confirmation;
 * informational ones ('info') are returned but never stop a save; 'block' ones can never be saved.
 * Company: Maharashtra (27), working date 15-Apr-2026. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { previewVoucher, saveVoucher } from './service.ts';
import { entryMap, ruleDetails, salesInput, setupKit, throwsApp } from './testkit.ts';

describe('warning levels', () => {
  it('a GST engine note (12% slab merged on 22-Sep-2025) is info: the save goes through unconfirmed', () => {
    const k = setupKit();
    const biscuits = k.t.addStockItem({ name: 'Biscuits', gstRate: 12, hsnSac: '1905', openingQty: 100, openingRate: 50 });
    // 10 × ₹100 = ₹1,000.00 @12%: CGST 6% = 60.00, SGST 60.00 → ₹1,120.00 (B2C).
    const input = salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: biscuits, qty: 10, rate: 100 }] });
    const p = previewVoucher(k.t.ctx, input);
    assert.ok(p.warnings.length > 0);
    assert.ok(p.warnings.every((w) => w.level === 'info' && !w.blocking), JSON.stringify(p.warnings));
    // Before the fix every engine note needed acknowledgeWarnings.
    const res = saveVoucher(k.t.ctx, input);
    assert.deepEqual(entryMap(k, res.id), { 'Walk-in Customer': 112000, Sales: -100000, 'Output CGST': -6000, 'Output SGST/UTGST': -6000 });
    assert.ok(res.warnings.some((w) => w.code === 'gst' && /slab was largely merged/.test(w.message) && w.level === 'info'));
    k.t.close();
  });

  it('missing HSN on a B2C line is info; on a B2B line it needs confirmation', () => {
    const k = setupKit();
    const plain = k.t.addStockItem({ name: 'Plain Item', gstRate: 18, openingQty: 10, openingRate: 10 });
    const b2c = salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: plain, qty: 1, rate: 100 }] });
    const pc = previewVoucher(k.t.ctx, b2c);
    assert.deepEqual(pc.warnings.map((w) => [w.code, w.level, w.path]), [['gst_missing_hsn', 'info', 'items[0]']]);
    saveVoucher(k.t.ctx, b2c);
    const err = throwsApp(() => saveVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: plain, qty: 1, rate: 100 }] })), 'BUSINESS_RULE', /Please confirm: Line 1 \(Plain Item\): HSN\/SAC code is required/);
    assert.equal(ruleDetails(err).needsConfirmation, true);
    k.t.close();
  });

  it('an HSN shorter than the configured digits is flagged like a missing one', () => {
    const k = setupKit();
    const short = k.t.addStockItem({ name: 'Short HSN', gstRate: 18, hsnSac: '85', openingQty: 10, openingRate: 10 });
    const b2b = previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: short, qty: 1, rate: 100 }] }));
    assert.deepEqual(b2b.warnings.map((w) => [w.code, w.level, w.message]), [
      ['gst_missing_hsn', 'confirm', 'Line 1 (Short HSN): HSN/SAC 85 has 2 digits; GST returns need at least 4 (F12 › GST › HSN digits).'],
    ]);
    // Turnover above ₹5 crore → 6 digits: the 4-digit HSN 8509 of the mixer is now short too.
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.gst.hsnDigits', 6) WHERE key = 'config'`);
    assert.match(previewVoucher(k.t.ctx, salesInput(k)).warnings[0]?.message ?? '', /HSN\/SAC 8509 has 4 digits; GST returns need at least 6/);
    k.t.close();
  });

  it('material engine warnings (GSTIN registered in another state) need confirmation', () => {
    const k = setupKit();
    const odd = k.t.addLedger({ name: 'Mismatch Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29', testPan(9)), stateCode: '27' });
    const err = throwsApp(() => saveVoucher(k.t.ctx, salesInput(k, { partyLedgerId: odd })), 'BUSINESS_RULE', /Please confirm/);
    const d = ruleDetails(err);
    assert.equal(d.needsConfirmation, true);
    assert.ok(d.warnings.some((w) => w.code === 'gst' && w.level === 'confirm' && /registered in 29-Karnataka but the party state is 27-Maharashtra/.test(w.message)));
    k.t.close();
  });

  it('confirmation counts only material warnings; info ones ride along in details', () => {
    const k = setupKit();
    const biscuits = k.t.addStockItem({ name: 'Biscuits', gstRate: 12, hsnSac: '1905', openingQty: 5, openingRate: 50 });
    // 6 sold, 5 in stock → negative_stock (confirm) + the 12% slab note (info).
    const err = throwsApp(
      () => saveVoucher(k.t.ctx, salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: biscuits, qty: 6, rate: 100 }] })),
      'BUSINESS_RULE',
      /^Please confirm: Stock of Biscuits in Main Location will go negative/,
    );
    const d = ruleDetails(err);
    assert.deepEqual(d.warnings.map((w) => w.level).sort(), ['confirm', 'info']);
    assert.equal(d.warnings.find((w) => w.code === 'negative_stock')?.path, 'items[0]');
    k.t.close();
  });

  it('GST entered as plain ledger lines (not in returns) needs confirmation', () => {
    const k = setupKit();
    const input = {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'ledger' as const,
      ledgers: [
        { ledgerId: k.L.acme, amount: 11800 },
        { ledgerId: k.L.sales, amount: -10000 },
        { ledgerId: k.L.OUTPUT_IGST, amount: -1800 },
      ],
    };
    const err = throwsApp(() => saveVoucher(k.t.ctx, input), 'BUSINESS_RULE', /not reported in GST returns/);
    assert.deepEqual(ruleDetails(err).warnings.map((w) => [w.code, w.level, w.path]), [['gst_ledger_lines', 'confirm', 'ledgers[2].ledgerId']]);
    k.t.close();
  });

  it('export under LUT needs a LUT valid on the invoice date', () => {
    const k = setupKit();
    const exp = salesInput(k, { partyLedgerId: k.L.export, exportDetails: { shippingBillNo: 'SB-1' } });
    const lut = (): string | undefined => previewVoucher(k.t.ctx, exp).warnings.find((w) => w.code === 'gst_lut')?.level;
    assert.equal(lut(), 'confirm', 'no LUT recorded');
    k.t.db.run(
      `UPDATE settings SET value = json_set(value, '$.gst.lutNumber', 'AD2704260012345', '$.gst.lutValidFrom', '2026-04-01', '$.gst.lutValidTo', '2027-03-31') WHERE key = 'config'`,
    );
    assert.equal(lut(), undefined, 'LUT covers 15-Apr-2026');
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.gst.lutValidTo', '2026-04-10') WHERE key = 'config'`);
    assert.equal(lut(), 'confirm', 'LUT expired on 10-Apr-2026');
    // With payment of IGST no LUT is needed.
    const wp = previewVoucher(k.t.ctx, { ...exp, exportDetails: { withPayment: true } });
    assert.equal(wp.warnings.some((w) => w.code === 'gst_lut'), false);
    k.t.close();
  });

  it('a GST invoice number longer than 16 characters needs confirmation', () => {
    const k = setupKit();
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'automatic_override' WHERE id = :id`, { id: k.vt.sales });
    const long = previewVoucher(k.t.ctx, salesInput(k, { number: 'INV/2026-27/000001' }));
    assert.deepEqual(long.warnings.map((w) => [w.code, w.level, w.path]), [['gst_invoice_number', 'confirm', 'number']]);
    const bad = previewVoucher(k.t.ctx, salesInput(k, { number: 'INV#12' }));
    assert.equal(bad.warnings[0]?.code, 'gst_invoice_number');
    const ok = previewVoucher(k.t.ctx, salesInput(k, { number: 'INV/26-27/0001' }));
    assert.deepEqual(ok.warnings, []);
    k.t.close();
  });

  it('an invoice whose discounts exceed its value is refused (no negative invoices)', () => {
    const k = setupKit();
    // Mixer 1 × ₹10 = ₹10.00 + CGST 0.90 + SGST 0.90 = ₹11.80; non-GST discount ₹20.00 → ₹-8.20 → rounded ₹-8.00.
    // Before the fix this posted Cr Acme ₹8.00 on a sales invoice and stored total_amount = −800.
    const input = salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 10 }], ledgers: [{ ledgerId: k.L.discount, amount: -2000 }] });
    const p = previewVoucher(k.t.ctx, input);
    assert.equal(p.totals.grandTotal, -800);
    assert.deepEqual(p.warnings.map((w) => [w.code, w.level, w.path]), [['negative_value', 'block', 'ledgers']]);
    const err = throwsApp(() => saveVoucher(k.t.ctx, { ...input, acknowledgeWarnings: true }), 'BUSINESS_RULE', /The invoice value is -₹ 8\.00/);
    assert.equal(ruleDetails(err).needsConfirmation, undefined);
    k.t.close();
  });

  it('every warning carries a level consistent with blocking', () => {
    const k = setupKit();
    const p = previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.noRate, qty: 20, rate: 10 }] }));
    assert.ok(p.warnings.length >= 3);
    for (const w of p.warnings) assert.equal(w.blocking, w.level === 'block');
    assert.deepEqual(
      p.warnings.map((w) => [w.code, w.level]),
      [
        ['gst_missing_rate', 'confirm'],
        ['gst_missing_hsn', 'confirm'],
        ['negative_stock', 'confirm'],
      ],
    );
    k.t.close();
  });
});
