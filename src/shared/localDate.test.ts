/**
 * localDateOf: the local calendar day of a UTC timestamp (regression: screens sliced the UTC string,
 * showing the previous day for changes made in India after 18:30 UTC / before 05:30 IST).
 * Own file: it pins the process time zone to India (node --test runs each file in its own process).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TZ = 'Asia/Kolkata';
const { localDateOf } = await import('./dates.ts');

test('localDateOf gives the IST day of a UTC timestamp, not the UTC day', () => {
  // 19:30 UTC on 9-Oct = 01:00 IST on 10-Oct.
  assert.equal(localDateOf('2026-10-09T19:30:00.000Z'), '2026-10-10');
  assert.equal('2026-10-09T19:30:00.000Z'.slice(0, 10), '2026-10-09', 'what the old code showed');
  // 18:29 UTC = 23:59 IST — still the same day.
  assert.equal(localDateOf('2026-10-09T18:29:59Z'), '2026-10-09');
  // An explicit offset is honoured.
  assert.equal(localDateOf('2026-10-10T01:00:00+05:30'), '2026-10-10');
});

test('localDateOf: empty or unparsable input gives an empty string', () => {
  assert.equal(localDateOf(''), '');
  assert.equal(localDateOf(null), '');
  assert.equal(localDateOf(undefined), '');
  assert.equal(localDateOf('not a date'), '');
});
