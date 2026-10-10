/**
 * createDatedGstResolver (final wave, perf): one resolver for many (item, date) pairs — ITC-04 resolves
 * every challan line on its own date with it — must give exactly what resolveItemGstProfile gives, and
 * its cost must not depend on the number of pairs resolved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { recordSql } from '../../testing/sqlPlans.ts';
import { createDatedGstResolver, resolveItemGstProfile } from './gst.ts';
import { saveItem } from './items.ts';
import { saveStockGroup } from './masters.ts';

function history(t: TestCompany, type: 'stock_item' | 'stock_group', id: number, from: string, rate: number, extra: { taxability?: string; hsn?: string; cess?: number } = {}): void {
  t.db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
     VALUES (:t, :id, :from, :hsn, :tax, :rate, :cess)`,
    { t: type, id, from, hsn: extra.hsn ?? null, tax: extra.taxability ?? 'taxable', rate, cess: extra.cess ?? 0 },
  );
}

describe('createDatedGstResolver', () => {
  it('matches resolveItemGstProfile for every item on every date (item / group history, columns, HSN fall-back)', () => {
    const t = createTestCompany();
    const a = saveStockGroup(t.ctx, { name: 'A', gstRate: 18, hsnSac: '8471' });
    const b = saveStockGroup(t.ctx, { name: 'B', parentId: a.id, hsnSac: '847130' });
    const c = saveStockGroup(t.ctx, { name: 'C', parentId: b.id, taxability: 'nil_rated' });
    history(t, 'stock_group', b.id, '2026-07-01', 5);
    history(t, 'stock_group', a.id, '2026-09-01', 28, { hsn: '8471' });
    const ids = [
      saveItem(t.ctx, { name: 'i1', unitId: t.ids.units.Nos, groupId: c.id }).item.id,
      saveItem(t.ctx, { name: 'i2', unitId: t.ids.units.Nos, groupId: b.id }).item.id,
      saveItem(t.ctx, { name: 'i3', unitId: t.ids.units.Nos, groupId: a.id, gstRate: 12 }).item.id,
      saveItem(t.ctx, { name: 'i4', unitId: t.ids.units.Nos }).item.id,
      t.addStockItem({ name: 'i5', groupId: b.id, gstRate: 3 }),
      saveItem(t.ctx, { name: 'i6', unitId: t.ids.units.Nos, groupId: c.id, hsnSac: '0401' }).item.id,
      saveItem(t.ctx, { name: 'i7', unitId: t.ids.units.Nos, hsnSac: '6403', gstRate: 18 }).item.id,
    ];
    history(t, 'stock_item', ids[1], '2026-08-01', 40);
    // Two rate changes of one item: before the first, between them, on and after the second.
    history(t, 'stock_item', ids[6], '2026-05-01', 12, { hsn: '6403' });
    history(t, 'stock_item', ids[6], '2026-09-22', 5, { hsn: '640399' });
    const resolve = createDatedGstResolver(t.db, ids);
    const dates = ['2025-01-01', '2026-04-01', '2026-04-30', '2026-05-01', '2026-06-30', '2026-07-01', '2026-08-01', '2026-09-01', '2026-09-21', '2026-09-22', '2027-03-31'];
    for (const date of dates) {
      for (const id of ids) assert.deepEqual(resolve(id, date), resolveItemGstProfile(t.db, id, date), `item ${id} on ${date}`);
    }
    // Spot checks with the arithmetic of the dates: i7 18% (columns) → 12% from 1-May → 5% from 22-Sep.
    assert.deepEqual([resolve(ids[6], '2026-04-30')?.rate, resolve(ids[6], '2026-05-01')?.rate, resolve(ids[6], '2026-09-22')?.rate], [18, 12, 5]);
    assert.equal(resolve(4242, '2026-06-01'), null, 'an item it was not given (or that does not exist) resolves to null');
    t.close();
  });

  it('reads its rows once: resolving 1 or 500 (item, date) pairs runs no further statement', () => {
    const t = createTestCompany();
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) ids.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471' }));
    const rec = recordSql(t.db);
    rec.start();
    const resolve = createDatedGstResolver(t.db, ids);
    const setup = rec.stop().length;
    assert.equal(setup, 4, 'items, item history, group history, groups');
    rec.start();
    for (let k = 0; k < 500; k++) resolve(ids[k % ids.length], `2026-0${4 + (k % 6)}-15`);
    assert.equal(rec.stop().length, 0);
    t.close();
  });
});
