import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PermissionCatalog } from '../../../../shared/types/security.ts';
import { idleDeadline, idleExplanation, idleLevel, KEEPALIVE_THROTTLE_MS, passwordStatus, permissionCountText, permissionSummary, previousLoginStatus, whenPhrase } from './session.ts';

const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('idle countdown', () => {
  const s = { idleTimeoutMinutes: 30, idleExpiresAt: iso(T0 + 30 * 60_000) };

  it('starts from the server deadline and never shows more time than the server allows', () => {
    assert.equal(idleDeadline(s, null), T0 + 30 * 60_000);
    // A key press 10 min after the fetch may not have reached the server yet (keep-alive is throttled
    // to once a minute), so the countdown assumes it arrived up to 60 s earlier:
    // 10:10 − 1 min + 30 min = 10:39.
    const press = T0 + 10 * 60_000;
    assert.equal(idleDeadline(s, press), press - KEEPALIVE_THROTTLE_MS + 30 * 60_000);
    assert.equal(idleDeadline(s, press), T0 + 39 * 60_000);
    // Activity right after the fetch can't move the deadline earlier than the server's own answer.
    assert.equal(idleDeadline(s, T0 + 5_000), T0 + 30 * 60_000);
  });

  it('has no deadline without an idle timeout', () => {
    assert.equal(idleDeadline({ idleTimeoutMinutes: 0, idleExpiresAt: null }, T0), null);
    assert.equal(idleDeadline({ idleTimeoutMinutes: 30, idleExpiresAt: null }, T0), null);
    assert.equal(idleDeadline({ idleTimeoutMinutes: 30, idleExpiresAt: 'garbage' }, null), null);
  });

  it('turns low in the last two minutes (or last fifth of a short timeout)', () => {
    const d = T0 + 30 * 60_000;
    assert.equal(idleLevel(null, 30, T0), 'none');
    assert.equal(idleLevel(d, 30, d - 3 * 60_000), 'ok');
    assert.equal(idleLevel(d, 30, d - 2 * 60_000), 'low');
    assert.equal(idleLevel(d, 30, d), 'expired');
    // 5-minute timeout: a fifth is 60 s, less than 2 minutes.
    assert.equal(idleLevel(d, 5, d - 90_000), 'ok');
    assert.equal(idleLevel(d, 5, d - 60_000), 'low');
  });

  it('explains the timeout in plain words', () => {
    assert.match(idleExplanation({ idleTimeoutMinutes: 30, implicit: false, securityEnabled: true }), /after 30 minutes without any key press/);
    assert.match(idleExplanation({ idleTimeoutMinutes: 90, implicit: false, securityEnabled: true }), /1 hour 30 minutes/);
    assert.match(idleExplanation({ idleTimeoutMinutes: 0, implicit: false, securityEnabled: true }), /Automatic logout is off/);
    assert.match(idleExplanation({ idleTimeoutMinutes: 30, implicit: true, securityEnabled: false }), /Security is off/);
  });
});

describe('password and login status', () => {
  const now = new Date(T0);
  const base = { implicit: false, passwordChangedAt: iso(T0 - 3 * 86_400_000) };

  it('words the password age and expiry with a tone', () => {
    assert.deepEqual(passwordStatus({ ...base, passwordExpiresAt: null, passwordExpiresInDays: null }, now), {
      text: 'Set 3 days ago. Passwords do not expire in this company.',
      tone: 'neutral',
    });
    assert.equal(passwordStatus({ ...base, passwordExpiresAt: iso(T0 + 40 * 86_400_000), passwordExpiresInDays: 40 }, now).tone, 'success');
    const soon = passwordStatus({ ...base, passwordExpiresAt: iso(T0 + 86_400_000), passwordExpiresInDays: 1 }, now);
    assert.equal(soon.tone, 'warning');
    assert.match(soon.text, /expires in 1 day \(/);
    assert.match(passwordStatus({ ...base, passwordExpiresAt: iso(T0), passwordExpiresInDays: 0 }, now).text, /expires today/);
    assert.equal(passwordStatus({ ...base, passwordExpiresAt: iso(T0 - 86_400_000), passwordExpiresInDays: -1 }, now).tone, 'danger');
    assert.equal(passwordStatus({ ...base, implicit: true, passwordExpiresAt: null, passwordExpiresInDays: null }, now).tone, 'neutral');
  });

  it('flags failed attempts since the previous login', () => {
    const ok = previousLoginStatus({ implicit: false, previousLoginAt: iso(T0 - 2 * 3_600_000), failedAttemptsSincePreviousLogin: 0 }, now);
    assert.equal(ok.tone, 'neutral');
    assert.match(ok.text, /2 hours ago/);
    const warn = previousLoginStatus({ implicit: false, previousLoginAt: iso(T0 - 2 * 3_600_000), failedAttemptsSincePreviousLogin: 3 }, now);
    assert.equal(warn.tone, 'warning');
    assert.match(warn.text, /were 3 failed attempts/);
    assert.match(previousLoginStatus({ implicit: false, previousLoginAt: null, failedAttemptsSincePreviousLogin: 1 }, now).text, /^This is your first login\. Since then there was 1 failed attempt/);
  });

  it('phrases relative times to follow a verb', () => {
    assert.equal(whenPhrase(iso(T0 - 10_000), now), 'just now');
    assert.equal(whenPhrase(iso(T0 - 5 * 60_000), now), '5 min ago');
    assert.match(whenPhrase(iso(T0 - 40 * 86_400_000), now), /^on \d{2}-[A-Z][a-z]{2}-\d{4}$/);
  });
});

describe('permission summary', () => {
  const catalog: PermissionCatalog = {
    groups: [
      {
        key: 'vouchers',
        label: 'Vouchers',
        items: [
          { permission: 'vouchers.view', label: 'View vouchers', fullLabel: 'Vouchers › View vouchers', description: '' },
          { permission: 'vouchers.create', label: 'Create vouchers', fullLabel: 'Vouchers › Create vouchers', description: '' },
        ],
      },
      { key: 'security', label: 'Security', items: [{ permission: 'security.manage', label: 'Manage users and security', fullLabel: '', description: '' }] },
    ],
  };

  it('marks held permissions per group', () => {
    const groups = permissionSummary(catalog, ['vouchers.view'], false);
    assert.deepEqual(
      groups.map((g) => [g.key, g.heldCount, g.items.map((i) => i.held)]),
      [
        ['vouchers', 1, [true, false]],
        ['security', 0, [false]],
      ],
    );
    assert.equal(permissionCountText(groups, false), '1 of 3 permissions');
  });

  it('gives an Owner everything', () => {
    const groups = permissionSummary(catalog, [], true);
    assert.equal(groups.every((g) => g.heldCount === g.items.length), true);
    assert.equal(permissionCountText(groups, true), 'Full access (Owner)');
    assert.deepEqual(permissionSummary(undefined, [], false), []);
  });
});
