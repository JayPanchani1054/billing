import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { computeStockValuation } from '../inventory/index.ts';
import { itemVouchers } from './itemVouchers.ts';
import { stockSummary } from './summary.ts';
import { APRIL, inventoryVoucher, invoice, post, stockMasters, stockScenario, type StockKit } from './testkit.ts';
import { traceMovementValues } from './trace.ts';

describe('stock.itemVouchers', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('April ledger of Steel Tumbler: every voucher at cost with the running balance', () => {
    const r = itemVouchers(k.t.db, k.t.today, { itemId: k.I.A, ...APRIL });
    assert.deepEqual(r.opening, { qty: 10, value: 1_00_000 });
    assert.deepEqual(
      r.rows.map((x) => [x.date, x.voucherTypeName, x.particulars, x.inward.qty, x.inward.value, x.outward.qty, x.outward.value, x.closing.qty, x.closing.value]),
      [
        ['2026-04-05', 'Purchase', 'Supreme Suppliers', 20, 2_30_000, 0, 0, 30, 3_30_000],
        // 15 × 3,30,000/30 = 1,65,000
        ['2026-04-10', 'Sales', 'Acme Traders', 0, 0, 15, 1_65_000, 15, 1_65_000],
        ['2026-04-15', 'Purchase', 'Bharat Wholesale', 10, 1_33_330, 0, 0, 25, 2_98_330],
        // sales return re-enters at cost: 3 × 2,98,330/25 = 35,799.6 → 35,800
        ['2026-04-20', 'Credit Note', 'Acme Traders', 3, 35_800, 0, 0, 28, 3_34_130],
        // 8 × 3,34,130/28 = 95,465.71 → 95,466
        ['2026-04-25', 'Stock Journal', 'Stock Journal', 0, 0, 8, 95_466, 20, 2_38_664],
        // 12 × 2,38,664/20 = 1,43,198.4 → 1,43,198
        ['2026-04-28', 'Sales', 'Metro Retail', 0, 0, 12, 1_43_198, 8, 95_466],
      ],
    );
    assert.deepEqual(r.totals, { inwardQty: 33, inwardValue: 3_99_130, outwardQty: 35, outwardValue: 4_03_664 });
    assert.deepEqual(r.closing, { qty: 8, value: 95_466, rate: 119.3325 });
    assert.equal(r.item.groupName, 'Kitchenware');
    assert.equal(r.item.costingMethod, 'avg_cost');
  });

  test('May–June: delivery notes move stock, the invoice billing a note does not; physical loss at cost', () => {
    const r = itemVouchers(k.t.db, k.t.today, { itemId: k.I.A, from: '2026-05-01', to: '2026-06-30' });
    assert.deepEqual(r.opening, { qty: 8, value: 95_466 });
    assert.deepEqual(
      r.rows.map((x) => [x.date, x.baseType, x.inward.qty, x.inward.value, x.outward.qty, x.outward.value, x.closing.qty, x.closing.value]),
      [
        // 5 × 95,466/8 = 59,666.25 → 59,666
        ['2026-05-05', 'delivery_note', 0, 0, 5, 59_666, 3, 35_800],
        // counted 2, book 3 → −1 at 35,800/3 = 11,933.33 → 11,933
        ['2026-05-12', 'physical_stock', 0, 0, 1, 11_933, 2, 23_867],
        ['2026-05-20', 'receipt_note', 20, 2_40_000, 0, 0, 22, 2_63_867],
        // 4 × 2,63,867/22 = 47,975.82 → 47,976
        ['2026-05-22', 'delivery_note', 0, 0, 4, 47_976, 18, 2_15_891],
        // transfer Main → Shop: 6 × 2,15,891/18 = 71,963.67 → 71,964 out and in
        ['2026-06-15', 'stock_journal', 6, 71_964, 6, 71_964, 18, 2_15_891],
      ],
    );
    assert.equal(r.rows.some((x) => x.voucherId === k.V.sal3), false, 'the invoice billing delivery note 1 moves no stock');
    assert.equal(r.rows.some((x) => x.voucherId === k.V.opt1), false, 'optional sale is not listed');
    assert.equal(r.rows[4].godowns, 'Main Location, Shop');
  });

  test('godown filter: only the Shop movements; closing at the item unit cost', () => {
    const r = itemVouchers(k.t.db, k.t.today, { itemId: k.I.A, from: '2026-04-01', to: '2026-06-30', godownId: k.godowns.shop });
    assert.deepEqual(r.opening, { qty: 0, value: 0 });
    assert.deepEqual(r.rows.map((x) => [x.date, x.inward.qty, x.inward.value, x.closing.qty, x.closing.value]), [['2026-06-15', 6, 71_964, 6, 71_964]]);
    assert.deepEqual(r.closing, { qty: 6, value: 71_964, rate: 119.94 });
  });

  test('totals and closing agree with the Stock Summary for every period', () => {
    for (const p of [APRIL, { from: '2026-04-11', to: '2026-05-21' }, { from: '2026-04-01', to: '2026-06-30' }]) {
      const r = itemVouchers(k.t.db, k.t.today, { itemId: k.I.F, ...p });
      const s = stockSummary(k.t.db, k.t.today, p).rows.find((x) => x.key === `i:${k.I.F}`);
      assert.ok(s);
      assert.equal(r.totals.inwardValue, s.inward.value);
      assert.equal(r.totals.outwardValue, s.outward.value);
      assert.equal(r.closing.value, s.closing.value);
      assert.equal(r.rows.at(-1)?.closing.value ?? r.opening.value, s.closing.value);
    }
  });

  test('unknown item → NOT_FOUND', () => {
    assert.throws(() => itemVouchers(k.t.db, k.t.today, { itemId: 9999, ...APRIL }), /Stock item not found/);
  });
});

describe('trace: per-line cost on top of the engine', () => {
  test('lines of a day add up exactly to the engine day totals (two sales of one item on one day)', () => {
    const m = stockMasters();
    try {
      const k = { ...m, V: {} };
      // Opening 10 @ ₹100; buy 3 @ ₹101 → Q 13, V 1,30,300; two sales of 1 and 2 on the same day.
      post(k, invoice(m, 'purchase', '2026-05-02', m.L.supreme, [{ itemId: m.I.A, qty: 3, rate: 101 }]));
      post(k, invoice(m, 'sales', '2026-05-03', m.L.acme, [{ itemId: m.I.A, qty: 1, rate: 150 }]));
      post(k, invoice(m, 'sales', '2026-05-03', m.L.metro, [{ itemId: m.I.A, qty: 2, rate: 150 }]));
      const tr = traceMovementValues(m.t.db, { itemIds: [m.I.A], from: '2026-05-01', to: '2026-05-31', today: m.t.today });
      const outs = tr.movements.filter((x) => x.qty < 0).map((x) => tr.values.get(x.id));
      const day = computeStockValuation(m.t.db, { from: '2026-05-03', to: '2026-05-03', today: m.t.today, itemIds: [m.I.A] }).rows[0];
      // 3 × 1,30,300/13 = 30,069.23: engine 10,023 + 20,046 = 30,069; the split by quantity 1 : 2 gives the same
      assert.equal(day.outward.value, 30_069);
      assert.deepEqual(outs, [10_023, 20_046]);
      assert.deepEqual(tr.closing.get(m.I.A)?.get('2026-05-03'), { qty: 10, value: 1_30_300 - 30_069 });
    } finally {
      m.t.close();
    }
  });

  test('stock journal production without an amount takes the consumed cost', () => {
    const m = stockMasters();
    try {
      const k = { ...m, V: {} };
      post(k, inventoryVoucher(m, 'stock_journal', '2026-05-05', [{ itemId: m.I.A, qty: 4, rate: 0, isConsumption: true }, { itemId: m.I.G, qty: 2, rate: 0 }]));
      const tr = traceMovementValues(m.t.db, { itemIds: [m.I.A, m.I.G], from: '2026-05-01', to: '2026-05-31', today: m.t.today });
      const byItem = new Map(tr.movements.map((x) => [x.itemId, tr.values.get(x.id)]));
      // 4 × ₹100 = 40,000 consumed → 2 hampers worth 40,000
      assert.equal(byItem.get(m.I.A), 40_000);
      assert.equal(byItem.get(m.I.G), 40_000);
    } finally {
      m.t.close();
    }
  });
});
