import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS } from '../../../shared/constants.ts';
import type { MySession } from '../../../shared/types/security.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { securityRoutes as R } from './routes.ts';

/** Every route with a valid-looking input, so access is checked before validation fails. */
const SAMPLE_INPUT: Record<string, unknown> = {
  'security.user.list': {},
  'security.user.get': { id: 1 },
  'security.user.save': { username: 'someone', displayName: 'S', roleId: 2, isActive: true, password: 'Someone2026' },
  'security.user.resetPassword': { id: 1, newPassword: 'Someone2026' },
  'security.user.unlock': { id: 1 },
  'security.user.delete': { id: 1 },
  'security.role.list': {},
  'security.role.get': { id: 1 },
  'security.role.save': { name: 'X', permissions: [] },
  'security.role.delete': { id: 1 },
  'security.permissions.catalog': {},
  'security.enable': { username: 'boss', password: 'Boss2026xx' },
  'security.disable': { password: 'Owner@1234' },
  'security.settings.get': {},
  'security.settings.save': {},
  'security.passwordPolicy': {},
  'security.audit.list': {},
  'security.audit.facets': {},
  'security.audit.get': { id: 1 },
  'security.audit.entityHistory': { entityType: 'ledger', entityId: 1 },
  'security.audit.verify': {},
  'security.audit.resetAnchor': {},
  'security.audit.export': { format: 'csv' },
  'security.mySession': {},
};

const EXPECTED_ACCESS: Record<string, string> = {
  'security.user.list': 'security.manage',
  'security.user.get': 'security.manage',
  'security.user.save': 'security.manage',
  'security.user.resetPassword': 'security.manage',
  'security.user.unlock': 'security.manage',
  'security.user.delete': 'security.manage',
  'security.role.list': 'security.manage',
  'security.role.get': 'security.manage',
  'security.role.save': 'security.manage',
  'security.role.delete': 'security.manage',
  'security.permissions.catalog': 'authenticated',
  'security.enable': 'company.manage',
  'security.disable': 'security.manage',
  'security.settings.get': 'security.manage',
  'security.settings.save': 'security.manage',
  'security.passwordPolicy': 'authenticated',
  'security.audit.list': 'audit.view',
  'security.audit.facets': 'audit.view',
  'security.audit.get': 'audit.view',
  'security.audit.entityHistory': 'audit.view',
  'security.audit.verify': 'audit.view',
  'security.audit.resetAnchor': 'audit.view',
  'security.audit.export': 'audit.view',
  'security.mySession': 'authenticated',
};

describe('security routes: access control through the real dispatcher', () => {
  it('declares the expected access for every route and nothing else', () => {
    assert.deepEqual(Object.keys(R).sort(), Object.keys(EXPECTED_ACCESS).sort());
    for (const [name, route] of Object.entries(R)) {
      assert.equal(route.access, EXPECTED_ACCESS[name], name);
      assert.equal(route.scope, 'company', name);
      assert.ok(name.startsWith('security.'), name);
    }
    // Async handlers must not run inside the dispatcher transaction.
    assert.equal(R['security.enable'].transactional, false);
    assert.equal(R['security.disable'].transactional, false);
    assert.equal(R['security.audit.export'].transactional, false);
    assert.equal(R['security.audit.resetAnchor'].transactional, false);
  });

  it('refuses every permission-guarded route to a session lacking that permission (FORBIDDEN before validation)', async () => {
    const t = createTestCompany({ security: true });
    for (const [name, access] of Object.entries(EXPECTED_ACCESS)) {
      if (access === 'authenticated') continue;
      const lacking = t.sessionAs({ permissions: PERMISSIONS.filter((p) => p !== access) });
      const r = await t.call(R, name, SAMPLE_INPUT[name], { session: lacking });
      assert.equal(r.ok ? 'ok' : r.error.code, 'FORBIDDEN', name);
    }
    t.close();
  });

  it('system roles: Data Entry and Accountant cannot administer security; the Auditor reads the edit log only', async () => {
    const t = createTestCompany({ security: true });
    const code = async (role: string, name: string) => {
      const r = await t.call(R, name, SAMPLE_INPUT[name], { session: t.sessionAs({ role }) });
      return r.ok ? 'ok' : r.error.code;
    };
    for (const role of ['Data Entry', 'Accountant', 'Auditor']) {
      for (const name of ['security.user.list', 'security.user.save', 'security.role.save', 'security.settings.save', 'security.disable'])
        assert.equal(await code(role, name), 'FORBIDDEN', `${role} → ${name}`);
    }
    assert.equal(await code('Auditor', 'security.audit.list'), 'ok');
    assert.equal(await code('Auditor', 'security.audit.verify'), 'ok');
    assert.equal(await code('Data Entry', 'security.audit.list'), 'FORBIDDEN');
    assert.equal(await code('Accountant', 'security.audit.list'), 'ok', 'Accountant holds audit.view');
    for (const role of ['Data Entry', 'Auditor']) {
      assert.equal(await code(role, 'security.permissions.catalog'), 'ok');
      assert.equal(await code(role, 'security.passwordPolicy'), 'ok');
      assert.equal(await code(role, 'security.mySession'), 'ok');
    }
    t.close();
  });

  it('requires a session for every route', async () => {
    const t = createTestCompany({ security: true });
    for (const name of Object.keys(R)) {
      const r = await t.call(R, name, SAMPLE_INPUT[name], { session: null });
      assert.equal(r.ok ? 'ok' : r.error.code, 'UNAUTHENTICATED', name);
    }
    t.close();
  });

  it('mySession describes the current user, their permissions and the idle timeout', async () => {
    const t = createTestCompany({ security: true });
    await t.callOk(R, 'security.settings.save', { idleTimeoutMinutes: 20, passwordExpiryDays: 90 });
    const me = await t.callOk<MySession>(R, 'security.mySession');
    assert.equal(me.username, 'owner');
    assert.equal(me.isOwner, true);
    assert.equal(me.implicit, false);
    assert.equal(me.securityEnabled, true);
    assert.deepEqual(me.permissions, [...PERMISSIONS]);
    assert.equal(me.idleTimeoutMinutes, 20);
    assert.equal(me.idleTimeoutRemainingMs, 20 * 60_000);
    assert.equal(me.idleExpiresAt, new Date(t.clock.now().getTime() + 20 * 60_000).toISOString());
    assert.equal(me.passwordExpiresInDays, 90);
    assert.equal(me.canManageSecurity, true);

    const clerk = await t.callOk<MySession>(R, 'security.mySession', {}, { session: t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(clerk.canManageSecurity, false);
    assert.equal(clerk.canViewAudit, false);
    assert.ok(!clerk.permissions.includes('masters.delete'));

    const open = createTestCompany();
    const implicit = await open.callOk<MySession>(R, 'security.mySession');
    assert.equal(implicit.implicit, true);
    assert.equal(implicit.securityEnabled, false);
    assert.equal(implicit.idleTimeoutMinutes, 0, 'no idle timeout without security');
    assert.equal(implicit.idleExpiresAt, null);
    assert.equal(implicit.passwordExpiresAt, null);
    open.close();
    t.close();
  });
});
