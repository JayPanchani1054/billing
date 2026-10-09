/**
 * Company Details subtitle in local time (regression: the UTC string was sliced, so a change at
 * 01:00 IST on 10-Oct-2026 read "last changed 09-Oct-2026"). Pins the process time zone to India.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TZ = 'Asia/Kolkata';
const { profileStampText } = await import('./companyForm.ts');
const { formatRelative } = await import('../../../app/display.ts');

test('created date is the local (IST) day; last change is relative to now', () => {
  const now = new Date('2026-10-09T21:30:00.000Z'); // 03:00 IST on 10-Oct
  const text = profileStampText('2026-10-09T19:30:00.000Z', '2026-10-09T19:30:00.000Z', (iso) => formatRelative(iso, now));
  assert.equal(text, 'Created 10-Oct-2026 · last changed 2 hours ago');
});

test('an older change shows its local date, never the UTC one', () => {
  const now = new Date('2026-10-20T06:00:00.000Z');
  // 20:00 UTC on 1-Oct = 01:30 IST on 2-Oct.
  const text = profileStampText('2026-04-01T04:00:00.000Z', '2026-10-01T20:00:00.000Z', (iso) => formatRelative(iso, now));
  assert.equal(text, 'Created 01-Apr-2026 · last changed 2-Oct-26');
});

test('missing stamps are left out instead of showing "Invalid"', () => {
  assert.equal(profileStampText('', '', () => ''), '');
  assert.equal(profileStampText('2026-04-01T04:00:00.000Z', 'bad', () => ''), 'Created 01-Apr-2026');
});
