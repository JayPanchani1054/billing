import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StatementLine, TbRow } from '../../../../shared/types/reports.ts';
import {
  balanceSheetCompareDate,
  currentRow,
  daysBetween,
  drillForRow,
  monthRange,
  pairLines,
  paramsPeriod,
  ratioText,
  statementAmountText,
  statementExport,
  tbExport,
  tbTotals,
  voucherTarget,
  yearStartFor,
} from './model.ts';
import { clearExpansionMemory, expansionKey, indentLabel, keysUpToLevel, loadExpansion, parentKeys, saveExpansion, visibleRows, type StorageLike } from './tree.ts';

const P = { from: '2026-04-01', to: '2026-04-30' };

const row = (key: string, level: number, parentKey: string | null, hasChildren = false) => ({ key, level, parentKey, hasChildren });
const TREE = [
  row('g:1', 0, null, true),
  row('g:2', 1, 'g:1', true),
  row('l:5', 2, 'g:2'),
  row('l:6', 1, 'g:1'),
  row('g:3', 0, null, true),
  row('l:7', 1, 'g:3'),
];

test('tree: parent keys, keys up to a level, visible rows follow every ancestor', () => {
  assert.deepEqual([...parentKeys(TREE)], ['g:1', 'g:2', 'g:3']);
  assert.deepEqual([...keysUpToLevel(TREE, 1)], ['g:1', 'g:3']);
  assert.deepEqual([...keysUpToLevel(TREE, 0)], []);
  assert.deepEqual(visibleRows(TREE, new Set()).map((r) => r.key), ['g:1', 'g:3']);
  assert.deepEqual(visibleRows(TREE, new Set(['g:1'])).map((r) => r.key), ['g:1', 'g:2', 'l:6', 'g:3']);
  // g:2 expanded but its parent collapsed → l:5 stays hidden
  assert.deepEqual(visibleRows(TREE, new Set(['g:2', 'g:3'])).map((r) => r.key), ['g:1', 'g:3', 'l:7']);
  assert.equal(indentLabel('Cash', 2), ' '.repeat(6) + 'Cash');
});

test('expansion is remembered per screen (memory + storage) and storage errors are ignored', () => {
  clearExpansionMemory();
  const store = new Map<string, string>();
  const storage: StorageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
  assert.equal(loadExpansion('tb', storage), null);
  saveExpansion('tb', new Set(['g:1', 'g:3']), storage);
  clearExpansionMemory();
  assert.deepEqual([...(loadExpansion('tb', storage) ?? [])], ['g:1', 'g:3']);
  assert.equal(loadExpansion('pl', storage), null);
  const broken: StorageLike = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  clearExpansionMemory();
  assert.equal(loadExpansion('x', broken), null);
  saveExpansion('x', new Set(['a']), broken);
  assert.deepEqual([...(loadExpansion('x', broken) ?? [])], ['a'], 'kept in memory for the session');
  store.set('pevqori.reports.expanded.bad', '{not json');
  clearExpansionMemory();
  assert.equal(loadExpansion('bad', storage), null);
});

test('drill-down targets for every row kind', () => {
  assert.deepEqual(drillForRow({ key: 'g:4', kind: 'group', id: 4 }, P), { screen: 'reports.groupSummary', params: { groupId: 4, ...P } });
  assert.deepEqual(drillForRow({ key: 'l:9', kind: 'ledger', id: 9 }, P), { screen: 'reports.ledger', params: { ledgerId: 9, ...P } });
  assert.equal(drillForRow({ key: 'stock:closing', kind: 'stock', id: null }, P)?.screen, 'stock.summary');
  assert.deepEqual(drillForRow({ key: 'pl', kind: 'profit_loss', id: 3 }, { from: '2026-10-01', to: '2026-10-31' }, { yearStart: '2026-04-01' }), {
    screen: 'reports.profitLoss',
    params: { from: '2026-04-01', to: '2026-10-31' },
  });
  for (const kind of ['gross', 'net', 'difference', 'total'] as const) assert.equal(drillForRow({ key: kind, kind, id: null }, P), null);
  assert.deepEqual(voucherTarget(12, 'sales'), { screen: 'vouchers.view', params: { id: 12 } });
  assert.deepEqual(voucherTarget(12, 'sales', true), { screen: 'vouchers.entry', params: { id: 12, baseType: 'sales' } });
});

test('periods: params override, comparative Balance Sheet date, year start, month range', () => {
  assert.deepEqual(paramsPeriod({ from: '2026-04-01', to: '2026-04-30' }), P);
  assert.equal(paramsPeriod({ from: '2026-04-30', to: '2026-04-01' }), null);
  assert.equal(paramsPeriod({ from: '2026-04-01' }), null);
  assert.equal(paramsPeriod(undefined), null);
  assert.equal(balanceSheetCompareDate('2027-03-31'), '2026-03-31');
  assert.equal(balanceSheetCompareDate('2028-02-29'), '2027-02-28');
  assert.equal(balanceSheetCompareDate('2026-10-15'), '2025-10-15');
  assert.equal(yearStartFor('2026-10-15', 4, '2026-06-01'), '2026-06-01');
  assert.equal(yearStartFor('2027-10-15', 4, '2026-06-01'), '2027-04-01');
  assert.deepEqual(monthRange('2026-04', { from: '2026-04-10', to: '2026-06-30' }), { from: '2026-04-10', to: '2026-04-30' });
  assert.deepEqual(monthRange('2026-06', { from: '2026-04-10', to: '2026-06-15' }), { from: '2026-06-01', to: '2026-06-15' });
  assert.equal(daysBetween('2026-04-01', '2026-04-30'), 30);
});

test('statement amounts never show a bare minus; ratio values read naturally', () => {
  assert.equal(statementAmountText(123456), '1,234.56');
  assert.equal(statementAmountText(-123456), '(1,234.56)');
  assert.equal(statementAmountText(0), '0.00');
  assert.equal(statementAmountText(0, true), '');
  assert.equal(statementAmountText(null), '');
  assert.equal(ratioText({ unit: 'ratio', value: 2.5 }), '2.50 : 1');
  assert.equal(ratioText({ unit: 'times', value: 4 }), '4.00 times');
  assert.equal(ratioText({ unit: 'percent', value: 28.89 }), '28.89%');
  assert.equal(ratioText({ unit: 'days', value: 37 }), '37 days');
  assert.equal(ratioText({ unit: 'days', value: 1 }), '1 day');
  assert.equal(ratioText({ unit: 'amount', value: -500 }), '(5.00)');
  assert.equal(ratioText({ unit: 'ratio', value: null }), '—');
});

const sl = (name: string, amount: number, level = 0, compare: number | null = null): StatementLine => ({
  key: name,
  kind: level ? 'ledger' : 'group',
  id: null,
  name,
  level,
  parentKey: level ? 'p' : null,
  hasChildren: false,
  amount,
  compare,
});

test('horizontal statement export pairs both sides row by row with totals', () => {
  assert.deepEqual(pairLines([1, 2, 3], ['a']), [
    [1, 'a'],
    [2, null],
    [3, null],
  ]);
  const ex = statementExport({ left: 'Expenses', right: 'Income' }, [{ caption: 'Trading Account', left: [sl('Opening Stock', 100), sl('Gross Profit c/o', 50)], right: [sl('Sales Accounts', 150)], total: 150, compareTotal: null }], null);
  assert.deepEqual(ex.columns.map((c) => c.header), ['Expenses', 'Amount', 'Income', 'Amount']);
  assert.deepEqual(ex.rows, [
    ['Trading Account', null, '', null],
    ['Opening Stock', 100, 'Sales Accounts', 150],
    ['Gross Profit c/o', 50, '', null],
    ['Total', 150, 'Total', 150],
  ]);
  const cmp = statementExport({ left: 'Liabilities', right: 'Assets' }, [{ left: [sl('Capital', 10, 0, 8)], right: [sl('Cash', 10, 0, 8)], total: 10, compareTotal: 8 }], '31-Mar-2026');
  assert.equal(cmp.columns.length, 6);
  assert.deepEqual(cmp.rows.at(-1), ['Total', 10, 8, 'Total', 10, 8]);
});

const tb = (name: string, level: number, opening: number, debit: number, credit: number, closing: number): TbRow => ({
  key: name,
  kind: 'group',
  id: null,
  name,
  level,
  parentKey: null,
  hasChildren: false,
  opening,
  debit,
  credit,
  closing,
});

test('trial balance export: Dr/Cr closing columns split by sign, totals over top-level rows', () => {
  const rows = [tb('Capital Account', 0, -1000, 0, 0, -1000), tb('Owner', 1, -1000, 0, 0, -1000), tb('Cash-in-Hand', 0, 1000, 500, 200, 1300), tb('Sales', 0, 0, 0, 300, -300)];
  assert.deepEqual(tbTotals(rows), { debit: 500, credit: 500, closingDebit: 1300, closingCredit: 1300 });
  const ex = tbExport(rows, { opening: false, transactions: true });
  assert.deepEqual(ex.columns.map((c) => c.header), ['Particulars', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr']);
  assert.deepEqual(ex.rows[2], ['Cash-in-Hand', 500, 200, 1300, null]);
  assert.deepEqual(ex.totals, ['Grand Total', 500, 500, 1300, 1300]);
  assert.deepEqual(ex.levels, [0, 1, 0, 0]);
});

test('P&L drill-downs keep the Profit & Loss basis; other rows ignore it', () => {
  assert.deepEqual(drillForRow({ key: 'g:7', kind: 'group', id: 7 }, P, { basis: 'profitLoss' }), {
    screen: 'reports.groupSummary',
    params: { groupId: 7, ...P, basis: 'profitLoss' },
  });
  // Trial-Balance basis is the default: no extra param.
  assert.deepEqual(drillForRow({ key: 'g:7', kind: 'group', id: 7 }, P, { basis: 'trialBalance' })?.params, { groupId: 7, ...P });
  assert.deepEqual(drillForRow({ key: 'l:9', kind: 'ledger', id: 9 }, P, { basis: 'profitLoss' })?.params, { ledgerId: 9, ...P });
});

test('an action applies to the highlighted row only while it is still on screen', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.equal(currentRow({ id: 2 }, rows, (r) => r.id), rows[1]);
  // After switching ledger / tab the old highlight is not one of the rows → nothing to alter.
  assert.equal(currentRow({ id: 9 }, rows, (r) => r.id), null);
  assert.equal(currentRow(null, rows, (r) => r.id), null);
  assert.equal(currentRow({ id: 1 }, undefined, (r) => r.id), null);
});

test('expansion state is kept apart per company', () => {
  assert.equal(expansionKey('7', 'tb:groups'), 'c7:tb:groups');
  assert.notEqual(expansionKey('7', 'tb:groups'), expansionKey('8', 'tb:groups'));
  assert.equal(expansionKey(null, 'tb:groups'), 'tb:groups');
  clearExpansionMemory();
  const store = new Map<string, string>();
  const storage: StorageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
  saveExpansion(expansionKey('7', 'bs:left'), new Set(['g:12']), storage);
  assert.equal(loadExpansion(expansionKey('8', 'bs:left'), storage), null);
  assert.deepEqual([...(loadExpansion(expansionKey('7', 'bs:left'), storage) ?? [])], ['g:12']);
});
