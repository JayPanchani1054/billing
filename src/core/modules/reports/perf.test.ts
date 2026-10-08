import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceSheet, profitLoss } from './financials.ts';
import { ledgerReport } from './ledger.ts';
import { bulkVouchers, makeBooks } from './testkit.ts';
import { trialBalance } from './trialBalance.ts';

test('performance: 20,000 vouchers — Trial Balance < 1 s, ledger and P&L/BS stay fast', () => {
  const b = makeBooks({ today: '2027-03-31', features: { integrateInventory: false } });
  // 200 extra ledgers spread over expense / income / debtor groups.
  const extra: number[] = [];
  const groups = ['INDIRECT_EXPENSES', 'INDIRECT_INCOMES', 'SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'] as const;
  for (let i = 0; i < 200; i++) extra.push(b.t.addLedger({ name: `Perf Ledger ${i}`, group: groups[i % groups.length] }));
  bulkVouchers(b.t, 20_000, { ledgers: [b.L.cash, b.L.bank, ...extra] });
  const env = b.env();
  const period = { from: '2026-04-01', to: '2027-03-31' };

  let t0 = performance.now();
  const tb = trialBalance(env, { ...period, mode: 'detailed' });
  const tbMs = performance.now() - t0;
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  assert.ok(tbMs < 1000, `Trial Balance took ${tbMs.toFixed(0)} ms`);

  t0 = performance.now();
  const led = ledgerReport(env, { ...period, ledgerId: b.L.cash });
  const ledMs = performance.now() - t0;
  assert.ok(led.count > 0);
  assert.equal(led.rows.at(-1)?.balance, led.closing);
  assert.ok(ledMs < 1000, `Ledger took ${ledMs.toFixed(0)} ms`);

  t0 = performance.now();
  const bs = balanceSheet(env, { asOf: period.to });
  profitLoss(env, { ...period, compareWith: 'previous_period' });
  const finMs = performance.now() - t0;
  assert.equal(bs.balanced, true);
  assert.ok(finMs < 2000, `P&L + BS took ${finMs.toFixed(0)} ms`);
});
