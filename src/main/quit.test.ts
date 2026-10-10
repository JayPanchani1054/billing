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

  describe('before-exit hooks (in-app updates install here)', () => {
    it('run once, in registration order, after the core stopped and before exit', async () => {
      const order: string[] = [];
      const h = harness(async () => {
        order.push('shutdown');
      });
      h.deps.exit = (code) => {
        order.push(`exit ${code}`);
        h.exits.push(code);
      };
      const q = createQuitController(h.deps);
      q.onBeforeExit(() => {
        order.push('a');
      });
      q.onBeforeExit(() => {
        order.push('b');
      });
      q.onWillQuit(event());
      await tick();
      assert.deepEqual(order, ['shutdown', 'a', 'b', 'exit 0']);
      // A late will-quit (e.g. the updater's own app.quit()) runs nothing again.
      q.onWillQuit(event());
      await tick();
      assert.deepEqual(order, ['shutdown', 'a', 'b', 'exit 0']);
    });

    it('a throwing or rejecting hook is logged and the process still exits; later hooks still run', async () => {
      const ran: string[] = [];
      const h = harness(async () => undefined);
      const q = createQuitController(h.deps);
      q.onBeforeExit(() => {
        throw new Error('installer missing');
      });
      q.onBeforeExit(() => Promise.reject(new Error('async boom')));
      q.onBeforeExit(() => {
        ran.push('last');
      });
      q.onWillQuit(event());
      await tick();
      await tick();
      assert.deepEqual(ran, ['last']);
      assert.deepEqual(h.exits, [0]);
      assert.equal(h.logs.filter((l) => l.includes('before-exit step failed')).length, 2);
    });

    it('waits for an async hook, but never longer than beforeExitMs', async () => {
      const h = harness(async () => undefined);
      const q = createQuitController(h.deps);
      q.onBeforeExit(() => new Promise<void>(() => undefined)); // never settles
      q.onWillQuit(event());
      await tick();
      assert.deepEqual(h.exits, [], 'still waiting for the hook');
      assert.equal(h.timers.size, 1, 'only the before-exit cap is pending (the quit deadline was cleared)');
      h.fire();
      assert.deepEqual(h.exits, [0]);

      const quick = harness(async () => undefined);
      const q2 = createQuitController(quick.deps);
      let settled = false;
      q2.onBeforeExit(async () => {
        settled = true;
      });
      q2.onWillQuit(event());
      await tick();
      await tick();
      assert.equal(settled, true);
      assert.deepEqual(quick.exits, [0]);
      assert.equal(quick.timers.size, 0, 'the cap timer is cleared');
    });

    it('hooks run on the deadline path too, and the late core result does not run them twice', async () => {
      let release!: () => void;
      const h = harness(() => new Promise<void>((resolve) => (release = resolve)));
      const q = createQuitController(h.deps);
      let runs = 0;
      q.onBeforeExit(() => {
        runs++;
      });
      q.onWillQuit(event());
      h.fire(); // deadline
      release();
      await tick();
      assert.equal(runs, 1);
      assert.deepEqual(h.exits, [0]);
    });

    it('will-quit while hooks run is prevented (exit stays ours); before-quit and hook registration are ignored then', async () => {
      const h = harness(async () => undefined);
      const q = createQuitController(h.deps);
      let late = 0;
      q.onBeforeExit(() => {
        // What electron-updater's quitAndInstall does: ask the app to quit again.
        q.onBeforeQuit();
        const e = event();
        q.onWillQuit(e);
        assert.equal(e.prevented, 1);
        assert.equal(q.phase, 'exiting');
        q.onBeforeExit(() => {
          late++;
        });
        return new Promise<void>((resolve) => setImmediate(resolve));
      });
      q.onWillQuit(event());
      await tick();
      await tick();
      await tick();
      assert.equal(late, 0);
      assert.deepEqual(h.exits, [0]);
      assert.equal(q.phase, 'exited');
    });

    it('unsubscribing removes only that hook', async () => {
      const h = harness(async () => undefined);
      const q = createQuitController(h.deps);
      const ran: string[] = [];
      const off = q.onBeforeExit(() => {
        ran.push('removed');
      });
      q.onBeforeExit(() => {
        ran.push('kept');
      });
      off();
      off();
      q.onWillQuit(event());
      await tick();
      assert.deepEqual(ran, ['kept']);
    });
  });
});
