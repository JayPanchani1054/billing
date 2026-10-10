/**
 * GST set-off posted to the books, GST challans and the electronic cash / credit ledgers — end to end
 * through the real dispatcher (runtime routes), for a regular and a composition taxpayer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Cmp08Summary, ElectronicCashLedger, ElectronicCreditLedger, GstSetoffResult, Gstr4Summary } from '../../../shared/types/gst-plus.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { entryMap, save, setupKit } from '../vouchers/testkit.ts';

const bal = (k: ReturnType<typeof setupKit>, ledgerName: string): number =>
  k.t.db.value<number>('SELECT COALESCE(SUM(le.amount), 0) FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE l.name = :n', { n: ledgerName }) ?? 0;

describe('GST set-off (regular taxpayer)', () => {
  it('computes Rule 88A utilisation, posts the challan and the set-off, and the electronic ledgers tie out', async () => {
    const k = setupKit({ today: '2026-06-25' });
    const kar = k.t.addLedger({ name: 'Karnataka Steel', group: 'SUNDRY_CREDITORS', gstin: makeGstin('29', testPan(9)) });
    // May: sale 1,00,000 @18% intra → CGST 9,000 + SGST 9,000.
    save(k, { voucherTypeId: k.vt.sales, date: '2026-05-05', mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 1_00_000_00 }] });
    // Inter-state purchase 10,000 @18% → IGST credit 1,800; local purchase 10,000 @5% → CGST 250 + SGST 250.
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-06', mode: 'item_invoice', partyLedgerId: kar, referenceNo: 'K-1', items: [{ itemId: k.I.mixer, qty: 10, rate: 1000 }] });
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    await k.t.callOk(routes, 'gst.gstr3b.saveAdjustments', { period: '052026', values: { interest: { cgst: 100_00 } } });

    const s = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '052026' });
    // Rule 88A: IGST credit 1,800 goes to the CGST shortfall (9,000 − 250); own credit then pays 250 each.
    assert.deepEqual(s.credit, [
      { from: 'igst', to: 'cgst', amount: 1_800_00 },
      { from: 'cgst', to: 'cgst', amount: 250_00 },
      { from: 'sgst', to: 'sgst', amount: 250_00 },
    ]);
    const cgst = s.cash.find((r) => r.head === 'cgst')!;
    const sgst = s.cash.find((r) => r.head === 'sgst')!;
    // Cash: CGST 9,000 − 1,800 − 250 = 6,950 tax + 100 interest; SGST 9,000 − 250 = 8,750.
    assert.deepEqual([cgst.tax, cgst.interest, cgst.total, cgst.toDeposit], [6_950_00, 100_00, 7_050_00, 7_050_00]);
    assert.deepEqual([sgst.tax, sgst.total], [8_750_00, 8_750_00]);
    assert.equal(s.cashTotal, 15_800_00);
    assert.equal(s.posted, null);

    const challan = await k.t.callOk<VoucherSaveResult>(routes, 'gst.challan.post', {
      date: '2026-06-18',
      bankLedgerId: k.L.bank,
      cpin: '26052700012345',
      cin: 'HDFC2605270001234',
      brn: 'BRN778899',
      challanDate: '2026-06-18',
      bankName: 'HDFC Bank',
      mode: 'epayment',
      period: '052026',
      heads: [
        { head: 'cgst', minor: 'tax', amount: 6_950_00 },
        { head: 'cgst', minor: 'interest', amount: 100_00 },
        { head: 'sgst', minor: 'tax', amount: 8_750_00 },
      ],
    });
    assert.equal(entryMap(k, challan.id)['GST Electronic Cash Ledger'], 15_800_00);
    const after = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '052026' });
    assert.equal(after.toDepositTotal, 0, 'the challan covers the cash needed');
    assert.equal(after.challans.length, 1);

    const posted = await k.t.callOk<VoucherSaveResult>(routes, 'gst.setoff.post', { period: '052026', date: '2026-06-20' });
    const e = entryMap(k, posted.id);
    assert.deepEqual(
      [e['Output CGST'], e['Output SGST/UTGST'], e['Input IGST'], e['Input CGST'], e['Input SGST/UTGST'], e['Interest on GST'], e['GST Electronic Cash Ledger']],
      [9_000_00, 9_000_00, -1_800_00, -250_00, -250_00, 100_00, -15_800_00],
    );
    // Every GST account is squared off.
    for (const name of ['Output CGST', 'Output SGST/UTGST', 'Input IGST', 'Input CGST', 'Input SGST/UTGST', 'GST Electronic Cash Ledger']) assert.equal(bal(k, name), 0, name);

    const again = await k.t.call(routes, 'gst.setoff.post', { period: '052026', date: '2026-06-21' });
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.error.code, 'CONFLICT');

    const cash = await k.t.callOk<ElectronicCashLedger>(routes, 'gst.ledger.cash', { from: '2026-05-01', to: '2026-06-30' });
    const row = (h: string, m: string) => cash.rows.find((r) => r.head === h && r.minor === m)!;
    assert.deepEqual([row('cgst', 'tax').deposited, row('cgst', 'tax').utilised, row('cgst', 'tax').closing], [6_950_00, 6_950_00, 0]);
    assert.deepEqual([row('cgst', 'interest').deposited, row('cgst', 'interest').utilised], [100_00, 100_00]);
    assert.deepEqual([cash.totals.deposited, cash.totals.closing, cash.booksBalance], [15_800_00, 0, 0]);
    assert.deepEqual(cash.transactions.map((t) => t.kind), ['deposit', 'utilised']);

    const credit = await k.t.callOk<ElectronicCreditLedger>(routes, 'gst.ledger.credit', { from: '2026-05-01', to: '2026-06-30' });
    const c = (h: string) => credit.rows.find((r) => r.head === h)!;
    assert.deepEqual([c('igst').accrued, c('igst').utilised, c('igst').closing], [1_800_00, 1_800_00, 0]);
    assert.deepEqual([c('cgst').accrued, c('cgst').utilised, c('cgst').closing], [250_00, 250_00, 0]);
    k.t.close();
  });

  it('refuses a set-off dated before the period ends and a challan without amounts', async () => {
    const k = setupKit({ today: '2026-06-25' });
    save(k, { voucherTypeId: k.vt.sales, date: '2026-05-05', mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 10_000_00 }] });
    const early = await k.t.call(routes, 'gst.setoff.post', { period: '052026', date: '2026-05-20' });
    assert.equal(!early.ok && early.error.code, 'VALIDATION');
    const empty = await k.t.call(routes, 'gst.challan.post', { date: '2026-06-01', bankLedgerId: k.L.bank, cpin: '1', heads: [{ head: 'igst', minor: 'tax', amount: 0 }] });
    assert.equal(!empty.ok && empty.error.code, 'VALIDATION');
    k.t.close();
  });
});

describe('composition taxpayer: CMP-08, GSTR-4 and set-off', () => {
  it('computes CMP-08 from turnover (rate master), pays it through the set-off and summarises GSTR-4', async () => {
    const k = setupKit({ today: '2026-07-10', registrationType: 'composition' });
    const veg = k.t.addStockItem({ name: 'Fresh Vegetables', taxability: 'exempt', hsnSac: '0706', openingQty: 100, openingRate: 10 });
    // Bill of supply: rice 100 × 100 = 10,000 (taxable goods) + vegetables 100 × 20 = 2,000 (exempt). No tax charged.
    const sale = save(k, {
      voucherTypeId: k.vt.sales,
      date: '2026-05-05',
      mode: 'item_invoice',
      partyLedgerId: k.L.walkin,
      items: [
        { itemId: k.I.rice, qty: 100, rate: 100 },
        { itemId: veg, qty: 100, rate: 20 },
      ],
    });
    const se = entryMap(k, sale.id);
    assert.equal(se['Output CGST'], undefined, 'a composition taxpayer charges no tax');
    assert.equal(se['Walk-in Customer'], 12_000_00);
    // Reverse charge: freight from a GTA 2,000 @5% → CGST 50 + SGST 50 payable by us.
    save(k, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-06',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.gta,
      referenceNo: 'GTA-1',
      reverseCharge: true,
      ledgers: [{ ledgerId: k.L.gtaFreight, amount: 2_000_00 }],
    });

    // Trader (default): 1% of taxable turnover 10,000 → CGST 50 + SGST 50.
    const c = await k.t.callOk<Cmp08Summary>(routes, 'gst.cmp08.summary', { period: '2026-27-Q1' });
    const t3 = (key: string) => c.table3.find((r) => r.key === key)!;
    assert.deepEqual([c.category, c.rate, c.basis], ['trader', 1, 'taxable_turnover']);
    assert.deepEqual([t3('outward').taxable, t3('outward').cgst, t3('outward').sgst], [12_000_00, 50_00, 50_00]);
    assert.deepEqual([t3('rcm').taxable, t3('rcm').cgst, t3('rcm').sgst], [2_000_00, 50_00, 50_00]);
    assert.deepEqual([t3('payable').cgst, t3('payable').sgst], [100_00, 100_00]);

    // A manufacturer pays 1% of the whole turnover (exempt included): 12,000 → CGST 60 + SGST 60.
    await k.t.callOk(routes, 'gst.composition.saveCategory', { category: 'manufacturer' });
    const m = await k.t.callOk<Cmp08Summary>(routes, 'gst.cmp08.summary', { period: '2026-27-Q1' });
    assert.deepEqual([m.table3[0].cgst, m.table3[0].sgst], [60_00, 60_00]);
    await k.t.callOk(routes, 'gst.composition.saveCategory', { category: 'trader' });

    // Interest entered by the user, then the set-off: all in cash.
    await k.t.callOk(routes, 'gst.cmp08.saveInterest', { period: '2026-27-Q1', interest: { cgst: 10_00, sgst: 10_00 } });
    const so = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '2026-27-Q1' });
    assert.equal(so.composition, true);
    assert.deepEqual(so.credit, []);
    assert.equal(so.cashTotal, 220_00);
    const posted = await k.t.callOk<VoucherSaveResult>(routes, 'gst.setoff.post', { period: '2026-27-Q1', date: '2026-07-10' });
    const e = entryMap(k, posted.id);
    assert.deepEqual(
      [e['Composition Tax (GST)'], e['CGST Payable (Reverse Charge)'], e['SGST Payable (Reverse Charge)'], e['Interest on GST'], e['GST Electronic Cash Ledger']],
      [100_00, 50_00, 50_00, 20_00, -220_00],
    );
    const paid = await k.t.callOk<Cmp08Summary>(routes, 'gst.cmp08.summary', { period: '2026-27-Q1' });
    assert.deepEqual([paid.paid.cgst, paid.paid.sgst, paid.paid.interest], [100_00, 100_00, 20_00]);

    const g4 = await k.t.callOk<Gstr4Summary>(routes, 'gst.gstr4.summary', { fy: '2026-27' });
    const b4 = g4.table4.find((r) => r.key === '4B')!;
    assert.deepEqual([b4.taxable, b4.cgst, b4.sgst, b4.documents], [2_000_00, 50_00, 50_00, 1]);
    assert.deepEqual([g4.table5[0].taxable, g4.table5[0].cgst], [14_000_00, 100_00]);
    assert.deepEqual(g4.table6.map((r) => [r.kind, r.rate, r.taxable, r.cgst]), [
      ['outward', 1, 12_000_00, 50_00],
      ['rcm', 5, 2_000_00, 50_00],
    ]);
    assert.deepEqual([g4.table8.payable.cgst, g4.table8.paid], [100_00, 220_00]);

    // Exports are our own documented formats, audited.
    const f = await k.t.callOk<{ fileName: string; content: string }>(routes, 'gst.cmp08.export', { period: '2026-27-Q1', format: 'csv' });
    assert.match(f.fileName, /^CMP08_.*_062026\.csv$/);
    assert.match(f.content, /Outward supplies \(including exempt supplies\),12000,0,50,50,0/);
    // A regular-taxpayer form is refused.
    const no = await k.t.call(routes, 'gst.filing.mark', { form: 'gstr1', period: '052026', filedOn: '2026-06-11' });
    assert.equal(!no.ok && no.error.code, 'BUSINESS_RULE');
    k.t.close();
  });
});
