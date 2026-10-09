/**
 * dashboard.summary on the hand-built books of testkit.ts (every voucher and figure is listed in its
 * header; amounts below are paise = rupees × 100). Cross-checks against the engines behind the
 * drill-down screens: P&L gross profit, outstanding ageing / due-soon, ledger balances.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerBalance } from '../accounts/books.ts';
import { ageing, dueSoon } from '../outstanding/reports.ts';
import { loadReportEnv } from '../reports/engine.ts';
import { profitLoss } from '../reports/financials.ts';
import { cashBank as cashBankReport } from '../reports/trialBalance.ts';
import { loadCompany } from '../gst/docs.ts';
import { pendingEinvoices } from '../gst/einvoice.ts';
import { pendingEwayBills } from '../gst/ewaybill.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { save } from '../vouchers/testkit.ts';
import { dashboardRanges, dashboardSummary, gstDueDate, summaryForCtx } from './summary.ts';
import { buildDashboardBooks, INPUT, TODAY } from './testkit.ts';

const rs = (r: number): number => Math.round(r * 100);

test('flows: sales and purchases for today / MTD / YTD / period and the same ranges last year', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);

  assert.deepEqual(s.ranges.today, { from: TODAY, to: TODAY });
  assert.deepEqual(s.ranges.mtd, { from: '2026-10-01', to: TODAY });
  assert.deepEqual(s.ranges.ytd, { from: '2026-04-01', to: TODAY });
  assert.deepEqual(s.ranges.lastYear.ytd, { from: '2025-04-01', to: '2025-10-08' });

  // Sales (net of the credit note, optional and cancelled vouchers ignored):
  //   today S4 300 · MTD S3 1,200 + S4 300 − CN 200 = 1,300 · YTD 1,000 + 2,500 + 1,200 + 300 − 200 = 4,800
  //   last year: today L3 600 · MTD L2 400 + L3 600 = 1,000 · YTD 1,000
  assert.deepEqual(s.sales, {
    today: rs(300),
    mtd: rs(1_300),
    ytd: rs(4_800),
    period: rs(4_800),
    lastYear: { today: rs(600), mtd: rs(1_000), ytd: rs(1_000), period: rs(1_000) },
  });
  // Purchases: MTD P2 3,000 · YTD P1 5,000 + P3 750 + P2 3,000 = 8,750 · last year L1 2,500
  assert.deepEqual(s.purchases, {
    today: 0,
    mtd: rs(3_000),
    ytd: rs(8_750),
    period: rs(8_750),
    lastYear: { today: 0, mtd: rs(2_500), ytd: rs(2_500), period: rs(2_500) },
  });
  assert.equal(s.hasVouchers, true);
  assert.equal(s.booksFrom, '2025-04-01');
  b.t.close();
});

test('gross profit with integrated inventory = sales − (opening + purchases − closing) = the P&L gross profit', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  // Opening stock 1-Apr-26: rice 140 × 50 = 7,000 · mixer 48 × 150 = 7,200 · noRate 10 × 10 = 100 · tumbler 3 × 80 = 240 → 14,540
  // Closing 8-Oct-26:       rice 220 × 50 = 11,000 · mixer 57 × 150 = 8,550 · noRate 100 · tumbler 240 → 19,890
  // Cost of sales = 14,540 + 8,750 − 19,890 = 3,400 (= mixer 16 × 150 + rice 20 × 50); GP = 4,800 − 3,400 = 1,400
  assert.deepEqual(s.grossProfit, {
    method: 'stock_valuation',
    sales: rs(4_800),
    purchases: rs(8_750),
    directIncomes: 0,
    directExpenses: 0,
    openingStock: rs(14_540),
    closingStock: rs(19_890),
    costOfSales: rs(3_400),
    amount: rs(1_400),
    marginPercent: 29.17, // 1,400 ÷ 4,800 = 29.1666…%
  });
  const pl = profitLoss(loadReportEnv(b.t.db, b.t.today), { from: INPUT.from, to: INPUT.to });
  assert.equal(s.grossProfit?.amount, pl.figures.grossProfit);
  assert.equal(s.grossProfit?.sales, pl.figures.sales);
  assert.equal(s.grossProfit?.closingStock, pl.figures.closingStock);
  b.t.close();
});

test('gross profit without integrated inventory = sales − purchases (a gross loss here)', () => {
  const b = buildDashboardBooks({ features: { integrateInventory: false } });
  const s = summaryForCtx(b.t.ctx, INPUT);
  // 4,800 − 8,750 = −3,950; margin −3,950 ÷ 4,800 = −82.29%
  assert.equal(s.grossProfit?.method, 'purchases');
  assert.equal(s.grossProfit?.openingStock, null);
  assert.equal(s.grossProfit?.amount, -rs(3_950));
  assert.equal(s.grossProfit?.marginPercent, -82.29);
  assert.equal(s.features.integrated, false);
  const pl = profitLoss(loadReportEnv(b.t.db, b.t.today), { from: INPUT.from, to: INPUT.to });
  assert.equal(s.grossProfit?.amount, pl.figures.grossProfit);
  b.t.close();
});

test('receivables and payables: totals, overdue, ageing and due within 7 days', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  // acme: S1 1,180 − R1 500 − CN 236 = 444 (due 20-May → 141 days overdue: 11+30+31+31+30+8) + S4 354 (due 7-Nov)
  // blr:  S2 2,950 (due 15-Sep → 23 days overdue) · metro: S3 1,260 (due 11-Oct → due within 7 days)
  // The post-dated receipt PD1 (20-Oct) does not count yet; the cancelled X1 never does.
  const r = s.receivables;
  assert.equal(r.total, rs(444 + 354 + 2_950 + 1_260)); // 5,008
  assert.equal(r.overdue, rs(444 + 2_950)); // 3,394
  assert.equal(r.overdueBillCount, 2);
  assert.equal(r.overduePartyCount, 2);
  assert.equal(r.notDue, rs(354 + 1_260));
  assert.equal(r.partyCount, 3);
  assert.deepEqual(
    r.ageing.map((a) => [a.label, a.amount]),
    [
      ['Not due', rs(1_614)],
      ['1–30 days', rs(2_950)],
      ['31–60 days', 0],
      ['61–90 days', 0],
      ['91–180 days', rs(444)],
      ['> 180 days', 0],
    ],
  );
  assert.deepEqual(r.dueSoon, { days: 7, until: '2026-10-15', amount: rs(1_260), count: 1 });

  // supplier: SUP-101 5,250 − 3,000 = 2,250 (due 25-May → 136 days) + SUP-102 3,540 (due 16-Nov) · quick: QS-77 885 (due 9-Oct)
  const p = s.payables;
  assert.equal(p.total, rs(2_250 + 3_540 + 885)); // 6,675
  assert.equal(p.overdue, rs(2_250));
  assert.equal(p.overdueBillCount, 1);
  assert.equal(p.notDue, rs(3_540 + 885));
  assert.deepEqual(p.dueSoon, { days: 7, until: '2026-10-15', amount: rs(885), count: 1 });
  assert.equal(p.ageing[4].amount, rs(2_250));

  // Same figures as the Receivables / Payables screens (outstanding engine, FIFO for non-bill-wise ledgers).
  for (const [side, d] of [['receivable', r], ['payable', p]] as const) {
    const a = ageing(b.t.db, b.t.today, { side, asOf: TODAY, nonBillWise: 'fifo' });
    assert.equal(d.total, a.totals.total);
    assert.deepEqual(d.ageing.map((x) => x.amount), a.totals.amounts);
    const ds = dueSoon(b.t.db, b.t.today, { side, asOf: TODAY, days: 7, nonBillWise: 'fifo' });
    assert.equal(d.dueSoon.amount, ds.amount);
    assert.equal(d.overdue, ds.overdue.amount);
  }
  b.t.close();
});

test('cash and bank balances as at the working date', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  // Cash: L2 472 + L3 630 + C1 5,000 = 6,102
  // Bank: L0 50,000 − L4 2,625 − C1 5,000 + R1 500 − PAY 3,000 − RNT 10,000 = 29,875 (post-dated PD1/PD2 not yet)
  assert.equal(s.cashBank.cashTotal, rs(6_102));
  assert.deepEqual(s.cashBank.banks, [{ ledgerId: b.L.bank, name: 'HDFC Bank', balance: rs(29_875), isOverdraft: false, accountTail: '5678' }]);
  assert.equal(s.cashBank.bankTotal, rs(29_875));
  assert.equal(ledgerBalance(b.t.db, b.L.bank, { to: TODAY, today: TODAY }).closing, rs(29_875));
  b.t.close();
});

test('GST for the current month: output − input with the GSTR-3B set-off', () => {
  const b = buildDashboardBooks();
  const g = summaryForCtx(b.t.ctx, INPUT).gst;
  // Oct 2026 outward: S3 1,200 @ 5% = 60 (C 30 / S 30) + S4 300 @ 18% = 54 (27 / 27) − CN 200 @ 18% = 36 (18 / 18) = 78
  // Inward: P2 3,000 @ 18% = 540 (270 / 270). Set-off: CGST 39 and SGST 39 from their own credit → cash 0;
  // credit carried forward (270 − 39) × 2 = 462.
  assert.ok(g);
  assert.equal(g.period, '102026');
  assert.equal(g.label, 'Oct 2026');
  assert.equal(g.dueDate, '2026-11-20');
  assert.equal(g.dueForm, 'GSTR-3B');
  assert.equal(g.outputTax, rs(78));
  assert.equal(g.inputTax, rs(540));
  assert.equal(g.reverseChargeTax, 0);
  assert.equal(g.netPayable, 0);
  assert.equal(g.creditCarriedForward, rs(462));
  assert.equal(g.documentCount, 4); // S3, S4, CN, P2 (OPT optional)
  b.t.close();
});

test('GST payable when output exceeds input; unregistered company has no GST card', () => {
  const b = buildDashboardBooks();
  // A further 10-Oct sale: mixer 10 @ 500 = 5,000 @ 18% = 900 (450 / 450). The clock moves to 10-Oct so it counts.
  b.t.clock.setToday('2026-10-10');
  save(b, { voucherTypeId: b.vt.sales, date: '2026-10-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.I.mixer, qty: 10, rate: 500 }] });
  const g = summaryForCtx(b.t.ctx, { asOf: '2026-10-10', from: INPUT.from, to: '2026-10-10' }).gst;
  // Output 78 + 900 = 978 (C 489 / S 489) vs ITC 540 (270 / 270) → cash 219 + 219 = 438
  assert.equal(g?.outputTax, rs(978));
  assert.equal(g?.netPayable, rs(438));
  assert.equal(g?.creditCarriedForward, 0);
  b.t.close();

  const u = createTestCompany({ gst: false, today: TODAY });
  assert.equal(summaryForCtx(u.ctx, INPUT).gst, null);
  u.close();
});

test('gstDueDate: monthly 20th; quarterly PMT-06 25th, quarter end 22nd / 24th by state; year rollover', () => {
  assert.deepEqual(gstDueDate('2026-10-01', 'monthly', '27'), { dueDate: '2026-11-20', form: 'GSTR-3B' });
  assert.deepEqual(gstDueDate('2026-12-01', 'monthly', '27'), { dueDate: '2027-01-20', form: 'GSTR-3B' });
  assert.deepEqual(gstDueDate('2026-10-01', 'quarterly', '27'), { dueDate: '2026-11-25', form: 'PMT-06' });
  assert.deepEqual(gstDueDate('2026-12-01', 'quarterly', '27'), { dueDate: '2027-01-22', form: 'GSTR-3B' });
  assert.deepEqual(gstDueDate('2027-03-01', 'quarterly', '09'), { dueDate: '2027-04-24', form: 'GSTR-3B' });
  // Category 1 (22nd) vs category 2 (24th), Notification 76/2020-CT: Ladakh (38), Delhi (07) and J&K (01)
  // file on the 24th; Gujarat (24), Daman & Diu (25), Telangana (36) on the 22nd.
  for (const st of ['38', '07', '01', '04', '19']) assert.equal(gstDueDate('2026-09-01', 'quarterly', st).dueDate, '2026-10-24', `state ${st}`);
  for (const st of ['24', '25', '26', '36', '37', '34']) assert.equal(gstDueDate('2026-09-01', 'quarterly', st).dueDate, '2026-10-22', `state ${st}`);
});

test("GST due: last month's return is shown until its due date", () => {
  const b = buildDashboardBooks();
  // September 2026: S2 blr (29, inter-state) 2,500 @ 18% IGST = 450; no purchases in September.
  // X1 is cancelled, RNT carries no GST. The electronic credit ledger brings forward the CGST/SGST credit
  // left by earlier months (chained from the books beginning, 1-Apr-2025):
  //   Oct 2025: ITC C/S 62.50 (L1) − tax C/S 36 + 15 (L2, L3) → 11.50 each
  //   Apr 2026: + 125 (P1) − 90 (S1) → 46.50 each;  Aug 2026: + 67.50 (P3) → 114.00 each
  //   Sep 2026: IGST 450 ← CGST 114 + SGST 114 (s.49(5)) → 222.00 payable in cash by 20-Oct (monthly filer).
  // (Before the carry-forward fix the card showed all 450 as payable.)
  const d = summaryForCtx(b.t.ctx, INPUT).gstDue;
  assert.ok(d);
  assert.equal(d.period, '092026');
  assert.equal(d.label, 'Sep 2026');
  assert.equal(d.dueDate, '2026-10-20');
  assert.equal(d.outputTax, rs(450));
  assert.equal(d.inputTax, 0);
  assert.equal(d.netPayable, rs(222));
  assert.equal(d.creditCarriedForward, 0);
  assert.equal(d.documentCount, 1);
  // On the due date it is still shown; the day after it is gone.
  b.t.clock.setToday('2026-10-20');
  assert.equal(summaryForCtx(b.t.ctx, { asOf: '2026-10-20', from: INPUT.from, to: '2026-10-20' }).gstDue?.period, '092026');
  b.t.clock.setToday('2026-10-21');
  assert.equal(summaryForCtx(b.t.ctx, { asOf: '2026-10-21', from: INPUT.from, to: '2026-10-21' }).gstDue, null);
  // Without gst.view: nothing.
  b.t.clock.setToday(TODAY);
  assert.equal(summaryForCtx(b.t.ctxAs({ permissions: ['reports.view'] }), INPUT).gstDue, null);
  b.t.close();
});

test('tie-out: sales / purchases = the P&L for the period; cash & bank = the Cash/Bank Books closing', () => {
  const b = buildDashboardBooks();
  for (const range of [INPUT, { asOf: TODAY, from: '2026-10-01', to: TODAY }, { asOf: TODAY, from: '2025-04-01', to: '2026-03-31' }]) {
    const s = summaryForCtx(b.t.ctx, range);
    const pl = profitLoss(loadReportEnv(b.t.db, b.t.today), { from: range.from, to: range.to });
    assert.equal(s.sales.period, pl.figures.sales, `sales ${range.from}`);
    assert.equal(s.purchases.period, pl.figures.purchases, `purchases ${range.from}`);
    assert.equal(s.grossProfit?.amount, pl.figures.grossProfit, `gross profit ${range.from}`);
  }
  const s = summaryForCtx(b.t.ctx, INPUT);
  const cb = cashBankReport(loadReportEnv(b.t.db, b.t.today), { from: INPUT.from, to: INPUT.asOf });
  assert.equal(s.cashBank.cashTotal + s.cashBank.bankTotal, cb.totals.closing); // 6,102 + 29,875 = 35,977
  assert.equal(cb.totals.closing, rs(35_977));
  b.t.close();
});

test('nominal opening balances (books begun mid-year) count in the first period, the trend and the P&L alike', () => {
  // Books from 1-Jul-2026; the year-to-date before that is entered as openings: Sales Cr 1,00,000,
  // Purchase Dr 60,000. One July sale of 1,000 (cash, rice 20 @ 50).
  const t = createTestCompany({ today: TODAY, booksFrom: '2026-07-01', features: { inventory: false, integrateInventory: false } });
  const L = t.ids.ledgers;
  t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -rs(100_000), id: L.SALES });
  t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: rs(60_000), id: L.PURCHASE });
  const s = summaryForCtx(t.ctx, { asOf: TODAY, from: '2026-04-01', to: TODAY });
  // Period / YTD contain 1-Jul: 1,00,000 opening; MTD / today do not.
  assert.equal(s.sales.period, rs(100_000));
  assert.equal(s.sales.ytd, rs(100_000));
  assert.equal(s.sales.mtd, 0);
  assert.equal(s.purchases.period, rs(60_000));
  // GP = 1,00,000 − 60,000 = 40,000 = the P&L.
  const pl = profitLoss(loadReportEnv(t.db, t.today), { from: '2026-04-01', to: TODAY });
  assert.equal(s.sales.period, pl.figures.sales);
  assert.equal(s.grossProfit?.amount, rs(40_000));
  assert.equal(s.grossProfit?.amount, pl.figures.grossProfit);
  // The trend puts them in July 2026 (the month of the books beginning), so Σ trend = YTD.
  assert.deepEqual(s.trend.find((m) => m.month === '2026-07'), { month: '2026-07', from: '2026-07-01', to: '2026-07-31', sales: rs(100_000), purchases: rs(60_000) });
  assert.equal(s.trend.reduce((a, m) => a + m.sales, 0), s.sales.ytd);
  // A period after the books beginning does not repeat them.
  const later = summaryForCtx(t.ctx, { asOf: TODAY, from: '2026-08-01', to: TODAY });
  assert.equal(later.sales.period, 0);
  t.close();
});

test('compliance tie-out: counts equal the e-Invoice / e-Way Bill screens, incl. vouchers without a stored GST nature', () => {
  const b = buildDashboardBooks({ features: { einvoice: true, ewayBill: true } });
  // Big B2B sale: rice 1,000 @ 60 = 60,000 + 5% = 63,000 (needs an IRN and an e-way bill). A second big
  // B2B sale, mixer 300 @ 200 = 60,000 + 18% = 70,800, is turned into a legacy row without a stored nature.
  save(b, { voucherTypeId: b.vt.sales, date: TODAY, mode: 'item_invoice', partyLedgerId: b.L.metro, items: [{ itemId: b.I.rice, qty: 1_000, rate: 60 }] });
  const legacy = save(b, { voucherTypeId: b.vt.sales, date: '2026-10-07', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.I.mixer, qty: 300, rate: 200 }] });
  // A legacy import: no stored nature (gst/docs.ts derives B2B); an unknown stored value is ignored too.
  b.t.db.run('UPDATE vouchers SET gst_nature = NULL WHERE id = :id', { id: legacy.id });
  b.t.db.run("UPDATE vouchers SET gst_nature = 'bogus' WHERE id = :id", { id: b.v.S3.id });
  const s = summaryForCtx(b.t.ctx, INPUT);
  const company = loadCompany(b.t.db);
  const ei = pendingEinvoices(b.t.db, company, s.compliance.from, s.compliance.to, b.t.today);
  const ew = pendingEwayBills(b.t.db, company, s.compliance.from, s.compliance.to, b.t.today);
  // S1, S2, S3 (derived), S4, CN, big, legacy (derived) = 7; e-way: big 63,000 and legacy 70,800 (> 50,000).
  assert.equal(ei.rows.length, 7);
  assert.equal(s.compliance.einvoicePending, ei.rows.length);
  assert.equal(ew.rows.length, 2);
  assert.equal(s.compliance.ewayPending, ew.rows.length);
  // A sale stored with an inward nature is still a sale (outward) for the GST engine.
  b.t.db.run("UPDATE vouchers SET gst_nature = 'inward_b2b' WHERE id = :id", { id: legacy.id });
  const s2 = summaryForCtx(b.t.ctx, INPUT);
  assert.equal(s2.compliance.einvoicePending, pendingEinvoices(b.t.db, company, INPUT.from, TODAY, b.t.today).rows.length);
  assert.equal(s2.compliance.ewayPending, pendingEwayBills(b.t.db, company, INPUT.from, TODAY, b.t.today).rows.length);
  assert.equal(s2.compliance.ewayPending, 2);
  b.t.close();
});

test('top customers (cash/bank parties excluded) and top items for the period', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  // blr 2,500 (52.08% of 4,800) · metro 1,200 (25%) · acme 1,000 + 300 − 200 = 1,100 (22.92%, 2 invoices)
  assert.deepEqual(
    s.topCustomers.map((c) => [c.name, c.amount, c.invoiceCount, c.sharePercent]),
    [
      ['Bangalore Retail', rs(2_500), 1, 52.08],
      ['Metro Mart', rs(1_200), 1, 25],
      ['Acme Traders', rs(1_100), 2, 22.92],
    ],
  );
  // mixer: S1 5 × 200 + S2 10 × 250 + S4 1 × 300 = 3,800 (16 Nos) · rice: S3 20 × 60 = 1,200 (20 Nos)
  assert.deepEqual(
    s.topItems.map((i) => [i.name, i.qty, i.unit, i.amount, i.sharePercent]),
    [
      ['Mixer Grinder', 16, 'Nos', rs(3_800), 79.17],
      ['Rice Bag', 20, 'Nos', rs(1_200), 25],
    ],
  );
  // Last year's period (cash sales only): no customer.
  const ly = summaryForCtx(b.t.ctx, { asOf: TODAY, from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(ly.topCustomers, []);
  assert.deepEqual(ly.topItems.map((i) => [i.name, i.amount]), [['Rice Bag', rs(600)], ['Mixer Grinder', rs(400)]]);
  b.t.close();
});

test('top items: a debit note to a customer (price revision) adds value, not quantity; a purchase return is not a sale', () => {
  const b = buildDashboardBooks();
  const { vt, L, I } = b;
  // Upward revision of ₹50 a unit on 2 mixers (value ₹100); a purchase return of 1 rice bag to the supplier.
  save(b, { voucherTypeId: vt.debit_note, date: '2026-09-15', mode: 'item_invoice', partyLedgerId: L.acme, items: [{ itemId: I.mixer, qty: 2, rate: 50 }] });
  save(b, { voucherTypeId: vt.debit_note, date: '2026-09-16', mode: 'item_invoice', partyLedgerId: L.supplier, items: [{ itemId: I.rice, qty: 1, rate: 50 }] });
  const s = summaryForCtx(b.t.ctx, INPUT);
  // mixer 3,800 + 100 = 3,900, still 16 Nos · rice unchanged 1,200 (20 Nos)
  assert.deepEqual(
    s.topItems.map((i) => [i.name, i.qty, i.amount]),
    [
      ['Mixer Grinder', 16, rs(3_900)],
      ['Rice Bag', 20, rs(1_200)],
    ],
  );
  b.t.close();
});

test('12-month trend ends with the month of the period end', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  assert.equal(s.trend.length, 12);
  assert.equal(s.trend[0].month, '2025-11');
  assert.deepEqual(s.trend[11], { month: '2026-10', from: '2026-10-01', to: '2026-10-31', sales: rs(1_300), purchases: rs(3_000) });
  const nonZero = s.trend.filter((m) => m.sales !== 0 || m.purchases !== 0).map((m) => [m.month, m.sales, m.purchases]);
  assert.deepEqual(nonZero, [
    ['2026-04', rs(1_000), rs(5_000)],
    ['2026-08', 0, rs(750)],
    ['2026-09', rs(2_500), 0],
    ['2026-10', rs(1_300), rs(3_000)],
  ]);
  // Σ trend over Apr–Oct = the YTD flows.
  const ytd = s.trend.filter((m) => m.month >= '2026-04');
  assert.equal(ytd.reduce((t, m) => t + m.sales, 0), s.sales.ytd);
  assert.equal(ytd.reduce((t, m) => t + m.purchases, 0), s.purchases.ytd);
  b.t.close();
});

test('low stock: items below their reorder level, least cover first', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  // tumbler 3 of 10 (cover 30%, short 7) · mixer 50 − 2 − 5 + 5 − 10 + 20 − 1 = 57 of 60 (short 3) · rice 220 ≥ 50
  assert.deepEqual(s.lowStock, {
    count: 2,
    items: [
      { itemId: b.I.tumbler, name: 'Steel Tumbler', unit: 'Nos', onHand: 3, reorderLevel: 10, shortfall: 7 },
      { itemId: b.I.mixer, name: 'Mixer Grinder', unit: 'Nos', onHand: 57, reorderLevel: 60, shortfall: 3 },
    ],
  });
  b.t.close();
});

test('recent vouchers (newest entered first) and upcoming post-dated cheques', () => {
  const b = buildDashboardBooks();
  const s = summaryForCtx(b.t.ctx, INPUT);
  assert.deepEqual(
    s.recentVouchers.map((r) => r.id),
    ['PD2', 'PD1', 'OPT', 'S4', 'CN', 'P2', 'S3', 'RNT'].map((k) => b.v[k].id),
  );
  const opt = s.recentVouchers[2];
  assert.equal(opt.isOptional, true);
  assert.equal(s.recentVouchers[0].isPostDated, true);
  // PD1 receipt 444 in, PD2 payment 2,250 out, earliest first.
  assert.equal(s.postDated.count, 2);
  assert.equal(s.postDated.inflow, rs(444));
  assert.equal(s.postDated.outflow, rs(2_250));
  assert.deepEqual(
    s.postDated.rows.map((r) => [r.id, r.date, r.direction, r.amount, r.bankName, r.instrumentNo, r.partyName]),
    [
      [b.v.PD1.id, '2026-10-20', 'in', rs(444), 'HDFC Bank', '123456', 'Acme Traders'],
      [b.v.PD2.id, '2026-10-25', 'out', rs(2_250), 'HDFC Bank', '654321', 'Supreme Suppliers'],
    ],
  );
  b.t.close();
});

test('a post-dated receipt counts once the working date reaches it', () => {
  const b = buildDashboardBooks();
  b.t.clock.setToday('2026-10-20');
  const s = summaryForCtx(b.t.ctx, { asOf: '2026-10-20', from: INPUT.from, to: '2026-10-20' });
  // PD1 settles S1's 444; the bank gets it: 29,875 + 444 = 30,319. PD2 (25-Oct) is still upcoming.
  assert.equal(s.cashBank.bankTotal, rs(30_319));
  assert.equal(s.receivables.total, rs(5_008 - 444));
  assert.equal(s.postDated.count, 1);
  assert.equal(s.postDated.rows[0].id, b.v.PD2.id);
  b.t.close();
});

test('backup age; never backed up → null', () => {
  const b = buildDashboardBooks();
  assert.deepEqual(summaryForCtx(b.t.ctx, INPUT).backup, { lastBackupAt: null, daysSince: null });
  // The fixed clock is 8-Oct-2026 10:00 IST (04:30Z): a backup at 28-Sep 04:30Z is exactly 10 days old.
  b.t.db.run(
    `INSERT INTO backup_history (created_at, file_name, folder, size_bytes, encrypted, kind, payload_sha256)
     VALUES ('2026-09-28T04:30:00.000Z', 'x.bahibak', '/tmp', 1, 0, 'manual', 'abc')`,
  );
  assert.deepEqual(summaryForCtx(b.t.ctx, INPUT).backup, { lastBackupAt: '2026-09-28T04:30:00.000Z', daysSince: 10 });
  b.t.close();
});

test('permissions: gross profit needs reports.financial; GST and e-invoice counts need gst.view', () => {
  const b = buildDashboardBooks({ features: { einvoice: true } });
  const viewer = b.t.ctxAs({ permissions: ['reports.view'] });
  const s = summaryForCtx(viewer, INPUT);
  assert.equal(s.grossProfit, null);
  assert.equal(s.gst, null);
  assert.equal(s.compliance.einvoicePending, null);
  assert.equal(s.sales.ytd, rs(4_800)); // everything else is there
  b.t.close();
});

test('compliance: pending e-invoices and e-way bills since the start of the financial year', () => {
  const b = buildDashboardBooks({ features: { einvoice: true, ewayBill: true } });
  // A large sale: rice 1,000 @ 60 = 60,000 + 5% 3,000 = 63,000 > ₹50,000 → needs an e-way bill.
  const big = save(b, { voucherTypeId: b.vt.sales, date: TODAY, mode: 'item_invoice', partyLedgerId: b.L.metro, items: [{ itemId: b.I.rice, qty: 1_000, rate: 60 }] });
  let s = summaryForCtx(b.t.ctx, INPUT);
  // B2B outward documents this year without an IRN: S1, S2, S3, S4, CN, big (X1 cancelled, OPT optional).
  assert.equal(s.compliance.einvoicePending, 6);
  assert.equal(s.compliance.ewayPending, 1);
  assert.deepEqual([s.compliance.from, s.compliance.to], ['2026-04-01', TODAY]);
  b.t.db.run("UPDATE vouchers SET irn = 'IRN1', irn_status = 'generated', eway_bill_no = '123456789012' WHERE id = :id", { id: big.id });
  s = summaryForCtx(b.t.ctx, INPUT);
  assert.equal(s.compliance.einvoicePending, 5);
  assert.equal(s.compliance.ewayPending, 0);
  b.t.close();
});

test('empty company: zeros everywhere, 12 empty months, no vouchers', () => {
  const t = createTestCompany({ today: TODAY });
  const s = summaryForCtx(t.ctx, INPUT);
  assert.equal(s.hasVouchers, false);
  assert.equal(s.sales.ytd, 0);
  assert.equal(s.receivables.total, 0);
  assert.equal(s.receivables.ageing.length, 6);
  assert.equal(s.trend.length, 12);
  assert.ok(s.trend.every((m) => m.sales === 0 && m.purchases === 0));
  assert.deepEqual(s.topCustomers, []);
  assert.deepEqual(s.recentVouchers, []);
  assert.deepEqual(s.postDated, { count: 0, inflow: 0, outflow: 0, rows: [] });
  assert.equal(s.grossProfit?.marginPercent, null);
  assert.equal(s.gst?.netPayable, 0);
  t.close();
});

test('inventory off: no top items, no low stock', () => {
  const t = createTestCompany({ today: TODAY, features: { inventory: false, integrateInventory: false } });
  const s = summaryForCtx(t.ctx, INPUT);
  assert.equal(s.features.inventory, false);
  assert.deepEqual(s.topItems, []);
  assert.deepEqual(s.lowStock, { count: 0, items: [] });
  assert.equal(s.grossProfit?.method, 'purchases');
  t.close();
});

test('memo: identical requests reuse the result until anything in the books changes', () => {
  const b = buildDashboardBooks();
  const deps = { db: b.t.db, today: b.t.today, now: b.t.clock.now(), session: b.t.ctx.session };
  const first = dashboardSummary(deps, INPUT);
  assert.equal(first.cached, false);
  const again = dashboardSummary(deps, INPUT);
  assert.equal(again.cached, true);
  assert.equal(again.sales.ytd, first.sales.ytd);
  // A new sale invalidates: S4-like 1 mixer @ 300 → YTD 4,800 + 300.
  save(b, { voucherTypeId: b.vt.sales, date: TODAY, mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.I.mixer, qty: 1, rate: 300 }] });
  const after = dashboardSummary(deps, INPUT);
  assert.equal(after.cached, false);
  assert.equal(after.sales.ytd, rs(5_100));
  // A different working date is a different request.
  assert.equal(dashboardSummary({ ...deps, today: '2026-10-09' }, INPUT).cached, false);
  // memo: false always recomputes.
  assert.equal(dashboardSummary(deps, INPUT, { memo: false }).cached, false);
  b.t.close();
});

test('memo: nothing is cached or reused while a transaction is open (uncommitted data may roll back)', () => {
  const b = buildDashboardBooks();
  const deps = { db: b.t.db, today: b.t.today, now: b.t.clock.now(), session: b.t.ctx.session };
  const committed = dashboardSummary(deps, INPUT);
  assert.equal(dashboardSummary(deps, INPUT).cached, true);
  let inside = 0;
  assert.throws(() =>
    b.t.db.transaction(() => {
      // S4-like 1 mixer @ 300 → YTD 4,800 + 300, visible inside the transaction only.
      save(b, { voucherTypeId: b.vt.sales, date: TODAY, mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.I.mixer, qty: 1, rate: 300 }] });
      const s = dashboardSummary(deps, INPUT);
      assert.equal(s.cached, false);
      assert.equal(dashboardSummary(deps, INPUT).cached, false, 'never reused inside the transaction');
      inside = s.sales.ytd;
      throw new Error('roll back');
    }),
  );
  assert.equal(inside, rs(5_100));
  const after = dashboardSummary(deps, INPUT);
  assert.equal(after.cached, false, 'the rolled-back write invalidated the earlier result');
  assert.equal(after.sales.ytd, committed.sales.ytd, 'the rolled-back sale was never remembered');
  b.t.close();
});

test('ranges: last year keeps month ends and maps 29-Feb; YTD starts at the books beginning in the first year', () => {
  const r = dashboardRanges({ asOf: '2028-02-29', from: '2027-04-01', to: '2028-02-29' }, 4, '2020-04-01');
  assert.deepEqual(r.lastYear.today, { from: '2027-02-28', to: '2027-02-28' });
  assert.deepEqual(r.lastYear.mtd, { from: '2027-02-01', to: '2027-02-28' });
  assert.deepEqual(r.ytd, { from: '2027-04-01', to: '2028-02-29' });
  const first = dashboardRanges({ asOf: '2026-10-08', from: '2026-07-01', to: '2026-10-08' }, 4, '2026-07-01');
  assert.deepEqual(first.ytd, { from: '2026-07-01', to: '2026-10-08' });
});
