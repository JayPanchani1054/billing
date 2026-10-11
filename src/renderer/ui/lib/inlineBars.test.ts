import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barWidths, MIN_BAR } from './inlineBars.ts';

test('widths are proportional to |value| / max |value|', () => {
  const bars = barWidths([400, 200, 100, 50]);
  assert.deepEqual(
    bars.map((b) => b?.width),
    [1, 0.5, 0.25, 0.125],
  );
  assert.ok(bars.every((b) => b && !b.negative));
});

test('totals are excluded: the caller passes null for them and they neither draw nor set the scale', () => {
  // A 4-row table whose last body row is a total (750): the total gets no bar and the largest row is full width.
  const bars = barWidths([300, 150, 300, null]);
  assert.equal(bars[3], null);
  assert.equal(bars[0]?.width, 1);
  assert.equal(bars[1]?.width, 0.5);
});

test('all-zero (or all-missing) → no bars at all', () => {
  assert.deepEqual(barWidths([0, 0, 0]), [null, null, null]);
  assert.deepEqual(barWidths([null, undefined]), [null, null]);
  assert.deepEqual(barWidths([]), []);
  assert.deepEqual(barWidths([Number.NaN, Number.POSITIVE_INFINITY]), [null, null], 'non-finite values are ignored');
});

test('negatives are flagged and measured by magnitude', () => {
  const bars = barWidths([-34_316_032, 13_139_800, 0]);
  assert.deepEqual(bars[0], { width: 1, negative: true });
  assert.equal(bars[1]?.negative, false);
  assert.ok(Math.abs((bars[1]?.width ?? 0) - 13_139_800 / 34_316_032) < 1e-12);
  assert.equal(bars[2], null, 'zero draws nothing');
});

test('a tiny non-zero value still shows a sliver', () => {
  const bars = barWidths([1_000_000_000, 1]);
  assert.equal(bars[1]?.width, MIN_BAR);
});
