import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ApiResult } from '../shared/api.ts';
import type { AppRuntime } from '../core/api/context.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { startCoreHost } from './core-host.ts';
import type { ChoiceAuthorizers } from './core-host.ts';
import type { FromWorker } from './core-protocol.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeRuntime extends Runtime {
  calls: Array<{ route: string; input: unknown }>;
  logs: Array<{ level: string; message: string; meta?: unknown }>;
  theme: 'system' | 'light' | 'dark';
  shutdowns: number;
  open: boolean;
  next: (route: string, input: unknown) => Promise<ApiResult<unknown>>;
}

function fakeRuntime(): FakeRuntime {
  const rt: FakeRuntime = {
    calls: [],
    logs: [],
    theme: 'light',
    shutdowns: 0,
    open: false,
    next: async () => ({ ok: true, data: null }),
    dispatch(route, input) {
      rt.calls.push({ route, input });
      return rt.next(route, input);
    },
    get app(): AppRuntime {
      return { dataDir: path.resolve('/data'), appVersion: '1.0.0', log: (level, message, meta) => rt.logs.push({ level, message, meta }) };
    },
    async shutdown() {
      rt.shutdowns++;
      rt.open = false;
    },
    hasOpenCompany: () => rt.open,
    getTheme: () => rt.theme,
    setTheme(mode) {
      rt.theme = mode;
    },
  };
  return rt;
}

function setup(opts: { choices?: Array<{ kind: 'file' | 'folder'; path: string }>; failPost?: (m: FromWorker) => boolean } = {}) {
  const rt = fakeRuntime();
  const posted: Array<{ message: FromWorker; transfer?: ArrayBuffer[] }> = [];
  let authorizers: ChoiceAuthorizers | null = null;
  const host = startCoreHost({
    createRuntime: (a) => {
      authorizers = a;
      return rt;
    },
    post: (message, transfer) => {
      if (opts.failPost?.(message)) {
        const err = new Error('could not be cloned');
        err.name = 'DataCloneError';
        throw err;
      }
      // Emulate the thread boundary: the message must be cloneable, transfers detach.
      posted.push({ message: structuredClone(message, { transfer: transfer ?? [] }), transfer });
    },
    choices: opts.choices,
  });
  return { rt, host, posted, auth: () => authorizers as unknown as ChoiceAuthorizers };
}

const replies = (posted: Array<{ message: FromWorker }>) => posted.map((p) => p.message).filter((m): m is Extract<FromWorker, { type: 'reply' }> => m.type === 'reply');

describe('core host (worker side)', () => {
  it('reports a runtime that cannot start, and answers calls with an error instead of hanging', () => {
    const posted: FromWorker[] = [];
    const host = startCoreHost({
      createRuntime: () => {
        throw new Error('config.json is corrupt');
      },
      post: (m) => posted.push(m),
    });
    assert.equal(host.runtime, null);
    assert.equal(posted[0].type, 'startup-failed');
    host.handle({ type: 'call', id: 1, op: 'dispatch', route: 'app.state', input: {} });
    const r = posted[1] as Extract<FromWorker, { type: 'reply' }>;
    assert.equal(r.type, 'reply');
    assert.equal(r.ok, false);
  });

  it('dispatches a call and replies with the result and a fresh snapshot', async () => {
    const { rt, host, posted } = setup();
    rt.next = async () => {
      rt.open = true;
      return { ok: true, data: { name: 'Sharma Traders' } };
    };
    host.handle({ type: 'call', id: 7, op: 'dispatch', route: 'app.company.open', input: { id: 'c1' } });
    await tick();
    assert.deepEqual(rt.calls, [{ route: 'app.company.open', input: { id: 'c1' } }]);
    const [r] = replies(posted);
    assert.equal(r.id, 7);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { ok: true, data: { name: 'Sharma Traders' } });
    assert.deepEqual(r.snapshot, { dataDir: path.resolve('/data'), hasOpenCompany: true, theme: 'light' });
  });

  it('copies result bytes into fresh transferred buffers; the handler’s buffer stays usable', async () => {
    const { rt, host, posted } = setup();
    const cached = new Uint8Array([1, 2, 3]);
    rt.next = async () => ({ ok: true, data: { bytes: cached } });
    host.handle({ type: 'call', id: 1, op: 'dispatch', route: 'data.export.vouchers', input: {} });
    await tick();
    assert.equal(posted[0].transfer?.length, 1);
    assert.equal(cached.byteLength, 3);
    const [r] = replies(posted);
    assert.deepEqual(r.ok && [...((r.value as { data: { bytes: Uint8Array } }).data.bytes)], [1, 2, 3]);
  });

  it('a value that cannot cross threads becomes an INTERNAL error reply (the call never hangs)', async () => {
    let first = true;
    const { rt, host, posted } = setup({
      failPost: (m) => {
        if (m.type === 'reply' && first) {
          first = false;
          return true;
        }
        return false;
      },
    });
    rt.next = async () => ({ ok: true, data: { fn: () => 1 } as unknown });
    host.handle({ type: 'call', id: 2, op: 'dispatch', route: 'x.y.z', input: {} });
    await tick();
    const [r] = replies(posted);
    assert.equal(r.id, 2);
    assert.equal(r.ok && (r.value as ApiResult<unknown>).ok, false);
    assert.ok(rt.logs.some((l) => l.level === 'error'));
  });

  it('a dispatcher that throws or rejects yields an ok:false reply', async () => {
    const { rt, host, posted } = setup();
    rt.next = () => Promise.reject(new Error('bug'));
    host.handle({ type: 'call', id: 3, op: 'dispatch', route: 'x.y.z', input: {} });
    await tick();
    const [r] = replies(posted);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.message, 'bug');
  });

  it('mirrors dialog choices: folders authorise the data folder and paths inside; files are read-only', () => {
    const pre = path.resolve('/media/usb/Backups');
    const { host, auth } = setup({ choices: [{ kind: 'folder', path: pre }] });
    const a = auth();
    assert.equal(a.authorizeDataDir(pre), true, 'choices made before the worker started count');
    const folder = path.resolve('/home/u/NewData');
    assert.equal(a.authorizeDataDir(folder), false);
    host.handle({ type: 'authorize-choice', kind: 'folder', path: folder });
    assert.equal(a.authorizeDataDir(folder), true);
    assert.equal(a.authorizePath(path.join(folder, 'x.pvqbak'), 'write-dir'), true);
    const file = path.resolve('/home/u/Downloads/a.pvqbak');
    host.handle({ type: 'authorize-choice', kind: 'file', path: file });
    assert.equal(a.authorizePath(file, 'read-file'), true);
    assert.equal(a.authorizePath(file, 'write-dir'), false);
    assert.equal(a.authorizeDataDir(path.dirname(file)), false);
  });

  it('shutdown closes the runtime, replies, and later calls are refused as "closing"', async () => {
    const { rt, host, posted } = setup();
    host.handle({ type: 'call', id: 1, op: 'shutdown' });
    await tick();
    assert.equal(rt.shutdowns, 1);
    host.handle({ type: 'call', id: 2, op: 'dispatch', route: 'app.state', input: {} });
    await tick();
    const [stop, refused] = replies(posted);
    assert.equal(stop.id, 1);
    assert.equal(stop.ok, true);
    assert.equal(refused.ok && (refused.value as ApiResult<unknown>).ok, false);
    assert.equal(rt.calls.length, 0);
  });

  it('a shutdown that throws synchronously is still answered at once (main never waits out its bound)', async () => {
    const { rt, host, posted } = setup();
    rt.shutdown = () => {
      throw new Error('close failed');
    };
    host.handle({ type: 'call', id: 7, op: 'shutdown' });
    await tick();
    const [stop] = replies(posted);
    assert.equal(stop.id, 7);
    assert.equal(stop.ok, false);
    assert.equal(!stop.ok && stop.error.message, 'close failed');
  });

  it('applies theme and log messages, ignores malformed ones', () => {
    const { rt, host, posted } = setup();
    host.handle({ type: 'set-theme', mode: 'dark' });
    assert.equal(rt.theme, 'dark');
    host.handle({ type: 'log', level: 'warn', message: 'from main', meta: { a: 1 } });
    assert.deepEqual(rt.logs.at(-1), { level: 'warn', message: 'from main', meta: { a: 1 } });
    host.handle({ type: 'call', id: -1, op: 'dispatch' });
    host.handle('garbage');
    assert.equal(posted.length, 0);
    assert.equal(rt.calls.length, 0);
  });

  it('forwards faults to main', () => {
    const { host, posted } = setup();
    host.fault('Uncaught exception in the core worker', new TypeError('x is undefined'));
    assert.equal(posted[0].message.type, 'fault');
  });
});
