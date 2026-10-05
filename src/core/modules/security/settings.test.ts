import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SECURITY_SETTINGS, type PasswordPolicyInfo, type SecuritySettings } from '../../../shared/types/security.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../app/controller.ts';
import { readSetting, writeSetting } from '../company/service.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { getLockoutPolicy, isPasswordExpired, passwordProblem } from './policy.ts';
import { securityRoutes as R } from './routes.ts';
import { getSecuritySettings } from './settings.ts';

async function fail(t: TestCompany, input: unknown, path: string, re: RegExp) {
  const r = await t.call(R, 'security.settings.save', input);
  assert.equal(r.ok, false, JSON.stringify(input));
  if (!r.ok) {
    assert.equal(r.error.code, 'VALIDATION');
    const issues = r.error.details as Array<{ path: string; message: string }>;
    assert.equal(issues[0].path, path);
    assert.match(issues[0].message, re);
  }
}

describe('security settings', () => {
  it('defaults match the controller and auth defaults when nothing is stored', async () => {
    const t = createTestCompany({ security: true });
    const s = await t.callOk<SecuritySettings>(R, 'security.settings.get');
    assert.deepEqual(s, DEFAULT_SECURITY_SETTINGS);
    assert.equal(s.idleTimeoutMinutes * 60_000, DEFAULT_IDLE_TIMEOUT_MS, 'same default idle timeout as the AppController');
    assert.deepEqual(getLockoutPolicy(t.db), { maxFailedAttempts: 5, lockoutMs: 5 * 60_000 }, 'same as auth.ts MAX_FAILED_ATTEMPTS / LOCKOUT_MS');
    t.close();
  });

  it('validates every range with a readable message', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, { idleTimeoutMinutes: 3 }, 'idleTimeoutMinutes', /0 \(never\) or between 5 and 240/);
    await fail(t, { idleTimeoutMinutes: 241 }, 'idleTimeoutMinutes', /between 5 and 240/);
    await fail(t, { idleTimeoutMinutes: 2.5 }, 'idleTimeoutMinutes', /whole number/);
    await fail(t, { passwordMinLength: 7 }, 'passwordMinLength', /between 8 and 64/);
    await fail(t, { passwordMinLength: 65 }, 'passwordMinLength', /between 8 and 64/);
    await fail(t, { lockoutThreshold: 2 }, 'lockoutThreshold', /3 to 10/);
    await fail(t, { lockoutThreshold: 11 }, 'lockoutThreshold', /3 to 10/);
    await fail(t, { lockoutMinutes: 0 }, 'lockoutMinutes', /between 1 and 60/);
    await fail(t, { lockoutMinutes: 61 }, 'lockoutMinutes', /between 1 and 60/);
    await fail(t, { passwordExpiryDays: -1 }, 'passwordExpiryDays', /0 \(never\)/);
    await fail(t, { passwordExpiryDays: 366 }, 'passwordExpiryDays', /365/);
    // Boundaries are accepted.
    for (const ok of [{ idleTimeoutMinutes: 0 }, { idleTimeoutMinutes: 5 }, { idleTimeoutMinutes: 240 }, { passwordMinLength: 64 }, { lockoutThreshold: 3 }, { lockoutMinutes: 60 }, { passwordExpiryDays: 365 }])
      await t.callOk(R, 'security.settings.save', ok);
    t.close();
  });

  it('merges into the stored "security" object the controller reads, keeping unknown keys', async () => {
    const t = createTestCompany({ security: true });
    // Shape written before this module existed (or by other code): only the idle timeout, plus a foreign key.
    writeSetting(t.db, 'security', { idleTimeoutMinutes: 15, vaultHint: 'blue' }, t.clock.now());
    assert.equal((await t.callOk<SecuritySettings>(R, 'security.settings.get')).idleTimeoutMinutes, 15);

    const saved = await t.callOk<SecuritySettings>(R, 'security.settings.save', { lockoutThreshold: 4, requireSymbol: true });
    assert.equal(saved.idleTimeoutMinutes, 15, 'omitted fields keep their value');
    assert.equal(saved.lockoutThreshold, 4);
    const stored = readSetting(t.db, 'security') as Record<string, unknown>;
    assert.equal(stored.vaultHint, 'blue');
    assert.equal(stored.idleTimeoutMinutes, 15, 'the controller reads a plain number of minutes');
    assert.equal(stored.lockoutThreshold, 4);

    await t.callOk(R, 'security.settings.save', { idleTimeoutMinutes: 0 });
    assert.equal((readSetting(t.db, 'security') as Record<string, unknown>).idleTimeoutMinutes, 0, '0 = never, as the controller expects');

    const entry = t.db.get<{ action: string; entity_type: string; before_json: string; after_json: string }>(
      "SELECT * FROM audit_log WHERE entity_type = 'security_settings' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(entry?.action, 'security');
    assert.equal(JSON.parse(entry?.before_json ?? '{}').idleTimeoutMinutes, 15);
    assert.equal(JSON.parse(entry?.after_json ?? '{}').idleTimeoutMinutes, 0);
    t.close();
  });

  it('ignores corrupt stored values field by field', () => {
    const t = createTestCompany({ security: true });
    writeSetting(t.db, 'security', { idleTimeoutMinutes: 'soon', lockoutThreshold: 99, requireMixedCase: true, passwordMinLength: 10 }, t.clock.now());
    const s = getSecuritySettings(t.db);
    assert.equal(s.idleTimeoutMinutes, 30);
    assert.equal(s.lockoutThreshold, 5);
    assert.equal(s.requireMixedCase, true);
    assert.equal(s.passwordMinLength, 10);
    writeSetting(t.db, 'security', [1, 2], t.clock.now());
    assert.deepEqual(getSecuritySettings(t.db), DEFAULT_SECURITY_SETTINGS);
    t.close();
  });

  it('describes the password policy to any logged-in user', async () => {
    const t = createTestCompany({ security: true });
    await t.callOk(R, 'security.settings.save', { passwordMinLength: 10, requireMixedCase: true, passwordExpiryDays: 90 });
    const p = await t.callOk<PasswordPolicyInfo>(R, 'security.passwordPolicy', {}, { session: t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(p.minLength, 10);
    assert.equal(p.historyDepth, 3);
    assert.ok(p.rules.includes('At least 10 characters'));
    assert.ok(p.rules.includes('Both upper-case and lower-case letters'));
    assert.ok(p.rules.includes('Must be changed every 90 days'));
    t.close();
  });

  it('password rules: base rules first, then the configured extras', () => {
    const s: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS, passwordMinLength: 10, requireMixedCase: true, requireSymbol: true };
    assert.match(passwordProblem(s, 'Ab1#') ?? '', /at least 10/);
    assert.match(passwordProblem(s, 'abcdefghij') ?? '', /digit/);
    assert.match(passwordProblem(s, 'abcdefgh12') ?? '', /upper-case and lower-case/);
    assert.match(passwordProblem(s, 'Abcdefgh12') ?? '', /symbol/);
    assert.match(passwordProblem(s, ' Abcdefg#12') ?? '', /start or end with a space/);
    assert.equal(passwordProblem(s, 'Abcdefg#12'), null);
    assert.equal(passwordProblem(s, 'Ünïcödé#12'), null, 'non-ASCII letters count as letters and cases');
    assert.match(passwordProblem(DEFAULT_SECURITY_SETTINGS, 'Ravi2026', 'ravi2026') ?? '', /same as the username/);
  });

  it('expiry and lockout policy follow the settings', async () => {
    const t = createTestCompany({ security: true });
    const owner = t.ids.ownerUserId as number;
    assert.equal(isPasswordExpired(t.db, owner, t.clock.now()), false);
    await t.callOk(R, 'security.settings.save', { passwordExpiryDays: 10, lockoutThreshold: 7, lockoutMinutes: 15 });
    t.clock.advance(9 * 86_400_000);
    assert.equal(isPasswordExpired(t.db, owner, t.clock.now()), false);
    t.clock.advance(86_400_000);
    assert.equal(isPasswordExpired(t.db, owner, t.clock.now()), true);
    assert.deepEqual(getLockoutPolicy(t.db), { maxFailedAttempts: 7, lockoutMs: 15 * 60_000 });
    t.close();
  });
});
