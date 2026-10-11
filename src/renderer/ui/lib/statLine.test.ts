import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropZeros, statMoney, statProblems } from './statLine.ts';

test('statMoney is exact: Indian grouping, ₹ prefix, paise only when non-zero', () => {
  assert.equal(statMoney(46_595_300), '₹4,65,953');
  assert.equal(statMoney(34_316_032), '₹3,43,160.32');
  assert.equal(statMoney(32), '₹0.32');
  assert.equal(statMoney(0), '₹0');
  assert.equal(statMoney(-120_000), '-₹1,200');
  assert.equal(statMoney(1_00_00_000_00), '₹1,00,00,000', 'never compact');
});

test('dropZeros removes zero amounts only', () => {
  const items = [
    { label: 'To collect', value: 9_995_300 },
    { label: 'Overdue', value: 0 },
    { label: 'Count', value: '0' },
    { label: 'Node', value: null },
  ];
  assert.deepEqual(dropZeros(items).map((i) => i.label), ['To collect', 'Count', 'Node']);
});

test('statProblems: at most three figures and one link', () => {
  assert.deepEqual(statProblems([{}, {}, {}, { link: true }]), []);
  assert.deepEqual(statProblems([{}, {}, {}, {}]), ['4 figures (max 3)']);
  assert.deepEqual(statProblems([{ link: true }, { link: true }]), ['2 links (max 1)']);
});

test('statTitle: the label rides in the tooltip (it is visually hidden below 1200 px); a link keeps its own title', async () => {
  const { statTitle } = await import('./statLine.ts');
  assert.equal(statTitle({ label: 'Overdue' }), 'Overdue');
  assert.equal(statTitle({ label: 'Overdue', title: 'Bills past their due date' }), 'Overdue · Bills past their due date');
  assert.equal(statTitle({ label: 'not matched to bills', link: true }), undefined);
  assert.equal(statTitle({ label: 'not matched to bills', link: true, title: 'Advances and on account' }), 'Advances and on account');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../StatLine.tsx', import.meta.url), 'utf8');
  assert.equal((src.match(/title=\{statTitle\(it\)\}/g) ?? []).length, 2, 'both item forms use it');
  assert.match(src, /const problems = statProblems\(items\);\n\s*if \(problems\.length\) console\.error\(/, 'the ≤ 3 figures + 1 link rule is asserted at render (a console error fails the e2e sweep)');
});
