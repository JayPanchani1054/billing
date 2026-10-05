import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { getItem } from './items.ts';
import { deletePriceLevel, getPriceList, listPriceLevels, priceFor, savePriceLevel, savePriceList, slabForQty } from './prices.ts';
import { auditRows, postStock } from './testkit.ts';

const fails = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

describe('price levels', () => {
  it('creates, renames, lists and protects price levels', () => {
    const t = createTestCompany();
    const w = savePriceLevel(t.ctx, { name: 'Wholesale' });
    savePriceLevel(t.ctx, { name: 'Retail' });
    assert.throws(() => savePriceLevel(t.ctx, { name: 'wholesale' }), fails('VALIDATION', /already exists/));
    assert.equal(savePriceLevel(t.ctx, { id: w.id, name: 'Dealer' }).name, 'Dealer');
    assert.deepEqual(listPriceLevels(t.db, {}).rows.map((r) => r.name), ['Dealer', 'Retail']);
    const item = t.addStockItem({ name: 'Soap' });
    postStock(t, { baseType: 'sales', date: '2026-04-05', priceLevelId: w.id, lines: [{ itemId: item, qty: -1, rate: 30 }] });
    assert.throws(() => deletePriceLevel(t.ctx, w.id), fails('BUSINESS_RULE', /1 voucher/));
    const r = listPriceLevels(t.db, { search: 'ret' }).rows[0];
    savePriceList(t.ctx, { priceLevelId: r.id, applicableFrom: '2026-04-01', rows: [{ itemId: item, qtyFrom: 0, rate: 40 }] });
    deletePriceLevel(t.ctx, r.id);
    assert.equal(t.db.value('SELECT COUNT(*) FROM price_list WHERE price_level_id = :id', { id: r.id }), 0);
    assert.deepEqual(auditRows(t, 'price_level').map((a) => a.action), ['create', 'create', 'alter', 'delete']);
    t.close();
  });
});

describe('price lists', () => {
  it('saves quantity slabs and selects the slab and the latest list for a date', () => {
    const t = createTestCompany();
    const lvl = savePriceLevel(t.ctx, { name: 'Wholesale' });
    const soap = t.addStockItem({ name: 'Soap', sellingPrice: 3500 });
    const oil = t.addStockItem({ name: 'Oil', sellingPrice: 15000 });
    savePriceList(t.ctx, {
      priceLevelId: lvl.id,
      applicableFrom: '2026-04-01',
      rows: [
        { itemId: soap, qtyFrom: 0, qtyTo: 10, rate: 32, discountPct: 0 },
        { itemId: soap, qtyFrom: 10, qtyTo: 100, rate: 30, discountPct: 2 },
        { itemId: soap, qtyFrom: 100, rate: 28, discountPct: 5 },
        { itemId: oil, qtyFrom: 1, rate: 140 },
      ],
    });
    savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-06-01', rows: [{ itemId: soap, qtyFrom: 0, rate: 33 }] });

    const may = getPriceList(t.db, { priceLevelId: lvl.id, date: '2026-05-15' });
    assert.deepEqual(may.rows.map((r) => [r.itemName, r.applicableFrom, r.slabs.length]), [
      ['Oil', '2026-04-01', 1],
      ['Soap', '2026-04-01', 3],
    ]);
    const june = getPriceList(t.db, { priceLevelId: lvl.id, date: '2026-06-01' });
    assert.deepEqual(june.rows.find((r) => r.itemName === 'Soap')?.slabs, [{ qtyFrom: 0, qtyTo: null, rate: 33, discountPct: 0 }]);
    assert.equal(getPriceList(t.db, { priceLevelId: lvl.id, date: '2026-03-31' }).rows.length, 0);
    assert.equal(getPriceList(t.db, { priceLevelId: lvl.id, date: '2026-03-31', includeAllItems: true }).rows.length, 2);

    // Slab edges: qtyFrom ≤ qty < qtyTo.
    const at = (qty: number, date = '2026-05-15') => priceFor(t.db, { itemId: soap, priceLevelId: lvl.id, date, qty });
    assert.deepEqual(at(9.999), { rate: 32, discountPct: 0, source: 'price_list', applicableFrom: '2026-04-01' });
    assert.equal(at(10).rate, 30);
    assert.equal(at(10).discountPct, 2);
    assert.equal(at(99).rate, 30);
    assert.equal(at(100).rate, 28);
    assert.equal(at(5000).discountPct, 5);
    assert.equal(at(10, '2026-06-02').rate, 33);
    // Before any list, or a quantity outside every slab → the item's default selling price.
    assert.deepEqual(at(10, '2026-03-01'), { rate: 35, discountPct: 0, source: 'item_default' });
    assert.deepEqual(priceFor(t.db, { itemId: oil, priceLevelId: lvl.id, date: '2026-05-01', qty: 0.5 }), {
      rate: 150,
      discountPct: 0,
      source: 'item_default',
    });
    assert.equal(priceFor(t.db, { itemId: oil, date: '2026-05-01', qty: 1 }).source, 'item_default');
    t.close();
  });

  it('rejects overlapping or inverted slabs with the row that is wrong', () => {
    const t = createTestCompany();
    const lvl = savePriceLevel(t.ctx, { name: 'Wholesale' });
    const soap = t.addStockItem({ name: 'Soap' });
    const save = (rows: Array<{ qtyFrom: number; qtyTo?: number | null; rate: number }>) =>
      savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: rows.map((r) => ({ itemId: soap, ...r })) });
    assert.throws(() => save([{ qtyFrom: 0, qtyTo: 10, rate: 1 }, { qtyFrom: 5, qtyTo: 20, rate: 1 }]), (e: unknown) => {
      const d = (e as AppError).details as Array<{ path: string; message: string }>;
      return fails('VALIDATION', /overlaps the slab 0 up to 10/)(e) && d[0].path === 'rows[1].qtyFrom';
    });
    assert.throws(() => save([{ qtyFrom: 0, rate: 1 }, { qtyFrom: 50, rate: 1 }]), fails('VALIDATION', /0 and above/));
    assert.throws(() => save([{ qtyFrom: 10, qtyTo: 10, rate: 1 }]), fails('VALIDATION', /must be more than/));
    assert.throws(() => save([{ qtyFrom: 0, qtyTo: 5, rate: 1 }, { qtyFrom: 0, qtyTo: 5, rate: 2 }]), fails('VALIDATION', /overlaps/));
    assert.throws(
      () => savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: [{ itemId: 999, qtyFrom: 0, rate: 1 }] }),
      fails('VALIDATION', /does not exist/),
    );
    // Touching edges are fine.
    assert.equal(save([{ qtyFrom: 0, qtyTo: 5, rate: 2 }, { qtyFrom: 5, rate: 1 }]).rows[0].slabs.length, 2);
    assert.deepEqual(
      slabForQty([{ qtyFrom: 0, qtyTo: 5, rate: 2, discountPct: 0 }, { qtyFrom: 5, qtyTo: null, rate: 1, discountPct: 0 }], 5)?.rate,
      1,
    );
    t.close();
  });

  it('replaces lists per item and date, clears items, audits and shows on the item detail', () => {
    const t = createTestCompany();
    const lvl = savePriceLevel(t.ctx, { name: 'Retail' });
    const a = t.addStockItem({ name: 'A' });
    const b = t.addStockItem({ name: 'B' });
    savePriceList(t.ctx, {
      priceLevelId: lvl.id,
      applicableFrom: '2026-04-01',
      rows: [
        { itemId: a, qtyFrom: 0, rate: 10 },
        { itemId: b, qtyFrom: 0, rate: 20 },
      ],
    });
    // Re-saving A on the same date replaces its slabs only.
    savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: [{ itemId: a, qtyFrom: 0, rate: 11 }] });
    const detail = getItem(t.db, a, '2026-04-15');
    assert.deepEqual(detail.priceLists, [
      { priceLevelId: lvl.id, priceLevelName: 'Retail', applicableFrom: '2026-04-01', slabs: [{ qtyFrom: 0, qtyTo: null, rate: 11, discountPct: 0 }] },
    ]);
    savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: [], clearItemIds: [b] });
    assert.deepEqual(getPriceList(t.db, { priceLevelId: lvl.id, date: '2026-04-15' }).rows.map((r) => r.itemName), ['A']);
    const audit = auditRows(t, 'price_list');
    assert.deepEqual(audit.map((x) => x.action), ['create', 'alter', 'alter']);
    assert.match(audit[1].entity_label, /Retail price list from 01-Apr-2026/);
    assert.ok(audit[1].before_json?.includes('"rate":10'));
    assert.ok(audit[1].after_json?.includes('"rate":11'));
    // Permission: altering an existing list needs masters.alter.
    const dataEntry = t.ctxAs({ role: 'Data Entry' });
    assert.throws(
      () => savePriceList(dataEntry, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: [{ itemId: a, qtyFrom: 0, rate: 12 }] }),
      fails('FORBIDDEN', /masters.alter/),
    );
    // …while a new date is a creation.
    savePriceList(dataEntry, { priceLevelId: lvl.id, applicableFrom: '2026-05-01', rows: [{ itemId: a, qtyFrom: 0, rate: 12 }] });
    assert.equal(priceFor(t.db, { itemId: a, priceLevelId: lvl.id, date: '2026-05-01', qty: 1 }).rate, 12);
    assert.equal(priceFor(t.db, { itemId: a, date: '2026-05-01', qty: 1, side: 'purchase' }).source, 'item_default');
    t.close();
  });
});
