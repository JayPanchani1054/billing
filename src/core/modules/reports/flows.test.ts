import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cashFlow, fundsFlow } from './flows.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';

test('cash flow: April inflow 1,02,00,000 / outflow 75,00,000; the contra is not a flow', () => {
  const b = makeBooks();
  const cf = cashFlow(b.env(), APRIL);
  // In: R1 bank 1,00,00,000 + R2 cash 2,00,000 · Out: P2 cash 25,00,000 + P3 bank 50,00,000 · C1 nets to 0
  assert.deepEqual(cf.totals, { inflow: 10_200_000, outflow: 7_500_000, net: 2_700_000 });
  assert.equal(cf.opening, 25_000_000);
  assert.equal(cf.closing, EXPECTED.cash + EXPECTED.bank);
  assert.equal(cf.opening + cf.totals.net, cf.closing);
});

test('cash flow: group-wise breakup by counter ledger group; Σ group net = net flow', () => {
  const b = makeBooks();
  const cf = cashFlow(b.env(), APRIL);
  const byName = Object.fromEntries(cf.groups.map((g) => [g.groupName, [g.inflow, g.outflow]]));
  assert.deepEqual(byName, {
    'Sundry Creditors': [0, 5_000_000],
    'Sundry Debtors': [10_000_000, 0],
    'Indirect Incomes': [200_000, 0],
    'Indirect Expenses': [0, 2_500_000],
  });
  assert.equal(
    cf.groups.reduce((s, g) => s + g.net, 0),
    cf.totals.net,
  );
});

test('cash flow: month rows over two months', () => {
  const b = makeBooks({ today: '2026-05-31' });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.receipt, date: '2026-05-12', mode: 'ledger', ledgers: [{ ledgerId: b.L.cash, amount: 4_160_000 }, { ledgerId: b.L.acme, amount: -4_160_000 }] });
  const cf = cashFlow(b.env(), { from: '2026-04-01', to: '2026-05-31' });
  assert.deepEqual(
    cf.months.map((m) => [m.month, m.inflow, m.outflow, m.net]),
    [
      ['2026-04', 10_200_000, 7_500_000, 2_700_000],
      ['2026-05', 4_160_000, 0, 4_160_000],
    ],
  );
  assert.equal(cf.closing, cf.opening + cf.totals.net);
});

test('funds flow: net profit and depreciation are sources; working capital rises by the same amount', () => {
  const b = makeBooks();
  const ff = fundsFlow(b.env(), APRIL);
  assert.deepEqual(
    ff.sources.map((s) => [s.label, s.amount]),
    [
      ['Net Profit', EXPECTED.netProfit],
      ['Fixed Assets', 500_000],
    ],
  );
  assert.deepEqual(ff.applications, []);
  // WC: (50,00,000 + 2,00,00,000 + stock 1,00,00,000) − 60,00,000 = 2,90,00,000 → 3,93,26,667 − 91,60,000 = 3,01,66,667
  assert.deepEqual(ff.workingCapital, { opening: 29_000_000, closing: 30_166_667, change: 1_166_667 });
  assert.equal(ff.difference, 0);
  const stock = ff.workingCapitalRows.find((r) => r.label === 'Stock-in-Hand');
  assert.deepEqual([stock?.opening, stock?.closing, stock?.change], [10_000_000, 7_466_667, -2_533_333]);
  const creditors = ff.workingCapitalRows.find((r) => r.label === 'Sundry Creditors');
  // creditors up 20,80,000 → working capital down
  assert.equal(creditors?.change, -2_080_000);
});

test('funds flow: a loan taken is a source, a fixed asset bought is an application', () => {
  const b = makeBooks();
  const loan = b.t.addLedger({ name: 'Term Loan', group: 'SECURED_LOANS' });
  const computer = b.t.addLedger({ name: 'Computers', group: 'FIXED_ASSETS' });
  const vt = b.t.ids.voucherTypes;
  b.post({ voucherTypeId: vt.receipt, date: '2026-04-27', mode: 'ledger', ledgers: [{ ledgerId: b.L.bank, amount: 50_000_000 }, { ledgerId: loan, amount: -50_000_000 }] });
  b.post({ voucherTypeId: vt.payment, date: '2026-04-27', mode: 'ledger', ledgers: [{ ledgerId: computer, amount: 10_000_000 }, { ledgerId: b.L.bank, amount: -10_000_000 }] });
  const ff = fundsFlow(b.env(), APRIL);
  assert.equal(ff.sources.find((s) => s.label === 'Loans (Liability)')?.amount, 50_000_000);
  // Fixed assets: +1,00,00,000 computer − 5,00,000 depreciation = +95,00,000 → application
  assert.equal(ff.applications.find((s) => s.label === 'Fixed Assets')?.amount, 9_500_000);
  assert.equal(ff.totalSources - ff.totalApplications, ff.workingCapital.change);
  assert.equal(ff.difference, 0);
});
