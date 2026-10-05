import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampDate, isOutOfRange, monthMatrix, moveDate, weekdayHeaders, weekdayIndex, weekdayName } from './calendar.ts';

test('weekday of known dates', () => {
  assert.equal(weekdayIndex('2026-10-05'), 1); // Monday
  assert.equal(weekdayName('2026-10-05'), 'Mon');
  assert.equal(weekdayName('2026-10-05', 'long'), 'Monday');
  assert.equal(weekdayName('2024-02-29', 'long'), 'Thursday');
  assert.equal(weekdayName('not-a-date'), '');
});

test('weekday headers rotate with week start', () => {
  assert.deepEqual(weekdayHeaders(0), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(weekdayHeaders(1), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('month matrix is 6×7 and starts on the configured weekday', () => {
  const m = monthMatrix(2026, 10, 0); // Oct 2026 starts Thursday
  assert.equal(m.length, 6);
  assert.ok(m.every((r) => r.length === 7));
  assert.equal(m[0][0], '2026-09-27');
  assert.equal(m[0][4], '2026-10-01');
  const mon = monthMatrix(2026, 10, 1);
  assert.equal(mon[0][0], '2026-09-28');
  assert.equal(weekdayIndex(mon[0][0]), 1);
  // Feb 2026 starts on Sunday → no leading days with Sunday start
  assert.equal(monthMatrix(2026, 2, 0)[0][0], '2026-02-01');
});

test('keyboard movement', () => {
  assert.equal(moveDate('2026-10-05', 'ArrowLeft'), '2026-10-04');
  assert.equal(moveDate('2026-10-05', 'ArrowDown'), '2026-10-12');
  assert.equal(moveDate('2026-01-31', 'PageDown'), '2026-02-28');
  assert.equal(moveDate('2026-10-05', 'PageUp', true), '2025-10-05');
  assert.equal(moveDate('2026-10-07', 'Home', false, 1), '2026-10-05'); // Wed → Mon
  assert.equal(moveDate('2026-10-07', 'End', false, 1), '2026-10-11'); // → Sun
  assert.equal(moveDate('2026-10-07', 'Home', false, 0), '2026-10-04'); // → Sun
  assert.equal(moveDate('2026-10-07', 'x'), null);
});

test('range helpers', () => {
  assert.equal(clampDate('2026-03-01', '2026-04-01', '2027-03-31'), '2026-04-01');
  assert.equal(clampDate('2027-05-01', '2026-04-01', '2027-03-31'), '2027-03-31');
  assert.equal(isOutOfRange('2026-05-01', '2026-04-01', '2027-03-31'), false);
  assert.equal(isOutOfRange('2026-03-31', '2026-04-01', null), true);
});
