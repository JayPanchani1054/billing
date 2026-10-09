/**
 * Performance probe: 50,000 vouchers (25,000 sales, 10,000 purchases, 10,000 receipts, 5,000 payments),
 * 1,000 customers, 200 suppliers, 50 items, integrated inventory, bill-wise. Budgets are generous for CI
 * machines; measured times are printed (see README §Performance for the breakdown).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { stockReplayCount } from '../inventory/index.ts';
import { dashboardSummary } from './summary.ts';
import { bulkBusiness } from './testkit.ts';

test('performance: 50,000 vouchers — cold summary < 3 s, repeat < 50 ms, period change reuses outstanding', () => {
  const t = createTestCompany({ today: '2026-10-08', booksFrom: '2025-04-01' });
  const debtors: number[] = [];
  const creditors: number[] = [];
  const items: number[] = [];
  for (let i = 0; i < 1_000; i++) debtors.push(t.addLedger({ name: `Customer ${i}`, group: 'SUNDRY_DEBTORS', creditDays: 30 }));
  for (let i = 0; i < 200; i++) creditors.push(t.addLedger({ name: `Supplier ${i}`, group: 'SUNDRY_CREDITORS', creditDays: 45 }));
  for (let i = 0; i < 50; i++) items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 10_000, openingRate: 100, reorderLevel: i % 5 === 0 ? 20_000 : undefined }));
  const bank = t.addLedger({ name: 'State Bank', group: 'BANK_ACCOUNTS' });
  const L = t.ids.ledgers;
  bulkBusiness(t, 50_000, {
    debtors,
    creditors,
    items,
    bank,
    ledgers: { sales: L.SALES, purchase: L.PURCHASE, outCgst: L.OUTPUT_CGST, outSgst: L.OUTPUT_SGST, inCgst: L.INPUT_CGST, inSgst: L.INPUT_SGST },
  });
  assert.equal(t.db.value('SELECT COUNT(*) FROM vouchers'), 50_000);
  const deps = { db: t.db, today: t.today, now: t.clock.now(), session: t.ctx.session };
  const input = { asOf: '2026-10-08', from: '2026-04-01', to: '2026-10-08' };

  const replays = stockReplayCount();
  const cold = dashboardSummary(deps, input);
  // Deterministic part of the budget (independent of the machine's load): the cold summary values
  // the stock ONCE (opening and closing of the period from the same replay).
  assert.equal(stockReplayCount() - replays, 1, 'one stock valuation replay for the cold summary');
  const warm = dashboardSummary(deps, input);
  const period = dashboardSummary(deps, { ...input, from: '2026-07-01', to: '2026-09-30' });
  const uncached = dashboardSummary(deps, input, { memo: false });
  console.log(`dashboard.summary on 50,000 vouchers: cold ${cold.elapsedMs} ms · repeat ${warm.elapsedMs} ms · period change ${period.elapsedMs} ms · uncached ${uncached.elapsedMs} ms`);

  assert.equal(cold.cached, false);
  assert.equal(warm.cached, true);
  // About 0.9 s, alone or under the fully parallel suite (3.3 s before the stock valuation ran once per
  // request); 3 s leaves room for a loaded CI runner while still catching a return of the old cost.
  assert.ok(cold.elapsedMs < 3_000, `cold summary took ${cold.elapsedMs} ms`);
  assert.ok(warm.elapsedMs < 50, `repeat took ${warm.elapsedMs} ms`);
  assert.ok(period.elapsedMs < cold.elapsedMs, 'a period change reuses receivables / payables');
  assert.ok(cold.sales.ytd > 0 && cold.receivables.total > 0 && cold.payables.total > 0);
  assert.equal(cold.lowStock.count, 10);
  assert.equal(cold.topCustomers.length, 5);
  assert.equal(cold.trend.length, 12);
  assert.deepEqual(uncached.receivables, cold.receivables);
  t.close();
});
