import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addDays } from '../../../shared/dates.ts';
import { computeStockValuation, stockReplayCount } from '../inventory/index.ts';
import { inventoryVoucher, invoice, post, stockMasters } from './testkit.ts';
import { traceMovementValues } from './trace.ts';

/**
 * trace.ts values every voucher line from the inventory engine's own replay (traceStockMovements).
 * These tests run every costing method through returns, a stock journal, a physical count, negative
 * stock and several movements on one day, and check — as a property, against independent engine
 * runs — that the traced figures are the engine's: line by line where hand-computable, the period
 * totals, and day by day against one engine run per day.
 */
describe('trace: per-line cost from the engine replay, equal to independent engine runs', () => {
  test('every costing method: no item falls back; each day closes at the engine figure; lines add up to the engine period totals', () => {
    const m = stockMasters();
    try {
      const k = { ...m, V: {} };
      const methods = ['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'] as const;
      const ids = methods.map((method, i) => {
        const id = m.t.addStockItem({ name: `Probe ${method}`, gstRate: 18, hsnSac: '7323', openingQty: 10, openingRate: 100, costingMethod: method, purchasePrice: 9_500 });
        if (method === 'std_cost') m.t.db.run('UPDATE stock_items SET standard_cost = 10500 WHERE id = :id', { id });
        return { id, i };
      });
      const all = ids.map((x) => x.id);
      const lines = (qty: number, rate: number) => all.map((itemId) => ({ itemId, qty, rate }));
      post(k, invoice(m, 'purchase', '2026-04-03', m.L.supreme, lines(20, 115)));
      post(k, invoice(m, 'sales', '2026-04-05', m.L.acme, lines(12, 150)));
      // one day: sale, purchase at a new price, sale again (the second sale sees the new cost)
      post(k, invoice(m, 'sales', '2026-04-08', m.L.acme, lines(5, 150)));
      post(k, invoice(m, 'purchase', '2026-04-08', m.L.bharat, lines(10, 133.33)));
      post(k, invoice(m, 'sales', '2026-04-08', m.L.metro, lines(4, 160)));
      post(k, invoice(m, 'credit_note', '2026-04-10', m.L.acme, lines(2, 150)));
      post(k, inventoryVoucher(m, 'stock_journal', '2026-04-12', [...all.map((itemId) => ({ itemId, qty: 3, rate: 0, isConsumption: true })), { itemId: m.I.G, qty: 5, rate: 0 }]));
      post(k, inventoryVoucher(m, 'physical_stock', '2026-04-15', all.map((itemId) => ({ itemId, qty: 15, rate: 0 }))));
      // negative stock, then refilled
      post(k, invoice(m, 'sales', '2026-04-20', m.L.metro, lines(25, 170)));
      post(k, invoice(m, 'purchase', '2026-04-25', m.L.supreme, lines(30, 120)));
      const today = m.t.today;
      const traced = [...all, m.I.G];
      const before = stockReplayCount();
      const tr = traceMovementValues(m.t.db, { itemIds: traced, from: '2026-04-01', to: '2026-04-30', today });
      assert.equal(stockReplayCount() - before, 1, 'one engine replay, no second "proof" run');

      // Period totals = engine (the proof the trace runs on, checked here independently).
      const period = new Map(computeStockValuation(m.t.db, { from: '2026-04-01', to: '2026-04-30', today, itemIds: traced }).rows.map((r) => [r.itemId, r]));
      for (const id of traced) {
        const mine = tr.movements.filter((x) => x.itemId === id);
        const sum = (sign: 1 | -1) => mine.filter((x) => Math.sign(x.qty) === sign).reduce((a, x) => a + (tr.values.get(x.id) ?? 0), 0);
        assert.equal(sum(1), period.get(id)?.inward.value, `inward value of ${id}`);
        assert.equal(sum(-1), period.get(id)?.outward.value, `outward value of ${id}`);
      }
      // Every day with movements closes at what one engine run for that day says.
      for (let d = '2026-04-01'; d <= '2026-04-30'; d = addDays(d, 1)) {
        const day = new Map(computeStockValuation(m.t.db, { from: d, to: d, today, itemIds: traced }).rows.map((r) => [r.itemId, r]));
        for (const id of traced) {
          const c = tr.closing.get(id)?.get(d);
          if (!c) continue;
          assert.deepEqual(c, { qty: day.get(id)?.closing.qty, value: day.get(id)?.closing.value }, `${id} on ${d}`);
          // and the lines of that day add up to the day's engine values
          const mine = tr.movements.filter((x) => x.itemId === id && x.date === d);
          const out = mine.filter((x) => x.qty < 0).reduce((a, x) => a + (tr.values.get(x.id) ?? 0), 0);
          assert.equal(out, day.get(id)?.outward.value, `${id} outward on ${d}`);
        }
      }

      // Hand-checked lines for Average Cost on 08-Apr (opening 10 @ ₹100 + 20 @ ₹115 = 30 / 3,30,000; sale 12 → 1,32,000):
      //   Q 18, V 1,98,000 (₹110) · sale 5 → 5 × 11,000 = 55,000 → Q 13, V 1,43,000
      //   purchase 10 @ ₹133.33 = 1,33,330 → Q 23, V 2,76,330 · sale 4 → 4 × 2,76,330 / 23 = 48,057.39 → 48,057
      const avg = ids[0].id;
      const outs = tr.movements.filter((x) => x.itemId === avg && x.date === '2026-04-08' && x.qty < 0).map((x) => tr.values.get(x.id));
      assert.deepEqual(outs, [55_000, 48_057]);
      // FIFO, same day: sale 5 from the 20 @ ₹115 layer (opening 10 @ ₹100 went to the 05-Apr sale with 2 more of the ₹115 layer)
      //   = 57,500; sale 4 = 4 × 11,500 = 46,000 (the new ₹133.33 layer is not touched)
      const fifo = ids[1].id;
      assert.deepEqual(
        tr.movements.filter((x) => x.itemId === fifo && x.date === '2026-04-08' && x.qty < 0).map((x) => tr.values.get(x.id)),
        [57_500, 46_000],
      );
    } finally {
      m.t.close();
    }
  });

  test('exact per line where a per-day split cannot be (two sales of one item on one day around a purchase)', () => {
    const m = stockMasters();
    try {
      const k = { ...m, V: {} };
      // A opening 10 @ ₹100. On 03-May: sale 5 → 5 × 10,000 = 50,000 (Q 5, V 50,000);
      // purchase 10 @ ₹200 → Q 15, V 2,50,000; sale 5 → 5 × 2,50,000 / 15 = 83,333.33 → 83,333.
      post(k, invoice(m, 'sales', '2026-05-03', m.L.acme, [{ itemId: m.I.A, qty: 5, rate: 150 }]));
      post(k, invoice(m, 'purchase', '2026-05-03', m.L.supreme, [{ itemId: m.I.A, qty: 10, rate: 200 }]));
      post(k, invoice(m, 'sales', '2026-05-03', m.L.metro, [{ itemId: m.I.A, qty: 5, rate: 250 }]));
      const q = { itemIds: [m.I.A], from: '2026-05-01', to: '2026-05-31', today: m.t.today };
      const exact = traceMovementValues(m.t.db, q);
      assert.deepEqual(exact.movements.filter((x) => x.qty < 0).map((x) => exact.values.get(x.id)), [50_000, 83_333]);
      // the day closes at what one engine run for that day says: opening 10 @ ₹100 − 5 + 10 @ ₹200 − 5 → 10 worth 1,66,667
      const day = computeStockValuation(m.t.db, { from: '2026-05-03', to: '2026-05-03', today: m.t.today, itemIds: [m.I.A] }).rows[0];
      assert.deepEqual(exact.closing.get(m.I.A)?.get('2026-05-03'), { qty: day.closing.qty, value: day.closing.value });
      assert.deepEqual(exact.closing.get(m.I.A)?.get('2026-05-03'), { qty: 10, value: 1_66_667 });
    } finally {
      m.t.close();
    }
  });

  test('godown scope: only that godown’s lines; the day closing is the godown quantity at the item’s unit cost', () => {
    const m = stockMasters();
    try {
      const k = { ...m, V: {} };
      // A opening 10 @ ₹100 in Main Location; move 4 to the Shop, then sell 1 from the Shop.
      post(k, inventoryVoucher(m, 'stock_journal', '2026-05-02', [
        { itemId: m.I.A, qty: 4, rate: 0, isConsumption: true, godownId: m.godowns.main },
        { itemId: m.I.A, qty: 4, rate: 0, godownId: m.godowns.shop },
      ]));
      post(k, invoice(m, 'sales', '2026-05-04', m.L.acme, [{ itemId: m.I.A, qty: 1, rate: 150, godownId: m.godowns.shop }]));
      const tr = traceMovementValues(m.t.db, { itemIds: [m.I.A], from: '2026-05-01', to: '2026-05-31', today: m.t.today, godownId: m.godowns.shop });
      // the transfer in (4 × ₹100 = 40,000) and the sale (10,000); the Main Location side is out of scope
      assert.deepEqual(tr.movements.map((x) => [x.qty, tr.values.get(x.id)]), [[4, 40_000], [-1, 10_000]]);
      assert.deepEqual(tr.closing.get(m.I.A)?.get('2026-05-04'), { qty: 3, value: 30_000 });
    } finally {
      m.t.close();
    }
  });
});
