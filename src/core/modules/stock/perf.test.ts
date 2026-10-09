/**
 * Performance probe of the stock reports on 8,000 items and 60,000 item invoices over two years
 * (integrated inventory). Each report runs exactly one valuation replay — the deterministic part of
 * the regression test — and the time budgets are generous for loaded CI machines (targets on a
 * developer machine: profitability ≤ 1 s, item vouchers ≤ 200 ms).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStockValuation, stockReplayCount } from '../inventory/index.ts';
import { bulkTrade, makeBooks } from '../reports/testkit.ts';
import { stockAgeing } from './ageing.ts';
import { itemVouchers } from './itemVouchers.ts';
import { profitability } from './profitability.ts';
import { stockSummary } from './summary.ts';

test('performance: 8,000 items, 60,000 item invoices — one replay per stock report', () => {
  const b = makeBooks({ today: '2027-03-31', booksFrom: '2025-04-01', skipVouchers: true });
  const t = b.t;
  const parties: number[] = [];
  for (let i = 0; i < 500; i++) parties.push(t.addLedger({ name: `Party ${i}`, group: 'SUNDRY_DEBTORS' }));
  const items: number[] = [];
  for (let i = 0; i < 8_000; i++) {
    items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 100, openingRate: 100 + (i % 50), costingMethod: i % 3 === 0 ? 'fifo' : 'avg_cost' }));
  }
  bulkTrade(t, 30_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase, from: '2025-04-01', batch: 'a' });
  bulkTrade(t, 30_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase, from: '2026-04-01', batch: 'b' });
  const today = t.today;
  const FY = { from: '2026-04-01', to: '2027-03-31' };
  const run = <T>(f: () => T): { out: T; ms: number; replays: number } => {
    const r0 = stockReplayCount();
    const t0 = performance.now();
    const out = f();
    return { out, ms: performance.now() - t0, replays: stockReplayCount() - r0 };
  };

  const prof = run(() => profitability(t.db, today, FY));
  assert.equal(prof.replays, 1, 'profitability: one replay (no second "proof" run)');
  assert.ok(prof.ms < 3_000, `profitability took ${prof.ms.toFixed(0)} ms`);
  // Cost of sales = what the valuation's outward values say for the sales of the period.
  const val = computeStockValuation(t.db, { ...FY, today });
  assert.equal(prof.out.totals.cost, val.totals.outwardValue, 'every outward of this data is a sale');

  const item = items[123];
  const iv = run(() => itemVouchers(t.db, today, { ...FY, itemId: item }));
  assert.equal(iv.replays, 1, 'item vouchers: one replay for the valuation and the line costs');
  assert.ok(iv.ms < 600, `item vouchers took ${iv.ms.toFixed(0)} ms`);
  const row = val.rows.find((r) => r.itemId === item);
  assert.deepEqual(iv.out.closing.value, row?.closing.value);
  assert.equal(iv.out.totals.outwardValue, row?.outward.value);

  const age = run(() => stockAgeing(t.db, today, { asOf: FY.to }));
  assert.equal(age.replays, 1, 'ageing: valuation and FIFO inward costs from one replay');
  assert.ok(age.ms < 3_000, `ageing took ${age.ms.toFixed(0)} ms`);
  assert.equal(age.out.totals.value, val.totals.closingValue);

  const sum = run(() => stockSummary(t.db, today, FY));
  assert.ok(sum.replays <= 1);
  assert.ok(sum.ms < 3_000, `stock summary took ${sum.ms.toFixed(0)} ms`);
  console.log(
    `stock reports on 8,000 items / 60,000 invoices: profitability ${prof.ms.toFixed(0)} ms · item vouchers ${iv.ms.toFixed(0)} ms · ageing ${age.ms.toFixed(0)} ms · summary ${sum.ms.toFixed(0)} ms`,
  );
});
