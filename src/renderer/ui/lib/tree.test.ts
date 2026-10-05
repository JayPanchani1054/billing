import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTreeInfo, keysUpToLevel, parentIndices, visibleTreeIndices } from './tree.ts';

// Trial balance-ish:
// 0 Current Assets (0)
// 1   Bank Accounts (1)
// 2     SBI (2)
// 3     HDFC (2)
// 4   Cash-in-Hand (1)
// 5 Current Liabilities (0)
// 6   Duties & Taxes (1)
// 7 Sales Accounts (0)
const levels = [0, 1, 2, 2, 1, 0, 1, 0];

test('parent indexes and hasChildren', () => {
  const t = computeTreeInfo(levels);
  assert.deepEqual(t.parentIndex, [-1, 0, 1, 1, 0, -1, 5, -1]);
  assert.deepEqual(t.hasChildren, [true, true, false, false, false, true, false, false]);
});

test('visibility follows expanded parents', () => {
  const { hasChildren } = computeTreeInfo(levels);
  assert.deepEqual(visibleTreeIndices(levels, hasChildren, () => true), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(visibleTreeIndices(levels, hasChildren, () => false), [0, 5, 7]);
  const expanded = new Set([0]);
  assert.deepEqual(visibleTreeIndices(levels, hasChildren, (i) => expanded.has(i)), [0, 1, 4, 5, 7]);
  const both = new Set([0, 1]);
  assert.deepEqual(visibleTreeIndices(levels, hasChildren, (i) => both.has(i)), [0, 1, 2, 3, 4, 5, 7]);
  // child expanded but parent collapsed → still hidden
  const onlyChild = new Set([1]);
  assert.deepEqual(visibleTreeIndices(levels, hasChildren, (i) => onlyChild.has(i)), [0, 5, 7]);
});

test('parentIndices and keysUpToLevel', () => {
  assert.deepEqual(parentIndices(levels), [0, 1, 5]);
  const rows = levels.map((level, i) => ({ id: `r${i}`, level }));
  assert.deepEqual([...keysUpToLevel(rows, (r) => r.id, (r) => r.level, 1)].sort(), ['r0', 'r5']);
  assert.deepEqual([...keysUpToLevel(rows, (r) => r.id, (r) => r.level, 9)].sort(), ['r0', 'r1', 'r5']);
});

test('irregular level jumps are tolerated', () => {
  const t = computeTreeInfo([0, 2, 1, 0]);
  assert.deepEqual(t.parentIndex, [-1, 0, 0, -1]);
  assert.deepEqual(t.hasChildren, [true, false, false, false]);
});
