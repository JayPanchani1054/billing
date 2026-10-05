/**
 * Inventory vouchers: delivery/receipt notes with tracking into invoices, orders, rejections,
 * stock journal, physical stock, godowns and batches.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { getVoucher, trackingRefs } from './queries.ts';
import { cancelVoucher, deleteVoucher, previewVoucher } from './service.ts';
import { entryMap, header, purchaseInput, salesInput, save, setupKit, stockOf, throwsApp, type Kit } from './testkit.ts';

const note = (k: Kit, base: 'delivery_note' | 'receipt_note' | 'sales_order' | 'purchase_order' | 'rejection_in', over: Partial<VoucherInput> = {}): VoucherInput => ({
  voucherTypeId: k.vt[base],
  date: k.t.today,
  mode: 'inventory',
  partyLedgerId: base === 'receipt_note' || base === 'purchase_order' ? k.L.supplier : k.L.acme,
  items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }],
  ...over,
});

const ieRows = (k: Kit, id: number) =>
  k.t.db.all<{ qty: number; affects_stock: number; tracking_ref: string | null; order_ref: string | null; amount: number; godown_id: number; batch_name: string | null }>(
    'SELECT qty, affects_stock, tracking_ref, order_ref, amount, godown_id, batch_name FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no',
    { id },
  );

describe('delivery note → sales invoice', () => {
  it('stock moves once: on the delivery note, not again on the tracked invoice line', () => {
    const k = setupKit();
    const dn = save(k, note(k, 'delivery_note'));
    assert.equal(dn.number, '1');
    assert.equal(stockOf(k, k.I.mixer), 45);
    const h = header(k, dn.id);
    assert.deepEqual([h.affects_books, h.affects_stock, h.total_amount], [0, 1, 100000]);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: dn.id }), 0);
    assert.deepEqual(ieRows(k, dn.id).map((r) => [r.qty, r.tracking_ref, r.affects_stock]), [[-5, '1', 1]]);

    const open = trackingRefs(k.t.db, k.L.acme, 'delivery');
    assert.equal(open.length, 1);
    assert.deepEqual([open[0].ref, open[0].lines[0].qty, open[0].lines[0].pendingQty], ['1', 5, 5]);

    // Invoice 3 of the 5 delivered.
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 3, rate: 200, trackingRef: '1' }] }));
    assert.equal(stockOf(k, k.I.mixer), 45, 'no second stock movement');
    assert.equal(header(k, inv.id).affects_stock, 0);
    assert.deepEqual(ieRows(k, inv.id).map((r) => [r.qty, r.affects_stock, r.tracking_ref]), [[-3, 0, '1']]);
    // Books are posted normally: 600 + CGST 54 + SGST 54 = ₹708.00.
    assert.deepEqual(entryMap(k, inv.id), { 'Acme Traders': 70800, Sales: -60000, 'Output CGST': -5400, 'Output SGST/UTGST': -5400 });
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'delivery')[0].lines[0].pendingQty, 2);
    // The rest.
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1' }] }));
    assert.deepEqual(trackingRefs(k.t.db, k.L.acme, 'delivery'), []);
    // Alter screens see their own consumption as still open.
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'delivery', inv.id)[0].lines[0].pendingQty, 3);
    k.t.close();
  });

  it('a billed delivery note cannot be deleted or cancelled (stock would never move)', () => {
    const k = setupKit();
    const dn = save(k, note(k, 'delivery_note'));
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, trackingRef: '1' }] }));
    throwsApp(() => deleteVoucher(k.t.ctx, dn.id), 'BUSINESS_RULE', /billed in Sales 1/);
    throwsApp(() => cancelVoucher(k.t.ctx, dn.id, 'x'), 'BUSINESS_RULE', /billed in Sales 1/);
    // Once the invoice is gone the note can go too.
    deleteVoucher(k.t.ctx, inv.id);
    deleteVoucher(k.t.ctx, dn.id);
    assert.equal(stockOf(k, k.I.mixer), 50);
    k.t.close();
  });

  it('an unknown tracking reference is flagged (the line would not move stock)', () => {
    const k = setupKit();
    const p = previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, trackingRef: 'DN-404' }] }));
    const w = p.warnings.find((x) => x.code === 'tracking_ref');
    assert.ok(w);
    assert.equal(w?.path, 'items[0]');
    assert.equal(p.inventory[0].affectsStock, false);
    k.t.close();
  });

  it('receipt note → purchase with tracking', () => {
    const k = setupKit();
    const rn = save(k, note(k, 'receipt_note', { items: [{ itemId: k.I.rice, qty: 30, rate: 80 }] }));
    assert.equal(stockOf(k, k.I.rice), 130);
    assert.equal(trackingRefs(k.t.db, k.L.supplier, 'receipt')[0].lines[0].pendingQty, 30);
    save(k, purchaseInput(k, { items: [{ itemId: k.I.rice, qty: 30, rate: 80, trackingRef: '1' }] }));
    assert.equal(stockOf(k, k.I.rice), 130);
    assert.deepEqual(trackingRefs(k.t.db, k.L.supplier, 'receipt'), []);
    assert.equal(header(k, rn.id).affects_books, 0);
    k.t.close();
  });

  it('a delivery note in item-invoice mode computes values but posts nothing', () => {
    const k = setupKit();
    const res = save(k, { ...note(k, 'delivery_note'), mode: 'item_invoice' });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM gst_lines WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(res.totals.grandTotal, 118000, 'challan value incl. GST for printing');
    assert.equal(stockOf(k, k.I.mixer), 45);
    k.t.close();
  });
});

describe('orders', () => {
  it('sales order: no stock movement; pending reduced by delivery notes and direct invoices', () => {
    const k = setupKit();
    const so = save(k, note(k, 'sales_order', { items: [{ itemId: k.I.mixer, qty: 10, rate: 200 }] }));
    assert.equal(stockOf(k, k.I.mixer), 50);
    assert.deepEqual(ieRows(k, so.id).map((r) => [r.qty, r.affects_stock, r.order_ref]), [[-10, 0, '1']]);
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'sales_order')[0].lines[0].pendingQty, 10);
    // Delivery note against the order: 4.
    save(k, note(k, 'delivery_note', { items: [{ itemId: k.I.mixer, qty: 4, rate: 200, orderRef: '1' }] }));
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'sales_order')[0].lines[0].pendingQty, 6);
    // Invoice of that delivery note (tracked) must not reduce the order again.
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 4, rate: 200, trackingRef: '1', orderRef: '1' }] }));
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'sales_order')[0].lines[0].pendingQty, 6);
    // Direct invoice against the order: 2.
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, rate: 200, orderRef: '1' }] }));
    assert.equal(trackingRefs(k.t.db, k.L.acme, 'sales_order')[0].lines[0].pendingQty, 4);
    assert.equal(stockOf(k, k.I.mixer), 50 - 4 - 2);
    k.t.close();
  });

  it('purchase order is open until received', () => {
    const k = setupKit();
    save(k, note(k, 'purchase_order', { items: [{ itemId: k.I.rice, qty: 25, rate: 80 }] }));
    assert.equal(trackingRefs(k.t.db, k.L.supplier, 'purchase_order')[0].lines[0].pendingQty, 25);
    save(k, purchaseInput(k, { items: [{ itemId: k.I.rice, qty: 25, rate: 80, orderRef: '1' }] }));
    assert.deepEqual(trackingRefs(k.t.db, k.L.supplier, 'purchase_order'), []);
    k.t.close();
  });

  it('orders and notes need a party', () => {
    const k = setupKit();
    throwsApp(() => save(k, note(k, 'sales_order', { partyLedgerId: undefined })), 'BUSINESS_RULE', /customer ledger/);
    k.t.close();
  });
});

describe('rejections, stock journal, physical stock', () => {
  it('rejection in brings stock back without touching the books', () => {
    const k = setupKit();
    const res = save(k, note(k, 'rejection_in', { items: [{ itemId: k.I.mixer, qty: 2, rate: 200 }] }));
    assert.equal(stockOf(k, k.I.mixer), 52);
    assert.equal(header(k, res.id).affects_books, 0);
    k.t.close();
  });

  it('stock journal: consumption goes out, production comes in', () => {
    const k = setupKit();
    // Consume 10 bags of rice (₹50) to produce 1 mixer valued at ₹500.
    const res = save(k, {
      voucherTypeId: k.vt.stock_journal,
      date: k.t.today,
      mode: 'inventory',
      items: [
        { itemId: k.I.rice, qty: 10, rate: 50, isConsumption: true },
        { itemId: k.I.mixer, qty: 1, rate: 500 },
      ],
    });
    assert.deepEqual(ieRows(k, res.id).map((r) => [r.qty, r.amount]), [[-10, 50000], [1, 50000]]);
    assert.equal(stockOf(k, k.I.rice), 90);
    assert.equal(stockOf(k, k.I.mixer), 51);
    assert.equal(header(k, res.id).total_amount, 50000);
    assert.equal(header(k, res.id).party_ledger_id, null);
    k.t.close();
  });

  it('physical stock posts the difference between counted and book quantity', () => {
    const k = setupKit();
    save(k, salesInput(k, { date: '2026-04-10', items: [{ itemId: k.I.rice, qty: 3, rate: 100 }] }));
    // Book quantity on 15-Apr: 100 − 3 = 97; counted 95 → adjustment −2.
    const res = save(k, { voucherTypeId: k.vt.physical_stock, date: k.t.today, mode: 'inventory', items: [{ itemId: k.I.rice, qty: 95, rate: 50 }] });
    assert.deepEqual(ieRows(k, res.id).map((r) => [r.qty, r.amount]), [[-2, 10000]]);
    assert.equal(stockOf(k, k.I.rice), 95);
    // The counted quantity is what the user entered (kept for alter/print).
    assert.equal(getVoucher(k.t.db, res.id).input.items?.[0].qty, 95);
    // Re-saving the same count is a no-op adjustment (the voucher's own row is excluded from the book qty).
    save(k, { ...getVoucher(k.t.db, res.id).input });
    assert.equal(stockOf(k, k.I.rice), 95);
    k.t.close();
  });
});

describe('services', () => {
  it('service items never move stock and report UQC NA', () => {
    const k = setupKit();
    const amc = k.t.addStockItem({ name: 'Annual Maintenance', unit: 'Nos', gstRate: 18, hsnSac: '998713', isService: true });
    const res = save(k, salesInput(k, { items: [{ itemId: amc, qty: 1, rate: 5000 }] }));
    const g = k.t.db.get<{ uqc: string; supply_type: string }>('SELECT uqc, supply_type FROM gst_lines WHERE voucher_id = :id', { id: res.id });
    assert.deepEqual(g, { uqc: 'NA', supply_type: 'services' });
    assert.equal(k.t.db.value('SELECT affects_stock FROM inventory_entries WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(header(k, res.id).affects_stock, 0);
    k.t.close();
  });
});

describe('godowns & batches', () => {
  it('lines default to Main Location; an explicit godown is respected', () => {
    const k = setupKit();
    const ts = k.t.clock.now().toISOString();
    const shop = k.t.db.run(`INSERT INTO godowns (guid, name, created_at, updated_at) VALUES ('g-shop', 'Shop Floor', :ts, :ts)`, { ts }).lastInsertRowid;
    const res = save(k, note(k, 'receipt_note', { items: [{ itemId: k.I.rice, qty: 1, rate: 1 }, { itemId: k.I.rice, qty: 2, rate: 1, godownId: shop }] }));
    assert.deepEqual(ieRows(k, res.id).map((r) => r.godown_id), [k.t.ids.mainGodownId, shop]);
    throwsApp(() => save(k, note(k, 'receipt_note', { items: [{ itemId: k.I.rice, qty: 1, rate: 1, godownId: 9999 }] })), 'NOT_FOUND');
    k.t.close();
  });

  it('batch-wise items require a batch when the Batches feature is on', () => {
    const k = setupKit({ features: { batches: true, expiryDates: true } });
    const med = k.t.addStockItem({ name: 'Cough Syrup', gstRate: 12, hsnSac: '3004', maintainBatches: true });
    throwsApp(() => save(k, purchaseInput(k, { items: [{ itemId: med, qty: 10, rate: 40 }] })), 'BUSINESS_RULE', /enter the batch/);
    const res = save(k, purchaseInput(k, { items: [{ itemId: med, qty: 10, rate: 40, batchName: 'B-01', expiryDate: '2027-12-31' }] }));
    const row = k.t.db.get<{ batch_name: string; expiry_date: string }>('SELECT batch_name, expiry_date FROM inventory_entries WHERE voucher_id = :id', { id: res.id });
    assert.deepEqual(row, { batch_name: 'B-01', expiry_date: '2027-12-31' });
    // Items without batches ignore a batch name.
    const plain = save(k, salesInput(k, { items: [{ itemId: k.I.rice, qty: 1, rate: 1, batchName: 'IGNORED' }] }));
    assert.equal(k.t.db.value('SELECT batch_name FROM inventory_entries WHERE voucher_id = :id', { id: plain.id }), null);
    k.t.close();
  });

  it('item invoices are refused when inventory is turned off', () => {
    const k = setupKit({ features: { inventory: false } });
    throwsApp(() => save(k, salesInput(k)), 'BUSINESS_RULE', /Inventory is turned off/);
    k.t.close();
  });
});
