/**
 * Review tie-outs (Chartered-Accountant lens): Group Summary on the P&L basis, funds flow of a company
 * that started its books mid-year, a second-year Balance Sheet with a transfer out of the Profit &
 * Loss A/c and a prior-year comparative, and Trial Balances across the year end. Every figure is
 * worked out by hand from the April books in testkit.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceSheet, profitLoss } from './financials.ts';
import { fundsFlow } from './flows.ts';
import { ratiosReport } from './ratios.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';
import { groupSummary, trialBalance } from './trialBalance.ts';

const MAY = { from: '2026-05-01', to: '2026-05-31' } as const;

/** April books + a May sale of 10 Widget @ ₹2,000 (taxable ₹20,000 = 20,00,000 p) to Acme. */
function aprilAndMay() {
  const b = makeBooks({ today: '2026-05-31' });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.sales, date: '2026-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  return b;
}

test('Group Summary drilled from a mid-year P&L (basis profitLoss) agrees with the P&L line', () => {
  const b = aprilAndMay();
  const env = b.env();
  const salesGroup = b.t.ids.groups.SALES_ACCOUNTS;
  const pl = profitLoss(env, MAY);
  assert.equal(pl.figures.sales, 2_000_000);
  // Trial-Balance basis: Sales starts at the year start → opening Cr 1,20,00,000 (April), closing Cr 1,40,00,000.
  const tbBasis = groupSummary(env, { groupId: salesGroup, ...MAY });
  assert.equal(tbBasis.basis, 'trialBalance');
  assert.deepEqual(tbBasis.totals, { opening: -12_000_000, debit: 0, credit: 2_000_000, closing: -14_000_000 });
  // P&L basis: May only → opening 0, closing Cr 20,00,000 = the P&L's Sales Accounts line.
  const plBasis = groupSummary(env, { groupId: salesGroup, ...MAY, basis: 'profitLoss' });
  assert.equal(plBasis.basis, 'profitLoss');
  assert.deepEqual(plBasis.totals, { opening: 0, debit: 0, credit: 2_000_000, closing: -2_000_000 });
  const salesLine = pl.trading.right.find((l) => l.key === `g:${salesGroup}`);
  assert.equal(salesLine?.amount, -plBasis.totals.closing);
  // A real (asset) group ignores the P&L basis.
  const ca = groupSummary(env, { groupId: b.t.ids.groups.CURRENT_ASSETS, ...MAY, basis: 'profitLoss' });
  assert.equal(ca.basis, 'trialBalance');
});

test('Group Summary on the P&L basis includes mid-year opening balances in the first period', () => {
  const b = makeBooks({ booksFrom: '2026-10-01', today: '2026-10-31', skipVouchers: true });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 1_000_000, id: b.L.rent });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 9_000_000, id: b.L.cash });
  const env = b.env();
  const oct = { from: '2026-10-01', to: '2026-10-31' };
  const gs = groupSummary(env, { groupId: b.t.ids.groups.SALES_ACCOUNTS, ...oct, basis: 'profitLoss' });
  // Year-to-date sales brought in as an opening balance: Cr 50,00,000 = P&L sales.
  assert.equal(gs.totals.closing, -5_000_000);
  assert.equal(profitLoss(env, oct).figures.sales, 5_000_000);
});

test('funds flow of a company that started mid-year: opening income/expense balances are not funds of the period', () => {
  const b = makeBooks({ booksFrom: '2026-10-01', today: '2026-10-31', skipVouchers: true });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 1_000_000, id: b.L.rent });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 9_000_000, id: b.L.cash });
  // 15-Oct: interest ₹10,000 received in cash.
  b.post({ voucherTypeId: b.t.ids.voucherTypes.receipt, date: '2026-10-15', mode: 'ledger', ledgers: [{ ledgerId: b.L.cash, amount: 1_000_000 }, { ledgerId: b.L.interest, amount: -1_000_000 }] });
  const env = b.env();
  const oct = { from: '2026-10-01', to: '2026-10-31' };
  // The P&L of the first period includes the openings: 50,00,000 − 10,00,000 + 10,00,000 = 50,00,000.
  assert.equal(profitLoss(env, oct).figures.netProfit, 5_000_000);
  const ff = fundsFlow(env, oct);
  // Funds from operations = only the October interest (stock unchanged at 1,00,00,000).
  assert.deepEqual(ff.sources.map((s) => [s.label, s.amount]), [['Net Profit', 1_000_000]]);
  assert.deepEqual(ff.applications, []);
  // WC: cash 90,00,000 + bank 2,00,00,000 + stock 1,00,00,000 − creditors 60,00,000 = 3,30,00,000 → +10,00,000
  assert.deepEqual(ff.workingCapital, { opening: 33_000_000, closing: 34_000_000, change: 1_000_000 });
  assert.equal(ff.difference, 0);
});

test('funds flow rows: ledgers placed directly under Current Assets carry their ledger id', () => {
  const b = makeBooks();
  const deposit = b.t.addLedger({ name: 'Rent Deposit', group: 'CURRENT_ASSETS', openingBalance: 0 });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.payment, date: '2026-04-21', mode: 'ledger', ledgers: [{ ledgerId: deposit, amount: 300_000 }, { ledgerId: b.L.cash, amount: -300_000 }] });
  const ff = fundsFlow(b.env(), APRIL);
  const row = ff.workingCapitalRows.find((r) => r.key === `l:${deposit}`);
  assert.deepEqual([row?.ledgerId, row?.groupId, row?.closing, row?.change], [deposit, null, 300_000, 300_000]);
  assert.equal(ff.difference, 0);
});

test('second year: P&L A/c = last year profit − amount transferred to capital + this year profit; prior-year comparative balances', () => {
  const b = makeBooks({ today: '2027-06-30' });
  const vt = b.t.ids.voucherTypes;
  // 5-Apr-2027: ₹3,000 of last year's profit transferred to the owner's capital.
  b.post({ voucherTypeId: vt.journal, date: '2027-04-05', mode: 'ledger', ledgers: [{ ledgerId: b.L.pl, amount: 300_000 }, { ledgerId: b.L.capital, amount: -300_000 }] });
  // 10-May-2027: 10 Widget @ ₹2,000 = 20,00,000 p; cost 10 × 1,60,00,000 / 150 = 10,66,667 p → profit 9,33,333 p.
  b.post({ voucherTypeId: vt.sales, date: '2027-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  const env = b.env();
  const bs = balanceSheet(env, { asOf: '2027-06-30', compareAsOf: '2026-06-30' });
  assert.equal(bs.balanced, true);
  assert.equal(bs.compareAssetsTotal, bs.compareLiabilitiesTotal);
  // 6,66,667 − 3,00,000 + 9,33,333 = 13,00,000
  assert.deepEqual(bs.profitLoss, { openingBalance: 366_667, currentPeriod: 933_333, total: 1_300_000 });
  const pl = bs.liabilities.filter((l) => l.key === 'pl' || l.parentKey === 'pl').map((l) => [l.name, l.amount, l.compare]);
  assert.deepEqual(pl, [
    ['Profit & Loss A/c', 1_300_000, 666_667],
    ['Opening Balance', 666_667, 0],
    ['Transferred during the year', -300_000, 0],
    ['Current Period', 933_333, 666_667],
  ]);
  // Capital Account: 3,90,00,000 + 3,000 transferred = 3,93,00,000 (the P&L A/c ledger is not inside it).
  const capital = bs.liabilities.find((l) => l.key === `g:${b.t.ids.groups.CAPITAL_ACCOUNT}`);
  assert.deepEqual([capital?.amount, capital?.compare], [39_300_000, 39_000_000]);
  // Debt/Equity and ROI use Capital + P&L A/c = 3,93,00,000 + 13,00,000 = 4,06,00,000; ROI = 9,33,333 ÷ 4,06,00,000 = 2.30 %.
  const r = ratiosReport(env, { from: '2027-04-01', to: '2027-06-30' });
  assert.equal(r.ratios.find((x) => x.key === 'roiPct')?.value, 2.3);
  assert.equal(r.ratios.find((x) => x.key === 'debtEquity')?.value, 0);
});

test('Trial Balance across and after the year end: balanced, opening stock at the year start', () => {
  const b = makeBooks({ today: '2027-06-30' });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.sales, date: '2027-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  const env = b.env();
  const mid = trialBalance(env, { from: '2027-05-01', to: '2027-06-30', mode: 'detailed' });
  assert.equal(mid.yearStart, '2027-04-01');
  assert.equal(mid.openingStock, EXPECTED.closingStock);
  assert.equal(mid.balanced, true);
  // The P&L A/c ledger carries last year's profit as its opening: Cr 6,66,667.
  assert.equal(mid.rows.find((r) => r.key === `l:${b.L.pl}`)?.opening, -EXPECTED.netProfit);
  const span = trialBalance(env, { from: '2026-04-01', to: '2027-06-30', mode: 'ledgers' });
  assert.equal(span.balanced, true);
  assert.equal(span.yearStart, '2026-04-01');
});

test('Group Summary of Current Assets equals the Balance Sheet line (closing stock included)', () => {
  const b = makeBooks();
  const env = b.env();
  const ca = b.t.ids.groups.CURRENT_ASSETS;
  const gs = groupSummary(env, { groupId: ca, ...APRIL });
  const bs = balanceSheet(env, { asOf: APRIL.to });
  // cash 37,00,000 + bank 2,40,00,000 + Acme 41,60,000 + stock 74,66,667 = 3,93,26,667
  // (input GST sits under Duties & Taxes, a current liability)
  assert.equal(gs.totals.closing, 39_326_667);
  assert.equal(bs.assets.find((l) => l.key === `g:${ca}`)?.amount, gs.totals.closing);
});

test('Balance Sheet: comparing a date with itself is refused before any work', () => {
  const b = makeBooks({ skipVouchers: true });
  assert.throws(() => balanceSheet(b.env(), { asOf: APRIL.to, compareAsOf: APRIL.to }), (e: unknown) => (e as { code?: string }).code === 'VALIDATION');
});
