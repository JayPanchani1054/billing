import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndRank, highlightRanges, matchFields, mergeRanges, splitHighlight } from './match.ts';

const ledgers = [
  { name: 'Cash', alias: '' },
  { name: 'State Bank of India', alias: 'SBI A/c' },
  { name: 'Sales @ 18%', alias: '' },
  { name: 'Sundry Creditors', alias: '' },
  { name: 'Purchase Accounts', alias: 'Purchases' },
  { name: 'Bank Charges', alias: '' },
  { name: 'Salesman Commission', alias: '', keywords: ['incentive'] },
];
const fields = (l: { name: string; alias: string; keywords?: string[] }) => ({ label: l.name, alias: l.alias, keywords: l.keywords });

test('empty query matches everything in source order', () => {
  const r = filterAndRank(ledgers, '  ', fields);
  assert.equal(r.length, ledgers.length);
  assert.deepEqual(r.map((x) => x.index), [0, 1, 2, 3, 4, 5, 6]);
});

test('case-insensitive token match: every token must match', () => {
  const r = filterAndRank(ledgers, 'bank', fields).map((x) => x.item.name);
  assert.deepEqual(r, ['Bank Charges', 'State Bank of India']); // prefix beats word-start
  assert.deepEqual(filterAndRank(ledgers, 'bank india', fields).map((x) => x.item.name), ['State Bank of India']);
  assert.deepEqual(filterAndRank(ledgers, 'bank xyz', fields), []);
});

test('ranking: exact > prefix > word-start > infix', () => {
  const r = filterAndRank(ledgers, 'sales', fields).map((x) => x.item.name);
  assert.deepEqual(r, ['Sales @ 18%', 'Salesman Commission']);
  const cash = filterAndRank(ledgers, 'cash', fields);
  assert.equal(cash[0].item.name, 'Cash');
  assert.ok(cash[0].match.score >= 1000);
});

test('alias, keywords and initials match', () => {
  assert.deepEqual(filterAndRank(ledgers, 'sbi', fields).map((x) => x.item.name), ['State Bank of India']);
  assert.deepEqual(filterAndRank(ledgers, 'purchases', fields).map((x) => x.item.name), ['Purchase Accounts']);
  assert.deepEqual(filterAndRank(ledgers, 'incentive', fields).map((x) => x.item.name), ['Salesman Commission']);
});

test('highlight ranges point at the label, prefer word starts, and merge', () => {
  const m = matchFields({ label: 'State Bank of India' }, 'ban ind');
  assert.ok(m);
  assert.deepEqual(m.ranges, [[6, 9], [14, 17]]);
  const initials = matchFields({ label: 'State Bank of India' }, 'sbi');
  assert.deepEqual(initials?.ranges, [[0, 1], [6, 7], [14, 15]]);
  // 'an' appears inside "Bank" — but there's no word-start 'an', so first occurrence wins
  assert.deepEqual(matchFields({ label: 'Bank' }, 'an')?.ranges, [[1, 3]]);
  assert.deepEqual(mergeRanges([[4, 6], [0, 2], [1, 3], [6, 8]]), [[0, 3], [4, 8]]);
});

test('splitHighlight produces text segments (no HTML)', () => {
  assert.deepEqual(splitHighlight('State Bank', [[6, 10]]), [
    { text: 'State ', match: false },
    { text: 'Bank', match: true },
  ]);
  assert.deepEqual(splitHighlight('abc', []), [{ text: 'abc', match: false }]);
  assert.deepEqual(splitHighlight('abc', [[0, 99]]), [{ text: 'abc', match: true }]);
  assert.deepEqual(splitHighlight('<b>x</b>', [[3, 4]]), [
    { text: '<b>', match: false },
    { text: 'x', match: true },
    { text: '</b>', match: false },
  ]);
});

test('limit and highlightRanges', () => {
  assert.equal(filterAndRank(ledgers, '', fields, 3).length, 3);
  assert.equal(filterAndRank(ledgers, 's', fields, 2).length, 2);
  assert.deepEqual(highlightRanges('Sundry Debtors', 'deb'), [[7, 10]]);
});
