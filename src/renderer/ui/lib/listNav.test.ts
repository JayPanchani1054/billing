import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findByPrefix, nextListIndex } from './listNav.ts';

test('arrows move, clamp without loop, wrap with loop', () => {
  assert.equal(nextListIndex(-1, 'ArrowDown', { count: 5 }), 0);
  assert.equal(nextListIndex(-1, 'ArrowUp', { count: 5 }), 4);
  assert.equal(nextListIndex(2, 'ArrowDown', { count: 5 }), 3);
  assert.equal(nextListIndex(4, 'ArrowDown', { count: 5 }), 4);
  assert.equal(nextListIndex(4, 'ArrowDown', { count: 5, loop: true }), 0);
  assert.equal(nextListIndex(0, 'ArrowUp', { count: 5, loop: true }), 4);
});

test('paging and Home/End', () => {
  assert.equal(nextListIndex(0, 'PageDown', { count: 100, pageSize: 10 }), 10);
  assert.equal(nextListIndex(95, 'PageDown', { count: 100, pageSize: 10 }), 99);
  assert.equal(nextListIndex(5, 'PageUp', { count: 100, pageSize: 10 }), 0);
  assert.equal(nextListIndex(-1, 'PageDown', { count: 100, pageSize: 10 }), 9);
  assert.equal(nextListIndex(50, 'Home', { count: 100 }), 0);
  assert.equal(nextListIndex(50, 'End', { count: 100 }), 99);
});

test('disabled entries are skipped', () => {
  const disabled = new Set([0, 1, 3, 9]);
  const isDisabled = (i: number) => disabled.has(i);
  assert.equal(nextListIndex(-1, 'ArrowDown', { count: 10, isDisabled }), 2);
  assert.equal(nextListIndex(2, 'ArrowDown', { count: 10, isDisabled }), 4);
  assert.equal(nextListIndex(4, 'ArrowUp', { count: 10, isDisabled }), 2);
  assert.equal(nextListIndex(2, 'ArrowUp', { count: 10, isDisabled }), 2);
  assert.equal(nextListIndex(0, 'Home', { count: 10, isDisabled }), 2);
  assert.equal(nextListIndex(0, 'End', { count: 10, isDisabled }), 8);
  assert.equal(nextListIndex(5, 'PageDown', { count: 10, pageSize: 4, isDisabled }), 8);
  assert.equal(nextListIndex(0, 'ArrowDown', { count: 3, isDisabled: () => true }), -1);
  assert.equal(nextListIndex(0, 'ArrowDown', { count: 0 }), -1);
});

test('findByPrefix: type-to-jump with cycling', () => {
  const labels = ['Cash', 'Capital', 'Bank', 'Cess', 'Creditors'];
  const at = (i: number) => labels[i];
  assert.equal(findByPrefix(at, labels.length, -1, 'c'), 0);
  assert.equal(findByPrefix(at, labels.length, 0, 'c'), 1);
  assert.equal(findByPrefix(at, labels.length, 1, 'cc'), 3); // repeated letter cycles
  assert.equal(findByPrefix(at, labels.length, 0, 'ca'), 0); // multi-char keeps current when it matches
  assert.equal(findByPrefix(at, labels.length, 0, 'cr'), 4);
  assert.equal(findByPrefix(at, labels.length, 4, 'c'), 0); // wraps
  assert.equal(findByPrefix(at, labels.length, 0, 'z'), -1);
});
