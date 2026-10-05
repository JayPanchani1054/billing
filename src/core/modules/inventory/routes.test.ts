import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ItemPickerRow, ListResult, StockItemDetail, StockItemSaveResult, UnitDto } from '../../../shared/types/inventory.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { itemPicker } from './items.ts';
import { saveStockGroup } from './masters.ts';
import { savePriceLevel, savePriceList } from './prices.ts';
import { inventoryRoutes as R } from './routes.ts';
import { auditRows, purchase, sale } from './testkit.ts';

const code = (r: { ok: boolean; error?: { code: string } }): string | null => (r.ok ? null : (r.error?.code ?? null));

describe('permissions', () => {
  it('Data Entry can create but not alter or delete; Auditor can only read', async () => {
    const t = createTestCompany();
    const dataEntry = { session: t.sessionAs({ role: 'Data Entry' }) };
    const auditor = { session: t.sessionAs({ role: 'Auditor' }) };
    const created = await t.callOk<StockItemSaveResult>(R, 'inventory.item.save', { name: 'Pen', unitId: t.ids.units.Nos }, dataEntry);
    const id = created.item.id;
    assert.equal(code(await t.call(R, 'inventory.item.save', { id, mrp: 1000 }, dataEntry)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.item.delete', { id }, dataEntry)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.item.save', { name: 'Ink', unitId: t.ids.units.Nos }, auditor)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.unit.save', { kind: 'simple', symbol: 'Tin' }, auditor)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.group.save', { name: 'G' }, auditor)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.godown.delete', { id: t.ids.mainGodownId }, auditor)), 'FORBIDDEN');
    assert.equal(code(await t.call(R, 'inventory.item.bulkCreate', { rows: [{ name: 'X', unitId: t.ids.units.Nos }] }, auditor)), 'FORBIDDEN');
    // Reads are fine for both.
    const got = await t.callOk<StockItemDetail>(R, 'inventory.item.get', { id }, auditor);
    assert.equal(got.name, 'Pen');
    assert.equal((await t.callOk<ListResult<UnitDto>>(R, 'inventory.unit.list', {}, dataEntry)).total, 10);
    // No masters.view at all → even reads are refused.
    const outsider = { session: t.sessionAs({ permissions: ['reports.view'] }) };
    assert.equal(code(await t.call(R, 'inventory.item.list', {}, outsider)), 'FORBIDDEN');
    // The owner can alter and delete.
    assert.equal((await t.callOk<StockItemSaveResult>(R, 'inventory.item.save', { id, mrp: 1000 })).item.mrp, 1000);
    await t.callOk(R, 'inventory.item.delete', { id });
    t.close();
  });

  it('validates input through the dispatcher and maps unit kinds', async () => {
    const t = createTestCompany();
    const bad = await t.call(R, 'inventory.item.save', { name: 'X', unitId: 'Nos' });
    assert.equal(code(bad), 'VALIDATION');
    const badKind = await t.call(R, 'inventory.unit.save', { kind: 'weird', symbol: 'X' });
    assert.equal(code(badKind), 'VALIDATION');
    const simple = await t.callOk<UnitDto>(R, 'inventory.unit.save', { symbol: 'Tin', formalName: 'Tins' }); // kind defaults to simple
    assert.equal(simple.uqc, 'CAN');
    const compound = await t.callOk<UnitDto>(R, 'inventory.unit.save', { kind: 'compound', firstUnitId: simple.id, conversion: 6, secondUnitId: t.ids.units.Ltr });
    assert.equal(compound.symbol, 'Tin of 6 Ltr');
    const rule = await t.call(R, 'inventory.group.save', { name: 'G', gstRate: 13 });
    assert.equal(code(rule), 'VALIDATION');
    assert.match(rule.ok ? '' : rule.error.message, /not a notified GST rate/);
    t.close();
  });
});

describe('audit trail', () => {
  it('records create/alter/delete with before and after snapshots in the hash chain', async () => {
    const t = createTestCompany();
    const res = await t.callOk<StockItemSaveResult>(R, 'inventory.item.save', {
      name: 'Kettle',
      unitId: t.ids.units.Nos,
      gstRate: 18,
      hsnSac: '8516',
      openings: [{ qty: 2, rate: 900 }],
    });
    await t.callOk(R, 'inventory.item.save', { id: res.item.id, sellingPrice: 150000 });
    await t.callOk(R, 'inventory.item.delete', { id: res.item.id });
    const rows = auditRows(t, 'stock_item');
    assert.deepEqual(rows.map((r) => r.action), ['create', 'alter', 'delete']);
    assert.equal(rows[0].before_json, null);
    const created = JSON.parse(rows[0].after_json ?? '{}') as { name: string; openings: Array<{ value: number }>; gstRate: number };
    assert.equal(created.name, 'Kettle');
    assert.equal(created.openings[0].value, 180000);
    const altered = { before: JSON.parse(rows[1].before_json ?? '{}'), after: JSON.parse(rows[1].after_json ?? '{}') } as {
      before: { sellingPrice: number | null };
      after: { sellingPrice: number | null };
    };
    assert.equal(altered.before.sellingPrice, null);
    assert.equal(altered.after.sellingPrice, 150000);
    assert.equal(rows[2].after_json, null);
    assert.ok(rows.every((r) => r.entity_label === 'Kettle' && r.username === t.ctx.session.username));
    assert.equal(verifyAuditChain(t.db).ok, true);
    t.close();
  });

  it('a failed save leaves no audit row and no data', async () => {
    const t = createTestCompany();
    const before = Number(t.db.value('SELECT COUNT(*) FROM audit_log'));
    const r = await t.call(R, 'inventory.item.save', { name: 'Bad', unitId: t.ids.units.Nos, openings: [{ qty: -1, rate: 1 }] });
    assert.equal(code(r), 'VALIDATION');
    assert.equal(Number(t.db.value('SELECT COUNT(*) FROM audit_log')), before);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM stock_items WHERE name = 'Bad'`), 0);
    t.close();
  });
});

describe('item picker', () => {
  it('returns compact rows with GST as of the date, stock, price level and alternate unit', async () => {
    const t = createTestCompany({ today: '2026-06-30' });
    const lvl = savePriceLevel(t.ctx, { name: 'Dealer' });
    const grp = saveStockGroup(t.ctx, { name: 'Appliances', gstRate: 18, hsnSac: '8516' });
    const kettle = t.addStockItem({ name: 'Kettle', groupId: grp.id, openingQty: 10, openingRate: 900, sellingPrice: 150000, columns: { gst_applicable: 'not_applicable' } });
    const juicer = t.addStockItem({ name: 'Juicer', gstRate: 12, hsnSac: '8509', columns: { alt_unit_id: t.ids.units.Box, alt_conversion: 4 } });
    t.db.run(
      `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate) VALUES ('stock_item', :id, '2026-06-01', '8509', 'taxable', 5, 0)`,
      { id: juicer },
    );
    t.addStockItem({ name: 'Retired', columns: { is_active: 0 } });
    sale(t, '2026-05-10', kettle, 3, 1500);
    purchase(t, '2026-07-10', kettle, 5, 900);
    savePriceList(t.ctx, { priceLevelId: lvl.id, applicableFrom: '2026-04-01', rows: [{ itemId: kettle, qtyFrom: 0, rate: 1400, discountPct: 2 }] });

    const may = await t.callOk<ItemPickerRow[]>(R, 'inventory.item.picker', { asOf: '2026-05-31', priceLevelId: lvl.id });
    assert.deepEqual(may.map((r) => r.name), ['Juicer', 'Kettle']);
    const k = may[1];
    assert.deepEqual(k.gst, { rate: 18, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '8516' });
    assert.equal(k.groupName, 'Appliances');
    assert.equal(k.stockQty, 7);
    assert.deepEqual(k.priceLevel, { rate: 1400, discountPct: 2 });
    assert.equal(k.sellingPrice, 150000);
    assert.equal(may[0].gst?.rate, 12);
    assert.deepEqual(may[0].altUnit, { id: t.ids.units.Box, symbol: 'Box', conversion: 4 });
    assert.equal(may[0].priceLevel, null);
    const june = itemPicker(t.db, {}, t.today); // default asOf = working date 2026-06-30
    assert.equal(june[0].gst?.rate, 5);
    assert.equal(june[1].stockQty, 7, 'later purchase not counted');
    const inOtherGodown = itemPicker(t.db, { godownId: 9999 }, t.today);
    assert.equal(inOtherGodown[1].stockQty, 0);
    t.close();
  });

  it('serves 20,000 items in under 500 ms', () => {
    const t = createTestCompany({ today: '2026-06-30' });
    const ts = new Date().toISOString();
    const groups: number[] = [];
    t.db.transaction(() => {
      for (let g = 0; g < 50; g++) {
        groups.push(
          t.db.run(
            `INSERT INTO stock_groups (guid, name, parent_id, gst_applicable, gst_taxability, gst_rate, hsn_sac, created_at, updated_at)
             VALUES (:guid, :name, :parent, :app, 'taxable', :rate, '8471', :ts, :ts)`,
            {
              guid: randomUUID(),
              name: `Group ${g}`,
              parent: g >= 10 ? groups[g % 10] : null,
              app: g < 10 ? 'applicable' : 'not_applicable',
              rate: g < 10 ? 18 : null,
              ts,
            },
          ).lastInsertRowid,
        );
      }
      for (let i = 0; i < 20_000; i++) {
        const id = t.db.run(
          `INSERT INTO stock_items (guid, name, unit_id, group_id, gst_applicable, gst_taxability, gst_rate, hsn_sac, selling_price, created_at, updated_at)
           VALUES (:guid, :name, :unit, :group, :app, 'taxable', :rate, :hsn, :price, :ts, :ts)`,
          {
            guid: randomUUID(),
            name: `Item ${String(i).padStart(5, '0')}`,
            unit: t.ids.units.Nos,
            group: groups[i % groups.length],
            app: i % 3 === 0 ? 'applicable' : 'not_applicable',
            rate: i % 3 === 0 ? 12 : null,
            hsn: i % 3 === 0 ? '6109' : null,
            price: 1000 + i,
            ts,
          },
        ).lastInsertRowid;
        if (i % 10 === 0) {
          t.db.run(
            `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, taxability, rate) VALUES ('stock_item', :id, '2026-04-01', 'taxable', 5)`,
            { id },
          );
        }
        if (i % 4 === 0) {
          t.db.run('INSERT INTO stock_openings (item_id, godown_id, qty, rate, value) VALUES (:id, :g, 10, 1, 1000)', { id, g: t.ids.mainGodownId });
        }
      }
    });
    const started = performance.now();
    const rows = itemPicker(t.db, {}, t.today);
    const ms = performance.now() - started;
    assert.equal(rows.length, 20_000);
    assert.equal(rows[0].name, 'Item 00000');
    assert.equal(rows[0].gst?.rate, 5); // history row (i % 10 === 0)
    assert.equal(rows[3].gst?.rate, 12); // own columns (i % 3 === 0)
    assert.equal(rows[1].gst?.rate, 18); // group chain
    assert.equal(rows[0].stockQty, 10);
    assert.ok(ms < 500, `picker took ${ms.toFixed(1)} ms`);
    t.close();
  });
});

describe('review regressions — picker search', () => {
  it('filters by search (names starting with the text first) and limits rows, as the Go To palette asks', async () => {
    const t = createTestCompany();
    t.addStockItem({ name: 'Green Apple', openingQty: 4, openingRate: 1 });
    t.addStockItem({ name: 'Apple', openingQty: 2, openingRate: 1 });
    t.addStockItem({ name: 'Banana', barcode: '8901234', partNo: 'APL-9' });
    t.addStockItem({ name: 'Apple Juice', columns: { is_active: 0 } });
    const names = async (input: Record<string, unknown>) =>
      (await t.callOk<ItemPickerRow[]>(R, 'inventory.item.picker', input)).map((r) => [r.name, r.stockQty]);
    // Before: both keys were dropped and every active item came back.
    assert.deepEqual(await names({ search: 'apple' }), [
      ['Apple', 2],
      ['Green Apple', 4],
    ]);
    assert.deepEqual(await names({ search: 'APP', limit: 1 }), [['Apple', 2]]);
    assert.deepEqual(await names({ search: '890123' }), [['Banana', 0]]); // barcode
    assert.deepEqual(await names({ search: 'apl-' }), [['Banana', 0]]); // part no.
    assert.deepEqual(await names({ search: '%' }), []); // LIKE wildcards are literal
    assert.equal((await names({})).length, 3);
    const badLevel = await t.call(R, 'inventory.item.picker', { priceLevelId: 4242 });
    assert.equal(code(badLevel), 'NOT_FOUND');
    t.close();
  });
});
