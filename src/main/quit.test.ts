import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createQuitController } from './quit.ts';
import type { QuitControllerDeps } from './quit.ts';

interface Harness {
  deps: QuitControllerDeps;
  exits: number[];
  timers: Map<number, () => void>;
  logs: string[];
  fire(id?: number): void;
}

function harness(shutdown: () => Promise<void>): Harness {
  const exits: number[] = [];
  const timers = new Map<number, () => void>();
  const logs: string[] = [];
  let seq = 0;
  return {
    exits,
    timers,
    logs,
    fire(id) {
      const key = id ?? [...timers.keys()][0];
      const fn = timers.get(key);
      timers.delete(key);
      fn?.();
    },
    deps: {
      shutdown,
      exit: (code) => exits.push(code),
      log: (_level, message) => logs.push(message),
      deadlineMs: 15_000,
      setTimeout: (fn) => {
        const id = ++seq;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (h) => timers.delete(h as number),
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function event() {
  let prevented = 0;
  return {
    preventDefault: () => {
      prevented++;
    },
    get prevented() {
      return prevented;
    },
  };
}

describe('quit controller', () => {
  it('prevents the first will-quit, shuts the core down, then exits exactly once and clears its deadline', async () => {
    let shutdowns = 0;
    const h = harness(async () => {
      shutdowns++;
    });
    const q = createQuitController(h.deps);
    q.onBeforeQuit();
    assert.equal(q.phase, 'quitting');
    const e = event();
    q.onWillQuit(e);
    assert.equal(e.prevented, 1);
    assert.equal(q.phase, 'shutting-down');
    await tick();
    assert.equal(shutdowns, 1);
    assert.deepEqual(h.exits, [0]);
    assert.equal(q.phase, 'exited');
    assert.equal(h.timers.size, 0, 'no timer left behind');
    // A late will-quit after exit is not prevented again (would otherwise wedge the quit).
    const late = event();
    q.onWillQuit(late);
    assert.equal(late.prevented, 0);
    assert.deepEqual(h.exits, [0]);
  });

  it('a second will-quit while shutting down is prevented but starts nothing new', async () => {
    let shutdowns = 0;
    let release!: () => void;
    const h = harness(() => {
      shutdowns++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const q = createQuitController(h.deps);
    q.onWillQuit(event());
    const again = event();
    q.onWillQuit(again);
    assert.equal(again.prevented, 1);
    assert.equal(shutdowns, 1);
    release();
    await tick();
    assert.deepEqual(h.exits, [0]);
  });

  it('exits at the hard deadline when the shutdown never settles (the CI app.close() hang)', async () => {
    const h = harness(() => new Promise<void>(() => undefined));
    const q = createQuitController(h.deps);
    q.onWillQuit(event());
    await tick();
    assert.deepEqual(h.exits, []);
    h.fire();
    assert.deepEqual(h.exits, [0]);
    assert.ok(h.logs.some((l) => l.includes('deadline')));
  });

  it('still exits when the shutdown rejects or throws synchronously', async () => {
    const rejecting = harness(() => Promise.reject(new Error('boom')));
    createQuitController(rejecting.deps).onWillQuit(event());
    await tick();
    assert.deepEqual(rejecting.exits, [0]);

    const throwing = harness(() => {
      throw new Error('sync boom');
    });
    createQuitController(throwing.deps).onWillQuit(event());
    await tick();
    assert.deepEqual(throwing.exits, [0]);
  });

  it('uses the exit code set by the smoke test', async () => {
    const h = harness(async () => undefined);
    const q = createQuitController(h.deps);
    q.setExitCode(1);
    q.onWillQuit(event());
    await tick();
    assert.deepEqual(h.exits, [1]);
  });
});
