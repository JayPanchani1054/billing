import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiErrorPayload } from '../../../shared/api.ts';
import type { SecurityUser, UserDeleteRefusal } from '../../../shared/types/security.ts';
import type { Session } from '../../api/context.ts';
import { changePassword, login } from '../../app/auth.ts';
import { createTestCompany, TEST_OWNER_PASSWORD, TEST_OWNER_USERNAME, type TestCompany } from '../../testing/fixtures.ts';
import { securityRoutes as R } from './routes.ts';

const PW = 'Clerk2026x';

async function fail(t: TestCompany, name: string, input: unknown, code: string, re?: RegExp, session?: Session): Promise<ApiErrorPayload> {
  const r = await t.call(R, name, input, session ? { session } : undefined);
  assert.equal(r.ok, false, `${name} should fail`);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code, `${name}: ${r.error.message}`);
  if (re) assert.match(r.error.message, re);
  return r.error;
}

const addUser = (t: TestCompany, over: Record<string, unknown> = {}, session?: Session): Promise<SecurityUser> =>
  t.callOk<SecurityUser>(R, 'security.user.save', { username: 'clerk', displayName: 'Ravi Clerk', roleId: t.ids.roles['Data Entry'], isActive: true, password: PW, ...over }, session ? { session } : undefined);

const auditRows = (t: TestCompany, where = '1 = 1') =>
  t.db.all<{ action: string; entity_type: string; entity_id: number; entity_label: string; before_json: string | null; after_json: string | null }>(
    `SELECT * FROM audit_log WHERE ${where} ORDER BY id`,
  );

describe('security users: create & validation', () => {
  it('creates a user (must change password by default) and lists it with its role', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t);
    assert.equal(u.username, 'clerk');
    assert.equal(u.roleName, 'Data Entry');
    assert.equal(u.isActive, true);
    assert.equal(u.locked, false);
    assert.equal(u.mustChangePassword, true);
    assert.equal(u.lastLoginAt, null);
    assert.equal(u.isSelf, false);

    const list = await t.callOk<{ rows: SecurityUser[]; total: number }>(R, 'security.user.list', {});
    assert.equal(list.total, 2);
    const owner = list.rows.find((r) => r.username === TEST_OWNER_USERNAME);
    assert.equal(owner?.isOwner, true);
    assert.equal(owner?.isSelf, true);

    const created = auditRows(t, "action = 'create' AND entity_type = 'user'");
    assert.equal(created.length, 1);
    assert.equal(created[0].entity_id, u.id);
    assert.doesNotMatch(created[0].after_json ?? '', /scrypt|Clerk2026x/, 'no password or hash in the edit log');
    // The new user can log in and is asked to change the password.
    const r = await login(t.db, 'CLERK', PW, t.clock.now());
    assert.equal(r.mustChangePassword, true);
    assert.equal(r.session.role, 'Data Entry');
    t.close();
  });

  it('validates usernames: 3–32 characters, allowed characters, unique ignoring case', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, 'security.user.save', { username: 'ab', displayName: '', roleId: t.ids.roles.Auditor, isActive: true, password: PW }, 'VALIDATION', /at least 3/);
    await fail(t, 'security.user.save', { username: 'a'.repeat(33), displayName: '', roleId: t.ids.roles.Auditor, isActive: true, password: PW }, 'VALIDATION', /at most 32/);
    for (const bad of ['ravi kumar', 'jo$n', '.dot', 'नाम'])
      await fail(t, 'security.user.save', { username: bad, displayName: '', roleId: t.ids.roles.Auditor, isActive: true, password: PW }, 'VALIDATION', /letters, digits/);
    const e = await fail(t, 'security.user.save', { username: 'OWNER', displayName: '', roleId: t.ids.roles.Auditor, isActive: true, password: PW }, 'CONFLICT', /already exists/);
    assert.deepEqual((e.details as Array<{ path: string }>)[0].path, 'username');
    const ok = await addUser(t, { username: 'r.k_2-x', displayName: '  ' });
    assert.equal(ok.displayName, 'r.k_2-x', 'blank display name falls back to the username');
    t.close();
  });

  it('requires a password on create, applies the configured policy and refuses username = password', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true }, 'VALIDATION', /Enter a password/);
    await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true, password: 'short1' }, 'VALIDATION', /at least 8/);
    await fail(t, 'security.user.save', { username: 'clerk123', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true, password: 'CLERK123' }, 'VALIDATION', /same as the username/);

    await t.callOk(R, 'security.settings.save', { passwordMinLength: 12, requireMixedCase: true, requireSymbol: true });
    await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true, password: 'Abcdefgh123' }, 'VALIDATION', /at least 12/);
    await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true, password: 'abcdefgh1234' }, 'VALIDATION', /upper-case and lower-case/);
    await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles.Auditor, isActive: true, password: 'Abcdefgh1234' }, 'VALIDATION', /symbol/);
    const u = await addUser(t, { password: 'Abcdefgh123#' });
    assert.equal(u.username, 'clerk');
    t.close();
  });

  it('rejects an unknown role and reports the field', async () => {
    const t = createTestCompany({ security: true });
    const e = await fail(t, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: 999, isActive: true, password: PW }, 'VALIDATION', /Choose a role/);
    assert.equal((e.details as Array<{ path: string }>)[0].path, 'roleId');
    t.close();
  });

  it('alters a user: rename, role and display name are audited as a diff; a no-op save writes nothing', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t);
    const before = auditRows(t).length;
    await t.callOk(R, 'security.user.save', { id: u.id, username: 'clerk', displayName: 'Ravi Clerk', roleId: u.roleId, isActive: true });
    assert.equal(auditRows(t).length, before, 'no change, no audit entry');

    const v = await t.callOk<SecurityUser>(R, 'security.user.save', { id: u.id, username: 'ravi', displayName: 'Ravi K', roleId: t.ids.roles.Auditor, isActive: true });
    assert.equal(v.username, 'ravi');
    assert.equal(v.roleName, 'Auditor');
    assert.equal(v.mustChangePassword, true, 'omitted mustChangePassword keeps the current value');
    const alter = auditRows(t, "action = 'alter' AND entity_type = 'user'").at(-1);
    assert.ok(alter);
    const after = JSON.parse(alter.after_json ?? '{}') as Record<string, unknown>;
    assert.equal(after.role, 'Auditor');
    assert.equal(after.username, 'ravi');
    assert.equal(JSON.parse(alter.before_json ?? '{}').role, 'Data Entry');
    t.close();
  });

  it('filters the user list by search, role and active state', async () => {
    const t = createTestCompany({ security: true });
    await addUser(t, { username: 'ravi', displayName: 'Ravi Kumar' });
    await addUser(t, { username: 'sita', displayName: 'Sita Devi', roleId: t.ids.roles.Auditor, isActive: false });
    const q = (input: object) => t.callOk<{ rows: SecurityUser[]; total: number }>(R, 'security.user.list', input);
    assert.deepEqual((await q({ search: 'kum' })).rows.map((r) => r.username), ['ravi']);
    assert.deepEqual((await q({ roleId: t.ids.roles.Auditor })).rows.map((r) => r.username), ['sita']);
    assert.deepEqual((await q({ activeOnly: true })).rows.map((r) => r.username).sort(), ['owner', 'ravi']);
    assert.equal((await q({ search: '%' })).total, 0, 'LIKE wildcards are literal');
    assert.deepEqual((await q({})).rows.map((r) => r.username), ['owner', 'ravi', 'sita'], 'active users first, then by name');
    t.close();
  });
});

describe('security users: owner and self protections', () => {
  it('refuses to deactivate or demote the last active Owner', async () => {
    const t = createTestCompany({ security: true });
    const ownerId = t.ids.ownerUserId as number;
    const other = t.sessionAs({ role: 'Owner', userId: 4242, username: 'auditor-owner' }); // an Owner session that is not this user
    const base = { id: ownerId, username: 'owner', displayName: 'Test Owner', roleId: t.ids.roles.Owner, isActive: true };
    await fail(t, 'security.user.save', { ...base, isActive: false }, 'BUSINESS_RULE', /only active Owner/, other);
    await fail(t, 'security.user.save', { ...base, roleId: t.ids.roles.Accountant }, 'BUSINESS_RULE', /only active Owner/, other);

    // With a second active Owner it is allowed.
    await addUser(t, { username: 'partner', roleId: t.ids.roles.Owner });
    const demoted = await t.callOk<SecurityUser>(R, 'security.user.save', { ...base, roleId: t.ids.roles.Accountant }, { session: other });
    assert.equal(demoted.isOwner, false);
    t.close();
  });

  it('refuses to deactivate yourself, change your own role, or set your own password without the current one', async () => {
    const t = createTestCompany({ security: true });
    await addUser(t, { username: 'partner', roleId: t.ids.roles.Owner });
    const self = { id: t.ids.ownerUserId, username: 'owner', displayName: 'Test Owner', roleId: t.ids.roles.Owner, isActive: true };
    await fail(t, 'security.user.save', { ...self, isActive: false }, 'BUSINESS_RULE', /cannot deactivate your own account/);
    await fail(t, 'security.user.save', { ...self, roleId: t.ids.roles.Accountant }, 'BUSINESS_RULE', /own role/);
    await fail(t, 'security.user.save', { ...self, password: 'NewOwner123' }, 'BUSINESS_RULE', /Change password/);
    await fail(t, 'security.user.resetPassword', { id: t.ids.ownerUserId, newPassword: 'NewOwner123' }, 'BUSINESS_RULE', /Change password/);
    // Changing your own display name is fine.
    const me = await t.callOk<SecurityUser>(R, 'security.user.save', { ...self, displayName: 'The Boss' });
    assert.equal(me.displayName, 'The Boss');
    t.close();
  });

  it('prevents privilege escalation by a security manager who is not an Owner', async () => {
    const t = createTestCompany({ security: true });
    const admin = t.sessionAs({ permissions: ['security.manage', 'company.view', 'masters.view', 'masters.create', 'vouchers.view', 'vouchers.create', 'reports.view', 'gst.view'] });
    await fail(t, 'security.user.save', { username: 'boss2', displayName: 'B', roleId: t.ids.roles.Owner, isActive: true, password: PW }, 'FORBIDDEN', /Only an Owner/, admin);
    await fail(t, 'security.user.save', { username: 'acct', displayName: 'A', roleId: t.ids.roles.Accountant, isActive: true, password: PW }, 'FORBIDDEN', /permissions you hold/, admin);
    // Data Entry's permissions are all held by this admin.
    const clerk = await addUser(t, {}, admin);
    assert.equal(clerk.roleName, 'Data Entry');
    // An Owner's account is out of reach (no password reset = no account takeover).
    await fail(t, 'security.user.resetPassword', { id: t.ids.ownerUserId, newPassword: 'Takeover123' }, 'FORBIDDEN', /Only an Owner/, admin);
    await fail(t, 'security.user.save', { id: t.ids.ownerUserId, username: 'owner', displayName: 'x', roleId: t.ids.roles.Owner, isActive: false }, 'FORBIDDEN', undefined, admin);
    t.close();
  });
});

describe('security users: passwords, lockout and deletion', () => {
  it('resets a password: must change at next login by default, unlocks the account, audited without secrets', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t, { mustChangePassword: false });
    for (let i = 0; i < 5; i++) await assert.rejects(login(t.db, 'clerk', `Wrong${i}pass`, t.clock.now()));
    assert.equal((await t.callOk<SecurityUser>(R, 'security.user.get', { id: u.id })).locked, true);

    const reset = await t.callOk<SecurityUser>(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Fresh2026pw' });
    assert.equal(reset.locked, false);
    assert.equal(reset.failedAttempts, 0);
    assert.equal(reset.mustChangePassword, true);
    const r = await login(t.db, 'clerk', 'Fresh2026pw', t.clock.now());
    assert.equal(r.mustChangePassword, true);
    await assert.rejects(login(t.db, 'clerk', PW, t.clock.now()), /Incorrect/);

    const entry = auditRows(t, "action = 'security' AND entity_type = 'user'").at(-1);
    assert.equal(entry?.entity_label, 'Password reset: clerk');
    assert.deepEqual(JSON.parse(entry?.after_json ?? '{}'), { mustChangePassword: true, unlocked: true });

    const keep = await t.callOk<SecurityUser>(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Second2026pw', mustChange: false });
    assert.equal(keep.mustChangePassword, false);
    t.close();
  });

  it('does not allow reusing any of the last 3 passwords (history kept by trigger, also for self-service changes)', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t, { password: 'Pass0word0' });
    const reset = (pw: string) => t.call(R, 'security.user.resetPassword', { id: u.id, newPassword: pw });
    const tick = () => t.clock.advance(60_000);
    const current = await reset('Pass0word0');
    assert.equal(current.ok, false, 'the current password cannot be "reset" to itself');
    tick();
    await t.callOk(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Pass1word1' }); // history: P0
    tick();
    await t.callOk(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Pass2word2' }); // history: P1, P0
    for (const old of ['Pass0word0', 'Pass1word1', 'Pass2word2']) {
      const r = await reset(old);
      assert.equal(r.ok, false, `${old} was used recently`);
      if (!r.ok) assert.match(r.error.message, /used recently/);
    }
    tick();
    await t.callOk(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Pass3word3' }); // last 3: P3, P2, P1
    assert.equal((await reset('Pass0word0')).ok, true, 'P0 is now older than the last 3');
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM password_history WHERE user_id = :id', { id: u.id }), 2, 'only 2 previous hashes kept');

    // The login screen's own "change password" (core/app/auth.ts) is covered by the trigger too.
    const s = (await login(t.db, 'clerk', 'Pass0word0', t.clock.now())).session;
    tick();
    await changePassword(t.db, s, { currentPassword: 'Pass0word0', newPassword: 'Mine2026pw' }, t.clock.now());
    const back = await reset('Pass0word0');
    assert.equal(back.ok, false, 'the password replaced by the user is remembered');
    t.close();
  });

  it('unlocks a locked account and records it', async () => {
    const t = createTestCompany({ security: true });
    await t.callOk(R, 'security.settings.save', { lockoutThreshold: 3, lockoutMinutes: 10 });
    const u = await addUser(t);
    for (let i = 0; i < 3; i++) await assert.rejects(login(t.db, 'clerk', `Wrong${i}pass`, t.clock.now()));
    // NOTE: core/app/auth.ts still uses its fixed 5 / 5 min until the requested change is applied (README),
    // so lock the account directly here for a deterministic test.
    t.db.run('UPDATE users SET failed_attempts = 3, locked_until = :until WHERE id = :id', { until: new Date(t.clock.now().getTime() + 600_000).toISOString(), id: u.id });
    const locked = await t.callOk<SecurityUser>(R, 'security.user.get', { id: u.id });
    assert.equal(locked.locked, true);
    assert.ok(locked.lockedUntil);

    const unlocked = await t.callOk<SecurityUser>(R, 'security.user.unlock', { id: u.id });
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.failedAttempts, 0);
    const entry = auditRows(t, "action = 'security'").at(-1);
    assert.equal(entry?.entity_label, 'Account unlocked: clerk');
    await login(t.db, 'clerk', PW, t.clock.now());
    // Unlocking an account that is not locked is a no-op (no entry).
    const n = auditRows(t).length;
    await t.callOk(R, 'security.user.unlock', { id: u.id });
    assert.equal(auditRows(t).length, n);
    t.close();
  });

  it('never deletes users: refuses with a clear message and suggests deactivation', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t);
    const e = await fail(t, 'security.user.delete', { id: u.id }, 'BUSINESS_RULE', /Deactivate "clerk" instead/);
    assert.deepEqual(e.details as UserDeleteRefusal, { reason: 'users_are_kept', suggestion: 'deactivate', userId: u.id, isActive: true });
    await t.callOk(R, 'security.user.save', { id: u.id, username: 'clerk', displayName: 'Ravi Clerk', roleId: u.roleId, isActive: false });
    await fail(t, 'security.user.delete', { id: u.id }, 'BUSINESS_RULE', /already deactivated/);
    await fail(t, 'security.user.delete', { id: 999 }, 'NOT_FOUND');
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM users'), 2);
    // A deactivated user cannot log in.
    await assert.rejects(login(t.db, 'clerk', PW, t.clock.now()), /disabled/);
    t.close();
  });

  it('flags expired passwords when the company sets an expiry', async () => {
    const t = createTestCompany({ security: true });
    const u = await addUser(t);
    assert.equal(u.passwordExpiresAt, null);
    await t.callOk(R, 'security.settings.save', { passwordExpiryDays: 30 });
    const fresh = await t.callOk<SecurityUser>(R, 'security.user.get', { id: u.id });
    assert.equal(fresh.passwordExpired, false);
    assert.equal(Date.parse(fresh.passwordExpiresAt ?? '') - Date.parse(fresh.passwordChangedAt), 30 * 86_400_000);
    t.clock.advance(31 * 86_400_000);
    assert.equal((await t.callOk<SecurityUser>(R, 'security.user.get', { id: u.id })).passwordExpired, true);
    // A reset starts a new period (password age = time of the change, from the history trigger).
    const reset = await t.callOk<SecurityUser>(R, 'security.user.resetPassword', { id: u.id, newPassword: 'Renewed2026' });
    assert.equal(reset.passwordExpired, false);
    assert.equal(reset.passwordChangedAt, t.clock.now().toISOString());
    t.close();
  });

  it('owner-password login still works for the seeded owner (sanity)', async () => {
    const t = createTestCompany({ security: true });
    const r = await login(t.db, TEST_OWNER_USERNAME, TEST_OWNER_PASSWORD, t.clock.now());
    assert.equal(r.session.isOwner, true);
    t.close();
  });
});
