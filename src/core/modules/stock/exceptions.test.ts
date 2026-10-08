import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { batchSummary, negativeStock } from './exceptions.ts';
import { inventoryVoucher, invoice, post, stockMasters, stockScenario, type StockKit } from './testkit.ts';

describe('stock.negative', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Cable Roll sold before any purchase: −5 since 05-Jun, valued at the purchase price (−5 × ₹90)', () => {
    const r = negativeStock(k.t.db, k.t.today, { asOf: '2026-06-30' });
    assert.deepEqual(r.rows, [
      {
        itemId: k.I.N,
        name: 'Cable Roll',
        unit: 'Nos',
        groupName: null,
        qty: -5,
        value: -45_000,
        negativeSince: '2026-06-05',
        godowns: [{ godownId: k.godowns.main, godownName: 'Main Location', qty: -5, negativeSince: '2026-06-05' }],
      },
    ]);
  });

  test('before the sale nothing is negative; a later purchase clears it', () => {
    assert.deepEqual(negativeStock(k.t.db, k.t.today, { asOf: '2026-06-04' }).rows, []);
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      post(kk, invoice(m, 'sales', '2026-06-05', m.L.metro, [{ itemId: m.I.N, qty: 5, rate: 200 }]));
      post(kk, invoice(m, 'purchase', '2026-06-08', m.L.supreme, [{ itemId: m.I.N, qty: 10, rate: 95 }]));
      assert.equal(negativeStock(m.t.db, m.t.today, { asOf: '2026-06-07' }).rows.length, 1);
      assert.deepEqual(negativeStock(m.t.db, m.t.today, { asOf: '2026-06-30' }).rows, []);
    } finally {
      m.t.close();
    }
  });

  test('negative in one godown while the item total is positive is still reported', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      // A: opening 10 at Main; 2 sold out of the Shop (which holds nothing) on 10-Jun
      post(kk, invoice(m, 'sales', '2026-06-10', m.L.acme, [{ itemId: m.I.A, qty: 2, rate: 150, godownId: m.godowns.shop }]));
      const r = negativeStock(m.t.db, m.t.today, { asOf: '2026-06-30' });
      assert.equal(r.rows.length, 1);
      const [row] = r.rows;
      assert.equal(row.qty, 8);
      assert.equal(row.negativeSince, null);
      assert.deepEqual(row.godowns, [{ godownId: m.godowns.shop, godownName: 'Shop', qty: -2, negativeSince: '2026-06-10' }]);
    } finally {
      m.t.close();
    }
  });
});

describe('stock.batches', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Rice batches on 30-Jun (FEFO): B1 70 Kg expiring in 15 days, B2 50 Kg fine', () => {
    const r = batchSummary(k.t.db, k.t.today, { asOf: '2026-06-30' });
    assert.equal(r.windowDays, 30);
    assert.deepEqual(
      r.rows.map((b) => [b.itemName, b.batchName, b.qty, b.mfgDate, b.expiryDate, b.daysToExpiry, b.status]),
      [
        // 100 bought − 30 sold = 70; 30-Jun → 15-Jul = 15 days
        ['Basmati Rice', 'B1', 70, '2026-01-15', '2026-07-15', 15, 'expiring'],
        // 30-Jun → 31-Dec = 184 days
        ['Basmati Rice', 'B2', 50, null, '2026-12-31', 184, 'ok'],
      ],
    );
  });

  test('expiringWithinDays keeps only expired / expiring batches; after the date B1 is expired', () => {
    assert.deepEqual(batchSummary(k.t.db, k.t.today, { asOf: '2026-06-30', expiringWithinDays: 10 }).rows, []);
    assert.deepEqual(
      batchSummary(k.t.db, k.t.today, { asOf: '2026-07-20', itemId: k.I.R, expiringWithinDays: 7 }).rows.map((b) => [b.batchName, b.daysToExpiry, b.status]),
      [['B1', -5, 'expired']],
    );
  });

  test('items without batches are not listed; unknown item → NOT_FOUND', () => {
    assert.deepEqual(batchSummary(k.t.db, k.t.today, { asOf: '2026-06-30', itemId: k.I.A }).rows, []);
    assert.throws(() => batchSummary(k.t.db, k.t.today, { asOf: '2026-06-30', itemId: 9999 }), /Stock item not found/);
  });

  test('a batch fully sold drops out', () => {
    const m = stockMasters();
    const kk = { ...m, V: {} };
    try {
      post(kk, invoice(m, 'purchase', '2026-06-01', m.L.bharat, [{ itemId: m.I.R, qty: 10, rate: 60, batchName: 'X1', expiryDate: '2026-09-30' }]));
      post(kk, inventoryVoucher(m, 'stock_journal', '2026-06-02', [{ itemId: m.I.R, qty: 10, rate: 0, isConsumption: true, batchName: 'X1' }, { itemId: m.I.G, qty: 1, rate: 0 }]));
      assert.deepEqual(batchSummary(m.t.db, m.t.today, { asOf: '2026-06-30' }).rows, []);
      assert.equal(batchSummary(m.t.db, m.t.today, { asOf: '2026-06-01' }).rows[0].qty, 10);
    } finally {
      m.t.close();
    }
  });
});
