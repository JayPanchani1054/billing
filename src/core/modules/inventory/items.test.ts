import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { bulkCreateItems, deleteItem, getItem, listItems, saveItem } from './items.ts';
import { saveStockCategory, saveStockGroup } from './masters.ts';
import { addGodown, auditRows, purchase, sale } from './testkit.ts';

const fails = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));
const fieldOf = (e: unknown): string | undefined => ((e as AppError).details as Array<{ path: string }> | undefined)?.[0]?.path;

describe('stock item save — identity and units', () => {
  it('creates an item with defaults and reads it back', () => {
    const t = createTestCompany();
    const { item, warnings } = saveItem(t.ctx, { name: '  Blue Pen ', unitId: t.ids.units.Nos, sellingPrice: 1000, mrp: 1200 });
    assert.deepEqual(warnings, []);
    assert.equal(item.name, 'Blue Pen');
    assert.equal(item.unitSymbol, 'Nos');
    assert.equal(item.costingMethod, 'avg_cost');
    assert.equal(item.gstApplicable, false); // no own GST details → inherits group / ledger
    assert.equal(item.isActive, true);
    assert.equal(item.sellingPrice, 1000);
    assert.deepEqual(item.openings, []);
    assert.equal(item.hasTransactions, false);
    t.close();
  });

  it('keeps name and alias unique across all names and aliases; barcode unique', () => {
    const t = createTestCompany();
    saveItem(t.ctx, { name: 'Basmati Rice', alias: 'BR01', unitId: t.ids.units.Kg, barcode: '8901234567890' });
    assert.throws(() => saveItem(t.ctx, { name: 'basmati rice', unitId: t.ids.units.Kg }), fails('VALIDATION', /already exists/));
    assert.throws(() => saveItem(t.ctx, { name: 'br01', unitId: t.ids.units.Kg }), fails('VALIDATION', /alias of 'Basmati Rice'/));
    assert.throws(() => saveItem(t.ctx, { name: 'Sona Masoori', alias: 'Basmati Rice', unitId: t.ids.units.Kg }), fails('VALIDATION'));
    assert.throws(
      () => saveItem(t.ctx, { name: 'Sona Masoori', unitId: t.ids.units.Kg, barcode: '8901234567890' }),
      fails('VALIDATION', /already used by 'Basmati Rice'/),
    );
    assert.throws(() => saveItem(t.ctx, { name: '   ', unitId: t.ids.units.Kg }), fails('VALIDATION', /Enter the stock item name/));
    t.close();
  });

  it('requires an existing unit and a consistent alternate unit', () => {
    const t = createTestCompany();
    const { Nos, Box } = t.ids.units;
    assert.throws(() => saveItem(t.ctx, { name: 'A' }), fails('VALIDATION', /Choose the unit/));
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: 9999 }), fails('VALIDATION', /unit does not exist/));
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: Nos, altUnitId: Box }), fails('VALIDATION', /how many Nos make 1 Box/));
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: Nos, altUnitId: Box, altConversion: 0 }), fails('VALIDATION', /more than 0/));
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: Nos, altUnitId: Nos, altConversion: 1 }), fails('VALIDATION', /different from the base/));
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: Nos, altConversion: 12 }), fails('VALIDATION', /Choose the alternate unit/));
    const ok = saveItem(t.ctx, { name: 'A', unitId: Nos, altUnitId: Box, altConversion: 12 }).item;
    assert.equal(ok.altUnitSymbol, 'Box');
    assert.equal(ok.altConversion, 12);
    t.close();
  });

  it('blocks a unit change once the item is used on vouchers', () => {
    const t = createTestCompany();
    const { item } = saveItem(t.ctx, { name: 'Sugar', unitId: t.ids.units.Kg });
    saveItem(t.ctx, { id: item.id, unitId: t.ids.units.Gm }); // no vouchers yet → allowed
    purchase(t, '2026-04-05', item.id, 1000, 0.04);
    assert.throws(() => saveItem(t.ctx, { id: item.id, unitId: t.ids.units.Kg }), fails('BUSINESS_RULE', /cannot change from Gm to Kg/));
    t.close();
  });

  it('alter uses patch semantics: omitted keeps, null clears', () => {
    const t = createTestCompany();
    const g = saveStockGroup(t.ctx, { name: 'Stationery' });
    const { item } = saveItem(t.ctx, { name: 'Pencil', alias: 'PNC', unitId: t.ids.units.Nos, groupId: g.id, mrp: 500, reorderLevel: 10 });
    const after = saveItem(t.ctx, { id: item.id, mrp: null, description: 'HB pencil' }).item;
    assert.equal(after.alias, 'PNC');
    assert.equal(after.groupId, g.id);
    assert.equal(after.mrp, null);
    assert.equal(after.reorderLevel, 10);
    assert.equal(after.description, 'HB pencil');
    t.close();
  });
});

describe('stock item save — batches, GST, prices', () => {
  it('warns when batches are maintained but the company feature is off; mfg/expiry need batches', () => {
    const t = createTestCompany({ features: { batches: false } });
    const r = saveItem(t.ctx, { name: 'Paracetamol', unitId: t.ids.units.Nos, maintainBatches: true });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /Batches are turned off/);
    assert.throws(() => saveItem(t.ctx, { name: 'Syrup', unitId: t.ids.units.Nos, useExpiry: true }), fails('VALIDATION', /Maintain in batches/));
    const t2 = createTestCompany({ features: { batches: true, expiryDates: true } });
    assert.deepEqual(saveItem(t2.ctx, { name: 'Syrup', unitId: t2.ids.units.Nos, maintainBatches: true, useExpiry: true }).warnings, []);
    t.close();
    t2.close();
  });

  it('validates HSN/SAC by item kind', () => {
    const t = createTestCompany();
    const base = { unitId: t.ids.units.Nos, gstRate: 18 };
    assert.throws(() => saveItem(t.ctx, { ...base, name: 'A', hsnSac: '84' }), fails('VALIDATION', /4, 6 or 8 digits/));
    assert.throws(() => saveItem(t.ctx, { ...base, name: 'A', hsnSac: '9983' }), fails('VALIDATION', /SAC \(services\) codes/));
    assert.throws(() => saveItem(t.ctx, { ...base, name: 'Repair', hsnSac: '8471', isService: true }), fails('VALIDATION', /start with 99/));
    assert.equal(saveItem(t.ctx, { ...base, name: 'Laptop', hsnSac: '8471 30' }).item.hsnSac, '847130');
    assert.equal(saveItem(t.ctx, { ...base, name: 'AMC', hsnSac: '998713', isService: true, unitId: t.ids.units.Hrs }).item.hsnSac, '998713');
    t.close();
  });

  it('checks the GST rate slab, taxability rules and cess', () => {
    const t = createTestCompany();
    const u = t.ids.units.Nos;
    assert.throws(() => saveItem(t.ctx, { name: 'A', unitId: u, gstRate: 17 }), fails('VALIDATION', /not a notified GST rate/));
    assert.equal(saveItem(t.ctx, { name: 'Special', unitId: u, gstRate: 17, allowNonStandardRate: true }).item.gstRate, 17);
    assert.throws(() => saveItem(t.ctx, { name: 'B', unitId: u, gstRate: 101, allowNonStandardRate: true }), fails('VALIDATION', /between 0 and 100/));
    assert.throws(() => saveItem(t.ctx, { name: 'Milk', unitId: u, taxability: 'exempt', gstRate: 5 }), fails('VALIDATION', /Exempt/));
    assert.throws(() => saveItem(t.ctx, { name: 'Milk', unitId: u, taxability: 'nil_rated', cessRate: 1 }), fails('VALIDATION', /no cess/));
    const milk = saveItem(t.ctx, { name: 'Milk', unitId: u, taxability: 'exempt' }).item;
    assert.equal(milk.gstApplicable, true);
    assert.equal(milk.gstRate, 0);
    assert.throws(() => saveItem(t.ctx, { name: 'C', unitId: u, gstApplicable: true }), fails('VALIDATION', /Enter the GST rate/));
    assert.throws(() => saveItem(t.ctx, { name: 'C', unitId: u, gstRate: 28, cessRate: -1 }), fails('VALIDATION', /Cess rate/));
    assert.throws(() => saveItem(t.ctx, { name: 'C', unitId: u, gstRate: 28, cessPerUnit: -5 }), fails('VALIDATION', /Cess per unit/));
    const cig = saveItem(t.ctx, { name: 'Cigarettes', unitId: u, gstRate: 28, cessRate: 5, cessPerUnit: 410 }).item;
    assert.equal(cig.cessRate, 5);
    assert.equal(cig.cessPerUnit, 410);
    t.close();
  });

  it('validates prices, reorder level and standard cost', () => {
    const t = createTestCompany();
    const u = t.ids.units.Nos;
    for (const [field, re] of [
      ['mrp', /MRP cannot be negative/],
      ['sellingPrice', /Selling price/],
      ['purchasePrice', /Purchase price/],
      ['standardCost', /Standard cost/],
      ['reorderLevel', /Reorder level/],
    ] as const) {
      assert.throws(() => saveItem(t.ctx, { name: 'X', unitId: u, [field]: -1 }), (e: unknown) => fails('VALIDATION', re)(e) && fieldOf(e) === field);
    }
    assert.throws(() => saveItem(t.ctx, { name: 'X', unitId: u, costingMethod: 'std_cost' }), fails('VALIDATION', /standard cost/));
    assert.equal(saveItem(t.ctx, { name: 'X', unitId: u, costingMethod: 'std_cost', standardCost: 12000 }).item.standardCost, 12000);
    t.close();
  });

  it('services cannot have opening stock or batches, and items with stock cannot become services', () => {
    const t = createTestCompany();
    const hrs = t.ids.units.Hrs;
    assert.throws(
      () => saveItem(t.ctx, { name: 'Consulting', unitId: hrs, isService: true, openings: [{ qty: 1, rate: 100 }] }),
      fails('VALIDATION', /service has no stock/),
    );
    assert.throws(() => saveItem(t.ctx, { name: 'Consulting', unitId: hrs, isService: true, maintainBatches: true }), fails('VALIDATION', /batches/));
    const { item } = saveItem(t.ctx, { name: 'Cable', unitId: t.ids.units.Mtr });
    sale(t, '2026-04-02', item.id, 3, 10);
    assert.throws(() => saveItem(t.ctx, { id: item.id, isService: true }), fails('BUSINESS_RULE', /cannot be turned into a service/));
    t.close();
  });
});

describe('stock item save — opening stock', () => {
  it('defaults to Main Location and computes value = qty × rate in paise', () => {
    const t = createTestCompany();
    const { item } = saveItem(t.ctx, {
      name: 'Cement',
      unitId: t.ids.units.Kg,
      openings: [{ qty: 12.345, rate: 7.77 }], // 12.345 × 7.77 = 95.92065 → 9592 paise
    });
    assert.equal(item.openings.length, 1);
    assert.equal(item.openings[0].godownId, t.ids.mainGodownId);
    assert.equal(item.openings[0].godownName, 'Main Location');
    assert.equal(item.openings[0].value, 9592);
    // An explicit value wins and the rate is derived from it.
    const v = saveItem(t.ctx, { id: item.id, openings: [{ qty: 4, value: 1001 }] }).item;
    assert.equal(v.openings[0].value, 1001);
    assert.equal(v.openings[0].rate, 2.5025);
    assert.deepEqual(v.openingTotal, { qty: 4, value: 1001 });
    t.close();
  });

  it('requires a godown when multiple godowns are on, and rejects duplicates and bad quantities', () => {
    const t = createTestCompany({ features: { multipleGodowns: true } });
    const wh = addGodown(t, 'Warehouse');
    const u = t.ids.units.Nos;
    assert.throws(
      () => saveItem(t.ctx, { name: 'Tile', unitId: u, openings: [{ qty: 5, rate: 10 }] }),
      (e: unknown) => fails('VALIDATION', /Choose the godown/)(e) && fieldOf(e) === 'openings[0].godownId',
    );
    assert.throws(
      () => saveItem(t.ctx, { name: 'Tile', unitId: u, openings: [{ godownId: wh, qty: 5, rate: 10 }, { godownId: wh, qty: 1, rate: 10 }] }),
      fails('VALIDATION', /Row 1 already has opening stock/),
    );
    assert.throws(() => saveItem(t.ctx, { name: 'Tile', unitId: u, openings: [{ godownId: wh, qty: 1.5, rate: 10 }] }), fails('VALIDATION', /decimal places/));
    assert.throws(() => saveItem(t.ctx, { name: 'Tile', unitId: u, openings: [{ godownId: wh, qty: 0, rate: 10 }] }), fails('VALIDATION', /more than 0/));
    assert.throws(() => saveItem(t.ctx, { name: 'Tile', unitId: u, openings: [{ godownId: 999, qty: 1, rate: 10 }] }), fails('VALIDATION', /godown does not exist/));
    const ok = saveItem(t.ctx, {
      name: 'Tile',
      unitId: u,
      openings: [
        { godownId: wh, qty: 5, rate: 10 },
        { godownId: t.ids.mainGodownId, qty: 2, rate: 10 },
      ],
    }).item;
    assert.deepEqual(ok.openingTotal, { qty: 7, value: 7000 });
    t.close();
  });

  it('requires batch names for batch items (and rejects them otherwise), with date checks', () => {
    const t = createTestCompany({ features: { batches: true, expiryDates: true } });
    const u = t.ids.units.Nos;
    assert.throws(
      () => saveItem(t.ctx, { name: 'Vaccine', unitId: u, maintainBatches: true, openings: [{ qty: 10, rate: 50 }] }),
      fails('VALIDATION', /Enter the batch name/),
    );
    assert.throws(
      () => saveItem(t.ctx, { name: 'Bucket', unitId: u, openings: [{ qty: 10, rate: 50, batchName: 'B1' }] }),
      fails('VALIDATION', /only to items maintained in batches/),
    );
    assert.throws(
      () =>
        saveItem(t.ctx, {
          name: 'Vaccine',
          unitId: u,
          maintainBatches: true,
          useExpiry: true,
          openings: [{ qty: 10, rate: 50, batchName: 'V1', mfgDate: '2026-03-01', expiryDate: '2026-01-01' }],
        }),
      fails('VALIDATION', /expiry date is before/),
    );
    const v = saveItem(t.ctx, {
      name: 'Vaccine',
      unitId: u,
      maintainBatches: true,
      useExpiry: true,
      openings: [
        { qty: 10, rate: 50, batchName: 'V1', expiryDate: '2027-01-31' },
        { qty: 5, rate: 52, batchName: 'V2', expiryDate: '2026-12-31' },
      ],
    }).item;
    assert.deepEqual(v.openings.map((o) => [o.batchName, o.expiryDate, o.value]), [
      ['V1', '2027-01-31', 50000],
      ['V2', '2026-12-31', 26000],
    ]);
    t.close();
  });
});

describe('stock item GST history', () => {
  it('records dated changes, keeps earlier details, refuses undated changes and clears history when switched off', () => {
    const t = createTestCompany(); // books from 2026-04-01
    const u = t.ids.units.Nos;
    const created = saveItem(t.ctx, { name: 'Shirt', unitId: u, hsnSac: '6205', gstRate: 12 }).item;
    assert.equal(created.gstHistory.length, 0);
    assert.equal(created.effectiveGst?.source, 'item');
    const changed = saveItem(t.ctx, { id: created.id, gstRate: 5, gstApplicableFrom: '2026-09-22' }).item;
    assert.deepEqual(
      changed.gstHistory.map((h) => [h.applicableFrom, h.rate, h.hsnSac]),
      [
        ['2026-04-01', 12, '6205'],
        ['2026-09-22', 5, '6205'],
      ],
    );
    assert.equal(changed.gstRate, 5);
    assert.throws(() => saveItem(t.ctx, { id: created.id, gstRate: 18 }), fails('BUSINESS_RULE', /Applicable from/));
    // Same date again replaces that row.
    const fixed = saveItem(t.ctx, { id: created.id, gstRate: 18, gstApplicableFrom: '2026-09-22' }).item;
    assert.deepEqual(fixed.gstHistory.map((h) => h.rate), [12, 18]);
    const off = saveItem(t.ctx, { id: created.id, gstApplicable: false }).item;
    assert.equal(off.gstApplicable, false);
    assert.deepEqual(off.gstHistory, []);
    assert.equal(off.effectiveGst, null);
    t.close();
  });
});

describe('items created outside this service', () => {
  it('treats "applicable" without a rate as no own GST details, and a rename keeps dated history', () => {
    const t = createTestCompany();
    // Column defaults: gst_applicable = 'applicable', gst_rate NULL (e.g. an import or the test fixture).
    const id = t.addStockItem({ name: 'Imported' });
    assert.equal(getItem(t.db, id, t.today).gstApplicable, false);
    assert.equal(saveItem(t.ctx, { id, name: 'Imported item' }).item.name, 'Imported item'); // no "Enter the GST rate" error
    // An item with a dated rate from the fixture keeps it through an unrelated alteration.
    const dated = t.addStockItem({ name: 'Dated', gstRate: 18, hsnSac: '8471' });
    const after = saveItem(t.ctx, { id: dated, mrp: 5000 }).item;
    assert.deepEqual(after.gstHistory.map((h) => [h.applicableFrom, h.rate]), [['2026-04-01', 18]]);
    assert.equal(after.effectiveGst?.source, 'item_history');
    t.close();
  });
});

describe('stock item delete, bulk create and list', () => {
  it('deletes unused items (with openings, price lists, GST history) and refuses used ones', () => {
    const t = createTestCompany();
    const { item } = saveItem(t.ctx, { name: 'Glue', unitId: t.ids.units.Nos, gstRate: 18, gstApplicableFrom: '2026-04-01', openings: [{ qty: 2, rate: 5 }] });
    const used = saveItem(t.ctx, { name: 'Tape', unitId: t.ids.units.Nos }).item;
    sale(t, '2026-04-03', used.id, 1, 10);
    assert.throws(() => deleteItem(t.ctx, used.id), fails('BUSINESS_RULE', /used in 1 voucher/));
    deleteItem(t.ctx, item.id);
    assert.equal(t.db.value('SELECT COUNT(*) FROM stock_openings WHERE item_id = :id', { id: item.id }), 0);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM gst_rate_history WHERE entity_type = 'stock_item' AND entity_id = :id`, { id: item.id }), 0);
    assert.throws(() => getItem(t.db, item.id, t.today), fails('NOT_FOUND'));
    const audit = auditRows(t, 'stock_item');
    assert.deepEqual(audit.map((a) => a.action), ['create', 'create', 'delete']);
    const before = JSON.parse(audit[2].before_json ?? '{}') as { name: string; openings: unknown[] };
    assert.equal(before.name, 'Glue');
    assert.equal(before.openings.length, 1);
    t.close();
  });

  it('bulk-creates items with a default group, all or nothing', () => {
    const t = createTestCompany();
    const g = saveStockGroup(t.ctx, { name: 'Hardware' });
    const u = t.ids.units.Nos;
    const res = bulkCreateItems(t.ctx, {
      groupId: g.id,
      rows: [
        { name: 'Nail', unitId: u, openings: [{ qty: 100, rate: 0.5 }] },
        { name: 'Screw', unitId: u, groupId: null },
      ],
    });
    assert.deepEqual(res.created.map((c) => c.name), ['Nail', 'Screw']);
    assert.equal(getItem(t.db, res.created[0].id, t.today).groupId, g.id);
    assert.equal(getItem(t.db, res.created[1].id, t.today).groupId, null);
    assert.throws(
      () => bulkCreateItems(t.ctx, { rows: [{ name: 'Washer', unitId: u }, { name: 'nail', unitId: u }] }),
      (e: unknown) => fails('VALIDATION', /^Row 2 \(nail\)/)(e) && fieldOf(e) === 'rows[1].name',
    );
    assert.equal(t.db.value(`SELECT COUNT(*) FROM stock_items WHERE name = 'Washer'`), 0, 'whole batch rolled back');
    t.close();
  });

  it('lists with search, group (with sub-groups), category, active filter and stock', () => {
    const t = createTestCompany();
    const parent = saveStockGroup(t.ctx, { name: 'Food' });
    const child = saveStockGroup(t.ctx, { name: 'Grains', parentId: parent.id });
    const cat = saveStockCategory(t.ctx, { name: 'Organic' });
    const u = t.ids.units.Kg;
    const rice = saveItem(t.ctx, { name: 'Rice', unitId: u, groupId: child.id, categoryId: cat.id, partNo: 'R-1', openings: [{ qty: 50, rate: 40 }] }).item;
    saveItem(t.ctx, { name: 'Oil', unitId: t.ids.units.Ltr, groupId: parent.id });
    saveItem(t.ctx, { name: 'Old stock', unitId: u, isActive: false });
    sale(t, '2026-04-10', rice.id, 20.5, 60);
    assert.equal(listItems(t.db, {}, t.today).total, 3);
    assert.equal(listItems(t.db, { activeOnly: true }, t.today).total, 2);
    assert.deepEqual(listItems(t.db, { groupId: parent.id }, t.today).rows.map((r) => r.name), ['Oil', 'Rice']);
    assert.deepEqual(listItems(t.db, { groupId: parent.id, includeSubgroups: false }, t.today).rows.map((r) => r.name), ['Oil']);
    assert.deepEqual(listItems(t.db, { categoryId: cat.id }, t.today).rows.map((r) => r.name), ['Rice']);
    assert.deepEqual(listItems(t.db, { search: 'r-1' }, t.today).rows.map((r) => r.name), ['Rice']);
    const withStock = listItems(t.db, { withStock: true, asOf: '2026-04-15' }, t.today).rows;
    assert.equal(withStock.find((r) => r.name === 'Rice')?.stockQty, 29.5);
    assert.equal(withStock.find((r) => r.name === 'Oil')?.stockQty, 0);
    assert.equal(listItems(t.db, { withStock: true, asOf: '2026-04-09' }, t.today).rows.find((r) => r.name === 'Rice')?.stockQty, 50);
    assert.equal(listItems(t.db, {}, t.today).rows[0].stockQty, undefined);
    const page = listItems(t.db, { limit: 1, offset: 1 }, t.today);
    assert.equal(page.rows.length, 1);
    assert.equal(page.total, 3);
    t.close();
  });
});
