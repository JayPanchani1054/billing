import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closingStockValue, openingStockValue } from '../inventory/index.ts';
import { saveGodown } from '../inventory/masters.ts';
import { categorySummary, godownSummary, stockSummary } from './summary.ts';
import { APRIL, inventoryVoucher, post, invoice, stockMasters, stockScenario, type StockKit } from './testkit.ts';

describe('stock.summary — April (inventory README worked example)', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Steel Tumbler (Average Cost): opening 10 / ₹1,000, inward 33 / ₹3,991.30, outward 35 / ₹4,036.64, closing 8 / ₹954.66', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL });
    const a = s.rows.find((r) => r.key === `i:${k.I.A}`);
    assert.ok(a);
    // inward: 2,30,000 (20 @ 115) + 1,33,330 (10 @ 133.33) + 35,800 (return 3 × 2,98,330/25 = 35,799.6) = 3,99,130
    // outward: 1,65,000 (15 × 11,000) + 95,466 (8 × 3,34,130/28) + 1,43,198 (12 × 2,38,664/20) = 4,03,664
    assert.deepEqual(a.opening, { qty: 10, value: 1_00_000 });
    assert.deepEqual(a.inward, { qty: 33, value: 3_99_130 });
    assert.deepEqual(a.outward, { qty: 35, value: 4_03_664 });
    // 1,00,000 + 3,99,130 − 4,03,664 = 95,466 → ₹119.3325 per unit
    assert.deepEqual(a.closing, { qty: 8, value: 95_466, rate: 119.3325 });
    assert.equal(a.costingMethod, 'avg_cost');
  });

  test('Copper Bottle (FIFO) through the same trades closes at 16 / ₹2,023.30', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL });
    const f = s.rows.find((r) => r.key === `i:${k.I.F}`);
    assert.ok(f);
    // sale 15: 10 × 10,000 + 5 × 11,500 = 1,57,500 → layers [15 : 1,72,500]
    // purchase 10 → [15 : 1,72,500][10 : 1,33,330]; return 3 at the oldest layer's rate 11,500 = 34,500
    // sale 12 from the oldest layer: 12 × 11,500 = 1,38,000 → [3 : 34,500][10 : 1,33,330][3 : 34,500]
    assert.deepEqual(f.inward, { qty: 33, value: 2_30_000 + 1_33_330 + 34_500 });
    assert.deepEqual(f.outward, { qty: 27, value: 1_57_500 + 1_38_000 });
    assert.deepEqual(f.closing, { qty: 16, value: 34_500 + 1_33_330 + 34_500, rate: 126.4563 });
  });

  test('tree: Household › Kitchenware › items (sub-groups first, then items by name); empty Grains hidden', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL });
    assert.deepEqual(
      s.rows.map((r) => [r.key, r.level, r.parentKey, r.hasChildren]),
      [
        [`g:${k.groups.household}`, 0, null, true],
        [`g:${k.groups.kitchen}`, 1, `g:${k.groups.household}`, true],
        [`i:${k.I.F}`, 2, `g:${k.groups.kitchen}`, false],
        [`i:${k.I.G}`, 2, `g:${k.groups.kitchen}`, false],
        [`i:${k.I.A}`, 2, `g:${k.groups.kitchen}`, false],
      ],
    );
  });

  test('group rows add up values, and quantities when the items share a unit', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL });
    const g = s.rows.find((r) => r.key === `g:${k.groups.kitchen}`);
    assert.ok(g);
    // closing: A 95,466 + F 2,02,330 + G 95,466 (4 hampers made from 8 tumblers) = 3,93,262; qty 8 + 16 + 4 = 28
    assert.deepEqual(g.closing, { qty: 28, value: 3_93_262, rate: 140.4507 });
    assert.equal(g.unit, 'Nos');
    assert.deepEqual(g.opening, { qty: 20, value: 2_00_000 });
    // 2,00,000 + 8,92,426 − 6,99,164 = 3,93,262
    assert.deepEqual(g.inward, { qty: 70, value: 3_99_130 + 3_97_830 + 95_466 });
    assert.deepEqual(g.outward, { qty: 62, value: 4_03_664 + 2_95_500 });
    assert.deepEqual(s.totals, { openingValue: 2_00_000, inwardValue: 8_92_426, outwardValue: 6_99_164, closingValue: 3_93_262 });
  });

  test('closing total ties to the inventory engine (P&L / Balance Sheet closing stock) for any date', () => {
    for (const to of ['2026-04-30', '2026-05-31', '2026-06-30']) {
      const s = stockSummary(k.t.db, k.t.today, { from: '2026-04-01', to });
      assert.equal(s.totals.closingValue, closingStockValue(k.t.db, { asOf: to, today: k.t.today }), to);
    }
    const may = stockSummary(k.t.db, k.t.today, { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(may.totals.openingValue, openingStockValue(k.t.db, { from: '2026-05-01', today: k.t.today }));
    assert.equal(may.totals.openingValue, 3_93_262, 'May opens with April closing');
  });

  test('a group with items in different units shows no quantity; showZero lists idle items', () => {
    const s = stockSummary(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-06-30', showZero: true });
    const keys = s.rows.map((r) => r.key);
    assert.ok(keys.includes(`i:${k.I.S}`), 'Spare Part never moved but is listed with showZero');
    const spare = s.rows.find((r) => r.key === `i:${k.I.S}`);
    assert.deepEqual(spare?.closing, { qty: 0, value: 0, rate: null });
    // Grains holds only Rice (Kg) → 120 Kg; the June total includes Rice (Kg) and Nos items at the top level.
    const grains = s.rows.find((r) => r.key === `g:${k.groups.grains}`);
    assert.deepEqual(grains?.closing, { qty: 120, value: 7_28_000, rate: 60.6667 });
    assert.equal(grains?.unit, 'Kg');
  });

  test('Add quantities off on a group → its quantity is null even with one unit', () => {
    k.t.db.run('UPDATE stock_groups SET add_quantities = 0 WHERE id = :id', { id: k.groups.kitchen });
    try {
      const s = stockSummary(k.t.db, k.t.today, { ...APRIL });
      const g = s.rows.find((r) => r.key === `g:${k.groups.kitchen}`);
      assert.equal(g?.closing.qty, null);
      assert.equal(g?.closing.rate, null);
      assert.equal(g?.closing.value, 3_93_262);
      assert.equal(g?.unit, null);
    } finally {
      k.t.db.run('UPDATE stock_groups SET add_quantities = 1 WHERE id = :id', { id: k.groups.kitchen });
    }
  });

  test('groupId drills into a group: its children become the top level', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL, groupId: k.groups.household });
    assert.deepEqual(
      s.rows.map((r) => [r.key, r.level]),
      [
        [`g:${k.groups.kitchen}`, 0],
        [`i:${k.I.F}`, 1],
        [`i:${k.I.G}`, 1],
        [`i:${k.I.A}`, 1],
      ],
    );
    assert.equal(s.totals.closingValue, 3_93_262);
    assert.equal(s.groupId, k.groups.household);
  });

  test('categoryId keeps only items of the category (Brand X: A and F)', () => {
    const s = stockSummary(k.t.db, k.t.today, { ...APRIL, categoryId: k.categoryId });
    assert.deepEqual(
      s.rows.filter((r) => r.kind === 'item').map((r) => r.id),
      [k.I.F, k.I.A],
    );
    // 2,02,330 + 95,466 = 2,97,796
    assert.equal(s.totals.closingValue, 2_97_796);
  });

  test('showValues: false gives the same quantities without running the valuation', () => {
    const valued = stockSummary(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-06-30' });
    const qty = stockSummary(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-06-30', showValues: false });
    assert.equal(qty.valuesShown, false);
    assert.deepEqual(
      qty.rows.map((r) => [r.key, r.opening.qty, r.inward.qty, r.outward.qty, r.closing.qty]),
      valued.rows.map((r) => [r.key, r.opening.qty, r.inward.qty, r.outward.qty, r.closing.qty]),
    );
    assert.ok(qty.rows.every((r) => r.closing.value === 0 && r.inward.value === 0));
    assert.deepEqual(qty.totals, { openingValue: 0, inwardValue: 0, outwardValue: 0, closingValue: 0 });
  });

  test('godown filter: Shop holds the 6 tumblers transferred on 15-Jun at the item unit cost', () => {
    const s = stockSummary(k.t.db, k.t.today, { from: '2026-06-01', to: '2026-06-30', godownId: k.godowns.shop });
    const a = s.rows.find((r) => r.key === `i:${k.I.A}`);
    // A overall at 30-Jun: 18 / 2,15,891 → Shop 6 × 2,15,891 / 18 = 71,963.67 → 71,964
    assert.deepEqual(a?.closing, { qty: 6, value: 71_964, rate: 119.94 });
    assert.deepEqual(a?.inward.qty, 6);
    assert.equal(s.rows.filter((r) => r.kind === 'item').length, 1, 'only the tumbler is in the Shop');
  });

  test('optional vouchers never count (the optional sale of 20-Jun leaves A at 18)', () => {
    const s = stockSummary(k.t.db, k.t.today, { from: '2026-06-01', to: '2026-06-30' });
    assert.equal(s.rows.find((r) => r.key === `i:${k.I.A}`)?.closing.qty, 18);
  });

  test('unknown group / category / godown → NOT_FOUND; reversed period → VALIDATION', () => {
    assert.throws(() => stockSummary(k.t.db, k.t.today, { ...APRIL, groupId: 9999 }), /Stock group not found/);
    assert.throws(() => stockSummary(k.t.db, k.t.today, { ...APRIL, categoryId: 9999 }), /Stock category not found/);
    assert.throws(() => stockSummary(k.t.db, k.t.today, { ...APRIL, godownId: 9999 }), /Godown not found/);
    assert.throws(() => stockSummary(k.t.db, k.t.today, { from: '2026-05-01', to: '2026-04-01' }), /ends before it starts/);
  });
});

describe('stock.categorySummary', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Brand X holds A and F; items without a category sit under "Not categorised"', () => {
    const s = categorySummary(k.t.db, k.t.today, { ...APRIL });
    assert.deepEqual(
      s.rows.map((r) => [r.key, r.level, r.closing.value]),
      [
        [`c:${k.categoryId}`, 0, 2_97_796],
        [`i:${k.I.F}`, 1, 2_02_330],
        [`i:${k.I.A}`, 1, 95_466],
        ['c:none', 0, 95_466],
        [`i:${k.I.G}`, 1, 95_466],
      ],
    );
    assert.equal(s.rows.find((r) => r.key === 'c:none')?.name, 'Not categorised');
    // 2,97,796 + 95,466 = 3,93,262 — same total as the group-wise summary
    assert.equal(s.totals.closingValue, 3_93_262);
  });
});

describe('stock.godownSummary', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Main Location and Shop with items; godown values add up to the closing stock', () => {
    const g = godownSummary(k.t.db, k.t.today, { asOf: '2026-06-30' });
    const main = g.rows.find((r) => r.key === `gd:${k.godowns.main}`);
    const shop = g.rows.find((r) => r.key === `gd:${k.godowns.shop}`);
    // A: Main 12 × 2,15,891/18 = 1,43,927.33 → 1,43,927 ; Shop 6 → 71,963.67 → 71,964
    assert.equal(g.rows.find((r) => r.key === `gi:${k.godowns.main}:${k.I.A}`)?.value, 1_43_927);
    assert.equal(g.rows.find((r) => r.key === `gi:${k.godowns.shop}:${k.I.A}`)?.value, 71_964);
    // Main: Rice 7,28,000 + Cable −45,000 (−5 @ ₹90) + Copper 2,02,330 + Hamper 95,466 + Tumbler 1,43,927 = 11,24,723
    assert.equal(main?.value, 11_24_723);
    assert.equal(shop?.value, 71_964);
    assert.equal(g.totalValue, 11_24_723 + 71_964);
    assert.equal(g.totalValue, closingStockValue(k.t.db, { asOf: '2026-06-30', today: k.t.today }));
  });

  test('one godown only; items appear under it with quantity and rate', () => {
    const g = godownSummary(k.t.db, k.t.today, { asOf: '2026-06-30', godownId: k.godowns.shop });
    assert.deepEqual(
      g.rows.map((r) => [r.key, r.level, r.qty]),
      [
        [`gd:${k.godowns.shop}`, 0, null],
        [`gi:${k.godowns.shop}:${k.I.A}`, 1, 6],
      ],
    );
    assert.equal(g.totalValue, 71_964);
  });

  test('before the transfer the Shop is empty and hidden (shown with showZero)', () => {
    const g = godownSummary(k.t.db, k.t.today, { asOf: '2026-06-14' });
    assert.equal(g.rows.some((r) => r.godownId === k.godowns.shop), false);
    const z = godownSummary(k.t.db, k.t.today, { asOf: '2026-06-14', showZero: true });
    assert.deepEqual(z.rows.find((r) => r.godownId === k.godowns.shop)?.value, 0);
  });

  test('an item spread over three godowns: its value is split by quantity so the godowns add up to the paisa', () => {
    const m = stockMasters();
    try {
      const kk = { ...m, V: {} };
      const annex = saveGodown(m.t.ctx, { name: 'Annex' }).id;
      // 3 Nos worth ₹10.00 (opening 3 @ ₹3.3333 = 999.99 → 1,000 paise), one in each godown.
      const odd = m.t.addStockItem({ name: 'Odd Lot', gstRate: 18, hsnSac: '7323', openingQty: 3, openingRate: 3.3333 });
      post(kk, inventoryVoucher(m, 'stock_journal', '2026-04-02', [
        { itemId: odd, qty: 2, rate: 0, isConsumption: true, godownId: m.godowns.main },
        { itemId: odd, qty: 1, rate: 0, godownId: m.godowns.shop },
        { itemId: odd, qty: 1, rate: 0, godownId: annex },
      ]));
      const g = godownSummary(m.t.db, m.t.today, { asOf: '2026-04-30' });
      const parts = g.rows.filter((r) => r.itemId === odd).map((r) => r.value);
      // 1,000 ÷ 3 = 333.33 each; each godown rounded alone would give 3 × 333 = 999 (a paisa short of the Balance Sheet);
      // largest remainder → 334 + 333 + 333 = 1,000
      assert.deepEqual([...parts].sort((a, b) => b - a), [334, 333, 333]);
      assert.equal(g.totalValue, closingStockValue(m.t.db, { asOf: '2026-04-30', today: m.t.today }));
    } finally {
      m.t.close();
    }
  });
});

describe('stock.summary — post-dated vouchers', () => {
  test('a post-dated purchase counts only once the working date reaches it', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      post(k, invoice(m, 'purchase', '2026-07-10', m.L.supreme, [{ itemId: m.I.N, qty: 4, rate: 100 }], { isPostDated: true }));
      const before = stockSummary(m.t.db, m.t.today, { from: '2026-07-01', to: '2026-07-31' });
      assert.equal(before.rows.some((r) => r.key === `i:${m.I.N}`), false, 'working date 30-Jun: not yet in the books');
      const later = stockSummary(m.t.db, '2026-07-10', { from: '2026-07-01', to: '2026-07-31' });
      assert.deepEqual(later.rows.find((r) => r.key === `i:${m.I.N}`)?.closing, { qty: 4, value: 40_000, rate: 100 });
    } finally {
      m.t.close();
    }
  });
});
