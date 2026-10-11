import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyColumnIds, isBlankCell } from './emptyColumns.ts';
import type { EmptyColumnLike } from './emptyColumns.ts';

interface Ledger {
  name: string;
  gstin: string | null;
  alias?: string;
  closing: number;
  opening: number;
}

const COLS: EmptyColumnLike<Ledger>[] = [
  { key: 'name' },
  { key: 'gstin' },
  { key: 'alias' },
  { key: 'opening', kind: 'amount' },
  { key: 'closing', kind: 'drcr' },
];

const rows: Ledger[] = [
  { name: 'Cash', gstin: null, alias: '  ', opening: 0, closing: 16_680_000 },
  { name: 'Bank', gstin: '', opening: 0, closing: -5_000 },
];

test('columns blank on every row are reported; the rest stay', () => {
  assert.deepEqual(emptyColumnIds(COLS, rows), ['gstin', 'alias']);
});

test('one value anywhere keeps the column', () => {
  const withGstin = [...rows, { name: 'Asha Retail', gstin: '27AAAPA0002A1Z5', opening: 0, closing: 0 }];
  assert.deepEqual(emptyColumnIds(COLS, withGstin), ['alias']);
});

test('zero is blank only where the kit draws it blank (Dr/Cr, amount with blankZero)', () => {
  const zero: Ledger[] = [{ name: 'Suspense', gstin: 'x', alias: 'x', opening: 0, closing: 0 }];
  assert.deepEqual(emptyColumnIds(COLS, zero), ['closing'], 'a plain amount column shows 0.00, so it stays');
  const blankZero = COLS.map((c) => (c.key === 'opening' ? { ...c, blankZero: true } : c));
  assert.deepEqual(emptyColumnIds(blankZero, zero), ['opening', 'closing']);
  assert.equal(isBlankCell('number', undefined, 0), false);
  assert.equal(isBlankCell('qty', undefined, 0), false);
  assert.equal(isBlankCell('drcr', undefined, 0), true);
  assert.equal(isBlankCell(undefined, undefined, false), false, 'booleans are content');
});

test('the label column, keepEmpty columns and empty tables are never hidden', () => {
  const blankNames = [{ name: '', gstin: null, opening: 1, closing: 1 }];
  assert.deepEqual(emptyColumnIds(COLS, blankNames), ['gstin', 'alias'], 'the first column is the label');
  const tree: EmptyColumnLike<Ledger>[] = [{ key: 'gstin' }, { key: 'name', tree: true }];
  assert.deepEqual(emptyColumnIds(tree, [{ name: '', gstin: null, opening: 0, closing: 0 }]), ['gstin'], 'the tree column is the label');
  const keep = COLS.map((c) => (c.key === 'gstin' ? { ...c, keepEmpty: true } : c));
  assert.deepEqual(emptyColumnIds(keep, rows), ['alias']);
  assert.deepEqual(emptyColumnIds(COLS, []), [], 'no rows → every header stays');
});

test('value() accessors are used when given', () => {
  const cols: EmptyColumnLike<Ledger>[] = [{ key: 'name' }, { key: 'state', value: (r) => (r.gstin ? r.gstin.slice(0, 2) : null) }];
  assert.deepEqual(emptyColumnIds(cols, rows), ['state']);
  assert.deepEqual(emptyColumnIds(cols, [{ name: 'A', gstin: '27X', opening: 0, closing: 0 }]), []);
});

test('a render-only column (no value, key not on the row) is never hidden; a rendered field column still is', () => {
  const render = () => 'drawn';
  const cols: EmptyColumnLike<Ledger>[] = [{ key: 'name' }, { key: 'status', render }, { key: 'gstin', render }];
  assert.deepEqual(emptyColumnIds(cols, rows), ['gstin'], '"status" draws from other fields; "gstin" is a blank field');
  const withValue: EmptyColumnLike<Ledger>[] = [{ key: 'name' }, { key: 'status', render, value: () => null }];
  assert.deepEqual(emptyColumnIds(withValue, rows), ['status'], 'a declared value() is trusted');
});
