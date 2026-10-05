import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaPath, bandLayout, linePath, linearScale, niceStep, niceTicks, sparkline } from './chart.ts';
import { paginationRange, pageBounds, pageCountOf } from './pagination.ts';

test('niceStep picks 1/2/2.5/5 × 10^k', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(130), 200);
  assert.equal(niceStep(0), 1);
});

test('niceTicks include zero and cover the domain', () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(13, 87, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(-40, 60, 5), [-50, -25, 0, 25, 50, 75]);
  assert.deepEqual(niceTicks(0, 0, 5), [0, 0.25, 0.5, 0.75, 1]);
  const big = niceTicks(0, 12_345_600, 5); // paise
  assert.equal(big[0], 0);
  assert.ok(big[big.length - 1] >= 12_345_600);
  assert.ok(big.length >= 4 && big.length <= 7);
  assert.deepEqual(niceTicks(0, 0.3, 4), [0, 0.1, 0.2, 0.3]);
});

test('linear scale and bands', () => {
  const s = linearScale([0, 100], [200, 0]);
  assert.equal(s(0), 200);
  assert.equal(s(50), 100);
  assert.equal(linearScale([5, 5], [0, 10])(5), 5);
  const b = bandLayout(4, 0, 400, 0.2, 0.1);
  assert.ok(Math.abs(b.start(0) - b.step * 0.1) < 1e-9);
  assert.ok(Math.abs(b.start(3) + b.bandwidth + b.step * 0.1 - 400) < 1e-6);
  assert.ok(Math.abs(b.center(1) - (b.start(1) + b.bandwidth / 2)) < 1e-9);
});

test('path builders', () => {
  assert.equal(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 20, y: 1 }, { x: 30, y: 2.555 }]), 'M0 0 L10 5 M20 1 L30 2.56');
  assert.equal(areaPath([{ x: 0, y: 5 }, { x: 10, y: 2 }], 10), 'M0 10 L0 5 L10 2 L10 10 Z');
  assert.equal(areaPath([], 10), '');
});

test('sparkline geometry', () => {
  const g = sparkline([1, 3, 2], 100, 20, 2);
  assert.equal(g.points.length, 3);
  assert.equal(g.points[0].x, 2);
  assert.equal(g.points[2].x, 98);
  assert.equal(g.points[1].y, 2); // max at top inset
  assert.equal(g.points[0].y, 18); // min at bottom inset
  assert.deepEqual(g.last, g.points[2]);
  assert.equal(sparkline([], 100, 20).line, '');
  assert.equal(sparkline([5, 5], 100, 20).points[0].y, 10);
});

test('pagination range', () => {
  assert.deepEqual(paginationRange(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationRange(1, 20), [1, 2, 3, 4, 5, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(10, 20), [1, 'ellipsis-start', 9, 10, 11, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(20, 20), [1, 'ellipsis-start', 16, 17, 18, 19, 20]);
  assert.deepEqual(paginationRange(4, 20), [1, 2, 3, 4, 5, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(99, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pageCountOf(0, 50), 1);
  assert.equal(pageCountOf(101, 50), 3);
  assert.deepEqual(pageBounds(2, 50, 120), { from: 51, to: 100 });
  assert.deepEqual(pageBounds(3, 50, 120), { from: 101, to: 120 });
  assert.deepEqual(pageBounds(1, 50, 0), { from: 0, to: 0 });
});
