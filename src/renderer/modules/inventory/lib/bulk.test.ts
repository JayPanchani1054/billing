import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkErrorTarget, bulkInputs, bulkWarnings, emptyBulkRow, isBlankBulkRow, validateBulkRows } from './bulk.ts';
import type { BulkContext, BulkRow } from './bulk.ts';

const ctx: BulkContext = { gstEnabled: true, openingGodownId: null, multipleGodowns: false, unitDecimals: (id) => (id === 2 ? 3 : 0) };
const row = (over: Partial<BulkRow>): BulkRow => ({ ...emptyBulkRow(1), ...over });

test('blank rows are ignored, even with the pre-filled unit', () => {
  assert.equal(isBlankBulkRow(emptyBulkRow(1)), true);
  assert.deepEqual(validateBulkRows([emptyBulkRow(1)], ctx), {});
  assert.deepEqual(bulkInputs([emptyBulkRow(1)], ctx), []);
});

test('row checks: names (also duplicates in the grid), unit, HSN, rate, opening', () => {
  const rows = [
    row({ key: 'a', name: 'Pen' }),
    row({ key: 'b', name: ' pen ' }),
    row({ key: 'c', name: '', gstRate: 18 }),
    row({ key: 'd', name: 'Sugar', unitId: 2, openingQty: 1.2345 }),
    row({ key: 'e', name: 'Ink', hsnSac: '12', gstRate: 13, openingRate: 5 }),
    row({ key: 'f', name: 'Clip', unitId: null }),
  ];
  const e = validateBulkRows(rows, ctx);
  assert.match(e['b.name'], /Same name as row 1/);
  assert.match(e['c.name'], /Enter the item name/);
  assert.match(e['d.openingQty'], /3 decimal places/);
  assert.match(e['e.hsnSac'], /4, 6 or 8 digits/);
  assert.match(e['e.gstRate'], /not a notified GST rate/);
  assert.match(e['e.openingQty'], /Enter the opening quantity/);
  assert.match(e['f.unitId'], /Choose the unit/);
  const g = validateBulkRows([row({ key: 'g', name: 'Tape', openingQty: 5 })], { ...ctx, multipleGodowns: true });
  assert.match(g['g.openingQty'], /godown/);
});

test('inputs: GST only when given, opening value calculated', () => {
  const out = bulkInputs(
    [row({ key: 'a', name: ' Pen ', hsnSac: '9608 10', gstRate: 18, sellingPrice: 1000, openingQty: 100, openingRate: 6.5 }), row({ key: 'b', name: 'Clip', groupId: 3 })],
    { ...ctx, multipleGodowns: true, openingGodownId: 4 },
  );
  assert.deepEqual(out[0], {
    key: 'a',
    input: {
      name: 'Pen',
      unitId: 1,
      hsnSac: '960810',
      gstApplicable: true,
      taxability: 'taxable',
      gstRate: 18,
      sellingPrice: 1000,
      openings: [{ qty: 100, godownId: 4, rate: 6.5, value: 65000 }], // 100 × ₹6.50 = ₹650.00
    },
  });
  assert.deepEqual(out[1].input, { name: 'Clip', groupId: 3, unitId: 1 });
});

test('server error paths map back to grid cells', () => {
  const sent = [{ key: 'a' }, { key: 'b' }];
  // No barcode column in the grid: the message lands on the row's name cell (never invisible).
  assert.deepEqual(bulkErrorTarget('rows[1].barcode', sent), { key: 'b', field: 'name' });
  assert.deepEqual(bulkErrorTarget('rows[1].hsnSac', sent), { key: 'b', field: 'hsnSac' });
  assert.deepEqual(bulkErrorTarget('rows[1].openings[0].value', sent), { key: 'b', field: 'openingRate' });
  assert.deepEqual(bulkErrorTarget('rows[1].openings[0].godownId', sent), { key: 'b', field: 'openingQty' });
  assert.deepEqual(bulkErrorTarget('rows[0].taxability', sent), { key: 'a', field: 'gstRate' });
  assert.deepEqual(bulkErrorTarget('rows[0].openings[0].qty', sent), { key: 'a', field: 'openingQty' });
  assert.deepEqual(bulkErrorTarget('rows[0]', sent), { key: 'a', field: 'name' });
  assert.equal(bulkErrorTarget('rows[5].name', sent), null);
  assert.equal(bulkErrorTarget('groupId', sent), null);
});

test('rows are goods: a SAC code is refused with a pointer to the item form', () => {
  const e = validateBulkRows([row({ key: 's', name: 'Repairs', hsnSac: '998713' })], ctx);
  assert.match(e['s.hsnSac'], /SAC \(services\) codes, not HSN.*item form/);
  // Without GST, HSN and rate are neither checked nor sent.
  const off = { ...ctx, gstEnabled: false };
  assert.deepEqual(validateBulkRows([row({ key: 's', name: 'Repairs', hsnSac: '998713', gstRate: 13 })], off), {});
  assert.deepEqual(bulkInputs([row({ key: 's', name: 'Repairs', hsnSac: '998713', gstRate: 13 })], off)[0].input, { name: 'Repairs', unitId: 1 });
});

test('retired 12% / 28% slabs are flagged (not blocked) from 22-Sep-2025', () => {
  const rows = [row({ name: 'Tiles', gstRate: 28 }), row({ name: 'Pen', gstRate: 18 }), row({ name: 'Ghee', gstRate: 12 }), emptyBulkRow(1)];
  const w = bulkWarnings(rows, ctx, '2026-10-08');
  assert.equal(w.length, 1);
  assert.match(w[0], /row 1 \(28%\), row 3 \(12%\)/);
  assert.deepEqual(bulkWarnings(rows, ctx, '2025-09-21'), []); // before the change the slabs were current
  assert.deepEqual(bulkWarnings(rows, { gstEnabled: false }, '2026-10-08'), []);
  assert.deepEqual(validateBulkRows(rows, ctx), {}); // 12 and 28 are still notified rates
});
