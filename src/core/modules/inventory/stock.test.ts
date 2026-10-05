import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { saveItem } from './items.ts';
import { inventoryRoutes } from './routes.ts';
import { batchesFor, stockByItem, stockOnHand } from './stock.ts';
import { addGodown, postStock, purchase, sale, salesReturn, stockJournal } from './testkit.ts';

describe('stockOnHand', () => {
  it('adds openings and movements up to the as-of date', () => {
    const t = createTestCompany();
    const item = t.addStockItem({ name: 'Widget', openingQty: 10, openingRate: 100 });
    purchase(t, '2026-04-05', item, 20, 110);
    sale(t, '2026-04-10', item, 15, 150);
    salesReturn(t, '2026-04-12', item, 2, 150);
    sale(t, '2026-04-20', item, 0.5, 150);
    const at = (asOf: string) => stockOnHand(t.db, { itemId: item, asOf });
    assert.equal(at('2026-04-01'), 10);
    assert.equal(at('2026-04-05'), 30);
    assert.equal(at('2026-04-11'), 15);
    assert.equal(at('2026-04-12'), 17);
    assert.equal(at('2026-04-30'), 16.5);
    t.close();
  });

  it('keeps godowns apart, including stock journal transfers', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = addGodown(t, 'Warehouse');
    const main = t.ids.mainGodownId;
    const item = t.addStockItem({ name: 'Tile', openingQty: 100, openingRate: 40, godownId: wh });
    sale(t, '2026-04-03', item, 10, 60, { godownId: wh });
    stockJournal(t, '2026-04-05', [{ itemId: item, qty: 30, godownId: wh }], [{ itemId: item, qty: 30, godownId: main }]);
    sale(t, '2026-04-06', item, 5, 60, { godownId: main });
    const q = (godownId: number) => stockOnHand(t.db, { itemId: item, godownId, asOf: '2026-04-30' });
    assert.equal(q(wh), 60);
    assert.equal(q(main), 25);
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30' }), 85);
    assert.equal(stockOnHand(t.db, { itemId: item, godownId: main, asOf: '2026-04-04' }), 0);
    // An entry without a godown counts in Main Location.
    postStock(t, { baseType: 'purchase', date: '2026-04-07', lines: [{ itemId: item, qty: 4, rate: 40, godownId: null }] });
    assert.equal(q(main), 29);
    t.close();
  });

  it('excludes optional, cancelled, non-stock lines, orders and memoranda; post-dated waits for its date', () => {
    const t = createTestCompany({ today: '2026-04-15' });
    const item = t.addStockItem({ name: 'Bolt', openingQty: 50, openingRate: 2 });
    sale(t, '2026-04-02', item, 5, 3, { optional: true });
    sale(t, '2026-04-03', item, 7, 3, { cancelled: true });
    sale(t, '2026-04-04', item, 9, 3, { affectsStock: false }); // e.g. invoice line tracked against a delivery note
    postStock(t, { baseType: 'sales_order', date: '2026-04-05', lines: [{ itemId: item, qty: -11, rate: 3 }] });
    postStock(t, { baseType: 'memorandum', date: '2026-04-05', lines: [{ itemId: item, qty: -13, rate: 3 }] });
    sale(t, '2026-04-20', item, 4, 3, { postDated: true });
    sale(t, '2026-04-06', item, 1, 3);
    const today = t.today;
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30', today }), 49, 'post-dated sale not yet effective');
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30', today: '2026-04-20' }), 45, 'post-dated sale effective on its date');
    // Without a working date, post-dated vouchers up to asOf count.
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30' }), 45);
    t.close();
  });

  it('can leave out the voucher being altered', () => {
    const t = createTestCompany();
    const item = t.addStockItem({ name: 'Nut', openingQty: 10, openingRate: 1 });
    const v = sale(t, '2026-04-05', item, 8, 2);
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30' }), 2);
    assert.equal(stockOnHand(t.db, { itemId: item, asOf: '2026-04-30', excludeVoucherId: v }), 10);
    t.close();
  });
});

describe('batches', () => {
  it('lists batches with stock in FEFO order and filters stockOnHand by batch (case-insensitive)', () => {
    const t = createTestCompany({ features: { batches: true, expiryDates: true, multipleGodowns: true } });
    const wh = addGodown(t, 'Cold Room');
    const { item } = saveItem(t.ctx, {
      name: 'Insulin',
      unitId: t.ids.units.Nos,
      maintainBatches: true,
      useExpiry: true,
      openings: [
        { godownId: t.ids.mainGodownId, batchName: 'B-LATE', expiryDate: '2027-06-30', qty: 10, rate: 300 },
        { godownId: t.ids.mainGodownId, batchName: 'B-NOEXP', qty: 3, rate: 300 },
      ],
    });
    purchase(t, '2026-04-05', item.id, 20, 310, { batchName: 'B-SOON', expiryDate: '2026-12-31', mfgDate: '2026-01-01' });
    purchase(t, '2026-04-06', item.id, 5, 310, { batchName: 'B-MID', expiryDate: '2027-01-31', godownId: wh });
    sale(t, '2026-04-08', item.id, 20, 400, { batchName: 'b-soon' }); // fully consumed (case-insensitive)
    sale(t, '2026-04-09', item.id, 4, 400, { batchName: 'B-LATE' });
    const list = batchesFor(t.db, item.id, undefined, '2026-04-30');
    assert.deepEqual(list, [
      { batchName: 'B-MID', mfgDate: null, expiryDate: '2027-01-31', qty: 5 },
      { batchName: 'B-LATE', mfgDate: null, expiryDate: '2027-06-30', qty: 6 },
      { batchName: 'B-NOEXP', mfgDate: null, expiryDate: null, qty: 3 },
    ]);
    // Before the sale, B-SOON (earliest expiry) comes first.
    assert.equal(batchesFor(t.db, item.id, undefined, '2026-04-07')[0].batchName, 'B-SOON');
    assert.equal(batchesFor(t.db, item.id, undefined, '2026-04-07')[0].mfgDate, '2026-01-01');
    assert.deepEqual(batchesFor(t.db, item.id, wh, '2026-04-30').map((b) => b.batchName), ['B-MID']);
    assert.equal(stockOnHand(t.db, { itemId: item.id, batchName: 'b-late', asOf: '2026-04-30' }), 6);
    assert.equal(stockOnHand(t.db, { itemId: item.id, batchName: 'B-SOON', asOf: '2026-04-30' }), 0);
    t.close();
  });
});

describe('bulk quantities and routes', () => {
  it('stockByItem gives one quantity per item, optionally per godown', () => {
    const t = createTestCompany();
    const a = t.addStockItem({ name: 'A', openingQty: 5, openingRate: 1 });
    const b = t.addStockItem({ name: 'B' });
    purchase(t, '2026-04-02', b, 0.1, 1);
    purchase(t, '2026-04-02', b, 0.2, 1);
    const m = stockByItem(t.db, { asOf: '2026-04-30' });
    assert.equal(m.get(a), 5);
    assert.equal(m.get(b), 0.3); // 0.1 + 0.2 without float noise
    assert.equal(stockByItem(t.db, { asOf: '2026-04-30', itemIds: [b] }).has(a), false);
    t.close();
  });

  it("serves 'inventory.stockOnHand' and 'inventory.batches' with the working date for post-dated vouchers", async () => {
    const t = createTestCompany({ today: '2026-04-15', features: { batches: true } });
    const item = t.addStockItem({ name: 'Cream', maintainBatches: true, openingQty: 8, openingRate: 50, batchName: 'C1' });
    sale(t, '2026-04-25', item, 3, 80, { batchName: 'C1', postDated: true });
    const r = await t.callOk<{ qty: number; batchName: string | null }>(inventoryRoutes, 'inventory.stockOnHand', { itemId: item, asOf: '2026-04-30' });
    assert.equal(r.qty, 8);
    assert.equal(r.batchName, null);
    const b = await t.callOk<Array<{ batchName: string; qty: number }>>(inventoryRoutes, 'inventory.batches', { itemId: item, asOf: '2026-04-30' });
    assert.deepEqual(b.map((x) => [x.batchName, x.qty]), [['C1', 8]]);
    const missing = await t.call(inventoryRoutes, 'inventory.stockOnHand', { itemId: 777, asOf: '2026-04-30' });
    assert.equal(missing.ok ? null : missing.error.code, 'NOT_FOUND');
    t.close();
  });
});
