import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendantIds, orderTree, pathText } from './tree.ts';

const rows = [
  { id: 1, parentId: null, name: 'Electronics' },
  { id: 2, parentId: 1, name: 'Phones' },
  { id: 3, parentId: 1, name: 'Chargers' },
  { id: 4, parentId: null, name: 'Apparel' },
  { id: 5, parentId: 2, name: 'Android' },
  { id: 6, parentId: 99, name: 'Orphan' },
  { id: 7, parentId: 8, name: 'Loop A' },
  { id: 8, parentId: 7, name: 'Loop B' },
];

test('parents first, children by name, levels', () => {
  const t = orderTree(rows);
  assert.deepEqual(
    t.map((r) => `${'-'.repeat(r.level)}${r.name}`),
    ['Apparel', 'Electronics', '-Chargers', '-Phones', '--Android', 'Orphan', 'Loop A', '-Loop B'],
  );
  assert.equal(t.find((r) => r.id === 1)?.hasChildren, true);
  assert.equal(t.find((r) => r.id === 3)?.hasChildren, false);
  assert.equal(t.length, rows.length); // nothing lost, even in a cycle
});

test('descendants and path', () => {
  assert.deepEqual([...descendantIds(rows, 1)].sort(), [1, 2, 3, 5]);
  assert.equal(pathText(rows, 5), 'Electronics › Phones › Android');
  assert.equal(pathText(rows, null), 'Primary');
  assert.equal(pathText(rows, 7), 'Loop B › Loop A'); // cycle stops
});
