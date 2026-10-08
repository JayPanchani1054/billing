import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SECURITY_SETTINGS } from '../../../../shared/types/security.ts';
import type { AuditFacets, AuditListRow } from '../../../../shared/types/security.ts';
import {
  actionLabel,
  actionOptions,
  actionsOf,
  actionTone,
  adjacentId,
  ANY,
  auditHistoryParams,
  DEFAULT_FILTERS,
  entityTypeOptions,
  filterSummary,
  formatCount,
  groupedHash,
  hasFilters,
  historyExportInput,
  historyTarget,
  initialFilters,
  printRows,
  toExportInput,
  toListInput,
  userOptions,
  verifyTone,
  withGroup,
} from './auditQuery.ts';
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

describe('edit log filter options', () => {
  const facets: AuditFacets = {
    entityTypes: [
      { value: 'ledger', label: 'Ledger', count: 1234 },
      { value: 'voucher', label: 'Voucher', count: 123456 },
    ],
    users: [
      { userId: null, username: 'owner', count: 40 },
      { userId: 2, username: 'ravi', count: 10 },
      { userId: 2, username: 'ravi.k', count: 5 },
      { userId: 1, username: 'Admin', count: 7 },
    ],
    actions: [
      { value: 'alter', count: 3 },
      { value: 'create', count: 12 },
      { value: 'login', count: 2 },
    ],
    firstTs: null,
    lastTs: null,
  };

  it('lists each user id once (renames merged; entries without a user id are not filterable)', () => {
    // ravi: 10 + 5 = 15 entries under both names.
    assert.deepEqual(userOptions(facets), [
      { value: ANY, label: 'All users' },
      { value: '1', label: 'Admin (7)' },
      { value: '2', label: 'ravi / ravi.k (15)' },
    ]);
    assert.deepEqual(userOptions(undefined), [{ value: ANY, label: 'All users' }]);
    // A user requested by the screen params stays selectable (the select must not read "All users").
    assert.deepEqual(userOptions(facets, 9).at(-1), { value: '9', label: 'User #9 (0)' });
    assert.equal(userOptions(facets, 2).length, 3, 'a known user is not added twice');
  });

  it('lists record types with Indian-grouped counts and keeps a requested type', () => {
    assert.deepEqual(entityTypeOptions(facets).map((o) => o.label), ['All record types', 'Ledger (1,234)', 'Voucher (1,23,456)']);
    assert.equal(entityTypeOptions(facets, 'godown').at(-1)?.value, 'godown');
    assert.equal(formatCount(1234567), '12,34,567');
  });

  it('offers only the actions of the chosen group that occur in the log', () => {
    assert.deepEqual(actionOptions(facets, 'changes').map((o) => o.value), [ANY, 'create', 'alter']);
    assert.deepEqual(actionOptions(facets, 'all').map((o) => o.value), [ANY, 'create', 'alter', 'login']);
    assert.deepEqual(actionOptions(facets, 'data').map((o) => o.value), [ANY]);
    assert.equal(actionOptions(facets, 'changes')[1].label, 'Created (12)');
  });

  it('switching group drops an action outside it and goes back to page 1', () => {
    const f = { ...DEFAULT_FILTERS, group: 'changes' as const, action: 'delete' as const, page: 4 };
    assert.deepEqual(withGroup(f, 'logins'), { ...f, group: 'logins', action: null, page: 1 });
    assert.equal(withGroup(f, 'all').action, 'delete', '"All" keeps a specific action');
    assert.equal(withGroup(f, 'changes').action, 'delete');
  });

  it('starts a user-filtered view on all dates', () => {
    const f = initialFilters({ userId: 3 });
    assert.equal(f.userId, 3);
    assert.equal(f.dates, 'all');
    assert.equal(initialFilters({ userId: 0 }).userId, null);
    assert.equal(initialFilters({ userId: '3' }).userId, null);
  });
});

describe('edit log navigation and output', () => {
  const rows = [{ id: 9 }, { id: 7 }, { id: 4 }];

  it('finds the newer / older entry for the drawer', () => {
    assert.equal(adjacentId(rows, 7, -1), 9);
    assert.equal(adjacentId(rows, 7, 1), 4);
    assert.equal(adjacentId(rows, 9, -1), null);
    assert.equal(adjacentId(rows, 4, 1), null);
    assert.equal(adjacentId(rows, 5, 1), null, 'an entry outside this page (e.g. from Verify) has no neighbours');
  });

  it('builds history params and export input for one record', () => {
    assert.deepEqual(auditHistoryParams('ledger', 7, 'Sharma & Sons'), { entityType: 'ledger', entityId: 7, label: 'Sharma & Sons' });
    assert.deepEqual(historyTarget(auditHistoryParams('voucher', 3, undefined, 'g-1')), { entityType: 'voucher', entityId: 3, entityGuid: 'g-1' });
    assert.deepEqual(historyExportInput({ entityType: 'voucher', entityId: 3, label: 'x' }, 'xlsx'), { entityType: 'voucher', entityId: 3, format: 'xlsx' });
  });

  it('summarises filters and prints rows as text', () => {
    assert.equal(filterSummary(DEFAULT_FILTERS, { periodLabel: 'FY 2026-27' }), 'FY 2026-27');
    assert.equal(
      filterSummary({ ...DEFAULT_FILTERS, dates: 'all', userId: 2, group: 'changes', entityType: 'ledger', search: ' sharma ' }, { periodLabel: 'FY', userLabel: 'ravi', entityTypeLabel: 'Ledger' }),
      'All dates · User: ravi · Changes · Record type: Ledger · Search: “sharma”',
    );
    assert.equal(filterSummary({ ...DEFAULT_FILTERS, group: 'changes', action: 'delete' }, { periodLabel: 'FY' }), 'FY · Action: Deleted');
    const row: AuditListRow = { id: 1, ts: '2026-10-05T05:00:00.000Z', userId: 2, username: null, action: 'delete', entityType: 'ledger', entityTypeLabel: 'Ledger', entityId: 7, entityGuid: null, entityLabel: null, summary: 'Deleted' };
    assert.deepEqual(printRows([row], (ts) => ts.slice(0, 10)), [['2026-10-05', '—', 'Deleted', 'Ledger', '#7', 'Deleted']]);
  });
});
