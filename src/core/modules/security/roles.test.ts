import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS } from '../../../shared/constants.ts';
import type { PermissionCatalog, SecurityRole } from '../../../shared/types/security.ts';
import { login } from '../../app/auth.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { securityRoutes as R } from './routes.ts';

async function fail(t: TestCompany, name: string, input: unknown, code: string, re?: RegExp, session?: ReturnType<TestCompany['sessionAs']>) {
  const r = await t.call(R, name, input, session ? { session } : undefined);
  assert.equal(r.ok, false, `${name} should fail`);
  if (!r.ok) {
    assert.equal(r.error.code, code, `${name}: ${r.error.message}`);
    if (re) assert.match(r.error.message, re);
  }
}

const list = (t: TestCompany) => t.callOk<{ rows: SecurityRole[]; total: number }>(R, 'security.role.list');
const lastAudit = (t: TestCompany) =>
  t.db.get<{ action: string; entity_type: string; entity_label: string; before_json: string | null; after_json: string | null }>(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT 1',
  );

describe('security roles', () => {
  it('lists the built-in roles first with user counts; Owner holds every permission', async () => {
    const t = createTestCompany({ security: true });
    const { rows, total } = await list(t);
    assert.equal(total, 4);
    assert.deepEqual(rows.map((r) => r.name), ['Owner', 'Accountant', 'Data Entry', 'Auditor']);
    const owner = rows[0];
    assert.equal(owner.isSystem, true);
    assert.equal(owner.isOwner, true);
    assert.deepEqual(owner.permissions, [...PERMISSIONS]);
    assert.equal(owner.userCount, 1);
    assert.equal(owner.activeUserCount, 1);
    const acct = rows[1];
    assert.equal(acct.isOwner, false);
    assert.ok(!acct.permissions.includes('security.manage'));
    assert.equal(acct.userCount, 0);
    t.close();
  });

  it('built-in roles are read-only and cannot be deleted', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, 'security.role.save', { id: t.ids.roles.Accountant, name: 'Accountant', permissions: ['company.view'] }, 'BUSINESS_RULE', /built-in role/);
    await fail(t, 'security.role.save', { id: t.ids.roles.Owner, name: 'Owner', permissions: [] }, 'BUSINESS_RULE', /built-in role/);
    await fail(t, 'security.role.delete', { id: t.ids.roles.Auditor }, 'BUSINESS_RULE', /cannot be deleted/);
    const after = await t.callOk<SecurityRole>(R, 'security.role.get', { id: t.ids.roles.Owner });
    assert.deepEqual(after.permissions, [...PERMISSIONS]);
    t.close();
  });

  it('creates a custom role with permissions de-duplicated in canonical order, audited', async () => {
    const t = createTestCompany({ security: true });
    const role = await t.callOk<SecurityRole>(R, 'security.role.save', {
      name: ' Billing Clerk ',
      description: 'Sales invoices only',
      permissions: ['vouchers.create', 'company.view', 'vouchers.create', 'masters.view', 'vouchers.view'],
    });
    assert.equal(role.name, 'Billing Clerk');
    assert.equal(role.isSystem, false);
    assert.deepEqual(role.permissions, ['company.view', 'masters.view', 'vouchers.view', 'vouchers.create']);
    const a = lastAudit(t);
    assert.equal(a?.action, 'create');
    assert.equal(a?.entity_type, 'role');
    assert.deepEqual(JSON.parse(a?.after_json ?? '{}').permissions, role.permissions);
    assert.deepEqual((await t.callOk<SecurityRole>(R, 'security.role.get', { id: role.id })).permissions, role.permissions);
    t.close();
  });

  it('validates permissions against the catalogue and names case-insensitively', async () => {
    const t = createTestCompany({ security: true });
    await fail(t, 'security.role.save', { name: 'Hacker', permissions: ['vouchers.create', 'root.everything'] }, 'VALIDATION', /must be one of/);
    await fail(t, 'security.role.save', { name: '', permissions: [] }, 'VALIDATION', /required/);
    await fail(t, 'security.role.save', { name: 'owner', permissions: [] }, 'CONFLICT', /already exists/);
    await t.callOk(R, 'security.role.save', { name: 'Cashier', permissions: ['vouchers.create'] });
    await fail(t, 'security.role.save', { name: 'CASHIER', permissions: [] }, 'CONFLICT', /already exists/);
    t.close();
  });

  it('alters a custom role (audited as a diff); new permissions apply from the next login', async () => {
    const t = createTestCompany({ security: true });
    const role = await t.callOk<SecurityRole>(R, 'security.role.save', { name: 'Cashier', permissions: ['vouchers.view', 'vouchers.create'] });
    await t.callOk(R, 'security.user.save', { username: 'cash1', displayName: 'Cash', roleId: role.id, isActive: true, password: 'Cashier2026', mustChangePassword: false });
    const n = t.db.value<number>('SELECT COUNT(*) FROM audit_log');
    await t.callOk(R, 'security.role.save', { id: role.id, name: 'Cashier', permissions: ['vouchers.create', 'vouchers.view'] });
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM audit_log'), n, 'unchanged → no entry');

    const altered = await t.callOk<SecurityRole>(R, 'security.role.save', { id: role.id, name: 'Cashier', description: 'Counter', permissions: ['vouchers.view', 'vouchers.create', 'banking.reconcile'] });
    assert.deepEqual(altered.permissions, ['vouchers.view', 'vouchers.create', 'banking.reconcile']);
    assert.equal(altered.userCount, 1);
    const a = lastAudit(t);
    assert.equal(a?.action, 'alter');
    assert.deepEqual(JSON.parse(a?.before_json ?? '{}').permissions, ['vouchers.view', 'vouchers.create']);
    const s = (await login(t.db, 'cash1', 'Cashier2026', t.clock.now())).session;
    assert.ok(s.permissions.has('banking.reconcile'));
    t.close();
  });

  it('deletes only unused custom roles', async () => {
    const t = createTestCompany({ security: true });
    const role = await t.callOk<SecurityRole>(R, 'security.role.save', { name: 'Temp', permissions: ['reports.view'] });
    const u = await t.callOk<{ id: number }>(R, 'security.user.save', { username: 'temp1', displayName: 'T', roleId: role.id, isActive: false, password: 'Temporary1' });
    await fail(t, 'security.role.delete', { id: role.id }, 'BUSINESS_RULE', /assigned to 1 user \(including deactivated users\)/);
    await t.callOk(R, 'security.user.save', { id: u.id, username: 'temp1', displayName: 'T', roleId: t.ids.roles.Auditor, isActive: false });
    assert.deepEqual(await t.callOk(R, 'security.role.delete', { id: role.id }), { deleted: true, id: role.id });
    assert.equal(lastAudit(t)?.action, 'delete');
    assert.equal(lastAudit(t)?.entity_label, 'Temp');
    await fail(t, 'security.role.get', { id: role.id }, 'NOT_FOUND');
    t.close();
  });

  it('edit history of a role shows only the current holder of a reused id (currentOnly)', async () => {
    const t = createTestCompany({ security: true });
    const old = await t.callOk<SecurityRole>(R, 'security.role.save', { name: 'Temp', permissions: ['reports.view'] });
    await t.callOk(R, 'security.role.save', { id: old.id, name: 'Temp 2', permissions: ['reports.view'] });
    await t.callOk(R, 'security.role.delete', { id: old.id });
    // SQLite reuses the highest deleted rowid (no AUTOINCREMENT): the new role gets the same id.
    const fresh = await t.callOk<SecurityRole>(R, 'security.role.save', { name: 'Billing', permissions: ['vouchers.view'] });
    assert.equal(fresh.id, old.id);
    type H = { versions: Array<{ action: string; entityLabel: string | null }> };
    const all = await t.callOk<H>(R, 'security.audit.entityHistory', { entityType: 'role', entityId: fresh.id });
    assert.deepEqual(all.versions.map((v) => v.action), ['create', 'alter', 'delete', 'create'], 'without the flag: every entry of the id');
    const current = await t.callOk<H>(R, 'security.audit.entityHistory', { entityType: 'role', entityId: fresh.id, currentOnly: true });
    assert.deepEqual(current.versions.map((v) => `${v.action}:${v.entityLabel}`), ['create:Billing']);
    t.close();
  });

  it('a security manager who is not an Owner cannot grant permissions they do not hold', async () => {
    const t = createTestCompany({ security: true });
    const admin = t.sessionAs({ permissions: ['security.manage', 'vouchers.view', 'vouchers.create'] });
    await fail(t, 'security.role.save', { name: 'Restorer', permissions: ['data.restore'] }, 'FORBIDDEN', /Data › Restore backups/, admin);
    const ok = await t.callOk<SecurityRole>(R, 'security.role.save', { name: 'Clerk', permissions: ['vouchers.create'] }, { session: admin });
    await fail(t, 'security.role.save', { id: ok.id, name: 'Clerk', permissions: ['vouchers.create', 'vouchers.delete'] }, 'FORBIDDEN', undefined, admin);
    // Removing a permission is not granting one.
    const owner = await t.callOk<SecurityRole>(R, 'security.role.save', { id: ok.id, name: 'Clerk', permissions: ['vouchers.create', 'period.lock'] });
    const trimmed = await t.callOk<SecurityRole>(R, 'security.role.save', { id: owner.id, name: 'Clerk', permissions: ['vouchers.create'] }, { session: admin });
    assert.deepEqual(trimmed.permissions, ['vouchers.create']);
    t.close();
  });

  it('serves a grouped, human-readable permission catalogue to any logged-in user', async () => {
    const t = createTestCompany({ security: true });
    const cat = await t.callOk<PermissionCatalog>(R, 'security.permissions.catalog', {}, { session: t.sessionAs({ role: 'Data Entry' }) });
    const all = cat.groups.flatMap((g) => g.items.map((i) => i.permission));
    assert.deepEqual([...all].sort(), [...PERMISSIONS].sort(), 'every permission exactly once');
    const create = cat.groups.flatMap((g) => g.items).find((i) => i.permission === 'vouchers.create');
    assert.equal(create?.fullLabel, 'Vouchers › Create vouchers');
    assert.ok(cat.groups.every((g) => g.items.length > 0 && g.label.length > 0));
    assert.ok(cat.groups.flatMap((g) => g.items).every((i) => i.description.endsWith('.')));
    t.close();
  });
});
