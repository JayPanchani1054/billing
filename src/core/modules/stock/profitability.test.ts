import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gpPercent, physicalVariance, profitability } from './profitability.ts';
import { APRIL, inventoryVoucher, invoice, post, stockMasters, stockScenario, type StockKit } from './testkit.ts';

describe('stock.profitability', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('April, Steel Tumbler (Average Cost): net sales ₹3,720, cost ₹2,723.98, GP ₹996.02 (26.77%)', () => {
    const r = profitability(k.t.db, k.t.today, { ...APRIL });
    const a = r.rows.find((x) => x.itemId === k.I.A);
    assert.ok(a);
    // sales 15 @ 150 + 12 @ 160 = 2,25,000 + 1,92,000 = 4,17,000; return 3 @ 150 = 45,000 → net 3,72,000
    assert.deepEqual([a.salesQty, a.salesValue, a.returnsQty, a.returnsValue, a.netQty, a.netSales], [27, 4_17_000, 3, 45_000, 24, 3_72_000]);
    // cost: 1,65,000 + 1,43,198 sold − 35,800 returned at cost = 2,72,398 (the stock journal's 95,466 is not cost of sales)
    assert.equal(a.cost, 2_72_398);
    // 3,72,000 − 2,72,398 = 99,602 → 99,602 / 3,72,000 = 26.7747% → 26.77
    assert.equal(a.grossProfit, 99_602);
    assert.equal(a.gpPercent, 26.77);
  });

  test('April, Copper Bottle (FIFO): cost 1,57,500 + 1,38,000 − 34,500 = 2,61,000, GP ₹1,110 (29.84%)', () => {
    const r = profitability(k.t.db, k.t.today, { ...APRIL });
    const f = r.rows.find((x) => x.itemId === k.I.F);
    assert.ok(f);
    assert.equal(f.cost, 2_61_000);
    // 3,72,000 − 2,61,000 = 1,11,000 → 29.8387% → 29.84
    assert.deepEqual([f.netSales, f.grossProfit, f.gpPercent], [3_72_000, 1_11_000, 29.84]);
    // totals: 7,44,000 net, 5,33,398 cost, 2,10,602 GP → 28.3067% → 28.31
    assert.deepEqual(r.totals, { netSales: 7_44_000, cost: 5_33_398, grossProfit: 2_10_602, gpPercent: 28.31 });
    assert.deepEqual(r.rows.map((x) => x.itemId), [k.I.F, k.I.A], 'highest gross profit first');
  });

  test('May: the invoice billing delivery note 1 is costed at the note (59,666); the un-invoiced note 2 is not cost of sales', () => {
    const r = profitability(k.t.db, k.t.today, { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(r.rows.length, 1);
    const [a] = r.rows;
    // 5 @ 160 = 80,000; cost 5 × 95,466/8 = 59,666.25 → 59,666; GP 20,334 → 25.4175% → 25.42
    assert.deepEqual([a.salesQty, a.netSales, a.cost, a.grossProfit, a.gpPercent], [5, 80_000, 59_666, 20_334, 25.42]);
  });

  test('June: Rice 30 Kg costs 1,82,000; Cable Roll sold short is costed at its purchase price ₹90 = 45,000', () => {
    const r = profitability(k.t.db, k.t.today, { from: '2026-06-01', to: '2026-06-30' });
    const by = new Map(r.rows.map((x) => [x.itemId, x]));
    // Rice: 150 Kg worth 6,00,000 + 3,10,000 = 9,10,000 → 30 × 9,10,000/150 = 1,82,000; sales 30 @ 80 = 2,40,000
    assert.deepEqual([by.get(k.I.R)?.netSales, by.get(k.I.R)?.cost, by.get(k.I.R)?.grossProfit], [2_40_000, 1_82_000, 58_000]);
    // Cable Roll: 5 @ 200 = 1,00,000; cost 5 × 9,000 = 45,000
    assert.deepEqual([by.get(k.I.N)?.netSales, by.get(k.I.N)?.cost], [1_00_000, 45_000]);
    assert.equal(by.has(k.I.A), false, 'the optional sale of 20-Jun is not in the books; the transfer is not a sale');
  });

  test('group filter and GP % edge cases', () => {
    const r = profitability(k.t.db, k.t.today, { ...APRIL, groupId: k.groups.grains });
    assert.deepEqual(r.rows, []);
    assert.equal(r.totals.gpPercent, null);
    assert.equal(gpPercent(0, 0), null);
    assert.equal(gpPercent(-500, 1000), -50);
  });

  test('a credit note tracked against a rejection-in is costed at the rejection note', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      post(kk, invoice(m, 'sales', '2026-06-02', m.L.acme, [{ itemId: m.I.A, qty: 4, rate: 150 }]));
      post(kk, inventoryVoucher(m, 'rejection_in', '2026-06-05', [{ itemId: m.I.A, qty: 1, rate: 150 }], { partyLedgerId: m.L.acme }));
      post(kk, invoice(m, 'credit_note', '2026-06-06', m.L.acme, [{ itemId: m.I.A, qty: 1, rate: 150, trackingRef: '1' }]));
      const [a] = profitability(m.t.db, m.t.today, { from: '2026-06-01', to: '2026-06-30' }).rows;
      // sold 4 at cost ₹100 = 40,000; 1 came back on the rejection note at cost 10,000 → cost 30,000
      // net sales 60,000 − 15,000 = 45,000 → GP 15,000 (33.33%)
      assert.deepEqual([a.salesValue, a.returnsValue, a.netSales, a.cost, a.grossProfit, a.gpPercent], [60_000, 15_000, 45_000, 30_000, 15_000, 33.33]);
    } finally {
      m.t.close();
    }
  });

  test('a debit note to a customer (price revision) adds sales value without quantity or cost; a purchase return is not a sale', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      post(kk, invoice(m, 'sales', '2026-06-02', m.L.acme, [{ itemId: m.I.A, qty: 4, rate: 150 }]));
      // Upward revision of ₹10 a unit on the 4 tumblers already delivered (value only).
      post(kk, { ...invoice(m, 'sales', '2026-06-03', m.L.acme, [{ itemId: m.I.A, qty: 4, rate: 10 }]), voucherTypeId: m.vt.debit_note });
      // A purchase return (debit note to a supplier) of 1 tumbler.
      post(kk, { ...invoice(m, 'sales', '2026-06-04', m.L.supreme, [{ itemId: m.I.A, qty: 1, rate: 100 }]), voucherTypeId: m.vt.debit_note });
      const r = profitability(m.t.db, m.t.today, { from: '2026-06-01', to: '2026-06-30' });
      const [a] = r.rows;
      // sales 4 × 150 = 60,000 + revision 4 × 10 = 4,000 → 64,000; quantity 4 (the note adds none);
      // cost 4 × ₹100 = 40,000 (the note moves no stock) → GP 24,000 = 37.5%
      assert.deepEqual([a.salesQty, a.salesValue, a.returnsValue, a.netQty, a.netSales, a.cost, a.grossProfit, a.gpPercent], [4, 64_000, 0, 4, 64_000, 40_000, 24_000, 37.5]);
      // = the Sales ledger of the P&L: Cr 60,000 + Cr 4,000
      const salesLedger = -(m.t.db.value<number>(
        `SELECT SUM(le.amount) FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE l.name = 'Sales' AND le.affects_books = 1`,
      ) ?? 0);
      assert.equal(r.totals.netSales, salesLedger);
    } finally {
      m.t.close();
    }
  });
});

describe('stock.physicalVariance', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('12-May count of Steel Tumbler: counted 2, book 3, shortage 1 at cost 11,933', () => {
    const r = physicalVariance(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(
      r.rows.map((x) => [x.date, x.number, x.itemName, x.godownName, x.countedQty, x.bookQty, x.differenceQty, x.value]),
      // 35,800 / 3 = 11,933.33 → 11,933
      [['2026-05-12', '1', 'Steel Tumbler', 'Main Location', 2, 3, -1, -11_933]],
    );
    assert.deepEqual(r.totals, { gainValue: 0, lossValue: 11_933, netValue: -11_933 });
    assert.deepEqual(physicalVariance(k.t.db, k.t.today, { ...APRIL }).rows, []);
  });

  test('a gain is valued at current cost and a matching count shows a zero difference', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      // A opening 10 @ ₹100 (book 10) → counted 12: +2 at ₹100; F counted 10 = book → difference 0
      post(kk, inventoryVoucher(m, 'physical_stock', '2026-06-10', [{ itemId: m.I.A, qty: 12, rate: 0 }, { itemId: m.I.F, qty: 10, rate: 0 }]));
      const r = physicalVariance(m.t.db, m.t.today, { from: '2026-06-01', to: '2026-06-30' });
      assert.deepEqual(r.rows.map((x) => [x.itemName, x.countedQty, x.bookQty, x.differenceQty, x.value]), [
        ['Steel Tumbler', 12, 10, 2, 20_000],
        ['Copper Bottle', 10, 10, 0, 0],
      ]);
      assert.deepEqual(r.totals, { gainValue: 20_000, lossValue: 0, netValue: 20_000 });
    } finally {
      m.t.close();
    }
  });

  test('one item counted in two racks (two lines, same godown): one row with the real book quantity', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      // A book 10 @ ₹100. Rack 1: 2, rack 2: 3 → counted 5. The posting engine stores 2 − 10 = −8 on the first line
      // and +3 on the second (net −5). Value: issue 8 at ₹100 = 80,000, then 3 back at the cost then (₹100) = 30,000
      // → loss 50,000.
      post(kk, inventoryVoucher(m, 'physical_stock', '2026-06-10', [{ itemId: m.I.A, qty: 2, rate: 0 }, { itemId: m.I.A, qty: 3, rate: 0 }]));
      const r = physicalVariance(m.t.db, m.t.today, { from: '2026-06-01', to: '2026-06-30' });
      assert.deepEqual(r.rows.map((x) => [x.itemName, x.countedQty, x.bookQty, x.differenceQty, x.value]), [['Steel Tumbler', 5, 10, -5, -50_000]]);
      assert.deepEqual(r.totals, { gainValue: 0, lossValue: 50_000, netValue: -50_000 });
    } finally {
      m.t.close();
    }
  });
});
