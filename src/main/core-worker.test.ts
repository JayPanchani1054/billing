// End-to-end test of the worker thread with the real core: core-proxy (main side) → node:worker_threads
// → core-worker.ts → core-host → createRuntime (node:sqlite) and back. No Electron involved.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppState } from '../shared/types/app.ts';
import { makeGstin } from '../core/testing/fixtures.ts';
import { createCoreProxy, nodeWorkerSpawner } from './core-proxy.ts';
import type { CoreProxy, CoreWorkerHandle, SpawnCoreWorker } from './core-proxy.ts';

const script = fileURLToPath(new URL('./core-worker.ts', import.meta.url));

function waitFor(done: () => boolean, what: string, limitMs = 20_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (done()) resolve();
      else if (Date.now() - started > limitMs) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

describe('core worker thread (real runtime)', () => {
  let tmp: string;
  let proxy: CoreProxy;
  const handles: CoreWorkerHandle[] = [];
  let restarted = 0;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'pevqori-core-worker-'));
    const real = nodeWorkerSpawner(script, {
      userDataDir: path.join(tmp, 'user'),
      defaultDataDir: path.join(tmp, 'data'),
      appVersion: '9.9.9',
      logDir: path.join(tmp, 'user', 'logs'),
      consoleLog: false,
    });
    const spawn: SpawnCoreWorker = (init, events) => {
      const h = real(init, events);
      handles.push(h);
      return h;
    };
    proxy = createCoreProxy({
      appVersion: '9.9.9',
      spawn,
      log: (level, message, meta) => proxy.app.log(level, message, meta),
      consoleLog: () => undefined,
      onRestarted: () => restarted++,
    });
    await proxy.start();
  });

  after(async () => {
    await proxy?.shutdown();
    // Windows releases file handles of a terminated thread asynchronously: retry briefly.
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('serves app.state from the worker thread', async () => {
    const r = await proxy.dispatch('app.state', {});
    assert.equal(r.ok, true);
    const state = (r as { ok: true; data: AppState }).data;
    assert.equal(state.appVersion, '9.9.9');
    assert.equal(state.dataDir, path.join(tmp, 'data'));
    assert.equal(proxy.app.dataDir, path.join(tmp, 'data'));
    assert.equal(proxy.hasOpenCompany(), false);
  });

  it('refuses a data folder the user did not pick, accepts it once picked in the dialog', async () => {
    const target = path.join(tmp, 'picked');
    fs.mkdirSync(target);
    const refused = await proxy.dispatch('app.dataDir.set', { path: target, mode: 'use' });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error.code, 'FORBIDDEN');
    proxy.authorizeChoice({ kind: 'folder', path: target }); // what native 'dialog.chooseFolder' triggers
    const accepted = await proxy.dispatch('app.dataDir.set', { path: target, mode: 'use' });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(proxy.app.dataDir, target, 'snapshot follows the change');
  });

  it('main-process log lines land in the worker-owned log file', async () => {
    proxy.app.log('info', 'hello from main');
    await proxy.dispatch('app.state', {}); // a round trip: the log message was handled before it
    const log = fs.readFileSync(path.join(tmp, 'user', 'logs', 'pevqori.log'), 'utf8');
    assert.match(log, /hello from main/);
  });

  it('survives the worker dying: restarts with the dialog choices and keeps serving', async () => {
    await handles[handles.length - 1].terminate(); // what a native crash / OOM looks like from main
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (restarted === 1 && proxy.state === 'running') resolve();
        else if (Date.now() - started > 20_000) reject(new Error(`no restart (state ${proxy.state})`));
        else setTimeout(poll, 20);
      };
      poll();
    });
    assert.equal(handles.length, 2);
    const r = await proxy.dispatch('app.state', {});
    assert.equal(r.ok, true);
    // The data folder chosen earlier is still authorised in the new worker.
    const again = await proxy.dispatch('app.dataDir.set', { path: path.join(tmp, 'picked'), mode: 'use' });
    assert.equal(again.ok, true, JSON.stringify(again));
  });

  it('a company that was open when the worker died reopens in the restarted worker (its lock is taken over)', async () => {
    const created = await proxy.dispatch('app.company.create', {
      name: 'Crash Test Traders',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      booksFrom: '2026-04-01',
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = (created as { ok: true; data: AppState }).data.companies[0].id;
    assert.equal(proxy.hasOpenCompany(), true);
    const lockFile = path.join(proxy.app.dataDir, 'companies', id, 'company.lock');
    assert.equal(fs.existsSync(lockFile), true, 'the open company is locked');

    // The thread dies with the company open: its lock file and SQLite handles are left behind.
    await handles[handles.length - 1].terminate();
    await waitFor(() => restarted === 2 && proxy.state === 'running', 'second restart');
    assert.equal(proxy.hasOpenCompany(), false, 'a restarted core has no company open');

    // Same process, new thread: the lock left by the dead thread must not read as "open elsewhere".
    const reopened = await proxy.dispatch('app.company.open', { id });
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    assert.equal((reopened as { ok: true; data: AppState }).data.company?.name, 'Crash Test Traders');
    const profile = await proxy.dispatch('company.profile.get', {});
    assert.equal(profile.ok, true, JSON.stringify(profile));
  });

  it('shuts down cleanly and promptly', async () => {
    const t0 = Date.now();
    await proxy.shutdown();
    assert.equal(proxy.state, 'stopped');
    assert.ok(Date.now() - t0 < 5_000, 'well inside the quit deadline');
    const r = await proxy.dispatch('app.state', {});
    assert.equal(r.ok, false);
  });
});
