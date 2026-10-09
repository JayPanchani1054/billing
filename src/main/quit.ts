/**
 * The quit sequence, as a small state machine with no Electron imports (unit-tested in quit.test.ts):
 *
 *   app.quit()  ─▶ 'before-quit' (logged once)
 *               ─▶ every window closes (the unsaved-work prompt may cancel this: nothing else happens)
 *               ─▶ 'will-quit'  → preventDefault ONCE, shut the core down (bounded by deadlineMs)
 *               ─▶ app.exit(code)  (never app.quit() again: no second will-quit, no re-entrancy)
 *
 * The core is only shut down once all windows are gone, so "Keep working" in the unsaved-work prompt
 * never leaves a window without its company. A hard deadline guarantees the process ends even if the
 * shutdown promise never settles, and every timer is cleared on the way out.
 */
import type { LogLevel } from './log.ts';

export type QuitPhase = 'running' | 'quitting' | 'shutting-down' | 'exited';

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
}

/** Default hard deadline: core shutdown (30 s, includes the automatic backup) + termination (3 s) + margin. */
export const QUIT_DEADLINE_MS = 40_000;

export function createQuitController(deps: QuitControllerDeps): QuitController {
  let phase: QuitPhase = 'running';
  let exitCode = 0;
  let deadline: unknown;

  function finish(reason: string): void {
    if (phase === 'exited') return;
    phase = 'exited';
    deps.clearTimeout(deadline);
    deps.log(reason === 'deadline' ? 'warn' : 'info', `Quit: exiting (${reason})`, { exitCode });
    deps.exit(exitCode);
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
      // Keep Electron from exiting before the core has closed the company (WAL checkpoint, lock).
      event.preventDefault();
      if (phase === 'shutting-down') return;
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
  };
}
