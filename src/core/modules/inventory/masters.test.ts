import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { resolveGroupGstProfile } from './gst.ts';
import { saveItem } from './items.ts';
import {
  deleteGodown,
  deleteStockCategory,
  deleteStockGroup,
  getStockGroup,
  listGodowns,
  listStockCategories,
  listStockGroups,
  saveGodown,
  saveStockCategory,
  saveStockGroup,
} from './masters.ts';
import { auditRows, postStock } from './testkit.ts';

const fails = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

describe('stock groups', () => {
  it('builds a tree, lists by parent and reports the ancestor path', () => {
    const t = createTestCompany();
    const elec = saveStockGroup(t.ctx, { name: 'Electronics', alias: 'ELEC' });
    const phones = saveStockGroup(t.ctx, { name: 'Phones', parentId: elec.id });
    const smart = saveStockGroup(t.ctx, { name: 'Smartphones', parentId: phones.id, addQuantities: false });
    assert.equal(smart.addQuantities, false);
    assert.deepEqual(smart.path.map((p) => p.name), ['Phones', 'Electronics']);
    assert.equal(listStockGroups(t.db, { parentId: null }).total, 1);
    assert.deepEqual(listStockGroups(t.db, { parentId: elec.id }).rows.map((r) => r.name), ['Phones']);
    assert.equal(listStockGroups(t.db, { search: 'phone' }).total, 2);
    assert.equal(listStockGroups(t.db, { search: 'elec' }).total, 1); // alias match
    assert.equal(getStockGroup(t.db, elec.id).childCount, 1);
    t.close();
  });

  it('prevents cycles: a group cannot move under itself or its descendants', () => {
    const t = createTestCompany();
    const a = saveStockGroup(t.ctx, { name: 'A' });
    const b = saveStockGroup(t.ctx, { name: 'B', parentId: a.id });
    const c = saveStockGroup(t.ctx, { name: 'C', parentId: b.id });
    assert.throws(() => saveStockGroup(t.ctx, { id: a.id, name: 'A', parentId: a.id }), fails('VALIDATION', /under itself/));
    assert.throws(() => saveStockGroup(t.ctx, { id: a.id, name: 'A', parentId: c.id }), fails('VALIDATION', /loop/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'D', parentId: 999 }), fails('VALIDATION', /does not exist/));
    // Moving C to the top is fine.
    assert.equal(saveStockGroup(t.ctx, { id: c.id, name: 'C', parentId: null }).parentId, null);
    t.close();
  });

  it('keeps names and aliases unique across both', () => {
    const t = createTestCompany();
    saveStockGroup(t.ctx, { name: 'Groceries', alias: 'GRO' });
    assert.throws(() => saveStockGroup(t.ctx, { name: 'groceries' }), fails('VALIDATION', /already exists/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'gro' }), fails('VALIDATION', /alias of 'Groceries'/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'Other', alias: 'Groceries' }), fails('VALIDATION', /already exists/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'Same', alias: 'same' }), fails('VALIDATION', /different from the name/));
    t.close();
  });

  it('protects groups with sub-groups or items from deletion, and audits deletes', () => {
    const t = createTestCompany();
    const a = saveStockGroup(t.ctx, { name: 'A' });
    const b = saveStockGroup(t.ctx, { name: 'B', parentId: a.id });
    saveItem(t.ctx, { name: 'Widget', unitId: t.ids.units.Nos, groupId: b.id });
    assert.throws(() => deleteStockGroup(t.ctx, a.id), fails('BUSINESS_RULE', /1 sub-group/));
    assert.throws(() => deleteStockGroup(t.ctx, b.id), fails('BUSINESS_RULE', /1 stock item/));
    const empty = saveStockGroup(t.ctx, { name: 'Empty', gstRate: 18, hsnSac: '8471', gstApplicableFrom: '2026-04-01' });
    deleteStockGroup(t.ctx, empty.id);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM gst_rate_history WHERE entity_type = 'stock_group' AND entity_id = :id`, { id: empty.id }), 0);
    const audit = auditRows(t, 'stock_group');
    assert.deepEqual(audit.map((a2) => a2.action), ['create', 'create', 'create', 'delete']);
    t.close();
  });

  it('validates GST details and records effective-dated history', () => {
    const t = createTestCompany(); // books from 2026-04-01
    assert.throws(() => saveStockGroup(t.ctx, { name: 'X', gstRate: 13 }), fails('VALIDATION', /not a notified GST rate/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'X', gstRate: 5, hsnSac: '12' }), fails('VALIDATION', /4, 6 or 8 digits/));
    assert.throws(() => saveStockGroup(t.ctx, { name: 'X', taxability: 'exempt', gstRate: 5 }), fails('VALIDATION', /set the GST rate to 0/));
    const g = saveStockGroup(t.ctx, { name: 'Textiles', gstRate: 12, hsnSac: '5208' });
    assert.equal(g.gstApplicable, true);
    assert.equal(g.gstHistory.length, 0); // no date given → current details only
    // Rate change from 22-Sep-2025 style date: the earlier rate is kept from books beginning.
    const g2 = saveStockGroup(t.ctx, { id: g.id, name: 'Textiles', gstRate: 5, gstApplicableFrom: '2026-09-22' });
    assert.deepEqual(
      g2.gstHistory.map((h) => [h.applicableFrom, h.rate]),
      [
        ['2026-04-01', 12],
        ['2026-09-22', 5],
      ],
    );
    assert.equal(resolveGroupGstProfile(t.db, g.id, '2026-09-21')?.rate, 12);
    assert.equal(resolveGroupGstProfile(t.db, g.id, '2026-09-22')?.rate, 5);
    // A further change without a date would rewrite history silently → refused.
    assert.throws(() => saveStockGroup(t.ctx, { id: g.id, name: 'Textiles', gstRate: 18 }), fails('BUSINESS_RULE', /Applicable from/));
    // Renaming without touching GST is fine.
    assert.equal(saveStockGroup(t.ctx, { id: g.id, name: 'Fabrics' }).name, 'Fabrics');
    t.close();
  });
});

describe('stock categories', () => {
  it('builds a tree with cycle and usage protection', () => {
    const t = createTestCompany();
    const brand = saveStockCategory(t.ctx, { name: 'Brands' });
    const acme = saveStockCategory(t.ctx, { name: 'Acme', parentId: brand.id });
    assert.equal(acme.parentName, 'Brands');
    assert.throws(() => saveStockCategory(t.ctx, { id: brand.id, name: 'Brands', parentId: acme.id }), fails('VALIDATION', /loop/));
    saveItem(t.ctx, { name: 'Acme Glue', unitId: t.ids.units.Nos, categoryId: acme.id });
    assert.throws(() => deleteStockCategory(t.ctx, acme.id), fails('BUSINESS_RULE', /1 stock item/));
    assert.throws(() => deleteStockCategory(t.ctx, brand.id), fails('BUSINESS_RULE', /sub-categor/));
    assert.equal(listStockCategories(t.db, { search: 'acm' }).rows[0].itemCount, 1);
    const spare = saveStockCategory(t.ctx, { name: 'Spare' });
    deleteStockCategory(t.ctx, spare.id);
    assert.equal(auditRows(t, 'stock_category').at(-1)?.action, 'delete');
    t.close();
  });
});

describe('godowns', () => {
  it("keeps 'Main Location' undeletable and not third-party", () => {
    const t = createTestCompany();
    const list = listGodowns(t.db, {});
    assert.equal(list.rows[0].name, 'Main Location');
    assert.equal(list.rows[0].isPredefined, true);
    assert.throws(() => deleteGodown(t.ctx, t.ids.mainGodownId), fails('BUSINESS_RULE', /cannot be deleted/));
    assert.throws(
      () => saveGodown(t.ctx, { id: t.ids.mainGodownId, name: 'Main Location', isThirdParty: true }),
      fails('VALIDATION', /third-party/),
    );
    // Renaming the main godown is allowed (as accountants expect).
    assert.equal(saveGodown(t.ctx, { id: t.ids.mainGodownId, name: 'Shop' }).isPredefined, true);
    t.close();
  });

  it('saves the third-party flag, prevents cycles and deletion while in use', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = saveGodown(t.ctx, { name: 'Warehouse', address: 'Plot 4, MIDC' });
    const rack = saveGodown(t.ctx, { name: 'Rack A', parentId: wh.id });
    const job = saveGodown(t.ctx, { name: 'Job Worker', isThirdParty: true });
    assert.equal(job.isThirdParty, true);
    assert.throws(() => saveGodown(t.ctx, { id: wh.id, name: 'Warehouse', parentId: rack.id }), fails('VALIDATION', /loop/));
    assert.throws(() => deleteGodown(t.ctx, wh.id), fails('BUSINESS_RULE', /sub-godown/));
    const item = t.addStockItem({ name: 'Bolt', openingQty: 5, openingRate: 2, godownId: rack.id });
    assert.throws(() => deleteGodown(t.ctx, rack.id), fails('BUSINESS_RULE', /1 stock item\(s\) with opening stock here/));
    postStock(t, { baseType: 'purchase', date: '2026-04-05', lines: [{ itemId: item, qty: 1, rate: 2, godownId: job.id }] });
    assert.throws(() => deleteGodown(t.ctx, job.id), fails('BUSINESS_RULE', /1 voucher/));
    const spare = saveGodown(t.ctx, { name: 'Spare' });
    deleteGodown(t.ctx, spare.id);
    assert.deepEqual(auditRows(t, 'godown').map((a) => a.action), ['create', 'create', 'create', 'create', 'delete']);
    t.close();
  });
});
