import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCount, filtersLabel, isActive } from './filters.ts';

test('empty values are inactive: null, undefined, blank text, empty list, false', () => {
  assert.equal(activeCount([{ value: null }, { value: undefined }, { value: '  ' }, { value: [] }, { value: false }]), 0);
});

test('a value is active unless it equals its default', () => {
  assert.equal(isActive({ value: 'sales' }), true);
  assert.equal(isActive({ value: ['sales', 'receipt'] }), true);
  assert.equal(isActive({ value: true }), true, 'a checked option');
  assert.equal(isActive({ value: 0 }), true, 'zero is a real value (e.g. "overdue by at least 0 days")');
  assert.equal(isActive({ value: 'all', defaultValue: 'all' }), false);
  assert.equal(isActive({ value: ' all ', defaultValue: 'all' }), false, 'strings compare trimmed');
  assert.equal(isActive({ value: 'pending', defaultValue: 'all' }), true);
  assert.equal(isActive({ value: ['a', 'b'], defaultValue: ['a', 'b'] }), false, 'lists compare item by item');
  assert.equal(isActive({ value: ['a'], defaultValue: ['a', 'b'] }), true);
  assert.equal(isActive({ value: true, defaultValue: true }), false, 'an option on by default (Show optional vouchers)');
  assert.equal(isActive({ value: false, defaultValue: true }), true, 'turned off = narrowed');
  assert.equal(isActive({ value: '', defaultValue: null }), false, 'empty vs empty default');
});

test('activeCount counts only the active filters', () => {
  assert.equal(activeCount([{ value: 'Sundry Debtors' }, { value: null }, { value: 'x', defaultValue: 'x' }, { value: 30, defaultValue: 0 }]), 2);
  assert.equal(activeCount([]), 0);
});

test('label and accessible name', () => {
  assert.deepEqual(filtersLabel(0), { text: 'Filters', name: 'Filters' });
  assert.deepEqual(filtersLabel(2), { text: 'Filters (2)', name: 'Filters, 2 active' });
  assert.deepEqual(filtersLabel(1), { text: 'Filters (1)', name: 'Filters, 1 active' });
  assert.ok(filtersLabel(3).name.startsWith('Filters'), 'label-in-name: the word the eye reads starts the name');
});
