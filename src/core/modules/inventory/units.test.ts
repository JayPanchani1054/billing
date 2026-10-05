import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { saveItem } from './items.ts';
import { auditRows, postStock } from './testkit.ts';
import { deleteUnit, getUnit, listUnits, saveUnit } from './units.ts';

const fails = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

describe('simple units', () => {
  it('creates a unit with the suggested UQC and decimals, and audits it', () => {
    const t = createTestCompany();
    const pkt = saveUnit(t.ctx, { kind: 'simple', symbol: 'Pkt', formalName: 'Packets', decimalPlaces: 0 });
    assert.equal(pkt.symbol, 'Pkt');
    assert.equal(pkt.uqc, 'PAC');
    assert.equal(pkt.isCompound, false);
    // Symbol not recognised → falls back to the formal name.
    const sqf = saveUnit(t.ctx, { kind: 'simple', symbol: 'SFT2', formalName: 'Square Feet', decimalPlaces: 2 });
    assert.equal(sqf.uqc, 'SQF');
    assert.equal(sqf.decimalPlaces, 2);
    const audit = auditRows(t, 'unit');
    assert.equal(audit.length, 2);
    assert.equal(audit[0].action, 'create');
    assert.equal(audit[0].entity_label, 'Pkt');
    assert.ok(audit[0].after_json?.includes('"uqc":"PAC"'));
    t.close();
  });

  it('rejects duplicate symbols (case-insensitive), bad UQC, spaces and decimals beyond 4', () => {
    const t = createTestCompany();
    assert.throws(() => saveUnit(t.ctx, { kind: 'simple', symbol: 'nos' }), fails('VALIDATION', /already exists/));
    assert.throws(() => saveUnit(t.ctx, { kind: 'simple', symbol: 'Tin', uqc: 'XYZ' }), fails('VALIDATION', /not a GST Unique Quantity Code/));
    assert.throws(() => saveUnit(t.ctx, { kind: 'simple', symbol: 'Big Box' }), fails('VALIDATION', /cannot contain spaces/));
    assert.throws(() => saveUnit(t.ctx, { kind: 'simple', symbol: 'Mg', decimalPlaces: 5 }), fails('VALIDATION', /0 to 4/));
    t.close();
  });

  it('renaming a simple unit refreshes compound unit symbols built from it', () => {
    const t = createTestCompany();
    const box = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    assert.equal(box.symbol, 'Box of 12 Nos');
    saveUnit(t.ctx, { id: t.ids.units.Box, kind: 'simple', symbol: 'Bx', formalName: 'Box' });
    assert.equal(getUnit(t.db, box.id).symbol, 'Bx of 12 Nos');
    t.close();
  });
});

describe('compound units', () => {
  it('creates 1 Box = 12 Nos with decimals of the second unit', () => {
    const t = createTestCompany();
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    assert.equal(c.isCompound, true);
    assert.equal(c.firstUnitSymbol, 'Box');
    assert.equal(c.secondUnitSymbol, 'Nos');
    assert.equal(c.conversion, 12);
    assert.equal(c.decimalPlaces, 0);
    assert.equal(c.uqc, 'BOX');
    t.close();
  });

  it('validates the parts: different simple units, conversion > 0, no duplicates', () => {
    const t = createTestCompany();
    const { Box, Nos } = t.ids.units;
    assert.throws(() => saveUnit(t.ctx, { kind: 'compound', firstUnitId: Box, conversion: 12, secondUnitId: Box }), fails('VALIDATION', /must be different/));
    assert.throws(() => saveUnit(t.ctx, { kind: 'compound', firstUnitId: Box, conversion: 0, secondUnitId: Nos }), fails('VALIDATION', /more than 0/));
    assert.throws(() => saveUnit(t.ctx, { kind: 'compound', firstUnitId: Box, conversion: -2, secondUnitId: Nos }), fails('VALIDATION', /more than 0/));
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: Box, conversion: 12, secondUnitId: Nos });
    assert.throws(() => saveUnit(t.ctx, { kind: 'compound', firstUnitId: Box, conversion: 12, secondUnitId: Nos }), fails('VALIDATION', /already exists/));
    assert.throws(
      () => saveUnit(t.ctx, { kind: 'compound', firstUnitId: c.id, conversion: 10, secondUnitId: Nos }),
      fails('VALIDATION', /itself a compound unit/),
    );
    assert.throws(() => saveUnit(t.ctx, { id: c.id, kind: 'simple', symbol: 'X' }), fails('BUSINESS_RULE', /compound unit/));
    t.close();
  });

  it('refuses to change a compound unit used by items', () => {
    const t = createTestCompany();
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    saveItem(t.ctx, { name: 'Soap carton', unitId: c.id });
    assert.throws(
      () => saveUnit(t.ctx, { id: c.id, kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 24, secondUnitId: t.ids.units.Nos }),
      fails('BUSINESS_RULE', /used by 1 stock item/),
    );
    t.close();
  });
});

describe('unit list and delete', () => {
  it('lists with search and kind filter and returns totals', () => {
    const t = createTestCompany();
    saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    const all = listUnits(t.db, {});
    assert.equal(all.total, 11);
    const compound = listUnits(t.db, { kind: 'compound' });
    assert.equal(compound.total, 1);
    assert.equal(compound.rows[0].symbol, 'Box of 12 Nos');
    const search = listUnits(t.db, { search: 'litre' });
    assert.deepEqual(search.rows.map((r) => r.symbol), ['Ltr']);
    const paged = listUnits(t.db, { limit: 3, offset: 0 });
    assert.equal(paged.rows.length, 3);
    assert.equal(paged.total, 11);
    t.close();
  });

  it('prevents deleting a unit used by items or compound units, deletes otherwise', () => {
    const t = createTestCompany();
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    assert.throws(() => deleteUnit(t.ctx, t.ids.units.Box), fails('BUSINESS_RULE', /1 compound unit/));
    saveItem(t.ctx, { name: 'Rice', unitId: t.ids.units.Kg, altUnitId: t.ids.units.Gm, altConversion: 0.001 });
    assert.throws(() => deleteUnit(t.ctx, t.ids.units.Gm), fails('BUSINESS_RULE', /1 stock item/));
    deleteUnit(t.ctx, c.id);
    deleteUnit(t.ctx, t.ids.units.Set);
    assert.throws(() => getUnit(t.db, t.ids.units.Set), fails('NOT_FOUND'));
    const del = auditRows(t, 'unit').filter((a) => a.action === 'delete');
    assert.equal(del.length, 2);
    assert.ok(del[1].before_json?.includes('"symbol":"Set"'));
    t.close();
  });
});

describe('review regressions — decimal places', () => {
  it('refuses fewer decimal places than existing opening or voucher quantities need', () => {
    const t = createTestCompany();
    const kg = t.ids.units.Kg; // 3 decimals
    const { item } = saveItem(t.ctx, { name: 'Sugar', unitId: kg, openings: [{ qty: 1.5, rate: 40 }] });
    assert.throws(
      () => saveUnit(t.ctx, { id: kg, kind: 'simple', symbol: 'Kg', decimalPlaces: 0 }),
      (e: unknown) =>
        fails('VALIDATION', /'Sugar' has a quantity of 1\.5 Kg on opening stock, which needs more than 0 decimal places/)(e) &&
        ((e as AppError).details as Array<{ path: string }>)[0].path === 'decimalPlaces',
    );
    assert.equal(saveUnit(t.ctx, { id: kg, kind: 'simple', symbol: 'Kg', decimalPlaces: 1 }).decimalPlaces, 1); // 1.5 still fits
    // Voucher quantities count too.
    t.db.run('UPDATE stock_openings SET qty = 2 WHERE item_id = :id', { id: item.id });
    postStock(t, { baseType: 'sales', date: '2026-04-05', lines: [{ itemId: item.id, qty: -0.5, rate: 50 }] });
    assert.throws(() => saveUnit(t.ctx, { id: kg, kind: 'simple', symbol: 'Kg', decimalPlaces: 0 }), fails('VALIDATION', /0\.5 Kg on a voucher/));
    // Adding decimals is always fine.
    assert.equal(saveUnit(t.ctx, { id: kg, kind: 'simple', symbol: 'Kg', decimalPlaces: 3 }).decimalPlaces, 3);
    t.close();
  });

  it('keeps a compound unit on its second unit’s decimal places', () => {
    const t = createTestCompany();
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    assert.equal(c.decimalPlaces, 0);
    saveUnit(t.ctx, { id: t.ids.units.Nos, kind: 'simple', symbol: 'Nos', decimalPlaces: 2 });
    assert.equal(getUnit(t.db, c.id).decimalPlaces, 2);
    // Items counted in the compound unit protect the second unit's decimals.
    saveItem(t.ctx, { name: 'Soap carton', unitId: c.id, openings: [{ qty: 1.25, rate: 300 }] });
    assert.throws(() => saveUnit(t.ctx, { id: t.ids.units.Nos, kind: 'simple', symbol: 'Nos', decimalPlaces: 0 }), fails('VALIDATION', /Soap carton/));
    t.close();
  });
});

describe('review regressions — audit of dependent compound units', () => {
  it('records the compound units that a rename or decimals change alters', () => {
    const t = createTestCompany();
    const c = saveUnit(t.ctx, { kind: 'compound', firstUnitId: t.ids.units.Box, conversion: 12, secondUnitId: t.ids.units.Nos });
    saveUnit(t.ctx, { id: t.ids.units.Box, kind: 'simple', symbol: 'Bx', formalName: 'Box' });
    saveUnit(t.ctx, { id: t.ids.units.Nos, kind: 'simple', symbol: 'Nos', decimalPlaces: 1 });
    const forCompound = auditRows(t, 'unit').filter((a) => a.entity_id === c.id);
    assert.deepEqual(forCompound.map((a) => [a.action, a.entity_label]), [
      ['create', 'Box of 12 Nos'],
      ['alter', 'Bx of 12 Nos'],
      ['alter', 'Bx of 12 Nos'],
    ]);
    assert.ok(forCompound[1].before_json?.includes('"symbol":"Box of 12 Nos"'));
    assert.ok(forCompound[2].before_json?.includes('"decimalPlaces":0') && forCompound[2].after_json?.includes('"decimalPlaces":1'));
    // A save that changes nothing about the parts adds no entry for the compound.
    saveUnit(t.ctx, { id: t.ids.units.Box, kind: 'simple', symbol: 'Bx', formalName: 'Boxes' });
    assert.equal(auditRows(t, 'unit').filter((a) => a.entity_id === c.id).length, 3);
    t.close();
  });
});
