import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChartNode, OpeningBalanceSummary } from '../../../../shared/types/accounts.ts';
import { bulkInput, bulkTotals, isBlankRow, mapBulkServerErrors, newBulkRow, validateBulkRows, applyRowGstin } from './bulkRows.ts';
import { filterChart, flattenChart, parentKeys, parentKeysUpTo } from './chartTree.ts';
import { chipClasses, explainOpening, ledgerKind } from './ledgerFilters.ts';

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

describe('ledger filters and opening summary', () => {
  it('chips map to classes', () => {
    assert.deepEqual(chipClasses('parties'), ['party']);
    assert.equal(chipClasses('all'), undefined);
    assert.equal(ledgerKind({ classes: ['party', 'creditor', 'liability'] }), 'Supplier');
    assert.equal(ledgerKind({ classes: ['bank', 'cash_bank', 'asset'] }), 'Bank');
  });

  const sum = (totalDebit: number, totalCredit: number, ledgerCount = 2): OpeningBalanceSummary => ({ totalDebit, totalCredit, difference: totalDebit - totalCredit, ledgerCount });

  it('balanced openings', () => {
    assert.equal(explainOpening(sum(50_000, 50_000), null).tone, 'success');
  });

  it('difference explained with side and amount: Dr 60,000 − Cr 50,000 = 10,000 Dr (₹100.00)', () => {
    const x = explainOpening(sum(60_000, 50_000), null);
    assert.equal(x.tone, 'warning');
    assert.equal(x.title, 'Difference in opening balances: ₹ 100.00 Dr');
  });

  it('opening stock (a debit) closes a credit difference: Dr 40,000 − Cr 50,000 + stock 10,000 = 0', () => {
    const x = explainOpening(sum(40_000, 50_000), 10_000);
    assert.equal(x.tone, 'success');
    assert.match(x.body, /opening stock of ₹ 100\.00/);
  });

  it('no openings at all', () => {
    assert.equal(explainOpening(sum(0, 0, 0), null).title, 'No opening balances entered');
  });
});
