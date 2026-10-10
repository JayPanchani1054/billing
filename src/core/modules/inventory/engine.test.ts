/**
 * Valuation engine mechanics (performance hardening): the item-index and the sequential-scan paths
 * give identical figures, value points from one replay equal the per-date valuations, the trace is
 * the engine's own replay, the cross-request memo invalidates on any change and never caches inside
 * a transaction, and the query plans stay index-friendly even with ANALYZE statistics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { CostingMethod } from '../../../shared/types/inventory.ts';
import { Db } from '../../db/db.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { STOCK_BY_ITEM_SOME_SQL, stockByItem } from './stock.ts';
import { postStock, purchase, sale, salesReturn, stockJournal } from './testkit.ts';
import {
  closingStockValue,
  computeStockValuation,
  openingStockValue,
  stockReplayCount,
  stockValuesAt,
  traceStockMovements,
  VALUATION_MOVEMENT_SQL,
} from './valuation.ts';

const METHODS: readonly CostingMethod[] = ['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'];
const TODAY = '2026-12-31';

/** 40 items (every costing method) and ~400 deterministic vouchers: purchases, sales (some into negative stock), returns, stock journals. */
function business(): { t: TestCompany; items: number[] } {
  const t = createTestCompany({ today: TODAY, booksFrom: '2026-04-01' });
  const items: number[] = [];
  for (let i = 0; i < 40; i++) {
    const id = t.addStockItem({ name: `Engine ${i}`, gstRate: 18, hsnSac: '8471', openingQty: i % 7 === 0 ? 0 : 10 + i, openingRate: 50 + i, costingMethod: METHODS[i % METHODS.length], purchasePrice: 6_000 });
    if (METHODS[i % METHODS.length] === 'std_cost') t.db.run('UPDATE stock_items SET standard_cost = :c WHERE id = :id', { c: 5_500 + i, id });
    items.push(id);
  }
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let k = 0; k < 400; k++) {
    const date = `2026-${String(4 + Math.floor(k / 50)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`;
    const item = items[rnd(items.length)];
    const kind = rnd(10);
    if (kind < 4) purchase(t, date, item, 1 + rnd(20), 40 + rnd(60) + rnd(100) / 100);
    else if (kind < 8) sale(t, date, item, 1 + rnd(25), 150);
    else if (kind < 9) salesReturn(t, date, item, 1 + rnd(3), 150);
    else {
      // Production: two inputs → one or two outputs (one may carry its own amount).
      const a = items[rnd(items.length)];
      const b = items[rnd(items.length)];
      const outs = rnd(2) === 0 ? [{ itemId: item, qty: 1 + rnd(5) }] : [{ itemId: item, qty: 2 }, { itemId: items[(items.indexOf(item) + 1) % items.length], qty: 1, amount: 9_999 }];
      stockJournal(t, date, [{ itemId: a, qty: 1 + rnd(4) }, { itemId: b, qty: 1 }], outs);
    }
  }
  return { t, items };
}

describe('valuation engine: one replay, two read paths, same figures', () => {
  it('a few items (item index) and many items (sequential scan) value every item exactly as the whole-company run', () => {
    const { t, items } = business();
    try {
      const q = { from: '2026-06-01', to: '2026-09-30', today: TODAY };
      const full = new Map(computeStockValuation(t.db, q).rows.map((r) => [r.itemId, r]));
      // One item at a time (1 × 4 ≤ 40 items: the item-index path), then 30 at once (the scan path).
      for (const id of items) {
        const one = computeStockValuation(t.db, { ...q, itemIds: [id] }).rows[0];
        const expected = full.get(id);
        if (expected) assert.deepEqual(one, expected, `item ${id} alone`);
        else assert.deepEqual([one.opening, one.inward, one.outward, one.closing.value], [{ qty: 0, value: 0 }, { qty: 0, value: 0 }, { qty: 0, value: 0 }, 0]);
      }
      const many = computeStockValuation(t.db, { ...q, itemIds: items.slice(0, 30) });
      for (const r of many.rows) {
        const expected = full.get(r.itemId);
        if (expected) assert.deepEqual(r, expected, `item ${r.itemId} among 30`);
      }
    } finally {
      t.close();
    }
  });

  it('value points from ONE replay equal openingStockValue / closingStockValue date by date (books beginning included)', () => {
    const { t } = business();
    try {
      const dates = ['2026-03-31', '2026-04-01', '2026-04-02', '2026-05-15', '2026-07-01', '2026-08-31', '2026-11-30', '2027-01-31'];
      const before = stockReplayCount();
      const points = stockValuesAt(t.db, { opening: dates, closing: dates, today: TODAY });
      assert.equal(stockReplayCount() - before, 1, 'every point from one replay');
      for (const d of dates) {
        const day = computeStockValuation(t.db, { from: d, to: d, today: TODAY }).totals;
        assert.equal(points.opening.get(d), day.openingValue, `opening ${d}`);
        assert.equal(points.closing.get(d), day.closingValue, `closing ${d}`);
      }
      // the single-date helpers read the same memo: no further replay
      const memoised = stockReplayCount();
      assert.equal(openingStockValue(t.db, { from: '2026-07-01', today: TODAY }), points.opening.get('2026-07-01'));
      assert.equal(closingStockValue(t.db, { asOf: '2026-08-31', today: TODAY }), points.closing.get('2026-08-31'));
      assert.equal(stockReplayCount(), memoised);
    } finally {
      t.close();
    }
  });

  it('the trace is the valuation replay itself: lines add up to the period, days close at the engine figure', () => {
    const { t, items } = business();
    try {
      const traced = items.slice(0, 12);
      const before = stockReplayCount();
      const tr = traceStockMovements(t.db, { from: '2026-05-01', to: '2026-08-31', today: TODAY, itemIds: traced, traceItemIds: traced });
      assert.equal(stockReplayCount() - before, 1);
      for (const r of tr.valuation.rows) {
        const mine = tr.movements.filter((m) => m.itemId === r.itemId);
        const sum = (sign: number): number => mine.filter((m) => Math.sign(m.qty) === sign).reduce((a, m) => a + (tr.values.get(m.id) ?? 0), 0);
        assert.equal(sum(1), r.inward.value, `inward ${r.itemId}`);
        assert.equal(sum(-1), r.outward.value, `outward ${r.itemId}`);
      }
      for (const d of ['2026-05-03', '2026-06-17', '2026-08-28']) {
        const day = new Map(computeStockValuation(t.db, { from: d, to: d, today: TODAY, itemIds: traced }).rows.map((r) => [r.itemId, r.closing]));
        for (const id of traced) {
          const c = tr.closing.get(id)?.get(d);
          if (c) assert.deepEqual(c, { qty: day.get(id)?.qty, value: day.get(id)?.value }, `${id} on ${d}`);
        }
      }
    } finally {
      t.close();
    }
  });
});

describe('valuation memo', () => {
  it('reuses a frozen result until the data changes; any write (even one rolled back) invalidates', () => {
    const { t, items } = business();
    try {
      const q = { from: '2026-04-01', to: '2026-12-31', today: TODAY };
      const a = computeStockValuation(t.db, q);
      const count = stockReplayCount();
      const b = computeStockValuation(t.db, q);
      assert.equal(b, a, 'same result object');
      assert.equal(stockReplayCount(), count, 'no replay');
      assert.ok(Object.isFrozen(a) && Object.isFrozen(a.rows) && Object.isFrozen(a.rows[0].closing));
      assert.throws(() => {
        (a.rows as unknown as unknown[]).push(null);
      }, TypeError);
      // a write through this connection
      sale(t, '2026-12-01', items[1], 1, 150);
      const c = computeStockValuation(t.db, q);
      assert.notEqual(c, a);
      assert.equal(stockReplayCount(), count + 1);
      assert.ok(c.totals.closingValue < a.totals.closingValue);
      // a write rolled back still invalidates (the memo never trusts a counter it cannot explain)
      assert.throws(() =>
        t.db.transaction(() => {
          sale(t, '2026-12-02', items[1], 1, 150);
          throw new Error('abandon');
        }),
      );
      assert.deepEqual(computeStockValuation(t.db, q).totals, c.totals);
      assert.equal(stockReplayCount(), count + 2);
    } finally {
      t.close();
    }
  });

  it('nothing computed inside a transaction is cached (uncommitted data could be rolled back)', () => {
    const { t, items } = business();
    try {
      const committed = closingStockValue(t.db, { asOf: TODAY, today: TODAY });
      let inside = 0;
      assert.throws(() =>
        t.db.transaction(() => {
          purchase(t, '2026-12-10', items[2], 100, 500);
          inside = closingStockValue(t.db, { asOf: TODAY, today: TODAY });
          const n = stockReplayCount();
          closingStockValue(t.db, { asOf: TODAY, today: TODAY });
          assert.equal(stockReplayCount(), n + 1, 'no memo inside a transaction');
          throw new Error('roll back');
        }),
      );
      assert.equal(inside, committed + 100 * 50_000);
      assert.equal(closingStockValue(t.db, { asOf: TODAY, today: TODAY }), committed, 'the rolled-back purchase is not remembered');
    } finally {
      t.close();
    }
  });

  it('a commit by another connection to the company file invalidates (PRAGMA data_version)', () => {
    const { t, items } = business();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-memo-'));
    const file = path.join(dir, 'company.db');
    t.db.run('VACUUM INTO :file', { file });
    t.close();
    const a = new Db(file);
    const b = new Db(file);
    try {
      const q = { from: '2026-04-01', to: '2026-12-31', today: TODAY };
      const first = computeStockValuation(a, q);
      const before = closingStockValue(a, { asOf: TODAY, today: TODAY });
      const n = stockReplayCount();
      assert.equal(computeStockValuation(a, q), first, 'memo hit while nothing changed');
      assert.equal(closingStockValue(a, { asOf: TODAY, today: TODAY }), before);
      assert.equal(stockReplayCount(), n);
      // Another connection (another window / the import worker) adds 5 units worth ₹500.00 to an
      // average-cost item's opening stock: the next read must replay and see it.
      const avg = items[0];
      b.run('UPDATE stock_openings SET qty = qty + 5, value = value + 50000 WHERE item_id = (SELECT MIN(item_id) FROM stock_openings WHERE item_id >= :id)', { id: avg });
      const again = computeStockValuation(a, q);
      assert.notEqual(again, first);
      assert.equal(stockReplayCount(), n + 1);
      assert.notEqual(closingStockValue(a, { asOf: TODAY, today: TODAY }), before);
      assert.equal(stockReplayCount(), n + 2);
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the working date is part of the key (post-dated vouchers count once their date arrives)', () => {
    const t = createTestCompany({ today: '2026-04-30', booksFrom: '2026-04-01' });
    try {
      const item = t.addStockItem({ name: 'Dated', gstRate: 18, hsnSac: '8471', openingQty: 10, openingRate: 100 });
      postStock(t, { baseType: 'sales', date: '2026-05-10', postDated: true, lines: [{ itemId: item, qty: -4, rate: 150 }] });
      assert.equal(closingStockValue(t.db, { asOf: '2026-05-31', today: '2026-04-30' }), 1_00_000);
      assert.equal(closingStockValue(t.db, { asOf: '2026-05-31', today: '2026-05-10' }), 60_000);
    } finally {
      t.close();
    }
  });
});

describe('query plans stay index-friendly with ANALYZE statistics', () => {
  it('one item reads its own lines through idx_ie_item_date; the whole company is one scan', () => {
    const { t, items } = business();
    try {
      t.db.exec('ANALYZE');
      const plan = (sql: string, params: Record<string, string | number | null>): string =>
        t.db
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
          .map((r) => r.detail)
          .join(' | ');
      const ids = JSON.stringify([items[3]]);
      const one = plan(VALUATION_MOVEMENT_SQL.items, { to: TODAY, today: TODAY, main: t.ids.mainGodownId, ids });
      assert.match(one, /SEARCH ie USING INDEX idx_ie_item_date \(item_id=\?/);
      assert.doesNotMatch(one, /SCAN ie\b/);
      assert.doesNotMatch(one, /ANY\(item_id\)/, 'never a skip-scan over every item id');
      const all = plan(VALUATION_MOVEMENT_SQL.all, { to: TODAY, today: TODAY, main: t.ids.mainGodownId });
      assert.match(all, /SCAN ie\b/);
      const soh = plan(STOCK_BY_ITEM_SOME_SQL, { asOf: TODAY, today: TODAY, main: t.ids.mainGodownId, gf: 0, gids: '[]', pw: '[]', exclude: null, ids });
      assert.match(soh, /idx_ie_item_date \(item_id=\?/);
      // and the figures are unchanged by the statistics
      const everyItem = stockByItem(t.db, { asOf: TODAY });
      assert.ok(everyItem.has(items[3]));
      assert.deepEqual(stockByItem(t.db, { asOf: TODAY, itemIds: [items[3]] }), new Map([[items[3], everyItem.get(items[3])]]));
    } finally {
      t.close();
    }
  });
});
