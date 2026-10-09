/**
 * Valuation tests on hand-computed scenarios. Money in paise; rates in the comments are paise/unit.
 *
 * Common scenario for item A (opening 10 Nos @ ₹100 = 1,00,000 p) and product B (no opening):
 *   04-05 Purchase   +20 @ ₹115      amount 2,30,000
 *   04-10 Sale       −15
 *   04-15 Purchase   +10 @ ₹133.33   amount 1,33,330
 *   04-20 Credit note +3 (sales return — re-enters at CURRENT COST, its sale amount is ignored)
 *   04-25 Stock journal: consume 8 A → produce 4 B (B has no amount → takes the consumed cost)
 *   04-28 Sale       −12
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StockValuationResult, StockValuationRow } from '../../../shared/types/inventory.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { inventoryRoutes } from './routes.ts';
import { addGodown, postStock, purchase, sale, salesReturn, stockJournal } from './testkit.ts';
import { closingStockValue, computeStockValuation, currentUnitCost, openingStockValue } from './valuation.ts';

const APRIL = { from: '2026-04-01', to: '2026-04-30', today: '2026-04-30' };

function scenario(t: TestCompany, a: number, b: number): void {
  purchase(t, '2026-04-05', a, 20, 115);
  sale(t, '2026-04-10', a, 15, 150);
  purchase(t, '2026-04-15', a, 10, 133.33);
  salesReturn(t, '2026-04-20', a, 3, 150);
  stockJournal(t, '2026-04-25', [{ itemId: a, qty: 8 }], [{ itemId: b, qty: 4 }]);
  sale(t, '2026-04-28', a, 12, 150);
}

const row = (res: StockValuationResult, itemId: number): StockValuationRow => {
  const r = res.rows.find((x) => x.itemId === itemId);
  assert.ok(r, `row for item ${itemId}`);
  return r;
};

const qv = (r: StockValuationRow) => ({
  opening: [r.opening.qty, r.opening.value],
  inward: [r.inward.qty, r.inward.value],
  outward: [r.outward.qty, r.outward.value],
  closing: [r.closing.qty, r.closing.value],
});

describe('avg_cost (running weighted average)', () => {
  it('values the common scenario exactly', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 });
    const b = t.addStockItem({ name: 'B' });
    scenario(t, a, b);
    // Noise that must not count: an optional purchase and a cancelled sale.
    purchase(t, '2026-04-06', a, 100, 1, { optional: true });
    sale(t, '2026-04-07', a, 5, 150, { cancelled: true });
    // Q=10 V=100000 (rate 10000)
    // 04-05 +20 @ 230000           → Q=30 V=330000 (rate 11000)
    // 04-10 −15 → 15 × 11000 = 165000 → Q=15 V=165000
    // 04-15 +10 @ 133330           → Q=25 V=298330 (rate 11933.2)
    // 04-20 +3 at 11933.2 = 35799.6 → 35800 → Q=28 V=334130
    // 04-25 −8 → 8 × 334130/28 = 95465.71 → 95466 → Q=20 V=238664 ; B +4 = 95466
    // 04-28 −12 → 12 × 238664/20 = 143198.4 → 143198 → Q=8 V=95466
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, a)), {
      opening: [10, 100000],
      inward: [33, 399130], // 230000 + 133330 + 35800
      outward: [35, 403664], // 165000 + 95466 + 143198
      closing: [8, 95466], // 100000 + 399130 − 403664
    });
    assert.equal(row(res, a).closing.rate, 119.3325);
    assert.deepEqual(qv(row(res, b)), { opening: [0, 0], inward: [4, 95466], outward: [0, 0], closing: [4, 95466] });
    assert.equal(row(res, b).closing.rate, 238.665);
    assert.deepEqual(res.totals, { openingValue: 100000, inwardValue: 494596, outwardValue: 403664, closingValue: 190932 });
    t.close();
  });

  it('splits a period correctly and gives opening/closing stock values for P&L', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 });
    const b = t.addStockItem({ name: 'B' });
    scenario(t, a, b);
    const res = computeStockValuation(t.db, { from: '2026-04-11', to: '2026-04-30', today: '2026-04-30' });
    assert.deepEqual(qv(row(res, a)), {
      opening: [15, 165000], // state after 04-10
      inward: [13, 169130], // 133330 + 35800
      outward: [20, 238664], // 95466 + 143198
      closing: [8, 95466],
    });
    assert.equal(openingStockValue(t.db, { from: '2026-04-01', today: '2026-04-30' }), 100000);
    assert.equal(openingStockValue(t.db, { from: '2026-04-11', today: '2026-04-30' }), 165000);
    assert.equal(closingStockValue(t.db, { asOf: '2026-04-30', today: '2026-04-30' }), 190932);
    assert.equal(closingStockValue(t.db, { asOf: '2026-04-12', today: '2026-04-30' }), 165000);
    // Current cost of A at the end of April: 95466 / 8 = 11933.25 p.
    assert.equal(currentUnitCost(t.db, { itemId: a, asOf: '2026-04-30', today: '2026-04-30' }), 119.3325);
    t.close();
  });

  it('values only the requested items but still costs their stock-journal inputs', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 });
    const b = t.addStockItem({ name: 'B' });
    t.addStockItem({ name: 'Unrelated', openingQty: 1, openingRate: 1 });
    scenario(t, a, b);
    const only = computeStockValuation(t.db, { ...APRIL, itemIds: [b] });
    assert.deepEqual(only.rows.map((r) => r.name), ['B']);
    assert.deepEqual(qv(only.rows[0]), { opening: [0, 0], inward: [4, 95466], outward: [0, 0], closing: [4, 95466] });
    assert.equal(only.totals.closingValue, 95466);
    t.close();
  });
});

describe('fifo and lifo (cost layers)', () => {
  it('values the common scenario with FIFO layers', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100, costingMethod: 'fifo' });
    const b = t.addStockItem({ name: 'B', costingMethod: 'fifo' });
    scenario(t, a, b);
    // Layers [10@10000]
    // 04-05 +20 → [10:100000, 20:230000]
    // 04-10 −15 → 100000 + 5×11500 = 157500 → [15:172500]
    // 04-15 +10 → [15:172500, 10:133330]
    // 04-20 +3 at current cost = oldest layer 11500 → 34500 → [15:172500, 10:133330, 3:34500]
    // 04-25 −8 → 8×11500 = 92000 → [7:80500, 10:133330, 3:34500] ; B +4 = 92000
    // 04-28 −12 → 80500 + 5×13333 = 66665 → 147165 → [5:66665, 3:34500]
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, a)), {
      opening: [10, 100000],
      inward: [33, 397830], // 230000 + 133330 + 34500
      outward: [35, 396665], // 157500 + 92000 + 147165
      closing: [8, 101165], // 66665 + 34500
    });
    assert.ok(Math.abs(row(res, a).closing.rate - 126.45625) < 0.0001);
    assert.deepEqual(qv(row(res, b)), { opening: [0, 0], inward: [4, 92000], outward: [0, 0], closing: [4, 92000] });
    t.close();
  });

  it('values the common scenario with LIFO layers', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100, costingMethod: 'lifo' });
    const b = t.addStockItem({ name: 'B', costingMethod: 'lifo' });
    scenario(t, a, b);
    // 04-10 −15 from the newest layer: 15×11500 = 172500 → [10:100000, 5:57500]
    // 04-15 +10 → […, 10:133330] ; 04-20 +3 at newest rate 13333 → 39999
    // 04-25 −8 → 39999 + 5×13333 (66665) = 106664 ; 04-28 −12 → 66665 + 57500 + 2×10000 = 144165 → [8:80000]
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, a)), {
      opening: [10, 100000],
      inward: [33, 403329],
      outward: [35, 423329],
      closing: [8, 80000],
    });
    assert.equal(row(res, a).closing.rate, 100);
    assert.equal(row(res, b).closing.value, 106664);
    t.close();
  });
});

describe('last_purchase and std_cost', () => {
  it('last purchase: every value at the last purchase rate up to that point; free goods do not set the rate', () => {
    const t = createTestCompany();
    const c = t.addStockItem({ name: 'C', openingQty: 10, openingRate: 100, costingMethod: 'last_purchase' });
    purchase(t, '2026-04-05', c, 20, 115); // rate 11500
    sale(t, '2026-04-10', c, 15, 150); // 15 × 11500 = 172500
    purchase(t, '2026-04-15', c, 10, 133.33); // rate 13333
    sale(t, '2026-04-28', c, 12, 150); // 12 × 13333 = 159996
    purchase(t, '2026-04-29', c, 2, 0); // free goods, value 0
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, c)), {
      opening: [10, 100000], // 10 × opening rate 10000
      inward: [32, 363330],
      outward: [27, 332496],
      closing: [15, 199995], // 15 × 13333
    });
    const mid = computeStockValuation(t.db, { from: '2026-04-12', to: '2026-04-12', today: '2026-04-30' });
    assert.deepEqual(row(mid, c).closing, { qty: 15, value: 172500, rate: 115 }); // 15 × 11500
    t.close();
  });

  it('standard cost: quantities at the standard cost; inwards keep their own amount', () => {
    const t = createTestCompany();
    const d = t.addStockItem({ name: 'D', openingQty: 10, openingRate: 100, costingMethod: 'std_cost', columns: { standard_cost: 12000 } });
    purchase(t, '2026-04-05', d, 20, 115); // inward value 230000
    sale(t, '2026-04-10', d, 15, 150); // 15 × 12000 = 180000
    salesReturn(t, '2026-04-12', d, 1, 150); // re-enters at 12000
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, d)), {
      // At the books beginning the opening stock is what the master says: 10 × ₹100 (not 10 × the
      // standard cost), so the Balance Sheet's opening stock matches the item masters.
      opening: [10, 100000],
      inward: [21, 242000],
      outward: [15, 180000],
      closing: [16, 192000],
    });
    assert.equal(row(res, d).closing.rate, 120);
    // From the next day on, opening = previous closing = Q × standard cost (periods chain).
    const later = computeStockValuation(t.db, { from: '2026-04-02', to: '2026-04-30', today: '2026-04-30' });
    assert.deepEqual(row(later, d).opening, { qty: 10, value: 120000 });
    t.close();
  });
});

describe('stock journals, godowns, post-dated vouchers', () => {
  it('values production by amount, by share of consumed cost, or at current cost without inputs', () => {
    const t = createTestCompany();
    const x = t.addStockItem({ name: 'X', openingQty: 10, openingRate: 20 }); // 2000 p/unit
    const y = t.addStockItem({ name: 'Y' });
    const z = t.addStockItem({ name: 'Z' });
    const w = t.addStockItem({ name: 'W' });
    // Consume 2 X (4000) → Y by-product with amount 1000, Z gets the rest 3000.
    stockJournal(t, '2026-04-05', [{ itemId: x, qty: 2 }], [{ itemId: y, qty: 1, amount: 1000 }, { itemId: z, qty: 2 }]);
    // Produce 1 Z with no inputs and no amount → Z's current cost 3000/2 = 1500.
    stockJournal(t, '2026-04-06', [], [{ itemId: z, qty: 1 }]);
    // Consume 3 X (6000) → Z 1 and W 2 share by quantity: 2000 and 4000.
    stockJournal(t, '2026-04-07', [{ itemId: x, qty: 3 }], [{ itemId: z, qty: 1 }, { itemId: w, qty: 2 }]);
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, x)), { opening: [10, 20000], inward: [0, 0], outward: [5, 10000], closing: [5, 10000] });
    assert.equal(row(res, y).closing.value, 1000);
    assert.deepEqual(qv(row(res, z)), { opening: [0, 0], inward: [4, 6500], outward: [0, 0], closing: [4, 6500] }); // 3000 + 1500 + 2000
    assert.equal(row(res, w).closing.value, 4000);
    t.close();
  });

  it('reports one godown: its quantities and movements, valued at the item cost', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = addGodown(t, 'Warehouse');
    const main = t.ids.mainGodownId;
    const g = t.addStockItem({ name: 'G', openingQty: 10, openingRate: 100 }); // Main
    purchase(t, '2026-04-03', g, 10, 120, { godownId: wh }); // Q=20 V=220000 avg 11000
    stockJournal(t, '2026-04-05', [{ itemId: g, qty: 4, godownId: main }], [{ itemId: g, qty: 4, godownId: wh }]); // 44000 moved
    sale(t, '2026-04-07', g, 2, 150, { godownId: wh }); // 22000
    const all = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(all, g)), { opening: [10, 100000], inward: [14, 164000], outward: [6, 66000], closing: [18, 198000] });
    const inWh = computeStockValuation(t.db, { ...APRIL, godownId: wh });
    assert.deepEqual(qv(row(inWh, g)), { opening: [0, 0], inward: [14, 164000], outward: [2, 22000], closing: [12, 132000] });
    const inMain = computeStockValuation(t.db, { ...APRIL, godownId: main });
    assert.deepEqual(qv(row(inMain, g)), { opening: [10, 100000], inward: [0, 0], outward: [4, 44000], closing: [6, 66000] });
    assert.equal(inWh.totals.closingValue + inMain.totals.closingValue, all.totals.closingValue);
    t.close();
  });

  it('counts a post-dated voucher only from its date', () => {
    const t = createTestCompany({ today: '2026-04-15' });
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 });
    purchase(t, '2026-04-25', a, 10, 120, { postDated: true });
    assert.equal(closingStockValue(t.db, { asOf: '2026-04-30', today: '2026-04-15' }), 100000);
    assert.equal(closingStockValue(t.db, { asOf: '2026-04-30', today: '2026-04-25' }), 220000);
    t.close();
  });
});

describe('negative stock robustness', () => {
  it('avg_cost: outward beyond stock at the last known cost; the next inward restarts the average', () => {
    const t = createTestCompany();
    const e = t.addStockItem({ name: 'E', purchasePrice: 5000 }); // no inward yet → last known cost = purchase price 5000
    sale(t, '2026-04-02', e, 5, 80); // 5 × 5000 = 25000 → Q=−5 V=−25000
    const early = computeStockValuation(t.db, { from: '2026-04-01', to: '2026-04-03', today: '2026-04-30' });
    assert.deepEqual(row(early, e).closing, { qty: -5, value: -25000, rate: 50 });
    purchase(t, '2026-04-05', e, 10, 60); // Q=5, average restarts at 6000 → V=30000
    sale(t, '2026-04-06', e, 2, 80); // 2 × 6000 = 12000 → Q=3 V=18000
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, e)), { opening: [0, 0], inward: [10, 60000], outward: [7, 37000], closing: [3, 18000] });
    t.close();
  });

  it('fifo: a shortfall is filled by the next inward; values stay finite', () => {
    const t = createTestCompany();
    const f = t.addStockItem({ name: 'F', costingMethod: 'fifo', purchasePrice: 4000 });
    sale(t, '2026-04-02', f, 5, 80); // 5 × 4000 = 20000, shortfall 5
    purchase(t, '2026-04-05', f, 8, 60); // fills 5, layer [3:18000]
    sale(t, '2026-04-06', f, 5, 80); // 18000 + 2 × 6000 = 30000 → Q=−2, V=−12000
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, f)), { opening: [0, 0], inward: [8, 48000], outward: [10, 50000], closing: [-2, -12000] });
    assert.equal(row(res, f).closing.rate, 60);
    t.close();
  });

  it('never produces NaN: no cost information at all, zero-value inwards, empty stock', () => {
    const t = createTestCompany();
    const n = t.addStockItem({ name: 'N' });
    const fifo = t.addStockItem({ name: 'NF', costingMethod: 'fifo' });
    const lp = t.addStockItem({ name: 'NL', costingMethod: 'last_purchase' });
    for (const id of [n, fifo, lp]) {
      sale(t, '2026-04-02', id, 3, 10);
      purchase(t, '2026-04-03', id, 3, 0);
      salesReturn(t, '2026-04-04', id, 1, 10);
      sale(t, '2026-04-05', id, 1, 10);
    }
    const res = computeStockValuation(t.db, APRIL);
    for (const r of res.rows) {
      for (const v of [r.opening, r.inward, r.outward, r.closing]) {
        assert.ok(Number.isFinite(v.qty) && Number.isSafeInteger(v.value), `${r.name}: ${JSON.stringify(v)}`);
      }
      assert.ok(Number.isFinite(r.closing.rate));
      assert.equal(r.closing.qty, 0);
      assert.equal(r.closing.value, 0);
    }
    assert.ok(Number.isSafeInteger(res.totals.closingValue));
    t.close();
  });

  it('leaves out items with nothing to report and service items', () => {
    const t = createTestCompany();
    t.addStockItem({ name: 'Idle' });
    t.addStockItem({ name: 'Consulting', isService: true });
    const a = t.addStockItem({ name: 'A', openingQty: 1, openingRate: 1 });
    assert.deepEqual(computeStockValuation(t.db, APRIL).rows.map((r) => r.itemId), [a]);
    t.close();
  });
});

describe("'inventory.valuation' route", () => {
  it('needs reports.view, validates the period and uses the working date', async () => {
    const t = createTestCompany({ today: '2026-04-30' });
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 });
    const b = t.addStockItem({ name: 'B' });
    scenario(t, a, b);
    const res = await t.callOk<StockValuationResult>(inventoryRoutes, 'inventory.valuation', { from: '2026-04-01', to: '2026-04-30' }, {
      session: t.sessionAs({ role: 'Auditor' }),
    });
    assert.equal(res.totals.closingValue, 190932);
    const denied = await t.call(inventoryRoutes, 'inventory.valuation', { from: '2026-04-01', to: '2026-04-30' }, {
      session: t.sessionAs({ permissions: ['masters.view'] }),
    });
    assert.equal(denied.ok ? null : denied.error.code, 'FORBIDDEN');
    const bad = await t.call(inventoryRoutes, 'inventory.valuation', { from: '2026-04-30', to: '2026-04-01' });
    assert.equal(bad.ok ? null : bad.error.message, 'The period end date is before its start date');
    t.close();
  });
});

describe('review regressions — valuation', () => {
  it('opening stock at the books beginning is what the masters say, for every costing method', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = addGodown(t, 'Warehouse');
    const main = t.ids.mainGodownId;
    // Last Purchase with two opening rows at different rates: entered 10 × ₹100 + 5 × ₹110 = 1,55,000 p.
    const lp = t.addStockItem({ name: 'LP', costingMethod: 'last_purchase', openingQty: 10, openingRate: 100 });
    t.db.run('INSERT INTO stock_openings (item_id, godown_id, qty, rate, value) VALUES (:id, :g, 5, 110, 55000)', { id: lp, g: wh });
    // Before: the last row's rate re-priced all 15 units → 15 × 11000 = 1,65,000 (₹100 more than entered).
    sale(t, '2026-04-05', lp, 3, 150, { godownId: main });
    // The opening rate is the weighted one: 1,55,000 / 15 = 10,333.33 p → sale 3 × 10,333.33 = 31,000.
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, lp)), { opening: [15, 155000], inward: [0, 0], outward: [3, 31000], closing: [12, 124000] });
    assert.equal(openingStockValue(t.db, { from: '2026-04-01', today: '2026-04-30' }), 155000);
    assert.equal(openingStockValue(t.db, { from: '2026-03-01', today: '2026-04-30' }), 155000, 'before books beginning too');
    // Periods chain: the opening of a later period is the closing of the day before.
    assert.equal(openingStockValue(t.db, { from: '2026-04-06', today: '2026-04-30' }), closingStockValue(t.db, { asOf: '2026-04-05', today: '2026-04-30' }));
    t.close();
  });

  it('values physical stock differences, purchase returns and rejections at cost', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 10, openingRate: 100 }); // Q10 V100000
    purchase(t, '2026-04-02', a, 10, 120); // Q20 V220000 (avg 11000)
    postStock(t, { baseType: 'physical_stock', date: '2026-04-03', lines: [{ itemId: a, qty: 2, rate: 999 }] }); // gain 2 × 11000 = 22000 → Q22 V242000
    postStock(t, { baseType: 'physical_stock', date: '2026-04-04', lines: [{ itemId: a, qty: -4, rate: 999 }] }); // loss 4 × 11000 = 44000 → Q18 V198000
    postStock(t, { baseType: 'debit_note', date: '2026-04-05', lines: [{ itemId: a, qty: -5, rate: 130 }] }); // return 5 × 11000 = 55000 → Q13 V143000
    postStock(t, { baseType: 'rejection_in', date: '2026-04-06', lines: [{ itemId: a, qty: 2, rate: 150 }] }); // back at cost 22000 → Q15 V165000
    postStock(t, { baseType: 'rejection_out', date: '2026-04-07', lines: [{ itemId: a, qty: -1, rate: 130 }] }); // 11000 → Q14 V154000
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, a)), {
      opening: [10, 100000],
      inward: [14, 164000], // 120000 + 22000 + 22000 — own amounts of the gain / rejection (999, 150) ignored
      outward: [10, 110000], // 44000 + 55000 + 11000
      closing: [14, 154000], // 100000 + 164000 − 110000
    });
    t.close();
  });

  it('FIFO takes opening rows from different godowns as separate layers', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = addGodown(t, 'Warehouse');
    const f = t.addStockItem({ name: 'F', costingMethod: 'fifo', openingQty: 10, openingRate: 100 });
    t.db.run('INSERT INTO stock_openings (item_id, godown_id, qty, rate, value) VALUES (:id, :g, 5, 110, 55000)', { id: f, g: wh });
    sale(t, '2026-04-05', f, 12, 150); // 10 × 10000 + 2 × 11000 = 122000
    const res = computeStockValuation(t.db, APRIL);
    assert.deepEqual(qv(row(res, f)), { opening: [15, 155000], inward: [0, 0], outward: [12, 122000], closing: [3, 33000] });
    t.close();
  });

  it('can roll a parent godown up with its sub-godowns', async () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const store = addGodown(t, 'Store');
    const rack = addGodown(t, 'Rack 1', store);
    const other = addGodown(t, 'Depot');
    const g = t.addStockItem({ name: 'G', openingQty: 5, openingRate: 100, godownId: store }); // 50000
    purchase(t, '2026-04-02', g, 3, 100, { godownId: rack }); // 30000
    purchase(t, '2026-04-03', g, 2, 100, { godownId: other }); // 20000
    const exact = computeStockValuation(t.db, { ...APRIL, godownId: store });
    assert.deepEqual(row(exact, g).closing, { qty: 5, value: 50000, rate: 100 });
    const rolled = computeStockValuation(t.db, { ...APRIL, godownId: store, includeSubGodowns: true });
    assert.deepEqual(qv(row(rolled, g)), { opening: [5, 50000], inward: [3, 30000], outward: [0, 0], closing: [8, 80000] });
    assert.equal(closingStockValue(t.db, { asOf: '2026-04-30', today: '2026-04-30', godownId: store, includeSubGodowns: true }), 80000);
    // The route takes the working date from the clock, not from the input (strict route input rejects `today`).
    const r = await t.callOk<StockValuationResult>(inventoryRoutes, 'inventory.valuation', { from: APRIL.from, to: APRIL.to, godownId: store, includeSubGodowns: true });
    assert.equal(r.totals.closingValue, 80000);
    const missing = await t.call(inventoryRoutes, 'inventory.valuation', { from: '2026-04-01', to: '2026-04-30', godownId: 9999 });
    assert.equal(missing.ok ? null : missing.error.code, 'NOT_FOUND');
    t.close();
  });
});
