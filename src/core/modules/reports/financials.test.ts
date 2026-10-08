import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StatementLine } from '../../../shared/types/reports.ts';
import { balanceSheet, comparePeriod, minusYear, netProfitFor, profitLoss } from './financials.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';
import { trialBalance } from './trialBalance.ts';

const top = (lines: readonly StatementLine[]) => lines.filter((l) => l.level === 0).map((l) => [l.name, l.amount]);

test('P&L figures for April (hand-computed in testkit.ts)', () => {
  const b = makeBooks();
  const pl = profitLoss(b.env(), APRIL);
  assert.deepEqual(pl.figures, {
    openingStock: EXPECTED.openingStock,
    closingStock: EXPECTED.closingStock,
    sales: EXPECTED.sales,
    purchases: EXPECTED.purchases,
    directIncomes: 0,
    directExpenses: 0,
    indirectIncomes: EXPECTED.indirectIncomes,
    indirectExpenses: EXPECTED.indirectExpenses,
    grossProfit: EXPECTED.grossProfit,
    netProfit: EXPECTED.netProfit,
  });
});

test('P&L horizontal layout: trading and P&L blocks balance (Tally Expenses | Income)', () => {
  const b = makeBooks();
  const pl = profitLoss(b.env(), APRIL);
  // Trading: 1,00,00,000 + 60,00,000 + GP 34,66,667 = 1,94,66,667 = 1,20,00,000 + 74,66,667
  assert.deepEqual(top(pl.trading.left), [
    ['Opening Stock', 10_000_000],
    ['Purchase Accounts', 6_000_000],
    ['Gross Profit c/o', 3_466_667],
  ]);
  assert.deepEqual(top(pl.trading.right), [
    ['Sales Accounts', 12_000_000],
    ['Closing Stock', 7_466_667],
  ]);
  assert.equal(pl.trading.total, 19_466_667);
  // P&L: 30,00,000 + NP 6,66,667 = 36,66,667 = GP b/f 34,66,667 + 2,00,000
  assert.deepEqual(top(pl.profitLoss.left), [
    ['Indirect Expenses', 3_000_000],
    ['Net Profit', 666_667],
  ]);
  assert.deepEqual(top(pl.profitLoss.right), [
    ['Gross Profit b/f', 3_466_667],
    ['Indirect Incomes', 200_000],
  ]);
  assert.equal(pl.profitLoss.total, 3_666_667);
  const ie = pl.profitLoss.left.filter((l) => l.parentKey === `g:${b.t.ids.groups.INDIRECT_EXPENSES}`).map((l) => [l.name, l.amount]);
  assert.deepEqual(ie, [
    ['Depreciation', 500_000],
    ['Office Rent', 2_500_000],
  ]);
});

test('P&L ties to the Trial Balance: NP = −Σ income/expense closings + closing stock − opening stock', () => {
  const b = makeBooks();
  const env = b.env();
  const tb = trialBalance(env, { ...APRIL, mode: 'groups' });
  let nominal = 0;
  for (const r of tb.rows) {
    if (r.kind !== 'group' || r.level !== 0 || r.id === null) continue;
    const g = env.tree.byId.get(r.id);
    if (g?.nature === 'income' || g?.nature === 'expenses') nominal += r.closing;
  }
  const pl = profitLoss(env, APRIL);
  // −(60,00,000 + 30,00,000 − 1,20,00,000 − 2,00,000) + 74,66,667 − 1,00,00,000 = 6,66,667
  assert.equal(-nominal + pl.figures.closingStock - tb.openingStock, pl.figures.netProfit);
  assert.equal(pl.figures.netProfit, EXPECTED.netProfit);
});

test('Schedule III vertical P&L: total income − total expenses = profit before tax', () => {
  const b = makeBooks();
  const pl = profitLoss(b.env(), APRIL);
  const v = Object.fromEntries(pl.vertical.map((l) => [l.key, l.amount]));
  assert.equal(v.rev, 12_000_000);
  assert.equal(v.income, 12_200_000);
  // purchases 60,00,000 + change in inventories (1,00,00,000 − 74,66,667) + other 30,00,000
  assert.equal(v['exp.inventory'], 2_533_333);
  assert.equal(v.expTotal, 11_533_333);
  assert.equal(v.pbt, v.income - v.expTotal);
  assert.equal(v.pbt, EXPECTED.netProfit);
});

test('gross loss is carried to the P&L side and the Balance Sheet shows the loss on the assets side', () => {
  const b = makeBooks({ skipVouchers: true });
  const vt = b.t.ids.voucherTypes;
  b.post({ voucherTypeId: vt.purchase, date: '2026-04-05', mode: 'item_invoice', partyLedgerId: b.L.supreme, referenceNo: 'SUP-1', items: [{ itemId: b.widget, qty: 50, rate: 1200 }] });
  b.post({ voucherTypeId: vt.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 80, rate: 500 }] });
  const env = b.env();
  const pl = profitLoss(env, APRIL);
  // GP = 40,00,000 + 74,66,667 − 1,00,00,000 − 60,00,000 = −45,33,333
  assert.equal(pl.figures.grossProfit, -4_533_333);
  assert.equal(pl.trading.right.find((l) => l.key === 'gl:co')?.amount, 4_533_333);
  assert.equal(pl.profitLoss.left.find((l) => l.key === 'gl:bf')?.amount, 4_533_333);
  assert.equal(pl.profitLoss.right.find((l) => l.key === 'nl')?.amount, 4_533_333);
  assert.ok(!pl.trading.left.some((l) => l.key === 'gp:co'));
  const bs = balanceSheet(env, { asOf: APRIL.to });
  const plLine = bs.assets.find((l) => l.key === 'pl');
  assert.equal(plLine?.amount, 4_533_333);
  assert.equal(bs.balanced, true);
});

test('comparison with the previous period (whole months) and previous year', () => {
  assert.deepEqual(comparePeriod('2026-05-01', '2026-05-31', 'previous_period'), { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(comparePeriod('2026-07-01', '2026-09-30', 'previous_period'), { from: '2026-04-01', to: '2026-06-30' });
  // 10 days → the 10 days before
  assert.deepEqual(comparePeriod('2026-05-11', '2026-05-20', 'previous_period'), { from: '2026-05-01', to: '2026-05-10' });
  assert.deepEqual(comparePeriod('2026-04-01', '2027-03-31', 'previous_year'), { from: '2025-04-01', to: '2026-03-31' });
  // Leap-year month end: Feb 2028 → Feb 2027 (28th)
  assert.deepEqual(comparePeriod('2028-02-01', '2028-02-29', 'previous_year'), { from: '2027-02-01', to: '2027-02-28' });
  assert.equal(minusYear('2028-02-29'), '2027-02-28');
});

test('P&L compare columns: May against April', () => {
  const b = makeBooks({ today: '2026-05-31' });
  // May: sell 10 Widget @ ₹2,000 = 20,00,000; cost 10 × 74,66,667 / 70 = 10,66,666.7 → 10,66,667; closing 64,00,000
  b.post({ voucherTypeId: b.t.ids.voucherTypes.sales, date: '2026-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  const pl = profitLoss(b.env(), { from: '2026-05-01', to: '2026-05-31', compareWith: 'previous_period' });
  assert.deepEqual(pl.compare, APRIL);
  assert.equal(pl.figures.closingStock, 6_400_000);
  // GP = 20,00,000 + 64,00,000 − 74,66,667 = 9,33,333
  assert.equal(pl.figures.netProfit, 933_333);
  assert.equal(pl.compareFigures?.netProfit, EXPECTED.netProfit);
  const sales = pl.trading.right.find((l) => l.name === 'Sales Accounts');
  assert.deepEqual([sales?.amount, sales?.compare], [2_000_000, 12_000_000]);
  // Rent only in April → still shown in May with 0 and its comparative figure.
  const rent = pl.profitLoss.left.find((l) => l.id === b.L.rent);
  assert.deepEqual([rent?.amount, rent?.compare], [0, 2_500_000]);
  assert.equal(pl.trading.total, sumTop(pl.trading.right));
  assert.equal(pl.trading.compareTotal, 19_466_667);
});

function sumTop(lines: readonly StatementLine[]): number {
  return lines.filter((l) => l.level === 0).reduce((s, l) => s + l.amount, 0);
}

test('Balance Sheet balances on books posted through the vouchers service (₹4,88,266.67 each side)', () => {
  const b = makeBooks();
  const bs = balanceSheet(b.env(), { asOf: APRIL.to });
  assert.equal(bs.liabilitiesTotal, EXPECTED.bsTotal);
  assert.equal(bs.assetsTotal, EXPECTED.bsTotal);
  assert.equal(bs.balanced, true);
  assert.equal(bs.difference, 0);
  assert.deepEqual(top(bs.liabilities), [
    ['Capital Account', 39_000_000],
    ['Current Liabilities', 9_160_000],
    ['Profit & Loss A/c', 666_667],
  ]);
  assert.deepEqual(top(bs.assets), [
    ['Fixed Assets', 9_500_000],
    ['Current Assets', 39_326_667],
  ]);
  assert.deepEqual(bs.profitLoss, { openingBalance: 0, currentPeriod: EXPECTED.netProfit, total: EXPECTED.netProfit });
});

test('closing stock flows to the P&L and to Stock-in-Hand in the Balance Sheet', () => {
  const b = makeBooks();
  const env = b.env();
  const pl = profitLoss(env, APRIL);
  const bs = balanceSheet(env, { asOf: APRIL.to });
  const stockLine = bs.assets.find((l) => l.key === 'stock:closing');
  assert.equal(stockLine?.amount, pl.figures.closingStock);
  assert.equal(stockLine?.parentKey, `g:${b.t.ids.groups.STOCK_IN_HAND}`);
  assert.equal(bs.assets.find((l) => l.name === 'Stock-in-Hand')?.amount, EXPECTED.closingStock);
  assert.equal(bs.closingStock, EXPECTED.closingStock);
});

test('Balance Sheet in the second year: P&L A/c = last year profit (opening) + this year profit (current)', () => {
  const b = makeBooks({ today: '2027-05-31' });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.sales, date: '2027-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  const env = b.env();
  const bs = balanceSheet(env, { asOf: '2027-05-31' });
  assert.equal(bs.yearStart, '2027-04-01');
  assert.deepEqual(bs.profitLoss, { openingBalance: 666_667, currentPeriod: 933_333, total: 1_600_000 });
  assert.equal(bs.balanced, true);
  assert.equal(bs.profitLoss.currentPeriod, netProfitFor(env, '2027-04-01', '2027-05-31'));
  const parts = bs.liabilities.filter((l) => l.parentKey === 'pl').map((l) => [l.name, l.amount]);
  assert.deepEqual(parts, [
    ['Opening Balance', 666_667],
    ['Current Period', 933_333],
  ]);
});

test('Balance Sheet with a comparative date: both columns balance', () => {
  const b = makeBooks();
  const bs = balanceSheet(b.env(), { asOf: APRIL.to, compareAsOf: '2026-04-10' });
  assert.equal(bs.compareAsOf, '2026-04-10');
  assert.equal(bs.compareLiabilitiesTotal, bs.compareAssetsTotal);
  assert.equal(bs.liabilitiesTotal, bs.assetsTotal);
  // On 10-Apr: Acme owes 1,41,600 → 1,41,60,000 p
  const acme = bs.assets.find((l) => l.id === b.L.acme);
  assert.deepEqual([acme?.amount, acme?.compare], [EXPECTED.acme, 14_160_000]);
});

test('Balance Sheet before the books begin shows the opening position (balanced)', () => {
  const b = makeBooks();
  const bs = balanceSheet(b.env(), { asOf: '2026-03-31' });
  // capital 3,90,00,000 + supplier 60,00,000 = cash 50,00,000 + bank 2,00,00,000 + furniture 1,00,00,000 + stock 1,00,00,000
  assert.equal(bs.liabilitiesTotal, 45_000_000);
  assert.equal(bs.assetsTotal, 45_000_000);
});

test('books started mid-year: opening balances of income/expense ledgers count in the first P&L and the BS balances', () => {
  const b = makeBooks({ booksFrom: '2026-10-01', today: '2026-10-31', skipVouchers: true });
  // Year-to-date sales ₹50,000 Cr and rent ₹10,000 Dr brought in as openings; cash raised by ₹40,000 to keep openings equal.
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 1_000_000, id: b.L.rent });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 9_000_000, id: b.L.cash });
  const env = b.env();
  const pl = profitLoss(env, { from: '2026-10-01', to: '2026-10-31' });
  // 50,00,000 − 10,00,000 (stock unchanged)
  assert.equal(pl.figures.netProfit, 4_000_000);
  const bs = balanceSheet(env, { asOf: '2026-10-31' });
  assert.equal(bs.profitLoss.currentPeriod, 4_000_000);
  assert.equal(bs.balanced, true);
  assert.equal(bs.openingDifference, 0);
  // A later period no longer includes the openings.
  assert.equal(profitLoss(env, { from: '2026-10-02', to: '2026-10-31' }).figures.netProfit, 0);
});

test('Balance Sheet: opening difference sits on the side that balances it', () => {
  const b = makeBooks({ capitalOpening: -38_000_000 });
  const bs = balanceSheet(b.env(), { asOf: APRIL.to });
  const diff = bs.liabilities.find((l) => l.kind === 'difference');
  assert.equal(diff?.amount, 1_000_000);
  assert.equal(bs.openingDifference, -1_000_000);
  assert.equal(bs.balanced, true);
});
