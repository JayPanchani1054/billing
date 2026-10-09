import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiResult } from '../../shared/api.ts';
import { PERMISSIONS } from '../../shared/constants.ts';
import { fixedClock } from '../app/clock.ts';
import { Db } from '../db/db.ts';
import { migrate } from '../db/migrate.ts';
import { AppError, rule } from '../lib/errors.ts';
import { v } from '../lib/validate.ts';
import type { AppRuntime, OpenCompanyInfo, Session } from './context.ts';
import { createDispatcher, isStrictRouteInput, setStrictRouteInput, type DispatchState } from './dispatch.ts';
import { appRoute, companyRoute, type RouteMap } from './route.ts';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  db.exec('CREATE TABLE t (name TEXT UNIQUE)');
  const logs: Array<{ level: string; message: string; meta?: unknown }> = [];
  const app: AppRuntime = { dataDir: '/tmp/x', appVersion: 'test', log: (level, message, meta) => logs.push({ level, message, meta }) };
  const clock = fixedClock('2026-04-15');
  const company: OpenCompanyInfo = { id: 'c1', name: 'Co', dbPath: ':memory:', dir: '/tmp/c1', gstEnabled: true, securityEnabled: true };
  const owner: Session = {
    userId: 1,
    username: 'owner',
    displayName: 'Owner',
    role: 'Owner',
    permissions: new Set(PERMISSIONS),
    isOwner: true,
    implicit: false,
    startedAt: clock.now().toISOString(),
  };
  const clerk: Session = { ...owner, userId: 2, username: 'clerk', role: 'Data Entry', isOwner: false, permissions: new Set(['vouchers.create']) };
  const state: DispatchState & { expired: number; touched: number[] } = {
    app,
    clock,
    company,
    db,
    session: owner,
    expired: 0,
    touched: [],
    touch(ms) {
      this.touched.push(ms);
      this.lastActivityMs = ms;
    },
    expireSession() {
      this.expired++;
      this.session = null;
    },
  };

  const routes = {
    'test.insert': companyRoute({
      access: 'vouchers.create',
      input: v.object({ name: v.string({ min: 1, max: 20 }), fail: v.boolean().optional() }),
      handler: (ctx, input) => {
        ctx.db.run('INSERT INTO t (name) VALUES (:name)', { name: input.name });
        ctx.audit({ action: 'create', entityType: 'test', entityLabel: input.name });
        if (input.fail) throw rule('Rejected by rule');
        return { inserted: input.name };
      },
    }),
    'test.manage': companyRoute({ access: 'company.manage', input: v.none(), handler: () => 'managed' }),
    'test.async': companyRoute({
      access: 'authenticated',
      input: v.none(),
      handler: async (ctx) => {
        ctx.db.run(`INSERT INTO t (name) VALUES ('async')`);
        return 'done';
      },
    }),
    'test.asyncOk': companyRoute({
      access: 'authenticated',
      input: v.none(),
      transactional: false,
      handler: async (ctx) => {
        await new Promise((r) => setTimeout(r, 1));
        return ctx.db.transaction(() => ctx.db.run(`INSERT INTO t (name) VALUES ('later')`).changes);
      },
    }),
    'test.inTx': companyRoute({ access: 'authenticated', input: v.none(), handler: (ctx) => ctx.db.inTransaction }),
    'test.notInTx': companyRoute({ access: 'authenticated', input: v.none(), transactional: false, handler: (ctx) => ctx.db.inTransaction }),
    'test.crash': companyRoute({
      access: 'authenticated',
      input: v.none(),
      handler: () => {
        throw new TypeError('secret internals at /home/dev/file.ts');
      },
    }),
    'test.void': companyRoute({ access: 'authenticated', input: v.none(), handler: () => undefined }),
    'app.public': appRoute({ access: 'public', input: v.none(), handler: (ctx) => ({ hasSession: ctx.session !== null }) }),
    'app.private': appRoute({ access: 'authenticated', input: v.none(), handler: () => 'secret' }),
    'app.perm': appRoute({ access: 'security.manage', input: v.none(), handler: () => 'ok' }),
  } satisfies RouteMap;

  const d = createDispatcher(routes, () => state);
  return { db, logs, state, owner, clerk, clock, dispatch: d.dispatch, close: () => db.close() };
}

const errCode = (r: ApiResult<unknown>): string | null => (r.ok ? null : r.error.code);

describe('dispatcher', () => {
  it('rejects unknown routes, including prototype keys', async () => {
    const t = setup();
    assert.equal(errCode(await t.dispatch('nope.nothing', {})), 'UNKNOWN_ROUTE');
    assert.equal(errCode(await t.dispatch('constructor', {})), 'UNKNOWN_ROUTE');
    assert.equal(errCode(await t.dispatch('__proto__', {})), 'UNKNOWN_ROUTE');
    t.close();
  });

  it('runs a company route in a transaction and returns its data', async () => {
    const t = setup();
    assert.deepEqual(await t.dispatch('test.insert', { name: ' Alpha ' }), { ok: true, data: { inserted: 'Alpha' } });
    assert.equal(t.db.value('SELECT COUNT(*) FROM t'), 1);
    assert.equal(t.db.value('SELECT username FROM audit_log'), 'owner', 'ctx.audit records the session user');
    assert.deepEqual(await t.dispatch('test.inTx', {}), { ok: true, data: true });
    assert.deepEqual(await t.dispatch('test.notInTx', {}), { ok: true, data: false });
    assert.deepEqual(await t.dispatch('test.void', {}), { ok: true, data: null });
    t.close();
  });

  it('rolls back all writes (including the audit row) when the handler throws', async () => {
    const t = setup();
    const r = await t.dispatch('test.insert', { name: 'Beta', fail: true });
    assert.deepEqual(r, { ok: false, error: { code: 'BUSINESS_RULE', message: 'Rejected by rule' } });
    assert.equal(t.db.value('SELECT COUNT(*) FROM t'), 0);
    assert.equal(t.db.value('SELECT COUNT(*) FROM audit_log'), 0);
    t.close();
  });

  it('returns VALIDATION with field issues', async () => {
    const t = setup();
    const r = await t.dispatch('test.insert', { name: '' });
    assert.equal(errCode(r), 'VALIDATION');
    assert.ok(!r.ok && Array.isArray(r.error.details) && (r.error.details as Array<{ path: string }>)[0].path === 'name');
    assert.equal(errCode(await t.dispatch('test.insert', 'not an object')), 'VALIDATION');
    t.close();
  });

  it('strict route input: unknown keys fail under the test runner and in development, and are dropped in production', async () => {
    const t = setup();
    assert.equal(isStrictRouteInput(), true, 'node --test sets NODE_TEST_CONTEXT: the whole suite runs strict');
    const r = await t.dispatch('test.insert', { name: 'Gamma', fial: true });
    assert.equal(errCode(r), 'VALIDATION');
    assert.deepEqual(!r.ok && r.error.details, [{ path: 'fial', message: 'Unknown field "fial" — did you mean "fail"?' }]);
    assert.equal(t.db.value('SELECT COUNT(*) FROM t'), 0, 'the handler never ran');
    setStrictRouteInput(false);
    try {
      assert.deepEqual(await t.dispatch('test.insert', { name: 'Gamma', fial: true }), { ok: true, data: { inserted: 'Gamma' } });
    } finally {
      setStrictRouteInput(true);
    }
    t.close();
  });

  it('enforces NO_COMPANY, UNAUTHENTICATED and FORBIDDEN in that order', async () => {
    const t = setup();
    t.state.session = t.clerk;
    assert.equal(errCode(await t.dispatch('test.manage', {})), 'FORBIDDEN');
    assert.ok((await t.dispatch('test.insert', { name: 'ok' })).ok, 'permission held');
    assert.equal(errCode(await t.dispatch('app.perm', {})), 'FORBIDDEN');
    t.state.session = null;
    assert.equal(errCode(await t.dispatch('test.insert', { name: 'x' })), 'UNAUTHENTICATED');
    assert.equal(errCode(await t.dispatch('app.private', {})), 'UNAUTHENTICATED');
    assert.deepEqual(await t.dispatch('app.public', {}), { ok: true, data: { hasSession: false } });
    t.state.company = null;
    t.state.db = null;
    assert.equal(errCode(await t.dispatch('test.insert', { name: 'x' })), 'NO_COMPANY');
    t.close();
  });

  it('lets the Owner through every permission check', async () => {
    const t = setup();
    t.state.session = { ...t.owner, permissions: new Set() };
    assert.deepEqual(await t.dispatch('test.manage', {}), { ok: true, data: 'managed' });
    assert.deepEqual(await t.dispatch('app.perm', {}), { ok: true, data: 'ok' });
    t.close();
  });

  it('refuses async handlers inside a transaction and rolls back', async () => {
    const t = setup();
    const r = await t.dispatch('test.async', {});
    assert.equal(errCode(r), 'INTERNAL');
    assert.match(!r.ok ? r.error.message : '', /transactional: false/);
    assert.equal(t.db.value('SELECT COUNT(*) FROM t'), 0);
    assert.deepEqual(await t.dispatch('test.asyncOk', {}), { ok: true, data: 1 });
    t.close();
  });

  it('maps unexpected errors to a generic INTERNAL and logs the details', async () => {
    const t = setup();
    const r = await t.dispatch('test.crash', {});
    assert.deepEqual(r, {
      ok: false,
      error: { code: 'INTERNAL', message: 'An unexpected error occurred. Details have been written to the application log.' },
    });
    const entry = t.logs.find((l) => l.level === 'error');
    assert.ok(entry);
    assert.match(String((entry.meta as { error: Error }).error.stack), /secret internals/);
    t.close();
  });

  it('maps SQLite unique violations to CONFLICT', async () => {
    const t = setup();
    await t.dispatch('test.insert', { name: 'Dup' });
    const r = await t.dispatch('test.insert', { name: 'Dup' });
    assert.equal(errCode(r), 'CONFLICT');
    t.close();
  });

  it('expires idle sessions and touches active ones', async () => {
    const t = setup();
    t.state.idleTimeoutMs = 30 * 60_000;
    t.state.lastActivityMs = t.clock.now().getTime();
    t.clock.advance(10 * 60_000);
    assert.ok((await t.dispatch('test.manage', {})).ok);
    assert.equal(t.state.touched.length, 1);
    await t.dispatch('app.public', {});
    assert.equal(t.state.touched.length, 1, 'public routes do not keep the session alive');
    t.clock.advance(31 * 60_000);
    const r = await t.dispatch('test.manage', {});
    assert.equal(errCode(r), 'UNAUTHENTICATED');
    assert.deepEqual(!r.ok && r.error.details, { reason: 'idle' });
    assert.equal(t.state.expired, 1);
    t.close();
  });

  it('never expires the implicit (security off) session', async () => {
    const t = setup();
    t.state.session = { ...t.owner, userId: null, implicit: true };
    t.state.idleTimeoutMs = 1000;
    t.state.lastActivityMs = t.clock.now().getTime();
    t.clock.advance(60 * 60_000);
    assert.ok((await t.dispatch('test.manage', {})).ok);
    assert.equal(t.state.expired, 0);
    t.close();
  });

  it('blocks company routes until a required password change is done', async () => {
    const t = setup();
    t.state.mustChangePassword = true;
    const r = await t.dispatch('test.manage', {});
    assert.equal(errCode(r), 'UNAUTHENTICATED');
    assert.deepEqual(!r.ok && r.error.details, { reason: 'must_change_password' });
    assert.ok((await t.dispatch('app.private', {})).ok, 'app routes (e.g. change password) still work');
    t.close();
  });

  it('passes AppError details through', async () => {
    const routes = {
      'x.y': appRoute({
        access: 'public',
        input: v.none(),
        handler: () => {
          throw new AppError('CONFLICT', 'Taken', { field: 'name' });
        },
      }),
    } satisfies RouteMap;
    const t = setup();
    const d = createDispatcher(routes, () => t.state);
    assert.deepEqual(await d.dispatch('x.y', undefined), { ok: false, error: { code: 'CONFLICT', message: 'Taken', details: { field: 'name' } } });
    t.close();
  });
});
