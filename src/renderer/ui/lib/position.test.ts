import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePosition } from './position.ts';

const vp = { width: 1000, height: 800 };

test('bottom-start below the anchor', () => {
  const p = computePosition({ top: 100, left: 50, width: 200, height: 30 }, { width: 240, height: 200 }, vp, 'bottom-start', 4, 8);
  assert.deepEqual(p, { top: 134, left: 50, placement: 'bottom-start', available: 800 - 130 - 4 - 8 });
});

test('flips to top when there is no room below and more room above', () => {
  const p = computePosition({ top: 700, left: 50, width: 200, height: 30 }, { width: 240, height: 200 }, vp, 'bottom-start', 4, 8);
  assert.equal(p.placement, 'top-start');
  assert.equal(p.top, 700 - 4 - 200);
});

test('does not flip when the other side is smaller', () => {
  const p = computePosition({ top: 300, left: 50, width: 200, height: 30 }, { width: 240, height: 600 }, vp, 'bottom-start', 4, 8);
  assert.equal(p.placement, 'bottom-start');
  assert.equal(p.available, 800 - 330 - 4 - 8);
});

test('shifts horizontally to stay inside the viewport', () => {
  const p = computePosition({ top: 100, left: 900, width: 80, height: 30 }, { width: 240, height: 100 }, vp, 'bottom-start', 4, 8);
  assert.equal(p.left, 1000 - 8 - 240);
  const q = computePosition({ top: 100, left: 0, width: 80, height: 30 }, { width: 240, height: 100 }, vp, 'bottom-end', 4, 8);
  assert.equal(q.left, 8);
});

test('end and centre alignment, side placements', () => {
  const end = computePosition({ top: 100, left: 400, width: 100, height: 30 }, { width: 200, height: 100 }, vp, 'bottom-end');
  assert.equal(end.left, 300);
  const center = computePosition({ top: 400, left: 400, width: 100, height: 30 }, { width: 200, height: 100 }, vp, 'top');
  assert.equal(center.left, 350);
  assert.equal(center.placement, 'top');
  const right = computePosition({ top: 100, left: 100, width: 100, height: 30 }, { width: 200, height: 100 }, vp, 'right-start', 4);
  assert.deepEqual([right.left, right.top, right.placement], [204, 100, 'right-start']);
  const flipped = computePosition({ top: 100, left: 850, width: 100, height: 30 }, { width: 200, height: 100 }, vp, 'right-start', 4);
  assert.equal(flipped.placement, 'left-start');
  assert.equal(flipped.left, 850 - 4 - 200);
});
