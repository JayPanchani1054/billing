/**
 * The quit sequence, as a small state machine with no Electron imports (unit-tested in quit.test.ts):
 *
 *   app.quit()  ─▶ 'before-quit' (logged once)
 *               ─▶ every window closes (the unsaved-work prompt may cancel this: nothing else happens)
 *               ─▶ 'will-quit'  → preventDefault ONCE, shut the core down (bounded by deadlineMs)
 *               ─▶ onBeforeExit hooks, once, in registration order (the in-app updater starts its
 *                  installer here); a throwing or rejecting hook is logged and the exit still happens;
 *                  async hooks are waited for at most beforeExitMs
 *               ─▶ app.exit(code)  (never app.quit() again: no second will-quit, no re-entrancy)
 *
 * The core is only shut down once all windows are gone, so "Keep working" in the unsaved-work prompt
 * never leaves a window without its company. A hard deadline guarantees the process ends even if the
 * shutdown promise never settles, and every timer is cleared on the way out.
 */
import type { LogLevel } from './log.ts';

export type QuitPhase = 'running' | 'quitting' | 'shutting-down' | 'exiting' | 'exited';

/** Runs once, right before the process exits (after the core shut down or the deadline passed). */
export type BeforeExitHook = () => void | Promise<void>;

export interface QuitControllerDeps {
  /** Close the core cleanly (bounded internally as well). Must not reject, but rejections are handled. */
  shutdown(): Promise<void>;
  /** Terminate the process now (Electron: app.exit). */
  exit(code: number): void;
  log(level: LogLevel, message: string, meta?: unknown): void;
  /** Longest wait between 'will-quit' and exit. */
  deadlineMs: number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Longest wait for asynchronous onBeforeExit hooks (default BEFORE_EXIT_MS). */
  beforeExitMs?: number;
}

export interface QuitEvent {
  preventDefault(): void;
}

export interface QuitController {
  readonly phase: QuitPhase;
  onBeforeQuit(): void;
  onWillQuit(event: QuitEvent): void;
  /** Exit code used when the process finally exits (default 0; the smoke test sets 1 on failure). */
  setExitCode(code: number): void;
  /**
   * Register a hook that runs once at the final step, before `deps.exit` (e.g. start the downloaded
   * update's installer). Returns an unsubscribe function. Hooks registered while exiting are ignored.
   */
  onBeforeExit(hook: BeforeExitHook): () => void;
}

/** Default hard deadline: core shutdown (30 s, includes the automatic backup) + termination (3 s) + margin. */
export const QUIT_DEADLINE_MS = 40_000;
/** Longest wait for asynchronous before-exit hooks. */
export const BEFORE_EXIT_MS = 3_000;

export function createQuitController(deps: QuitControllerDeps): QuitController {
  let phase: QuitPhase = 'running';
  let exitCode = 0;
  let deadline: unknown;
  const hooks: BeforeExitHook[] = [];

  function exitNow(reason: string): void {
    if (phase === 'exited') return;
    phase = 'exited';
    deps.log(reason === 'deadline' ? 'warn' : 'info', `Quit: exiting (${reason})`, { exitCode });
    deps.exit(exitCode);
  }

  /** Run every before-exit hook once; exit when the synchronous ones are done or the async ones settle (bounded). */
  function finish(reason: string): void {
    // Re-entrancy guard: a second finish (deadline vs core stopped, a hook quitting the app) is ignored.
    if (phase === 'exiting' || phase === 'exited') return;
    phase = 'exiting';
    deps.clearTimeout(deadline);
    const pending: Promise<unknown>[] = [];
    for (const hook of hooks.splice(0)) {
      try {
        const r = hook();
        if (r && typeof (r as Promise<void>).then === 'function') {
          pending.push(
            (r as Promise<void>).then(undefined, (err: unknown) => {
              deps.log('error', 'Quit: a before-exit step failed', { error: err });
            }),
          );
        }
      } catch (err) {
        deps.log('error', 'Quit: a before-exit step failed', { error: err });
      }
    }
    if (pending.length === 0) {
      exitNow(reason);
      return;
    }
    const cap = deps.setTimeout(() => exitNow(reason), deps.beforeExitMs ?? BEFORE_EXIT_MS);
    void Promise.all(pending).then(() => {
      deps.clearTimeout(cap);
      exitNow(reason);
    });
  }

  return {
    get phase() {
      return phase;
    },
    onBeforeQuit() {
      if (phase !== 'running') return;
      phase = 'quitting';
      deps.log('info', 'Quit: requested, closing windows');
    },
    onWillQuit(event) {
      if (phase === 'exited') return;
      // Keep Electron from exiting before the core has closed the company (WAL checkpoint, lock) and
      // before the before-exit hooks are done (a hook may itself call app.quit()).
      event.preventDefault();
      if (phase === 'shutting-down' || phase === 'exiting') return;
      phase = 'shutting-down';
      deps.log('info', 'Quit: all windows closed, shutting down the core');
      deadline = deps.setTimeout(() => finish('deadline'), deps.deadlineMs);
      let pending: Promise<void>;
      try {
        pending = deps.shutdown();
      } catch (err) {
        pending = Promise.reject(err);
      }
      pending.then(
        () => finish('core stopped'),
        (err: unknown) => {
          deps.log('error', 'Quit: core shutdown failed', { error: err });
          finish('core shutdown failed');
        },
      );
    },
    setExitCode(code) {
      exitCode = Number.isInteger(code) ? code : 1;
    },
    onBeforeExit(hook) {
      if (phase === 'exiting' || phase === 'exited' || typeof hook !== 'function') return () => undefined;
      hooks.push(hook);
      return () => {
        const i = hooks.indexOf(hook);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
  };
}
