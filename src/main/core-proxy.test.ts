import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ApiResult } from '../shared/api.ts';
import { CORE_DEFAULTS, CORE_ERRORS, createCoreProxy, SLOW_CALL_MS, workerScriptPath } from './core-proxy.ts';
import type { CoreProxyOptions, CoreWorkerEvents, CoreWorkerHandle, ProxyTimers } from './core-proxy.ts';
import type { CoreSnapshot, ToWorker } from './core-protocol.ts';
import type { UserChoice } from './user-choices.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// ───────────────────────────── fakes ─────────────────────────────

class FakeTimers implements ProxyTimers {
  private t = 1_000_000;
  private seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.t && this.timers.has(id)) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

const SNAP: CoreSnapshot = { dataDir: path.resolve('/data'), hasOpenCompany: false, theme: 'dark' };

class FakeWorker implements CoreWorkerHandle {
  readonly sent: ToWorker[] = [];
  terminated = false;
  readonly events: CoreWorkerEvents;
  readonly init: { choices: UserChoice[] };
  constructor(events: CoreWorkerEvents, init: { choices: UserChoice[] }) {
    this.events = events;
    this.init = init;
  }
  postMessage(message: ToWorker, transfer?: ArrayBuffer[]): void {
    if (this.terminated) return;
    // Emulate the thread boundary (clone + detach transferred buffers).
    this.sent.push(structuredClone(message, { transfer: transfer ?? [] }));
  }
  terminate(): Promise<unknown> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.events.exit(1));
    }
    return Promise.resolve(1);
  }
  ready(snapshot: CoreSnapshot = SNAP): void {
    this.events.message({ type: 'ready', snapshot });
  }
  calls(): Array<Extract<ToWorker, { type: 'call' }>> {
    return this.sent.filter((m): m is Extract<ToWorker, { type: 'call' }> => m.type === 'call');
  }
  reply(id: number, value: unknown, snapshot: CoreSnapshot | null = SNAP): void {
    this.events.message({ type: 'reply', id, ok: true, value, snapshot });
  }
  crash(err: Error = new Error('native fault')): void {
    this.terminated = true;
    this.events.error(err);
    this.events.exit(1);
  }
}

function setup(over: Partial<CoreProxyOptions> = {}) {
  const timers = new FakeTimers();
  const workers: FakeWorker[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const consoleLines: string[] = [];
  let restarted = 0;
  const faults: string[] = [];
  let self: ReturnType<typeof createCoreProxy> | null = null;
  const proxy = createCoreProxy({
    appVersion: '1.0.0',
    spawn: (init, events) => {
      const w = new FakeWorker(events, init);
      workers.push(w);
      return w;
    },
    // Like main: the proxy's own log lines go through log.ts, whose sink is proxy.app.log.
    log: (level, message, meta) => {
      logs.push({ level, message });
      self?.app.log(level, message, meta);
    },
    consoleLog: (_level, message) => consoleLines.push(message),
    onRestarted: () => restarted++,
    onFault: (kind) => faults.push(kind),
    timers,
    ...over,
  });
  self = proxy;
  return {
    proxy,
    timers,
    workers,
    logs,
    consoleLines,
    faults,
    get restarted() {
      return restarted;
    },
    get w() {
      return workers[workers.length - 1];
    },
  };
}

async function started(over: Partial<CoreProxyOptions> = {}) {
  const h = setup(over);
  const p = h.proxy.start();
  h.w.ready();
  await p;
  return h;
}

// ───────────────────────────── tests ─────────────────────────────

describe('core proxy: start-up', () => {
  it('resolves once the worker is ready and answers the synchronous getters from its snapshot', async () => {
    const h = await started();
    assert.equal(h.proxy.state, 'running');
    assert.equal(h.proxy.app.dataDir, SNAP.dataDir);
    assert.equal(h.proxy.app.appVersion, '1.0.0');
    assert.equal(h.proxy.getTheme(), 'dark');
    assert.equal(h.proxy.hasOpenCompany(), false);
    assert.equal(h.timers.timers.size, 0, 'start-up timer cleared');
  });

  it('rejects with the core’s own error when it cannot start, and refuses calls afterwards', async () => {
    const h = setup();
    const p = h.proxy.start();
    h.w.events.message({ type: 'startup-failed', error: { name: 'Error', message: 'config.json is unreadable' } });
    await assert.rejects(p, /config\.json is unreadable/);
    assert.equal(h.proxy.state, 'failed');
    assert.deepEqual(await h.proxy.dispatch('app.state', {}), CORE_ERRORS.failed);
    assert.equal(h.workers.length, 1, 'a failed first start is never retried');
    assert.equal(h.w.terminated, true);
  });

  it('gives up (and terminates the thread) when the worker never becomes ready', async () => {
    const h = setup({ startupTimeoutMs: 5_000 });
    const p = h.proxy.start();
    h.timers.advance(5_000);
    await assert.rejects(p, /did not start within 5000 ms/);
    assert.equal(h.w.terminated, true);
  });

  it('log lines written before the worker is ready reach it once it is', async () => {
    const h = setup();
    const p = h.proxy.start();
    h.proxy.app.log('info', 'early line');
    assert.equal(h.w.sent.length, 0);
    h.w.ready();
    await p;
    assert.deepEqual(h.w.sent, [{ type: 'log', level: 'info', message: 'early line' }]);
  });
});

describe('core proxy: calls', () => {
  it('matches replies to requests by id, in any order', async () => {
    const h = await started();
    const a = h.proxy.dispatch('reports.trialBalance', { asOf: '2026-03-31' });
    const b = h.proxy.dispatch('app.state', {});
    const [ca, cb] = h.w.calls();
    assert.equal(ca.op === 'dispatch' && ca.route, 'reports.trialBalance');
    assert.notEqual(ca.id, cb.id);
    h.w.reply(cb.id, { ok: true, data: 'state' });
    h.w.reply(ca.id, { ok: true, data: 'tb' });
    assert.deepEqual(await a, { ok: true, data: 'tb' });
    assert.deepEqual(await b, { ok: true, data: 'state' });
    assert.equal(h.timers.timers.size, 0, 'call timeouts cleared');
  });

  it('moves the IPC input’s bytes to the worker instead of copying them', async () => {
    const h = await started();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = h.proxy.dispatch('data.import.preview', { file: { bytes } });
    assert.equal(bytes.byteLength, 0, 'transferred (detached here)');
    const [c] = h.w.calls();
    assert.deepEqual(c.op === 'dispatch' && [...(c.input as { file: { bytes: Uint8Array } }).file.bytes], [1, 2, 3]);
    h.w.reply(c.id, { ok: true, data: null });
    await pending;
  });

  it('keeps the synchronous getters in step with every reply', async () => {
    const h = await started();
    const p = h.proxy.dispatch('app.company.open', { id: 'c1' });
    h.w.reply(h.w.calls()[0].id, { ok: true, data: null }, { dataDir: path.resolve('/new'), hasOpenCompany: true, theme: 'light' });
    await p;
    assert.equal(h.proxy.hasOpenCompany(), true);
    assert.equal(h.proxy.app.dataDir, path.resolve('/new'));
    assert.equal(h.proxy.getTheme(), 'light');
  });

  it('logs slow round trips (not fast ones) with the route name', async () => {
    const h = await started();
    const fast = h.proxy.dispatch('app.state', {});
    h.w.reply(h.w.calls()[0].id, { ok: true, data: null });
    await fast;
    const slow = h.proxy.dispatch('data.verify', {});
    h.timers.advance(SLOW_CALL_MS);
    h.w.reply(h.w.calls()[1].id, { ok: true, data: null });
    await slow;
    assert.deepEqual(
      h.logs.filter((l) => l.message === 'Slow route'),
      [{ level: 'info', message: 'Slow route' }],
    );
  });

  it('a call without an answer resolves to a timeout error; the late answer is ignored', async () => {
    const h = await started({ callTimeoutMs: 60_000 });
    const p = h.proxy.dispatch('data.verify', {});
    h.timers.advance(60_000);
    assert.deepEqual(await p, CORE_ERRORS.timeout);
    h.w.reply(h.w.calls()[0].id, { ok: true, data: 'late' });
    assert.ok(h.logs.some((l) => l.message.includes('after its request had timed out')));
    assert.equal(h.proxy.state, 'running', 'a slow route does not kill the core');
  });

  it('a worker-side exception becomes a generic INTERNAL error (no stack crosses to the window)', async () => {
    const h = await started();
    const p = h.proxy.dispatch('x.y.z', {});
    h.w.events.message({ type: 'reply', id: h.w.calls()[0].id, ok: false, error: { name: 'TypeError', message: 'x is undefined', stack: 'at …' }, snapshot: null });
    const r = (await p) as ApiResult<never>;
    assert.deepEqual(r, CORE_ERRORS.broken);
    assert.ok(h.logs.some((l) => l.level === 'error'));
  });

  it('forwards theme changes, dialog choices and log lines (secrets redacted)', async () => {
    const h = await started();
    h.proxy.setTheme('light');
    assert.equal(h.proxy.getTheme(), 'light');
    h.proxy.authorizeChoice({ kind: 'folder', path: path.resolve('/media/usb') });
    h.proxy.authorizeChoice({ kind: 'folder', path: 'relative/path' });
    h.proxy.app.log('warn', 'login failed', { username: 'raj', password: 'hunter2' });
    assert.deepEqual(h.w.sent, [
      { type: 'set-theme', mode: 'light' },
      { type: 'authorize-choice', kind: 'folder', path: path.resolve('/media/usb') },
      { type: 'log', level: 'warn', message: 'login failed', meta: { username: 'raj', password: '[redacted]' } },
    ]);
  });

  it('reports worker faults and ignores malformed messages', async () => {
    const h = await started();
    h.w.events.message({ type: 'fault', kind: 'Uncaught exception in the core worker', error: { name: 'E', message: 'm' } });
    h.w.events.message({ type: 'nonsense' });
    assert.deepEqual(h.faults, ['Uncaught exception in the core worker']);
    assert.ok(h.logs.some((l) => l.message.includes('malformed')));
  });
});

describe('core proxy: crash and restart', () => {
  it('answers in-flight calls with a clear error, restarts the worker with the choices replayed, and tells the window', async () => {
    const h = await started();
    h.proxy.authorizeChoice({ kind: 'folder', path: path.resolve('/chosen') });
    const inflight = h.proxy.dispatch('data.export.vouchers', {});
    const first = h.w;
    first.crash(new Error('ERR_WORKER_OUT_OF_MEMORY'));
    assert.deepEqual(await inflight, CORE_ERRORS.restarted);
    assert.equal(h.workers.length, 2);
    assert.equal(h.proxy.state, 'starting');
    assert.deepEqual(h.w.init.choices, [{ kind: 'folder', path: path.resolve('/chosen') }]);
    // The crash log line waits for the new worker (so it lands in the log file), then flows.
    h.w.ready({ ...SNAP, hasOpenCompany: false });
    await tick();
    assert.equal(h.proxy.state, 'running');
    assert.equal(h.restarted, 1);
    assert.ok(h.w.sent.some((m) => m.type === 'log' && m.message === 'The core worker stopped unexpectedly'));
    const p = h.proxy.dispatch('app.state', {});
    h.w.reply(h.w.calls()[0].id, { ok: true, data: 'after restart' });
    assert.deepEqual(await p, { ok: true, data: 'after restart' });
  });

  it('stops restarting after maxRestarts crashes within the window', async () => {
    const h = await started({ maxRestarts: 2, restartWindowMs: 60_000 });
    h.w.crash();
    h.w.ready();
    h.w.crash();
    h.w.ready();
    assert.equal(h.workers.length, 3);
    h.w.crash();
    assert.equal(h.workers.length, 3, 'no fourth worker');
    assert.equal(h.proxy.state, 'failed');
    assert.deepEqual(await h.proxy.dispatch('app.state', {}), CORE_ERRORS.failed);
    assert.ok(h.consoleLines.some((l) => l.includes('could not be restarted')));
  });

  it('crashes spread over time do not exhaust the restart budget', async () => {
    const h = await started({ maxRestarts: 1, restartWindowMs: 60_000 });
    h.w.crash();
    h.w.ready();
    h.timers.advance(61_000);
    h.w.crash();
    assert.equal(h.workers.length, 3);
  });

  it('a restart that cannot start leaves the proxy failed (no restart loop)', async () => {
    const h = await started();
    h.w.crash();
    h.w.events.message({ type: 'startup-failed', error: { name: 'Error', message: 'data folder gone' } });
    assert.equal(h.proxy.state, 'failed');
    assert.equal(h.workers.length, 2);
  });
});

describe('core proxy: shutdown', () => {
  it('asks the core to stop, then terminates the thread; later calls answer "closing"', async () => {
    const h = await started();
    const done = h.proxy.shutdown();
    assert.equal(h.proxy.state, 'stopping');
    const stop = h.w.calls().find((c) => c.op === 'shutdown');
    assert.ok(stop);
    h.w.reply(stop.id, null);
    await done;
    assert.equal(h.proxy.state, 'stopped');
    assert.equal(h.w.terminated, true);
    assert.equal(h.timers.timers.size, 0, 'no timer left to keep the process alive');
    assert.deepEqual(await h.proxy.dispatch('app.state', {}), CORE_ERRORS.closing);
    assert.equal(h.proxy.shutdown(), done, 'idempotent');
    await tick();
    assert.equal(h.restarted, 0, 'the exit of a stopped worker is not a crash');
    assert.equal(h.workers.length, 1);
    h.proxy.app.log('info', 'after shutdown');
    assert.ok(h.consoleLines.includes('after shutdown'), 'logs fall back to the console');
  });

  it('is bounded: a core that never answers is terminated after shutdownTimeoutMs', async () => {
    const h = await started({ shutdownTimeoutMs: 8_000 });
    const inflight = h.proxy.dispatch('data.backup.create', {});
    const done = h.proxy.shutdown();
    h.timers.advance(8_000);
    await done;
    assert.equal(h.w.terminated, true);
    assert.equal(h.proxy.state, 'stopped');
    assert.deepEqual(await inflight, CORE_ERRORS.closing);
    assert.ok(h.logs.some((l) => l.message.includes('did not stop within 8000 ms')));
  });

  it('a worker that dies while stopping does not hang the shutdown or restart', async () => {
    const h = await started();
    const done = h.proxy.shutdown();
    h.w.crash();
    await done;
    assert.equal(h.proxy.state, 'stopped');
    assert.equal(h.workers.length, 1);
  });

  it('shutting down during start-up rejects the start and stops the thread', async () => {
    const h = setup();
    const start = h.proxy.start();
    const done = h.proxy.shutdown();
    h.timers.advance(CORE_DEFAULTS.shutdownTimeoutMs);
    await done;
    await assert.rejects(start, /closed while the core was starting/);
    assert.equal(h.w.terminated, true);
  });

  it('a restarted worker that becomes ready while the app is quitting is not announced as a restart', async () => {
    const h = await started();
    h.w.crash();
    const done = h.proxy.shutdown();
    h.w.ready();
    assert.equal(h.restarted, 0);
    const stop = h.w.calls().find((c) => c.op === 'shutdown');
    assert.ok(stop);
    h.w.reply(stop.id, null);
    await done;
    assert.equal(h.proxy.state, 'stopped');
  });

  it('shutdown before start, and getters while stopped, are safe', async () => {
    const h = setup();
    await h.proxy.shutdown();
    assert.equal(h.proxy.state, 'stopped');
    assert.equal(h.proxy.hasOpenCompany(), false);
    assert.equal(h.proxy.getTheme(), 'system');
    assert.equal(h.proxy.app.dataDir, '');
  });
});


describe('workerScriptPath', () => {
  it('points at the unpacked copy inside a packaged app and at out/main in development', () => {
    const packaged = path.join('C:', 'Program Files', 'Pevqori', 'resources', 'app.asar', 'out', 'main');
    assert.equal(workerScriptPath(packaged), path.join('C:', 'Program Files', 'Pevqori', 'resources', 'app.asar.unpacked', 'out', 'main', 'core-worker.cjs'));
    assert.equal(workerScriptPath('/repo/out/main'), path.join('/repo/out/main', 'core-worker.cjs'));
    assert.equal(workerScriptPath('/x/app.asar.unpacked/out/main'), path.join('/x/app.asar.unpacked/out/main', 'core-worker.cjs'));
  });
});
