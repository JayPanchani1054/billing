import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceSheet, profitLoss } from './financials.ts';
import { cashFlow, fundsFlow } from './flows.ts';
import { groupVouchers, ledgerReport } from './ledger.ts';
import { ratiosReport } from './ratios.ts';
import { bulkTrade, bulkVouchers, makeBooks } from './testkit.ts';
import { groupSummary, trialBalance } from './trialBalance.ts';

const YEAR = { from: '2026-04-01', to: '2027-03-31' };

/** Run `f` and return [result, milliseconds]. */
function timed<T>(f: () => T): [T, number] {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
}

test('performance: 20,000 vouchers — Trial Balance < 1 s, ledger and P&L/BS stay fast', () => {
  const b = makeBooks({ today: '2027-03-31', features: { integrateInventory: false } });
  // 200 extra ledgers spread over expense / income / debtor groups.
  const extra: number[] = [];
  const groups = ['INDIRECT_EXPENSES', 'INDIRECT_INCOMES', 'SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'] as const;
  for (let i = 0; i < 200; i++) extra.push(b.t.addLedger({ name: `Perf Ledger ${i}`, group: groups[i % groups.length] }));
  bulkVouchers(b.t, 20_000, { ledgers: [b.L.cash, b.L.bank, ...extra] });
  const env = b.env();

  const [tb, tbMs] = timed(() => trialBalance(env, { ...YEAR, mode: 'detailed' }));
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  assert.ok(tbMs < 1000, `Trial Balance took ${tbMs.toFixed(0)} ms`);

  const [led, ledMs] = timed(() => ledgerReport(env, { ...YEAR, ledgerId: b.L.cash }));
  assert.ok(led.count > 0);
  assert.equal(led.rows.at(-1)?.balance, led.closing);
  assert.ok(ledMs < 1000, `Ledger took ${ledMs.toFixed(0)} ms`);

  const [bs, finMs] = timed(() => {
    const out = balanceSheet(env, { asOf: YEAR.to });
    profitLoss(env, { ...YEAR, compareWith: 'previous_period' });
    return out;
  });
  assert.equal(bs.balanced, true);
  assert.ok(finMs < 2000, `P&L + BS took ${finMs.toFixed(0)} ms`);
});

test('performance: 2,000 ledgers, 20,000 item invoices, integrated inventory — every report well under budget', () => {
  const b = makeBooks({ today: '2027-03-31', skipVouchers: true });
  const t = b.t;
  const groups = ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS', 'INDIRECT_EXPENSES', 'INDIRECT_INCOMES'] as const;
  const parties: number[] = [];
  for (let i = 0; i < 2_000; i++) {
    const id = t.addLedger({ name: `Party ${i}`, group: groups[i % groups.length] });
    if (i % 4 < 2) parties.push(id);
  }
  const items = [b.widget];
  for (let i = 0; i < 50; i++) items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 1_000, openingRate: 100 + i }));
  bulkTrade(t, 20_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase });
  // A fresh environment per report, as each route call builds its own.
  const env = () => b.env();

  const [tb, tbMs] = timed(() => trialBalance(env(), { ...YEAR, mode: 'detailed' }));
  assert.equal(tb.balanced, true);
  assert.ok(tb.openingStock > 0);
  assert.ok(tbMs < 1000, `Trial Balance took ${tbMs.toFixed(0)} ms`);

  const budgets: Array<[string, () => unknown]> = [
    ['Balance Sheet with comparison', () => assert.equal(balanceSheet(env(), { asOf: YEAR.to, compareAsOf: '2026-09-30' }).balanced, true)],
    ['P&L with comparison', () => profitLoss(env(), { ...YEAR, compareWith: 'previous_period' })],
    ['Group Summary (Current Assets)', () => groupSummary(env(), { ...YEAR, groupId: t.ids.groups.CURRENT_ASSETS })],
    ['Ledger (10,000 sales)', () => assert.equal(ledgerReport(env(), { ...YEAR, ledgerId: b.L.sales }).count, 10_000)],
    ['Group Vouchers (Sundry Debtors, 500 ledgers)', () => groupVouchers(env(), { ...YEAR, groupId: t.ids.groups.SUNDRY_DEBTORS })],
    ['Cash Flow', () => cashFlow(env(), YEAR)],
    ['Funds Flow', () => assert.equal(fundsFlow(env(), YEAR).difference, 0)],
    ['Ratios', () => ratiosReport(env(), YEAR)],
  ];
  for (const [label, run] of budgets) {
    const [, ms] = timed(run);
    assert.ok(ms < 2000, `${label} took ${ms.toFixed(0)} ms`);
  }
});
