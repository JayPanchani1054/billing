import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import type { AppState } from '../../../shared/types/app.ts';
import type { MySession, SecurityDisableResult, SecurityEnableResult, SecurityUser } from '../../../shared/types/security.ts';
import { login } from '../../app/auth.ts';
import { fixedClock } from '../../app/clock.ts';
import { appRoutes } from '../../app/routes.ts';
import { createRuntimeWithRoutes } from '../../app/runtime-core.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { companyRoutes } from '../company/routes.ts';
import { getFeatures } from '../company/service.ts';
import { createTestCompany, makeGstin, TEST_OWNER_PASSWORD, type TestCompany } from '../../testing/fixtures.ts';
import { securityRoutes as R } from './routes.ts';

async function fail(t: TestCompany, name: string, input: unknown, code: string, re?: RegExp, session?: ReturnType<TestCompany['sessionAs']>) {
  const r = await t.call(R, name, input, session ? { session } : undefined);
  assert.equal(r.ok, false, `${name} should fail`);
  if (!r.ok) {
    assert.equal(r.error.code, code, `${name}: ${r.error.message}`);
    if (re) assert.match(r.error.message, re);
  }
  return r;
}

const actions = (t: TestCompany) => t.db.all<{ action: string; entity_type: string; entity_label: string }>('SELECT action, entity_type, entity_label FROM audit_log ORDER BY id');

describe('security on/off (service through the dispatcher)', () => {
  it('turns security on by creating the Owner user; the new Owner can log in', async () => {
    const t = createTestCompany();
    assert.equal(getFeatures(t.db).security, false);
    const r = await t.callOk<SecurityEnableResult>(R, 'security.enable', { username: 'Mehta', displayName: 'R. Mehta', password: 'Mehta2026!' });
    assert.equal(r.securityEnabled, true);
    assert.equal(r.createdOwner, true);
    assert.equal(r.loginRequired, true);
    assert.equal(r.ownerUsername, 'Mehta');
    assert.equal(getFeatures(t.db).security, true);
    const s = await login(t.db, 'mehta', 'Mehta2026!', t.clock.now());
    assert.equal(s.session.isOwner, true);
    assert.equal(s.mustChangePassword, false, 'they chose this password themselves');
    const log = actions(t).filter((a) => a.action !== 'login');
    assert.deepEqual(
      log.map((a) => `${a.action}:${a.entity_type}`),
      ['create:user', 'settings:company_features', 'security:company_security'],
    );
    assert.equal(log[2].entity_label, 'Security turned on');
    assert.deepEqual(verifyAuditChain(t.db), { ok: true, count: actions(t).length });
    t.close();
  });

  it('applies the password policy to a new Owner and refuses when security is already on', async () => {
    const t = createTestCompany();
    await fail(t, 'security.enable', { username: 'boss', password: 'weak' }, 'VALIDATION', /at least 8/);
    await fail(t, 'security.enable', { username: 'b', password: 'Strong2026' }, 'VALIDATION', /at least 3/);
    assert.equal(getFeatures(t.db).security, false, 'nothing changed');
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM users'), 0);
    await t.callOk(R, 'security.enable', { username: 'boss', password: 'Strong2026' });
    await fail(t, 'security.enable', { username: 'boss', password: 'Strong2026' }, 'BUSINESS_RULE', /already on/);
    t.close();
  });

  it('reuses an existing (even deactivated) Owner after verifying the password; wrong passwords count towards lockout', async () => {
    const t = createTestCompany({ security: true });
    const ownerId = t.ids.ownerUserId as number;
    // Security turned off earlier by the owner; the user remains (deactivated meanwhile by a second owner).
    t.db.run("UPDATE settings SET value = json_set(value, '$.security', json('false')) WHERE key = 'features'");
    t.db.run('UPDATE users SET is_active = 0 WHERE id = :id', { id: ownerId });
    const implicit = t.sessionAs({ role: 'Owner', userId: null });

    for (let i = 1; i <= 4; i++) {
      const r = await fail(t, 'security.enable', { username: 'OWNER', password: `Wrong${i}pass` }, 'VALIDATION', /Incorrect password/, implicit);
      if (i === 3 && !r.ok) assert.match(r.error.message, /2 attempts left/);
    }
    assert.equal(t.db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: ownerId }), 4, 'failures persisted despite the error');
    await fail(t, 'security.enable', { username: 'owner', password: 'Wrong5pass' }, 'LOCKED', /locked for 5 minutes/, implicit);
    await fail(t, 'security.enable', { username: 'owner', password: TEST_OWNER_PASSWORD }, 'LOCKED', /Try again in 5 minutes/, implicit);
    assert.equal(actions(t).filter((a) => a.action === 'login_failed').length, 5);
    assert.equal(getFeatures(t.db).security, false);

    t.clock.advance(5 * 60_000 + 1);
    const r = await t.callOk<SecurityEnableResult>(R, 'security.enable', { username: 'owner', password: TEST_OWNER_PASSWORD }, { session: implicit });
    assert.equal(r.createdOwner, false);
    assert.equal(r.ownerUserId, ownerId);
    const u = await t.callOk<SecurityUser>(R, 'security.user.get', { id: ownerId });
    assert.equal(u.isActive, true, 'reactivated');
    assert.equal(u.failedAttempts, 0);
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM users'), 1, 'no second owner created');
    t.close();
  });

  it('refuses to reuse a username that belongs to a non-Owner user', async () => {
    const t = createTestCompany();
    await t.callOk(R, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles['Data Entry'], isActive: true, password: 'Clerk2026x' });
    await fail(t, 'security.enable', { username: 'Clerk', password: 'Clerk2026x' }, 'VALIDATION', /Data Entry role/);
    assert.equal(getFeatures(t.db).security, false);
    t.close();
  });

  it('turns security off only for an Owner who re-enters their password; users are kept', async () => {
    const t = createTestCompany({ security: true });
    await t.callOk(R, 'security.user.save', { username: 'clerk', displayName: 'C', roleId: t.ids.roles['Data Entry'], isActive: true, password: 'Clerk2026x' });
    const admin = t.sessionAs({ permissions: ['security.manage'] });
    await fail(t, 'security.disable', { password: TEST_OWNER_PASSWORD }, 'FORBIDDEN', /Only an Owner/, admin);
    await fail(t, 'security.disable', { password: 'NotMyPass1' }, 'VALIDATION', /Incorrect password for "owner"/);
    assert.equal(getFeatures(t.db).security, true);
    assert.equal(t.db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: t.ids.ownerUserId }), 1);

    const r = await t.callOk<SecurityDisableResult>(R, 'security.disable', { password: TEST_OWNER_PASSWORD });
    assert.equal(r.securityEnabled, false);
    assert.equal(getFeatures(t.db).security, false);
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM users'), 2, 'users kept');
    assert.equal(t.db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: t.ids.ownerUserId }), 0);
    const last = actions(t).at(-1);
    assert.equal(last?.entity_label, 'Security turned off');
    await fail(t, 'security.disable', { password: TEST_OWNER_PASSWORD }, 'BUSINESS_RULE', /already off/);
    t.close();
  });

  it('only an Owner session (not the implicit one) can disable', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, 'security.disable', { password: TEST_OWNER_PASSWORD }, 'FORBIDDEN', /Owner/, t.sessionAs({ role: 'Owner', userId: null }));
    t.close();
  });
});

describe('security on/off with the real runtime (controller compatibility)', () => {
  async function ok<T>(dispatch: (r: string, i: unknown) => Promise<ApiResult<unknown>>, route: string, input: unknown = {}): Promise<T> {
    const r = await dispatch(route, input);
    if (!r.ok) assert.fail(`${route}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  }

  it('enable drops the implicit session; settings drive the idle timeout; disable brings the implicit session back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-sec-'));
    const clock = fixedClock('2026-10-05');
    const rt = createRuntimeWithRoutes(
      { userDataDir: path.join(root, 'u'), defaultDataDir: path.join(root, 'd'), appVersion: '1.0.0', clock, consoleLog: false },
      { ...appRoutes, ...companyRoutes, ...R },
    );
    const d = (r: string, i: unknown = {}) => rt.dispatch(r, i);
    try {
      const created = await ok<AppState>(d, 'app.company.create', {
        name: 'Open Co',
        stateCode: '27',
        gstRegistrationType: 'regular',
        gstin: makeGstin('27'),
        booksFrom: '2026-04-01',
      });
      assert.equal(created.session?.implicit, true);

      await ok(d, 'security.enable', { username: 'boss', displayName: 'The Boss', password: 'Boss2026!' });
      const after = await ok<AppState>(d, 'app.state');
      assert.equal(after.session, null, 'the implicit session is dropped as soon as security is on');
      assert.equal(after.pendingLogin?.companyName, 'Open Co');
      const denied = await d('security.mySession');
      assert.equal(denied.ok ? null : denied.error.code, 'UNAUTHENTICATED');

      await ok(d, 'app.auth.login', { username: 'boss', password: 'Boss2026!' });
      const me = await ok<MySession>(d, 'security.mySession');
      assert.equal(me.username, 'boss');
      assert.equal(me.idleTimeoutMinutes, 30);
      assert.equal(me.previousLoginAt, null);

      // The controller picks up the saved idle timeout on the next call.
      await ok(d, 'security.settings.save', { idleTimeoutMinutes: 5 });
      clock.advance(4 * 60_000);
      await ok(d, 'security.mySession');
      clock.advance(5 * 60_000 + 1);
      const expired = await d('security.mySession');
      assert.equal(expired.ok ? null : expired.error.code, 'UNAUTHENTICATED');
      assert.match(expired.ok ? '' : expired.error.message, /inactivity/);

      // A failed attempt, then a login: mySession reports the previous login and the failure.
      await d('app.auth.login', { username: 'boss', password: 'wrong-pass1' });
      clock.advance(1000);
      await ok(d, 'app.auth.login', { username: 'boss', password: 'Boss2026!' });
      const again = await ok<MySession>(d, 'security.mySession');
      assert.ok(again.previousLoginAt);
      assert.equal(again.failedAttemptsSincePreviousLogin, 1);

      // 0 = never time out.
      await ok(d, 'security.settings.save', { idleTimeoutMinutes: 0 });
      clock.advance(10 * 60 * 60_000);
      assert.equal((await ok<MySession>(d, 'security.mySession')).idleExpiresAt, null);

      await ok(d, 'security.disable', { password: 'Boss2026!' });
      await ok(d, 'app.auth.logout');
      const s = await ok<AppState>(d, 'app.state');
      assert.equal(s.session?.implicit, true, 'with security off the implicit owner session returns after logout');
    } finally {
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
