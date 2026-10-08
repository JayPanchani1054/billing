import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChartNode } from '../../../../shared/types/accounts.ts';
import { filterChart, flattenChart, parentKeys, parentKeysUpTo } from './chartTree.ts';

const node = (kind: 'group' | 'ledger', id: number, name: string, closing: number, children: ChartNode[] = [], alias: string | null = null): ChartNode => ({
  kind,
  id,
  name,
  alias,
  nature: 'assets',
  reservedCode: null,
  isPredefined: false,
  isActive: true,
  closing,
  children,
});

// Current Assets (−2,000 + 15,000 = 13,000)
//   Sundry Debtors (15,000)
//     Sharma Traders 10,000 · Gupta & Co 5,000
//   Bank Accounts (−2,000)
//     HDFC Bank (alias "hdfc od") −2,000
const ROOTS: ChartNode[] = [
  node('group', 1, 'Current Assets', 13_000, [
    node('group', 2, 'Sundry Debtors', 15_000, [node('ledger', 10, 'Sharma Traders', 10_000), node('ledger', 11, 'Gupta & Co', 5_000)]),
    node('group', 3, 'Bank Accounts', -2_000, [node('ledger', 12, 'HDFC Bank', -2_000, [], 'hdfc od')]),
  ]),
  node('group', 4, 'Capital Account', 0),
];

describe('flattenChart', () => {
  it('pre-order rows with levels, keys, parents and ledger counts', () => {
    const rows = flattenChart(ROOTS);
    assert.deepEqual(
      rows.map((r) => `${r.key}@${r.level}`),
      ['g:1@0', 'g:2@1', 'l:10@2', 'l:11@2', 'g:3@1', 'l:12@2', 'g:4@0'],
    );
    assert.equal(rows[0].ledgerCount, 3);
    assert.equal(rows[1].ledgerCount, 2);
    assert.deepEqual(rows[2].parents, ['Current Assets', 'Sundry Debtors']);
    assert.equal(rows[6].ledgerCount, 0);
  });

  it('parent keys for expand all / collapse to primary', () => {
    const rows = flattenChart(ROOTS);
    assert.deepEqual([...parentKeys(rows)].sort(), ['g:1', 'g:2', 'g:3']);
    assert.deepEqual([...parentKeysUpTo(rows, 1)], ['g:1']);
  });
});

describe('filterChart', () => {
  const rows = flattenChart(ROOTS);
  it('keeps matches and their ancestors', () => {
    assert.deepEqual(filterChart(rows, 'gupta').map((r) => r.key), ['g:1', 'g:2', 'l:11']);
  });
  it('matches the alias, all words required', () => {
    assert.deepEqual(filterChart(rows, 'od hdfc').map((r) => r.key), ['g:1', 'g:3', 'l:12']);
    assert.deepEqual(filterChart(rows, 'hdfc sharma'), []);
  });
  it('a matching group keeps its sub-tree', () => {
    assert.deepEqual(filterChart(rows, 'debtors').map((r) => r.key), ['g:1', 'g:2', 'l:10', 'l:11']);
  });
  it('empty query → everything', () => {
    assert.equal(filterChart(rows, '  ').length, rows.length);
  });
});
