import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRowGstin, bulkInput, bulkTotals, cellDescribedBy, cellErrorId, isBlankRow, mapBulkServerErrors, newBulkRow, validateBulkRows } from './bulkRows.ts';

describe('bulk ledger rows', () => {
  const MH = '27AAPFU0939F1ZV';
  it('validates names (duplicates in the grid, existing names), group and GSTIN; blank rows ignored', () => {
    const a = { ...newBulkRow(5), name: 'Sharma' };
    const b = { ...newBulkRow(5), name: 'sharma ' };
    const c = { ...newBulkRow(null), name: 'Cash' };
    const d = { ...newBulkRow(5), name: 'Gupta', gstin: `${MH.slice(0, 14)}A` };
    const blank = newBulkRow(5);
    const e = validateBulkRows([a, b, c, d, blank], new Set(['cash']));
    assert.equal(e[`${b.key}.name`], 'Same name as row 1');
    assert.match(e[`${c.key}.name`], /already exists/);
    assert.equal(e[`${c.key}.groupId`], 'Choose the group');
    assert.match(e[`${d.key}.gstin`], /check character/);
    assert.equal(Object.keys(e).some((k) => k.startsWith(blank.key)), false);
    assert.equal(e[`${a.key}.name`], undefined);
  });

  it('builds the input without blank rows and maps server errors back', () => {
    const blank = newBulkRow(5);
    const a = applyRowGstin({ ...newBulkRow(5), name: 'Sharma', openingBalance: 10_000 }, MH.toLowerCase());
    assert.equal(a.stateCode, '27');
    const { rows, rowKeys } = bulkInput([blank, a]);
    assert.deepEqual(rows, [{ name: 'Sharma', groupId: 5, openingBalance: 10_000, gstin: MH, stateCode: '27' }]);
    assert.deepEqual(rowKeys, [a.key]);
    assert.deepEqual(mapBulkServerErrors({ 'rows[0].name': 'Taken', rows: 'x' }, rowKeys), { [`${a.key}.name`]: 'Taken', _: 'x' });
    assert.equal(isBlankRow(blank), true);
  });

  it('totals: Dr 10,000 + Dr 2,500 and Cr 4,000 (paise)', () => {
    const t = bulkTotals([
      { ...newBulkRow(1), name: 'A', openingBalance: 10_000 },
      { ...newBulkRow(1), name: 'B', openingBalance: 2_500 },
      { ...newBulkRow(1), name: 'C', openingBalance: -4_000 },
      newBulkRow(1),
    ]);
    assert.deepEqual(t, { debit: 12_500, credit: 4_000, count: 3 });
  });
});

describe('bulk ledger grid accessibility', () => {
  it('links a cell to its error text only while it has one', () => {
    assert.equal(cellErrorId('r-3', 'stateCode'), 'bl-r-3-stateCode-err');
    assert.equal(cellErrorId('a b:1', 'name'), 'bl-a_b_1-name-err', 'a valid id whatever the row key');
    assert.equal(cellDescribedBy({ 'r-3.stateCode': 'Choose a state' }, 'r-3', 'stateCode'), 'bl-r-3-stateCode-err');
    assert.equal(cellDescribedBy({ 'r-3.stateCode': 'Choose a state' }, 'r-3', 'name'), undefined);
  });

  it('every control of a grid row has an accessible name and points at its error (incl. the State picker)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(dir, '../BulkLedgerScreen.tsx'), 'utf8');
    for (const [label, field] of [['name', 'name'], ['group', 'groupId'], ['opening balance', 'openingBalance'], ['GSTIN', 'gstin'], ['state', 'stateCode']]) {
      assert.ok(src.includes(`aria-label={\`Row \${i + 1} ${label}\`}`), `row ${label} has an aria-label`);
      assert.ok(src.includes(`cellDescribedBy(errors, r.key, '${field}')`), `row ${label} is described by its error`);
      assert.ok(src.includes(`id={cellErrorId(r.key, '${field}')}`), `row ${label} error has an id`);
    }
    // StatePicker forwards the accessible name to the combobox.
    const comp = fs.readFileSync(path.join(dir, '../components.tsx'), 'utf8');
    assert.match(comp, /aria-label=\{ariaLabel\}/);
    assert.match(comp, /aria-describedby=\{ariaDescribedBy\}/);
  });
});
