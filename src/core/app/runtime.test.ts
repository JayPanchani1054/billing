import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiResult } from '../../shared/api.ts';
import type { AppState, CompanyListItem, CreateCompanyInput } from '../../shared/types/app.ts';
import type { CompanyProfile } from '../../shared/types/company.ts';
import { Db } from '../db/db.ts';
import { verifyAuditChain } from '../lib/audit.ts';
import { companyRoutes } from '../modules/company/routes.ts';
import { makeGstin } from '../testing/fixtures.ts';
import { fixedClock, type FixedClock } from './clock.ts';
import { appRoutes } from './routes.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { createRuntimeWithRoutes } from './runtime-core.ts';

let root: string;
let clock: FixedClock;
const runtimes: Runtime[] = [];

function makeRuntime(opts: { idleTimeoutMs?: number } = {}): Runtime {
  const rt = createRuntimeWithRoutes(
    {
      userDataDir: path.join(root, 'userData'),
      defaultDataDir: path.join(root, 'Documents', 'Bahi ERP'),
      appVersion: '1.2.3',
      clock,
      consoleLog: false,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
    { ...appRoutes, ...companyRoutes },
  );
  runtimes.push(rt);
  return rt;
}

async function ok<T>(rt: Runtime, route: string, input: unknown = {}): Promise<T> {
  const r = await rt.dispatch(route, input);
  if (!r.ok) assert.fail(`${route} failed: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? '')}`);
  return r.data as T;
}

async function fail(rt: Runtime, route: string, input: unknown, code: string, re?: RegExp): Promise<ApiResult<unknown>> {
  const r = await rt.dispatch(route, input);
  assert.equal(r.ok, false, `${route} should fail`);
  if (!r.ok) {
    assert.equal(r.error.code, code, `${route}: ${r.error.message}`);
    if (re) assert.match(r.error.message, re);
  }
  return r;
}

const company = (name: string, over: Partial<CreateCompanyInput> = {}): CreateCompanyInput => ({
  name,
  stateCode: '27',
  gstRegistrationType: 'regular',
  gstin: makeGstin('27'),
  booksFrom: '2026-04-01',
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-rt-'));
  clock = fixedClock('2026-10-05');
});
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime: first run and company lifecycle', () => {
  it('reports state before any company exists', async () => {
    const rt = makeRuntime();
    const s = await ok<AppState>(rt, 'app.state');
    assert.deepEqual(s, {
      appVersion: '1.2.3',
      dataDir: path.join(root, 'Documents', 'Bahi ERP'),
      firstRun: true,
      companies: [],
      company: null,
      session: null,
      pendingLogin: null,
    });
    assert.equal(rt.hasOpenCompany(), false);
    assert.equal(rt.app.dataDir, s.dataDir);
    await fail(rt, 'company.profile.get', {}, 'NO_COMPANY');
    await fail(rt, 'no.such.route', {}, 'UNKNOWN_ROUTE');
  });

  it('creates and opens an unsecured company with an implicit owner session', async () => {
    const rt = makeRuntime();
    const s = await ok<AppState>(rt, 'app.company.create', company('Shree Ganesh Traders'));
    assert.equal(s.firstRun, false, 'creating a company accepts the data folder');
    assert.equal(s.company?.name, 'Shree Ganesh Traders');
    assert.equal(s.company?.gstEnabled, true);
    assert.equal(s.session?.implicit, true);
    assert.equal(s.session?.isOwner, true);
    assert.equal(s.pendingLogin, null);
    assert.equal(s.companies.length, 1);
    assert.equal(s.companies[0].lastOpenedAt, clock.now().toISOString());
    assert.equal(rt.hasOpenCompany(), true);

    const profile = await ok<CompanyProfile>(rt, 'company.profile.get');
    assert.equal(profile.gstin, makeGstin('27'));
    const summary = await ok<{ id: string }>(rt, 'company.summary');
    assert.equal(summary.id, s.companies[0].id);

    const closed = await ok<AppState>(rt, 'app.company.close');
    assert.equal(closed.company, null);
    assert.equal(closed.session, null);
    assert.equal(rt.hasOpenCompany(), false);

    const reopened = await ok<AppState>(rt, 'app.company.open', { id: s.companies[0].id });
    assert.equal(reopened.company?.name, 'Shree Ganesh Traders');

    // The DB records the creation in an intact audit chain.
    const dbPath = path.join(rt.app.dataDir, 'companies', s.companies[0].id, 'company.db');
    await rt.shutdown();
    assert.equal(fs.existsSync(path.join(path.dirname(dbPath), 'company.lock')), false, 'shutdown releases the lock');
    const db = new Db(dbPath, { readOnly: true });
    assert.equal(db.value(`SELECT action FROM audit_log WHERE entity_type = 'company'`), 'create');
    assert.equal(verifyAuditChain(db).ok, true);
    db.close();
  });

  it('validates company input', async () => {
    const rt = makeRuntime();
    const r = await fail(rt, 'app.company.create', company('', { gstin: makeGstin('29') }), 'VALIDATION');
    assert.ok(!r.ok && (r.error.details as Array<{ path: string }>).some((i) => i.path === 'name'));
    await fail(rt, 'app.company.create', company('X', { gstin: makeGstin('29') }), 'VALIDATION', /does not match/);
    await fail(rt, 'app.company.create', company('X', { owner: { username: 'boss', password: 'weak' } }), 'VALIDATION', /at least 8/);
    await fail(rt, 'app.company.create', company('X', { stateCode: '99' }), 'VALIDATION', /valid state/);
    assert.deepEqual(await ok<CompanyListItem[]>(rt, 'app.company.list'), []);
  });

  it('switches companies (closing the previous one) and refuses a company open in another runtime', async () => {
    const rt = makeRuntime();
    const a = await ok<AppState>(rt, 'app.company.create', company('Alpha'));
    const b = await ok<AppState>(rt, 'app.company.create', company('Beta', { gstRegistrationType: 'unregistered', gstin: undefined }));
    assert.equal(b.company?.name, 'Beta');
    assert.equal(b.company?.gstEnabled, false);
    const alphaId = a.companies[0].id;
    await ok(rt, 'app.company.open', { id: alphaId });

    const other = makeRuntime();
    await fail(other, 'app.company.open', { id: alphaId }, 'LOCKED', /another Bahi ERP window/);
    await fail(other, 'app.company.open', { id: 'does-not-exist-123456' }, 'NOT_FOUND');
    await ok(rt, 'app.company.close');
    await ok(other, 'app.company.open', { id: alphaId });
  });
});

describe('runtime: security', () => {
  async function securedRuntime(idleTimeoutMs?: number) {
    const rt = makeRuntime({ idleTimeoutMs });
    const s = await ok<AppState>(rt, 'app.company.create', company('Secure Co', { owner: { username: 'boss', displayName: 'The Boss', password: 'Boss12345' } }));
    return { rt, id: s.companies[0].id, created: s };
  }

  it('logs the owner in on creation; reopening requires login', async () => {
    const { rt, id, created } = await securedRuntime();
    assert.equal(created.session?.username, 'boss');
    assert.equal(created.session?.implicit, false);
    assert.equal(created.companies[0].securityEnabled, true);

    await ok(rt, 'app.company.close');
    const opened = await ok<AppState>(rt, 'app.company.open', { id });
    assert.equal(opened.session, null);
    assert.equal(opened.company, null, 'company details hidden until login');
    assert.deepEqual(opened.pendingLogin, { companyId: id, companyName: 'Secure Co' });
    await fail(rt, 'company.profile.get', {}, 'UNAUTHENTICATED');
    await fail(rt, 'app.auth.changePassword', { currentPassword: 'Boss12345', newPassword: 'Boss67890' }, 'UNAUTHENTICATED');

    await fail(rt, 'app.auth.login', { username: 'boss', password: 'nope' }, 'UNAUTHENTICATED');
    const logged = await ok<AppState>(rt, 'app.auth.login', { username: 'BOSS', password: 'Boss12345' });
    assert.equal(logged.session?.displayName, 'The Boss');
    assert.equal(logged.company?.name, 'Secure Co');
    assert.equal(logged.pendingLogin, null);
    assert.ok((await ok<CompanyProfile>(rt, 'company.profile.get')).name === 'Secure Co');

    const out = await ok<AppState>(rt, 'app.auth.logout');
    assert.equal(out.session, null);
    assert.deepEqual(out.pendingLogin, { companyId: id, companyName: 'Secure Co' });
    await fail(rt, 'company.summary', {}, 'UNAUTHENTICATED');
  });

  it('changes the password through the app route', async () => {
    const { rt } = await securedRuntime();
    await fail(rt, 'app.auth.changePassword', { currentPassword: 'Boss12345', newPassword: 'short' }, 'VALIDATION');
    assert.deepEqual(await ok(rt, 'app.auth.changePassword', { currentPassword: 'Boss12345', newPassword: 'Boss67890' }), { ok: true });
    await ok(rt, 'app.auth.logout');
    await fail(rt, 'app.auth.login', { username: 'boss', password: 'Boss12345' }, 'UNAUTHENTICATED');
    await ok(rt, 'app.auth.login', { username: 'boss', password: 'Boss67890' });
  });

  it('ends the session after the idle timeout; app.session.touch keeps it alive', async () => {
    const { rt, id } = await securedRuntime(10 * 60_000);
    clock.advance(9 * 60_000);
    assert.equal((await ok<{ username: string }>(rt, 'app.session.touch')).username, 'boss');
    clock.advance(9 * 60_000);
    await ok(rt, 'company.summary');
    clock.advance(11 * 60_000);
    await fail(rt, 'company.summary', {}, 'UNAUTHENTICATED', /inactivity/);
    const s = await ok<AppState>(rt, 'app.state');
    assert.deepEqual(s.pendingLogin, { companyId: id, companyName: 'Secure Co' });
    assert.equal(await ok(rt, 'app.session.touch'), null);
  });

  it('locks out after repeated failures', async () => {
    const { rt } = await securedRuntime();
    await ok(rt, 'app.auth.logout');
    for (let i = 0; i < 4; i++) await fail(rt, 'app.auth.login', { username: 'boss', password: `wrong${i}xx` }, 'UNAUTHENTICATED');
    await fail(rt, 'app.auth.login', { username: 'boss', password: 'wrong5xx' }, 'LOCKED', /5 minutes/);
    await fail(rt, 'app.auth.login', { username: 'boss', password: 'Boss12345' }, 'LOCKED');
    clock.advance(5 * 60_000 + 1);
    await ok(rt, 'app.auth.login', { username: 'boss', password: 'Boss12345' });
  });

  it('deletes a secured company only with the typed name and the owner password', async () => {
    const { rt, id } = await securedRuntime();
    await fail(rt, 'app.company.delete', { id, confirmName: 'Secure Co', password: 'Boss12345' }, 'CONFLICT', /Close this company/);
    await ok(rt, 'app.company.close');
    await fail(rt, 'app.company.delete', { id, confirmName: 'Secure', password: 'Boss12345' }, 'VALIDATION');
    await fail(rt, 'app.company.delete', { id, confirmName: 'Secure Co' }, 'VALIDATION', /owner password/);
    await fail(rt, 'app.company.delete', { id, confirmName: 'Secure Co', password: 'Wrong1234' }, 'UNAUTHENTICATED');
    const list = await ok<CompanyListItem[]>(rt, 'app.company.delete', { id, confirmName: 'Secure Co', password: 'Boss12345' });
    assert.deepEqual(list, []);
    const trash = fs.readdirSync(path.join(rt.app.dataDir, 'trash'));
    assert.equal(trash.length, 1);
    assert.ok(trash[0].startsWith(`${id}--`));
  });
});

describe('runtime: data folder', () => {
  it("'use' switches folders and completes first run", async () => {
    const rt = makeRuntime();
    const target = path.join(root, 'D-drive', 'BahiData');
    const s = await ok<AppState>(rt, 'app.dataDir.set', { path: target, mode: 'use' });
    assert.equal(s.dataDir, target);
    assert.equal(s.firstRun, false);
    assert.ok(fs.existsSync(path.join(target, 'companies')));
    // Persisted for the next launch.
    const next = makeRuntime();
    assert.equal((await ok<AppState>(next, 'app.state')).dataDir, target);
  });

  it('validates the requested folder', async () => {
    const rt = makeRuntime();
    await fail(rt, 'app.dataDir.set', { path: 'relative/dir', mode: 'use' }, 'VALIDATION', /full folder path/);
    const blocker = path.join(root, 'a-file');
    fs.writeFileSync(blocker, 'x');
    await fail(rt, 'app.dataDir.set', { path: path.join(blocker, 'sub'), mode: 'use' }, 'VALIDATION', /cannot write/);
    await fail(rt, 'app.dataDir.set', { path: path.join(rt.app.dataDir, 'inner'), mode: 'copy' }, 'VALIDATION', /inside/);
    await ok(rt, 'app.company.create', company('Open Co'));
    await fail(rt, 'app.dataDir.set', { path: path.join(root, 'new'), mode: 'use' }, 'CONFLICT', /Close the company/);
  });

  it("'copy' copies and verifies every company, keeping the original", async () => {
    const rt = makeRuntime();
    const a = await ok<AppState>(rt, 'app.company.create', company('Copy One'));
    await ok(rt, 'app.company.create', company('Copy Two', { gstRegistrationType: 'unregistered', gstin: undefined }));
    await ok(rt, 'app.company.close');
    const oldDir = rt.app.dataDir;
    const target = path.join(root, 'copied');
    const s = await ok<AppState>(rt, 'app.dataDir.set', { path: target, mode: 'copy' });
    assert.equal(s.dataDir, target);
    assert.deepEqual(s.companies.map((c) => c.name).sort(), ['Copy One', 'Copy Two']);
    assert.equal(fs.readdirSync(path.join(oldDir, 'companies')).length, 2, 'original kept');
    const id = a.companies[0].id;
    assert.ok(s.companies.find((c) => c.id === id)?.lastOpenedAt, 'registry carried over');
    assert.ok(!fs.existsSync(path.join(target, 'companies', id, 'company.lock')));
    await ok(rt, 'app.company.open', { id });
  });

  it("'move' removes the originals only after verification and refuses id collisions", async () => {
    const rt = makeRuntime();
    const a = await ok<AppState>(rt, 'app.company.create', company('Move Me'));
    await ok(rt, 'app.company.close');
    const oldDir = rt.app.dataDir;
    const id = a.companies[0].id;

    const clash = path.join(root, 'clash');
    fs.mkdirSync(path.join(clash, 'companies', id), { recursive: true });
    await fail(rt, 'app.dataDir.set', { path: clash, mode: 'move' }, 'CONFLICT', /already contains/);
    assert.ok(fs.existsSync(path.join(oldDir, 'companies', id, 'company.db')), 'source untouched');

    const target = path.join(root, 'moved');
    const s = await ok<AppState>(rt, 'app.dataDir.set', { path: target, mode: 'move' });
    assert.deepEqual(s.companies.map((c) => c.id), [id]);
    assert.equal(fs.existsSync(path.join(oldDir, 'companies', id)), false);
    assert.equal(fs.existsSync(path.join(oldDir, 'registry.json')), false);
    const opened = await ok<AppState>(rt, 'app.company.open', { id });
    assert.equal(opened.company?.name, 'Move Me');
  });

  it('refuses to move a company that is open in another window', async () => {
    const rt = makeRuntime();
    const a = await ok<AppState>(rt, 'app.company.create', company('Busy Co'));
    await ok(rt, 'app.company.close');
    const other = makeRuntime();
    await ok(other, 'app.company.open', { id: a.companies[0].id });
    await fail(rt, 'app.dataDir.set', { path: path.join(root, 'elsewhere'), mode: 'move' }, 'LOCKED');
  });
});

describe('runtime: theme', () => {
  it('persists the theme preference', () => {
    const rt = makeRuntime();
    assert.equal(rt.getTheme(), 'system');
    rt.setTheme('dark');
    assert.equal(makeRuntime().getTheme(), 'dark');
  });
});

describe('createRuntime (production entry point)', () => {
  it('serves app and company routes through the full route table and writes the app log', async () => {
    const rt = createRuntime({
      userDataDir: path.join(root, 'userData'),
      defaultDataDir: path.join(root, 'data'),
      appVersion: '9.9.9',
      clock,
      consoleLog: false,
    });
    runtimes.push(rt);
    await ok(rt, 'app.company.create', company('Production Path Co'));
    assert.equal((await ok<CompanyProfile>(rt, 'company.profile.get')).name, 'Production Path Co');
    await rt.shutdown();
    const log = fs.readFileSync(path.join(root, 'userData', 'logs', 'bahi.log'), 'utf8');
    assert.match(log, /"msg":"Company created"/);
    assert.doesNotMatch(log, /Production Path Co/, 'business data stays out of the app log');
  });
});
