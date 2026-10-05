import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVirtualWindow, pageSize, scrollTopToReveal } from './virtual.ts';

test('window at top with overscan', () => {
  const w = computeVirtualWindow({ count: 10_000, rowHeight: 30, scrollTop: 0, viewportHeight: 300, overscan: 5 });
  assert.deepEqual(w, { start: 0, end: 16, padTop: 0, padBottom: (10_000 - 16) * 30 });
});

test('window in the middle keeps total height constant', () => {
  const count = 10_000;
  const w = computeVirtualWindow({ count, rowHeight: 30, scrollTop: 30_015, viewportHeight: 300, overscan: 5 });
  assert.equal(w.start, 1000 - 5);
  assert.equal(w.end, 1000 + 11 + 5);
  assert.equal(w.padTop + (w.end - w.start) * 30 + w.padBottom, count * 30);
});

test('window at the bottom clamps to count', () => {
  const w = computeVirtualWindow({ count: 100, rowHeight: 20, scrollTop: 5000, viewportHeight: 200, overscan: 3 });
  assert.equal(w.end, 100);
  assert.equal(w.padBottom, 0);
  assert.ok(w.start < 100);
});

test('degenerate inputs', () => {
  assert.deepEqual(computeVirtualWindow({ count: 0, rowHeight: 20, scrollTop: 0, viewportHeight: 100 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  const unmeasured = computeVirtualWindow({ count: 500, rowHeight: 20, scrollTop: 0, viewportHeight: 0 });
  assert.equal(unmeasured.start, 0);
  assert.equal(unmeasured.end, 50);
  assert.equal(unmeasured.padBottom, 450 * 20);
  assert.equal(computeVirtualWindow({ count: 3, rowHeight: 20, scrollTop: -50, viewportHeight: 100 }).start, 0);
});

test('scrollTopToReveal with sticky header and footer', () => {
  const base = { rowHeight: 30, viewportHeight: 300, headerHeight: 30, footerHeight: 30 };
  // visible rows region: [scrollTop + 30, scrollTop + 270] → rows 0..7 fully visible at scrollTop 0
  assert.equal(scrollTopToReveal({ ...base, index: 0, scrollTop: 0 }), null);
  assert.equal(scrollTopToReveal({ ...base, index: 7, scrollTop: 0 }), null);
  // row 8 bottom = 30 + 270 = 300 > 270 → scroll by 30
  assert.equal(scrollTopToReveal({ ...base, index: 8, scrollTop: 0 }), 30);
  // scrolled down; row 2 top = 90 < 300 + 30 → scrollTop = 60
  assert.equal(scrollTopToReveal({ ...base, index: 2, scrollTop: 300 }), 60);
  assert.equal(scrollTopToReveal({ ...base, index: -1, scrollTop: 0 }), null);
});

test('pageSize', () => {
  assert.equal(pageSize(300, 30), 9);
  assert.equal(pageSize(300, 30, 60), 7);
  assert.equal(pageSize(10, 30), 1);
  assert.equal(pageSize(300, 0), 10);
});
