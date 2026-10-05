import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SECURITY_SETTINGS } from '../../../../shared/types/security.ts';
import { actionLabel, actionsOf, actionTone, DEFAULT_FILTERS, groupedHash, hasFilters, historyTarget, initialFilters, toExportInput, toListInput, verifyTone } from './auditQuery.ts';
import { changedKeys, describeExpiry, describeIdle, draftOf, patchOf, recommendations, settingsErrors } from './settingsForm.ts';
import { formatCountdown, formatDateTime, formatMinutes, relativeTime } from './time.ts';

const PERIOD = { from: '2026-04-01', to: '2026-10-05' };

describe('edit log query state', () => {
  it('builds list input from filters and paging', () => {
    assert.deepEqual(toListInput(DEFAULT_FILTERS, PERIOD), { from: '2026-04-01', to: '2026-10-05', limit: 200, offset: 0, order: 'desc' });
    assert.deepEqual(toListInput({ ...DEFAULT_FILTERS, dates: 'all', userId: 3, group: 'logins', entityType: 'user', search: '  ravi ', page: 3, pageSize: 100 }, PERIOD), {
      userId: 3,
      actions: ['login', 'logout', 'login_failed'],
      entityType: 'user',
      search: 'ravi',
      limit: 100,
      offset: 200,
      order: 'desc',
    });
    assert.deepEqual(actionsOf({ group: 'changes', action: 'delete' }), ['delete'], 'a specific action wins over the group');
    assert.equal(actionsOf({ group: 'all', action: null }), undefined);
    assert.equal(toListInput({ ...DEFAULT_FILTERS, pageSize: 9999 }, PERIOD).limit, 500);
    assert.deepEqual(toExportInput({ ...DEFAULT_FILTERS, group: 'data' }, PERIOD, 'csv'), { from: '2026-04-01', to: '2026-10-05', actions: ['export', 'import', 'backup', 'restore'], format: 'csv' });
    assert.equal(hasFilters(DEFAULT_FILTERS), false);
    assert.equal(hasFilters({ ...DEFAULT_FILTERS, search: 'x' }), true);
  });

  it('recognises history mode from screen params', () => {
    assert.equal(historyTarget(undefined), null);
    assert.equal(historyTarget({ entityType: 'voucher' }), null);
    assert.deepEqual(historyTarget({ entityType: 'voucher', entityId: 42, label: 'Sales 42' }), { entityType: 'voucher', entityId: 42, label: 'Sales 42' });
    assert.deepEqual(historyTarget({ entityType: 'ledger', entityId: '7', entityGuid: 'g' }), { entityType: 'ledger', entityId: 7, entityGuid: 'g' });
    assert.equal(historyTarget({ entityType: 'ledger', entityId: -1 }), null);
    assert.equal(initialFilters({ entityType: 'voucher' }).entityType, 'voucher');
  });

  it('labels and tones', () => {
    assert.equal(actionLabel('login_failed'), 'Failed login');
    assert.equal(actionLabel('custom'), 'custom');
    assert.equal(actionTone('delete'), 'danger');
    assert.equal(actionTone('create'), 'success');
    assert.equal(groupedHash('a'.repeat(64), 2), 'aaaaaaaa aaaaaaaa');
    assert.equal(groupedHash(null), '');
    const base = { count: 0, totalEntries: 0, brokenAtId: null, reason: null, message: '', detail: '', checkedAt: '', lastEntryId: null, lastHash: null };
    assert.equal(verifyTone({ ...base, ok: true }), 'info');
    assert.equal(verifyTone({ ...base, ok: true, count: 3 }), 'success');
    assert.equal(verifyTone({ ...base, ok: false }), 'danger');
  });
});

describe('security settings form', () => {
  it('validates like the server and builds a patch of changed fields', () => {
    const saved = { ...DEFAULT_SECURITY_SETTINGS };
    assert.deepEqual(settingsErrors(draftOf(saved)), {});
    const bad = { ...draftOf(saved), idleTimeoutMinutes: 3, passwordMinLength: 7, lockoutThreshold: 11, lockoutMinutes: null, passwordExpiryDays: 400 };
    assert.deepEqual(Object.keys(settingsErrors(bad)).sort(), ['idleTimeoutMinutes', 'lockoutMinutes', 'lockoutThreshold', 'passwordExpiryDays', 'passwordMinLength']);
    assert.match(settingsErrors(bad).idleTimeoutMinutes ?? '', /0 \(never\) or between 5 and 240/);
    const draft = { ...draftOf(saved), idleTimeoutMinutes: 15, requireSymbol: true };
    assert.deepEqual(changedKeys(saved, draft), ['idleTimeoutMinutes', 'requireSymbol']);
    assert.deepEqual(patchOf(saved, draft), { idleTimeoutMinutes: 15, requireSymbol: true });
  });

  it('explains settings in plain words and recommends safer ones', () => {
    assert.match(describeIdle(0), /Never log out/);
    assert.match(describeIdle(90), /1 hour 30 minutes/);
    assert.match(describeExpiry(90), /every 90 days/);
    const s = { ...draftOf(DEFAULT_SECURITY_SETTINGS), idleTimeoutMinutes: 0 };
    assert.equal(recommendations(s, { securityEnabled: false, activeOwners: 1 }).length, 1);
    const tips = recommendations(s, { securityEnabled: true, activeOwners: 1 });
    assert.equal(tips.length, 3, tips.join(' | '));
    assert.deepEqual(recommendations({ ...s, idleTimeoutMinutes: 15, passwordMinLength: 12 }, { securityEnabled: true, activeOwners: 2 }), []);
  });
});

describe('time display', () => {
  const now = new Date(2026, 9, 5, 10, 0, 0);
  it('formats local date-times and relative times', () => {
    assert.equal(formatDateTime(new Date(2026, 9, 5, 9, 7).toISOString()), '05-Oct-2026 09:07');
    assert.equal(formatDateTime(null), '');
    assert.equal(relativeTime(new Date(2026, 9, 5, 9, 59, 40).toISOString(), now), 'Just now');
    assert.equal(relativeTime(new Date(2026, 9, 5, 7, 0).toISOString(), now), '3 hours ago');
    assert.equal(relativeTime(new Date(2026, 9, 4, 18, 5).toISOString(), now), 'Yesterday 18:05');
    assert.equal(relativeTime(new Date(2026, 9, 1, 12, 0).toISOString(), now), '4 days ago');
    assert.equal(relativeTime(new Date(2026, 8, 1, 12, 0).toISOString(), now), '01-Sep-2026');
    assert.equal(relativeTime(new Date(2026, 9, 5, 10, 5).toISOString(), now), 'in 5 min');
  });

  it('formats countdowns and durations', () => {
    assert.equal(formatCountdown(29 * 60_000 + 59_000), '29:59');
    assert.equal(formatCountdown(65 * 60_000), '1 h 05 min');
    assert.equal(formatCountdown(-5), '0:00');
    assert.equal(formatMinutes(1), '1 minute');
    assert.equal(formatMinutes(120), '2 hours');
  });
});
