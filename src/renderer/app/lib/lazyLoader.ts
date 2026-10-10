/**
 * Load-once helpers behind `lazyScreen()` (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a). Pure — no
 * React, no DOM — so the node unit test (app/lazyScreen.test.ts) drives them.
 *
 *   const loader = createLazyLoader(() => import('./BrsScreen.tsx').then((m) => m.BrsScreen));
 *   loader.load();   // starts the import once; every later call returns the same promise
 *   loader.peek();   // { status: 'idle' | 'loading' | 'loaded' | 'failed', … }
 *
 * A failed load is remembered (rendering again shows the same error instead of retrying in a loop)
 * until `retryFailedLoads()` — the screen error boundary's "Try again" — puts it back to idle.
 */

export type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading'; promise: Promise<T> }
  | { status: 'loaded'; promise: Promise<T>; value: T }
  | { status: 'failed'; promise: Promise<T>; error: unknown };

export interface LazyLoader<T> {
  /** Start the load (once) and return its promise; the same promise until a failure is retried. */
  load(): Promise<T>;
  /** Where the load is now (never starts it). */
  peek(): LoadState<T>;
  /** A failed load goes back to idle so the next `load()` tries again. True when it was failed. */
  reset(): boolean;
}

/** Every loader created, so one "Try again" can re-arm all failed loads. */
const loaders = new Set<LazyLoader<unknown>>();

export function createLazyLoader<T>(load: () => Promise<T>): LazyLoader<T> {
  let state: LoadState<T> = { status: 'idle' };
  const loader: LazyLoader<T> = {
    load() {
      if (state.status !== 'idle') return state.promise;
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(load());
      } catch (error) {
        promise = Promise.reject(error);
      }
      const started: LoadState<T> = { status: 'loading', promise };
      state = started;
      // This handler also marks the rejection as handled: a failed prefetch nobody awaits must not
      // surface as an unhandled rejection (the screen reports the error when it is opened).
      promise.then(
        (value) => {
          if (state === started) state = { status: 'loaded', promise, value };
        },
        (error: unknown) => {
          if (state === started) state = { status: 'failed', promise, error };
        },
      );
      return promise;
    },
    peek: () => state,
    reset() {
      if (state.status !== 'failed') return false;
      state = { status: 'idle' };
      return true;
    },
  };
  loaders.add(loader as LazyLoader<unknown>);
  return loader;
}

/** Re-arm every failed load (a screen's "Try again"). Returns how many were reset. */
export function retryFailedLoads(): number {
  let n = 0;
  for (const l of loaders) if (l.reset()) n++;
  return n;
}

/** Schedules `run` when the renderer is idle; returns a cancel function. */
export type IdleScheduler = (run: () => void) => () => void;

/**
 * Run `tasks` one after another, each in its own idle slot (one chunk evaluated per slot, so a
 * prefetch never competes with what the user is doing). A failing task is skipped. Returns a cancel
 * function: tasks not started yet never start.
 */
export function runWhenIdle(tasks: ReadonlyArray<() => Promise<unknown>>, schedule: IdleScheduler): () => void {
  let cancelled = false;
  let cancelSlot: () => void = () => undefined;
  const next = (i: number): void => {
    if (cancelled || i >= tasks.length) return;
    cancelSlot = schedule(() => {
      if (cancelled) return;
      let p: Promise<unknown>;
      try {
        p = Promise.resolve(tasks[i]());
      } catch (error) {
        p = Promise.reject(error);
      }
      p.then(
        () => next(i + 1),
        () => next(i + 1),
      );
    });
  };
  next(0);
  return () => {
    cancelled = true;
    cancelSlot();
  };
}

/** Longest wait for an idle slot before a prefetch step runs anyway (ms). */
export const PREFETCH_IDLE_TIMEOUT_MS = 2_000;

/** The browser's requestIdleCallback (setTimeout where it is missing) as an IdleScheduler. */
export function browserIdleScheduler(g: typeof globalThis = globalThis): IdleScheduler {
  const ric = (g as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (g as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof ric === 'function' && typeof cic === 'function') {
    return (run) => {
      const id = ric.call(g, run, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
      return () => cic.call(g, id);
    };
  }
  return (run) => {
    const id = setTimeout(run, 50);
    return () => clearTimeout(id);
  };
}
