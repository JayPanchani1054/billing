import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS } from '../../shared/constants.ts';
import { verifyPassword } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import { verifyAuditChain } from '../lib/audit.ts';
import { createTestCompany, TEST_OWNER_PASSWORD, TEST_OWNER_USERNAME } from '../testing/fixtures.ts';
import { buildSession, changePassword, implicitSession, login, LOCKOUT_MS, maskLoginName, toSessionInfo, verifyOwnerCredentials } from './auth.ts';
import { hashPasswordSync, needsRehash } from '../lib/crypto.ts';
import { scryptSync } from 'node:crypto';

const isCode = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

function securedCompany() {
  const t = createTestCompany({ security: true });
  const ts = t.clock.now().toISOString();
  const accountantId = t.db.run(
    `INSERT INTO users (username, display_name, password_hash, role_id, created_at, updated_at)
     VALUES ('meera', 'Meera', :hash, :role, :ts, :ts)`,
    { hash: hashPasswordSync('Meera1234'), role: t.ids.roles.Accountant, ts },
  ).lastInsertRowid;
  return { t, accountantId };
}

const audits = (t: ReturnType<typeof createTestCompany>) =>
  t.db.all<{ action: string; user_id: number | null; entity_label: string; after_json: string | null; before_json: string | null }>(
    'SELECT * FROM audit_log ORDER BY id',
  );

describe('login', () => {
  it('logs in an Owner with all permissions and records last login + audit', async () => {
    const { t } = securedCompany();
    const { session, mustChangePassword } = await login(t.db, 'OWNER', TEST_OWNER_PASSWORD, t.clock.now());
    assert.equal(session.username, TEST_OWNER_USERNAME, 'username is case-insensitive');
    assert.equal(session.isOwner, true);
    assert.equal(session.implicit, false);
    assert.equal(session.permissions.size, PERMISSIONS.length);
    assert.equal(mustChangePassword, false);
    assert.equal(t.db.value('SELECT last_login_at FROM users WHERE id = :id', { id: session.userId }), t.clock.now().toISOString());
    const last = audits(t).at(-1);
    assert.equal(last?.action, 'login');
    assert.equal(last?.user_id, session.userId);
    t.close();
  });

  it('builds a role-limited session for other users', async () => {
    const { t } = securedCompany();
    const { session } = await login(t.db, 'meera', 'Meera1234', t.clock.now());
    assert.equal(session.role, 'Accountant');
    assert.equal(session.isOwner, false);
    assert.equal(session.permissions.has('security.manage'), false);
    assert.equal(session.permissions.has('vouchers.create'), true);
    const info = toSessionInfo(session, true);
    assert.equal(info.mustChangePassword, true);
    assert.ok(!info.permissions.includes('security.manage'));
    t.close();
  });

  it('gives the same answer for unknown users and wrong passwords, without leaking passwords to the audit log', async () => {
    const { t } = securedCompany();
    await assert.rejects(login(t.db, 'nobody', 'whatever1', t.clock.now()), isCode('UNAUTHENTICATED', /^Incorrect username or password$/));
    await assert.rejects(login(t.db, 'meera', 'wrong-pass1', t.clock.now()), isCode('UNAUTHENTICATED', /^Incorrect username or password$/));
    const rows = audits(t);
    assert.deepEqual(rows.map((r) => r.action), ['login_failed', 'login_failed']);
    assert.ok(rows.every((r) => !String(r.after_json).includes('whatever1') && !String(r.after_json).includes('wrong-pass1')));
    assert.equal(rows[0].entity_label, 'n… (6 chars)', 'unknown names are masked');
    assert.equal(rows[1].entity_label, 'meera');
    await assert.rejects(login(t.db, '', 'x', t.clock.now()), isCode('VALIDATION'));
    t.close();
  });

  it('locks the account after 5 consecutive failures for 5 minutes', async () => {
    const { t, accountantId } = securedCompany();
    const now = () => t.clock.now();
    for (let i = 1; i <= 3; i++) await assert.rejects(login(t.db, 'meera', `bad-pass${i}`, now()), isCode('UNAUTHENTICATED'));
    await assert.rejects(login(t.db, 'meera', 'bad-pass4', now()), isCode('UNAUTHENTICATED', /1 attempt left/));
    await assert.rejects(login(t.db, 'meera', 'bad-pass5', now()), isCode('LOCKED', /try again in 5 minutes/));
    // Correct password is refused while locked.
    t.clock.advance(2 * 60_000 + 1000);
    await assert.rejects(login(t.db, 'meera', 'Meera1234', now()), isCode('LOCKED', /try again in 3 minutes/));
    // After the lockout expires the correct password works and counters reset.
    t.clock.advance(LOCKOUT_MS);
    const { session } = await login(t.db, 'meera', 'Meera1234', now());
    assert.equal(session.userId, accountantId);
    assert.deepEqual(t.db.get('SELECT failed_attempts, locked_until FROM users WHERE id = :id', { id: accountantId }), {
      failed_attempts: 0,
      locked_until: null,
    });
    assert.deepEqual(verifyAuditChain(t.db).ok, true);
    t.close();
  });

  it('starts a fresh count after an expired lockout', async () => {
    const { t } = securedCompany();
    for (let i = 0; i < 5; i++) await assert.rejects(login(t.db, 'meera', 'nope-nope1', t.clock.now()));
    t.clock.advance(LOCKOUT_MS + 1000);
    await assert.rejects(login(t.db, 'meera', 'nope-nope1', t.clock.now()), isCode('UNAUTHENTICATED'), 'one failure does not re-lock');
    t.close();
  });

  it('refuses disabled users only after a correct password', async () => {
    const { t, accountantId } = securedCompany();
    t.db.run('UPDATE users SET is_active = 0 WHERE id = :id', { id: accountantId });
    await assert.rejects(login(t.db, 'meera', 'wrong-pass1', t.clock.now()), isCode('UNAUTHENTICATED', /^Incorrect/));
    await assert.rejects(login(t.db, 'meera', 'Meera1234', t.clock.now()), isCode('UNAUTHENTICATED', /disabled/));
    t.close();
  });

  it('never writes a password typed into the username box to the edit log (regression)', async () => {
    const { t } = securedCompany();
    await assert.rejects(login(t.db, 'Meera1234', 'Meera1234', t.clock.now()), isCode('UNAUTHENTICATED'));
    await assert.rejects(login(t.db, 'MEERA', 'wrong-pass1', t.clock.now()), isCode('UNAUTHENTICATED'));
    const dump = JSON.stringify(audits(t));
    assert.ok(!dump.includes('Meera1234'), 'typed secret not recorded');
    assert.equal(audits(t)[1].entity_label, 'meera', 'known users are recorded by their canonical name');
    assert.equal(maskLoginName('पासवर्ड'), 'प… (7 chars)');
    assert.equal(maskLoginName('x'), 'x… (1 char)');
    t.close();
  });

  it('upgrades a hash made with weaker scrypt parameters on successful login', async () => {
    const { t, accountantId } = securedCompany();
    const salt = Buffer.alloc(16, 7);
    const weakKey = scryptSync('Meera1234', salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const weak = `scrypt$16384$8$1$${salt.toString('base64')}$${weakKey.toString('base64')}`;
    t.db.run('UPDATE users SET password_hash = :h WHERE id = :id', { h: weak, id: accountantId });
    await login(t.db, 'meera', 'Meera1234', t.clock.now());
    const now = t.db.value<string>('SELECT password_hash FROM users WHERE id = :id', { id: accountantId }) ?? '';
    assert.notEqual(now, weak);
    assert.equal(needsRehash(now), false);
    assert.equal(await verifyPassword('Meera1234', now), true);
    t.close();
  });

  it('surfaces must_change_password', async () => {
    const { t, accountantId } = securedCompany();
    t.db.run('UPDATE users SET must_change_password = 1 WHERE id = :id', { id: accountantId });
    const r = await login(t.db, 'meera', 'Meera1234', t.clock.now());
    assert.equal(r.mustChangePassword, true);
    t.close();
  });
});

describe('changePassword', () => {
  it('enforces the current password and policy, then updates and audits without secrets', async () => {
    const { t, accountantId } = securedCompany();
    t.db.run('UPDATE users SET must_change_password = 1 WHERE id = :id', { id: accountantId });
    const session = buildSession(t.db, accountantId, t.clock.now());
    await assert.rejects(changePassword(t.db, session, { currentPassword: 'wrong', newPassword: 'NewPass123' }, t.clock.now()), isCode('VALIDATION', /Current password/));
    await assert.rejects(changePassword(t.db, session, { currentPassword: 'Meera1234', newPassword: 'short' }, t.clock.now()), isCode('VALIDATION', /at least 8/));
    await assert.rejects(changePassword(t.db, session, { currentPassword: 'Meera1234', newPassword: 'Meera1234' }, t.clock.now()), isCode('VALIDATION', /different/));
    assert.deepEqual(await changePassword(t.db, session, { currentPassword: 'Meera1234', newPassword: 'NewPass123' }, t.clock.now()), { ok: true });
    const hash = t.db.value<string>('SELECT password_hash FROM users WHERE id = :id', { id: accountantId }) ?? '';
    assert.equal(await verifyPassword('NewPass123', hash), true);
    assert.equal(t.db.value('SELECT must_change_password FROM users WHERE id = :id', { id: accountantId }), 0);
    const last = audits(t).at(-1);
    assert.equal(last?.action, 'security');
    assert.ok(!JSON.stringify(last).includes('NewPass123'));
    t.close();
  });

  it('is not available to the implicit session', async () => {
    const t = createTestCompany();
    await assert.rejects(
      changePassword(t.db, implicitSession(t.clock.now()), { currentPassword: 'a', newPassword: 'NewPass123' }, t.clock.now()),
      isCode('BUSINESS_RULE'),
    );
    t.close();
  });
});

describe('sessions', () => {
  it('implicit session is an all-powerful owner with no user id', () => {
    const s = implicitSession(new Date('2026-04-15T00:00:00Z'));
    assert.equal(s.userId, null);
    assert.equal(s.isOwner, true);
    assert.equal(s.implicit, true);
    assert.equal(s.permissions.size, PERMISSIONS.length);
  });

  it('verifyOwnerCredentials accepts only active Owner-role users', async () => {
    const { t } = securedCompany();
    assert.equal(await verifyOwnerCredentials(t.db, TEST_OWNER_PASSWORD), true);
    assert.equal(await verifyOwnerCredentials(t.db, TEST_OWNER_PASSWORD, 'owner'), true);
    assert.equal(await verifyOwnerCredentials(t.db, TEST_OWNER_PASSWORD, 'meera'), false);
    assert.equal(await verifyOwnerCredentials(t.db, 'Meera1234'), false, 'non-owner password does not count');
    t.close();
  });
});
