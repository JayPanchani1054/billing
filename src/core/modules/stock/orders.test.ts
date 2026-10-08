import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { trackingRefs } from '../vouchers/queries.ts';
import { pendingOrders, reorderStatus } from './orders.ts';
import { inventoryVoucher, invoice, post, stockMasters, stockScenario, type StockKit } from './testkit.ts';

describe('stock.pendingOrders', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('purchase order 1: 50 ordered, 20 received, 30 pending worth ₹3,600, overdue since 25-May', () => {
    const r = pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-06-30' });
    assert.equal(r.rows.length, 1);
    const l = r.rows[0];
    assert.deepEqual(
      [l.orderNo, l.partyName, l.itemName, l.orderedQty, l.fulfilledQty, l.pendingQty, l.rate, l.pendingValue, l.dueDate, l.overdueDays],
      // 30 × ₹120 = 3,60,000 paise; 25-May → 30-Jun = 6 + 30 = 36 days
      ['1', 'Supreme Suppliers', 'Steel Tumbler', 50, 20, 30, 120, 3_60_000, '2026-05-25', 36],
    );
    assert.deepEqual(r.totals, { orders: 1, pendingValue: 3_60_000, overdueLines: 1 });
  });

  test('sales order 1: 10 ordered, 4 delivered, 6 pending; no due date → never overdue', () => {
    const r = pendingOrders(k.t.db, { kind: 'sales', asOf: '2026-06-30' });
    assert.deepEqual(
      r.rows.map((l) => [l.partyName, l.orderedQty, l.fulfilledQty, l.pendingQty, l.pendingValue, l.overdueDays]),
      // 6 × ₹170 = 1,02,000
      [['Metro Retail', 10, 4, 6, 1_02_000, null]],
    );
  });

  test('as of an earlier date: the receipt note of 20-May has not happened yet; before the order date nothing is pending', () => {
    assert.deepEqual(
      pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-05-19' }).rows.map((l) => [l.pendingQty, l.overdueDays]),
      [[50, null]],
    );
    assert.deepEqual(pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-05-14' }).rows, []);
  });

  test('agrees with the vouchers module tracking (vouchers.trackingRefs) as of today', () => {
    const open = trackingRefs(k.t.db, k.L.supreme, 'purchase_order');
    assert.deepEqual(open.map((d) => d.lines.map((x) => x.pendingQty)), [[30]]);
  });
});

describe('order fulfilment rules', () => {
  test('an invoice billing a delivery note that fulfilled the order is not counted twice; a direct invoice is', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      post(k, inventoryVoucher(m, 'sales_order', '2026-06-01', [{ itemId: m.I.A, qty: 8, rate: 150 }], { partyLedgerId: m.L.acme }));
      post(k, inventoryVoucher(m, 'delivery_note', '2026-06-02', [{ itemId: m.I.A, qty: 3, rate: 150, orderRef: '1' }], { partyLedgerId: m.L.acme }));
      post(k, invoice(m, 'sales', '2026-06-03', m.L.acme, [{ itemId: m.I.A, qty: 3, rate: 150, trackingRef: '1', orderRef: '1' }]));
      post(k, invoice(m, 'sales', '2026-06-04', m.L.acme, [{ itemId: m.I.A, qty: 2, rate: 150, orderRef: '1' }]));
      // ordered 8 − delivered 3 (note) − invoiced directly 2 = 3 pending (the billing invoice adds nothing)
      const r = pendingOrders(m.t.db, { kind: 'sales', asOf: '2026-06-30' });
      assert.deepEqual(r.rows.map((l) => [l.fulfilledQty, l.pendingQty]), [[5, 3]]);
    } finally {
      m.t.close();
    }
  });

  test('cancelled and optional orders are not pending', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      post(k, inventoryVoucher(m, 'purchase_order', '2026-06-01', [{ itemId: m.I.A, qty: 5, rate: 100 }], { partyLedgerId: m.L.supreme, isOptional: true }));
      assert.deepEqual(pendingOrders(m.t.db, { kind: 'purchase', asOf: '2026-06-30' }).rows, []);
    } finally {
      m.t.close();
    }
  });
});

describe('stock.reorder', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Steel Tumbler: closing 18 + pending PO 30 − pending SO 6 = 42 < level 50 → short 8, order the minimum 25', () => {
    const r = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' });
    assert.equal(r.itemsWithLevel, 1);
    assert.deepEqual(r.rows, [
      {
        itemId: k.I.A,
        name: 'Steel Tumbler',
        unit: 'Nos',
        groupName: 'Kitchenware',
        closingQty: 18,
        reorderLevel: 50,
        minOrderQty: 25,
        pendingPurchaseQty: 30,
        pendingSalesQty: 6,
        netAvailable: 42,
        shortfall: 8,
        suggestedQty: 25,
      },
    ]);
  });

  test('without a minimum order quantity the suggestion is the shortfall; above the level nothing is listed', () => {
    k.t.db.run('UPDATE stock_items SET min_order_qty = NULL WHERE id = :id', { id: k.I.A });
    try {
      assert.equal(reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' }).rows[0].suggestedQty, 8);
    } finally {
      k.t.db.run('UPDATE stock_items SET min_order_qty = 25 WHERE id = :id', { id: k.I.A });
    }
    k.t.db.run('UPDATE stock_items SET reorder_level = 10 WHERE id = :id', { id: k.I.A });
    try {
      const r = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' });
      assert.deepEqual(r.rows, []);
      assert.equal(r.itemsWithLevel, 1);
    } finally {
      k.t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: k.I.A });
    }
  });

  test('stock below the level but covered by open purchase orders: listed with no order to place', () => {
    k.t.db.run('UPDATE stock_items SET reorder_level = 40 WHERE id = :id', { id: k.I.A });
    try {
      const [row] = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' }).rows;
      // net 42 ≥ 40 → no shortfall, but on hand 18 < 40
      assert.deepEqual([row.closingQty, row.netAvailable, row.shortfall, row.suggestedQty], [18, 42, 0, 0]);
    } finally {
      k.t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: k.I.A });
    }
  });
});
