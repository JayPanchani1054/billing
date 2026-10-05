import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { createGstResolver, resolveItemGstProfile, type ItemGstSource } from './gst.ts';
import { saveItem } from './items.ts';
import { saveStockGroup } from './masters.ts';
import { inventoryRoutes } from './routes.ts';

function history(t: TestCompany, type: 'stock_item' | 'stock_group', id: number, from: string, rate: number, extra: { taxability?: string; hsn?: string; cess?: number } = {}): void {
  t.db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
     VALUES (:t, :id, :from, :hsn, :tax, :rate, :cess)`,
    { t: type, id, from, hsn: extra.hsn ?? null, tax: extra.taxability ?? 'taxable', rate, cess: extra.cess ?? 0 },
  );
}

describe('resolveItemGstProfile precedence', () => {
  it('item history beats item columns, by effective date', () => {
    const t = createTestCompany();
    const { item } = saveItem(t.ctx, { name: 'Shoes', unitId: t.ids.units.Nos, hsnSac: '6403', gstRate: 18 });
    history(t, 'stock_item', item.id, '2026-05-01', 12, { hsn: '6403' });
    history(t, 'stock_item', item.id, '2026-09-22', 5, { hsn: '640399' });
    // Before the first history row → the item's own columns.
    assert.deepEqual(resolveItemGstProfile(t.db, item.id, '2026-04-30'), {
      source: 'item',
      sourceId: item.id,
      applicableFrom: null,
      taxability: 'taxable',
      rate: 18,
      cessRate: 0,
      cessPerUnit: 0,
      hsnSac: '6403',
    });
    assert.equal(resolveItemGstProfile(t.db, item.id, '2026-05-01')?.rate, 12);
    const late = resolveItemGstProfile(t.db, item.id, '2026-12-01');
    assert.equal(late?.source, 'item_history');
    assert.equal(late?.applicableFrom, '2026-09-22');
    assert.equal(late?.rate, 5);
    assert.equal(late?.hsnSac, '640399');
    t.close();
  });

  it('falls back to the nearest group (history, then columns), then its parents', () => {
    const t = createTestCompany();
    const top = saveStockGroup(t.ctx, { name: 'Goods', gstRate: 18, hsnSac: '8471' });
    const mid = saveStockGroup(t.ctx, { name: 'Computers', parentId: top.id });
    const leaf = saveStockGroup(t.ctx, { name: 'Laptops', parentId: mid.id });
    const { item } = saveItem(t.ctx, { name: 'ThinkBook', unitId: t.ids.units.Nos, groupId: leaf.id });
    // No item details, no leaf/mid details → top group's columns.
    const p1 = resolveItemGstProfile(t.db, item.id, '2026-06-01');
    assert.equal(p1?.source, 'group');
    assert.equal(p1?.sourceId, top.id);
    assert.equal(p1?.rate, 18);
    // A dated row on the middle group wins from its date (nearest group first).
    history(t, 'stock_group', mid.id, '2026-06-15', 5);
    assert.equal(resolveItemGstProfile(t.db, item.id, '2026-06-14')?.sourceId, top.id);
    const p2 = resolveItemGstProfile(t.db, item.id, '2026-06-15');
    assert.equal(p2?.source, 'group_history');
    assert.equal(p2?.sourceId, mid.id);
    assert.equal(p2?.rate, 5);
    // Leaf group columns are nearer than the middle group's history.
    saveStockGroup(t.ctx, { id: leaf.id, name: 'Laptops', gstRate: 40 });
    assert.equal(resolveItemGstProfile(t.db, item.id, '2026-07-01')?.sourceId, leaf.id);
    // The item's own details beat every group.
    saveItem(t.ctx, { id: item.id, gstRate: 12 });
    assert.equal(resolveItemGstProfile(t.db, item.id, '2026-07-01')?.source, 'item');
    t.close();
  });

  it('returns null when neither item nor groups define GST (caller uses the ledger)', () => {
    const t = createTestCompany();
    const g = saveStockGroup(t.ctx, { name: 'Misc' });
    const { item } = saveItem(t.ctx, { name: 'Thing', unitId: t.ids.units.Nos, groupId: g.id });
    assert.equal(resolveItemGstProfile(t.db, item.id, '2026-06-01'), null);
    const loose = saveItem(t.ctx, { name: 'Loose', unitId: t.ids.units.Nos }).item;
    assert.equal(resolveItemGstProfile(t.db, loose.id, '2026-06-01'), null);
    assert.equal(resolveItemGstProfile(t.db, 99999, '2026-06-01'), null);
    t.close();
  });

  it('ignores incomplete item columns (applicable but no rate) and zeroes non-taxable profiles', () => {
    const t = createTestCompany();
    const g = saveStockGroup(t.ctx, { name: 'Dairy', taxability: 'exempt' });
    // A fixture-style item: gst_applicable = 'applicable' but no rate → falls through to the group.
    const id = t.addStockItem({ name: 'Paneer', groupId: g.id });
    const p = resolveItemGstProfile(t.db, id, '2026-06-01');
    assert.equal(p?.source, 'group');
    assert.equal(p?.taxability, 'exempt');
    assert.equal(p?.rate, 0);
    // History rows with a non-taxable taxability never carry a rate.
    history(t, 'stock_item', id, '2026-04-01', 5, { taxability: 'nil_rated', cess: 2 });
    const h = resolveItemGstProfile(t.db, id, '2026-06-01');
    assert.equal(h?.taxability, 'nil_rated');
    assert.equal(h?.rate, 0);
    assert.equal(h?.cessRate, 0);
    t.close();
  });

  it('takes HSN/SAC from the resolving level, else the first one along the chain', () => {
    const t = createTestCompany();
    const top = saveStockGroup(t.ctx, { name: 'Apparel', hsnSac: '6109' }); // HSN only, no GST details
    const mid = saveStockGroup(t.ctx, { name: 'Shirts', parentId: top.id, gstRate: 5 }); // rate, no HSN
    // Rate from the item, HSN from the nearest group that has one.
    const own = saveItem(t.ctx, { name: 'Polo', unitId: t.ids.units.Nos, groupId: mid.id, gstRate: 12 }).item;
    const p1 = resolveItemGstProfile(t.db, own.id, '2026-06-01');
    assert.deepEqual([p1?.source, p1?.rate, p1?.hsnSac], ['item', 12, '6109']);
    // Rate from the middle group, HSN from the item's own (incomplete) columns, which come first.
    const tee = saveItem(t.ctx, { name: 'Tee', unitId: t.ids.units.Nos, groupId: mid.id, hsnSac: '610910' }).item;
    const p2 = resolveItemGstProfile(t.db, tee.id, '2026-06-01');
    assert.deepEqual([p2?.source, p2?.sourceId, p2?.rate, p2?.hsnSac], ['group', mid.id, 5, '610910']);
    // A history row without HSN falls back to the item's column HSN.
    history(t, 'stock_item', tee.id, '2026-05-01', 18);
    assert.deepEqual(
      [resolveItemGstProfile(t.db, tee.id, '2026-06-01')?.source, resolveItemGstProfile(t.db, tee.id, '2026-06-01')?.hsnSac],
      ['item_history', '610910'],
    );
    // The resolving level's own HSN wins over earlier ones.
    history(t, 'stock_group', mid.id, '2026-04-01', 5, { hsn: '6105' });
    const plain = saveItem(t.ctx, { name: 'Plain', unitId: t.ids.units.Nos, groupId: mid.id }).item;
    assert.equal(resolveItemGstProfile(t.db, plain.id, '2026-06-01')?.hsnSac, '6105');
    t.close();
  });

  it('the bulk resolver matches resolveItemGstProfile for every item and date', () => {
    const t = createTestCompany();
    const a = saveStockGroup(t.ctx, { name: 'A', gstRate: 18, hsnSac: '8471' });
    const b = saveStockGroup(t.ctx, { name: 'B', parentId: a.id, hsnSac: '847130' });
    const c = saveStockGroup(t.ctx, { name: 'C', parentId: b.id, taxability: 'nil_rated' });
    history(t, 'stock_group', b.id, '2026-07-01', 5);
    const ids = [
      saveItem(t.ctx, { name: 'i1', unitId: t.ids.units.Nos, groupId: c.id }).item.id,
      saveItem(t.ctx, { name: 'i2', unitId: t.ids.units.Nos, groupId: b.id }).item.id,
      saveItem(t.ctx, { name: 'i3', unitId: t.ids.units.Nos, groupId: a.id, gstRate: 12 }).item.id,
      saveItem(t.ctx, { name: 'i4', unitId: t.ids.units.Nos }).item.id,
      t.addStockItem({ name: 'i5', groupId: b.id, gstRate: 3 }),
      saveItem(t.ctx, { name: 'i6', unitId: t.ids.units.Nos, groupId: c.id, hsnSac: '0401' }).item.id,
    ];
    history(t, 'stock_item', ids[1], '2026-08-01', 40);
    for (const date of ['2026-04-01', '2026-06-30', '2026-07-01', '2026-08-01', '2027-03-31']) {
      const resolve = createGstResolver(t.db, date);
      for (const id of ids) {
        const row = t.db.get<ItemGstSource>(
          'SELECT id, group_id, gst_applicable, gst_taxability, gst_rate, cess_rate, cess_per_unit, hsn_sac FROM stock_items WHERE id = :id',
          { id },
        ) as ItemGstSource;
        assert.deepEqual(resolve(row), resolveItemGstProfile(t.db, id, date), `item ${id} on ${date}`);
      }
    }
    t.close();
  });

  it("is exposed as 'inventory.item.gstProfile'", async () => {
    const t = createTestCompany();
    const id = t.addStockItem({ name: 'Widget', gstRate: 18, hsnSac: '8471' });
    const p = await t.callOk<{ rate: number; source: string }>(inventoryRoutes, 'inventory.item.gstProfile', { itemId: id, date: '2026-04-15' });
    assert.equal(p.rate, 18);
    assert.equal(p.source, 'item_history'); // the fixture records history from books beginning
    const missing = await t.call(inventoryRoutes, 'inventory.item.gstProfile', { itemId: 4242, date: '2026-04-15' });
    assert.equal(missing.ok, false);
    t.close();
  });
});
