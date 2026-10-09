/**
 * Main-thread proxy for the core runtime, which runs on a worker thread (core-worker.ts). It
 * implements the same Runtime interface main used when the core ran in-process, so ipc.ts and
 * native.ts do not care where the core lives.
 *
 *   start()           spawn the worker, wait for 'ready' (bounded); rejects if the core cannot start
 *   dispatch()        { call dispatch } → reply, matched by request id; never throws, always an ApiResult
 *   app.dataDir       \
 *   hasOpenCompany()   } answered from the snapshot that arrives with every reply (no round trip)
 *   getTheme()        /
 *   setTheme()        cached + posted (fire and forget)
 *   app.log()         posted to the worker, which owns the rotating log file
 *   authorizeChoice() the user picked this file/folder in a native dialog → allowlist inside the worker
 *   shutdown()        { call shutdown } (bounded) → terminate (bounded); never rejects
 *
 * Failure handling:
 *   - A call that gets no reply within callTimeoutMs resolves to an INTERNAL error that says the work
 *     may still finish (a synchronous route cannot be interrupted; the worker is left running).
 *   - If the worker dies (crash, out-of-memory, native fault) every pending call resolves to a clear
 *     error, the worker is restarted (at most maxRestarts within restartWindowMs) with no company open,
 *     and onRestarted() lets main tell the window. Log lines written meanwhile are buffered and flushed
 *     into the new worker, so the crash itself ends up in the log file.
 *   - A restart that cannot start, or too many crashes, leave the proxy 'failed': calls answer with an
 *     error asking the user to restart Bahi ERP.
 *
 * Pure (no Electron, no worker_threads): the worker and the timers are injected, so the whole
 * protocol is unit-tested with a fake worker (core-proxy.test.ts). nodeWorkerSpawner() is the real one.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ApiResult } from '../shared/api.ts';
import type { AppRuntime } from '../core/api/context.ts';
import { redact } from '../core/app/logger.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { isFromWorker, isThemeMode, prepareTransfer, serializeError } from './core-protocol.ts';
import type { CoreSnapshot, CoreWorkerInit, FromWorker, SerializedError, ThemeMode, ToWorker } from './core-protocol.ts';
import type { LogLevel } from './log.ts';
import type { UserChoice } from './user-choices.ts';

// ───────────────────────────── injectable worker + timers ─────────────────────────────

export interface CoreWorkerHandle {
  postMessage(message: ToWorker, transfer?: ArrayBuffer[]): void;
  /** Stop the thread; resolves once it has exited. */
  terminate(): Promise<unknown>;
}

export interface CoreWorkerEvents {
  message(message: unknown): void;
  /** The thread threw something it did not catch (it exits next). */
  error(err: unknown): void;
  /** A message from the worker could not be deserialised (the thread keeps running). */
  messageError(err: unknown): void;
  exit(code: number): void;
}

export type SpawnCoreWorker = (init: { choices: UserChoice[] }, events: CoreWorkerEvents) => CoreWorkerHandle;

export interface ProxyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** Real timers, unref'd: a pending timeout never keeps a process alive on its own. */
export const realTimers: ProxyTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

// ───────────────────────────── options ─────────────────────────────

export interface CoreProxyOptions {
  appVersion: string;
  spawn: SpawnCoreWorker;
  /** Logger for the proxy's own events. Main passes log.ts → it may come back through app.log. */
  log(level: LogLevel, message: string, meta?: unknown): void;
  /** Console fallback for log lines when no worker can take them. */
  consoleLog?(level: LogLevel, message: string, meta?: unknown): void;
  /** A crashed worker was replaced (no company is open any more). */
  onRestarted?(): void;
  /** The worker reported an uncaught exception / unhandled rejection (it keeps running). */
  onFault?(kind: string, error: SerializedError): void;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminateTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  timers?: ProxyTimers;
}

export interface CoreProxy extends Runtime {
  /** Spawn the worker and wait until the core has started. Rejects with the start-up error. */
  start(): Promise<void>;
  /** The user picked this file/folder in a native dialog (see user-choices.ts). */
  authorizeChoice(choice: UserChoice): void;
  /** 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' */
  readonly state: ProxyState;
}

export type ProxyState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export const CORE_DEFAULTS = {
  startupTimeoutMs: 30_000,
  /** Long enough for the slowest legitimate route (a 10k-voucher import took ~2 minutes in tests). */
  callTimeoutMs: 30 * 60_000,
  /** Core shutdown runs the F12 automatic backup (bounded at 20 s in core), then waits for in-flight work. */
  shutdownTimeoutMs: 30_000,
  terminateTimeoutMs: 3_000,
  maxRestarts: 3,
  restartWindowMs: 10 * 60_000,
} as const;

// ───────────────────────────── user-facing errors ─────────────────────────────

function internal(message: string): ApiResult<never> {
  return { ok: false, error: { code: 'INTERNAL', message } };
}

export const CORE_ERRORS = {
  restarted: internal(
    'The accounting engine stopped unexpectedly and has been restarted. Your last action may not have been saved — check it, then try again. Saved data is safe.',
  ),
  failed: internal('The accounting engine stopped and could not be restarted. Close Bahi ERP and open it again. Saved data is safe.'),
  closing: internal('Bahi ERP is closing. Open it again to continue.'),
  notStarted: internal('Bahi ERP is still starting. Try again in a moment.'),
  timeout: internal(
    'This is taking much longer than expected. It may still finish in the background — check the result before trying again.',
  ),
  broken: internal('An unexpected error occurred. Details have been written to the application log.'),
} as const;

type CallBody = { op: 'dispatch'; route: string; input: unknown } | { op: 'shutdown' };

type Outcome = { kind: 'reply'; message: Extract<FromWorker, { type: 'reply' }> } | { kind: 'lost'; result: ApiResult<never> } | { kind: 'timeout' };

interface Pending {
  settle(outcome: Outcome): void;
  timer: unknown;
}

interface LiveWorker {
  handle: CoreWorkerHandle;
  lastError: unknown;
  startupTimer: unknown;
}

const MAX_BUFFERED_LOGS = 200;
/** Round trips at least this long are logged ('Slow route'), so performance regressions show up. */
export const SLOW_CALL_MS = 500;

function defaultConsoleLog(level: LogLevel, message: string, meta?: unknown): void {
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) out(`[bahi:${level}] ${message}`);
  else out(`[bahi:${level}] ${message}`, meta);
}

export function createCoreProxy(options: CoreProxyOptions): CoreProxy {
  const timers = options.timers ?? realTimers;
  const cfg = {
    startupTimeoutMs: options.startupTimeoutMs ?? CORE_DEFAULTS.startupTimeoutMs,
    callTimeoutMs: options.callTimeoutMs ?? CORE_DEFAULTS.callTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? CORE_DEFAULTS.shutdownTimeoutMs,
    terminateTimeoutMs: options.terminateTimeoutMs ?? CORE_DEFAULTS.terminateTimeoutMs,
    maxRestarts: options.maxRestarts ?? CORE_DEFAULTS.maxRestarts,
    restartWindowMs: options.restartWindowMs ?? CORE_DEFAULTS.restartWindowMs,
  };
  const consoleLog = options.consoleLog ?? defaultConsoleLog;

  let state: ProxyState = 'idle';
  let current: LiveWorker | null = null;
  let snapshot: CoreSnapshot | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const choices: UserChoice[] = [];
  const restarts: number[] = [];
  const logBuffer: Array<{ level: LogLevel; message: string; meta?: unknown }> = [];
  let startWaiter: { resolve(): void; reject(err: Error): void } | null = null;
  let shutdownPromise: Promise<void> | null = null;

  // ───────────── logging ─────────────

  function postLog(w: LiveWorker, level: LogLevel, message: string, meta: unknown): void {
    const safeMeta = meta === undefined ? undefined : redact(meta);
    try {
      w.handle.postMessage(safeMeta === undefined ? { type: 'log', level, message } : { type: 'log', level, message, meta: safeMeta });
    } catch {
      try {
        w.handle.postMessage({ type: 'log', level, message, meta: String(safeMeta) });
      } catch {
        consoleLog(level, message, meta);
      }
    }
  }

  function appLog(level: LogLevel, message: string, meta?: unknown): void {
    if (current && (state === 'running' || state === 'stopping')) {
      postLog(current, level, message, meta);
    } else if (state === 'starting') {
      // Hold until the worker is ready (start-up or restart), so the line reaches the log file.
      if (logBuffer.length < MAX_BUFFERED_LOGS) logBuffer.push({ level, message, meta });
    } else {
      consoleLog(level, message, meta);
    }
  }

  function flushLogs(target: LiveWorker | null): void {
    const lines = logBuffer.splice(0);
    for (const l of lines) {
      if (target) postLog(target, l.level, l.message, l.meta);
      else consoleLog(l.level, l.message, l.meta);
    }
  }

  // ───────────── pending calls ─────────────

  function settleAll(result: ApiResult<never>): void {
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) {
      timers.clearTimeout(p.timer);
      p.settle({ kind: 'lost', result });
    }
  }

  function send(w: LiveWorker, body: CallBody, transfer: ArrayBuffer[], timeoutMs: number): Promise<Outcome> {
    const id = ++seq;
    return new Promise<Outcome>((resolve) => {
      const entry: Pending = {
        settle: resolve,
        timer: timers.setTimeout(() => {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          resolve({ kind: 'timeout' });
        }, timeoutMs),
      };
      pending.set(id, entry);
      try {
        w.handle.postMessage({ type: 'call', id, ...body }, transfer);
      } catch (err) {
        pending.delete(id);
        timers.clearTimeout(entry.timer);
        options.log('error', 'Could not send a request to the core worker', { error: err });
        resolve({ kind: 'lost', result: CORE_ERRORS.broken });
      }
    });
  }

  // ───────────── worker lifecycle ─────────────

  function canRestart(): boolean {
    const now = timers.now();
    while (restarts.length > 0 && now - restarts[0] > cfg.restartWindowMs) restarts.shift();
    return restarts.length < cfg.maxRestarts;
  }

  function errorOf(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    const s = reason as SerializedError | null;
    const e = new Error(s && typeof s.message === 'string' ? s.message : String(reason));
    if (s && typeof s.name === 'string') e.name = s.name;
    return e;
  }

  /** The worker is gone (exit, start-up failure or start-up timeout). */
  function lost(w: LiveWorker, reason: unknown, retry: boolean): void {
    if (current !== w) return;
    current = null;
    timers.clearTimeout(w.startupTimer);
    void w.handle.terminate().catch(() => undefined);

    if (state === 'stopping' || state === 'stopped') {
      settleAll(CORE_ERRORS.closing);
      return;
    }

    const initial = startWaiter;
    const restart = initial === null && retry && canRestart();
    settleAll(restart ? CORE_ERRORS.restarted : CORE_ERRORS.failed);
    if (!restart) flushLogs(null);
    // While restarting, log lines are buffered for the new worker so the crash reaches the log file.
    state = restart ? 'starting' : 'failed';
    options.log('error', 'The core worker stopped unexpectedly', { error: serializeError(reason), restarting: restart });

    if (initial) {
      startWaiter = null;
      initial.reject(errorOf(reason));
      return;
    }
    if (!restart) {
      options.log('error', 'The core worker could not be restarted; Bahi ERP must be restarted');
      return;
    }
    restarts.push(timers.now());
    spawnWorker();
  }

  function onMessage(w: LiveWorker, raw: unknown): void {
    if (current !== w) return;
    if (!isFromWorker(raw)) {
      options.log('warn', 'Ignored a malformed message from the core worker');
      return;
    }
    const msg = raw;
    switch (msg.type) {
      case 'ready': {
        timers.clearTimeout(w.startupTimer);
        snapshot = msg.snapshot;
        // Shutting down already: the shutdown call queued behind 'ready' finishes the job.
        if (state !== 'starting') return;
        state = 'running';
        flushLogs(w);
        const initial = startWaiter;
        if (initial) {
          startWaiter = null;
          initial.resolve();
        } else {
          options.log('warn', 'The core worker was restarted after a failure; no company is open');
          options.onRestarted?.();
        }
        return;
      }
      case 'startup-failed':
        lost(w, msg.error, false);
        return;
      case 'fault':
        options.onFault?.(msg.kind, msg.error);
        return;
      case 'reply': {
        if (msg.snapshot) snapshot = msg.snapshot;
        const p = pending.get(msg.id);
        if (!p) {
          options.log('warn', 'A core reply arrived after its request had timed out', { id: msg.id });
          return;
        }
        pending.delete(msg.id);
        timers.clearTimeout(p.timer);
        p.settle({ kind: 'reply', message: msg });
        return;
      }
    }
  }

  function spawnWorker(): void {
    state = 'starting';
    let live: LiveWorker | null = null;
    const events: CoreWorkerEvents = {
      message: (m) => {
        if (live) onMessage(live, m);
      },
      error: (err) => {
        if (live) live.lastError = err;
      },
      messageError: (err) => {
        if (live && current === live) options.log('error', 'A message from the core worker could not be read', { error: err });
      },
      exit: (code) => {
        if (live) lost(live, live.lastError ?? new Error(`The core worker exited with code ${code}`), true);
      },
    };
    let handle: CoreWorkerHandle;
    try {
      handle = options.spawn({ choices: [...choices] }, events);
    } catch (err) {
      const w: LiveWorker = { handle: { postMessage: () => undefined, terminate: () => Promise.resolve() }, lastError: err, startupTimer: undefined };
      current = w;
      lost(w, err, false);
      return;
    }
    const w: LiveWorker = { handle, lastError: undefined, startupTimer: undefined };
    live = w;
    current = w;
    w.startupTimer = timers.setTimeout(() => {
      lost(w, new Error(`The core worker did not start within ${cfg.startupTimeoutMs} ms`), true);
    }, cfg.startupTimeoutMs);
  }

  // ───────────── Runtime surface ─────────────

  function unavailable(): ApiResult<never> {
    switch (state) {
      case 'stopping':
      case 'stopped':
        return CORE_ERRORS.closing;
      case 'failed':
        return CORE_ERRORS.failed;
      default:
        return CORE_ERRORS.notStarted;
    }
  }

  async function dispatch(route: string, input: unknown): Promise<ApiResult<unknown>> {
    const w = current;
    if (!w || (state !== 'running' && state !== 'starting')) return unavailable();
    const prepared = prepareTransfer(input, true);
    const startedAt = timers.now();
    const outcome = await send(w, { op: 'dispatch', route, input: prepared.value }, prepared.transfer, cfg.callTimeoutMs);
    const elapsed = timers.now() - startedAt;
    // Slow routes no longer freeze the window, so make them visible in the log instead.
    if (outcome.kind === 'reply' && elapsed >= SLOW_CALL_MS) options.log('info', 'Slow route', { route, ms: elapsed });
    switch (outcome.kind) {
      case 'lost':
        return outcome.result;
      case 'timeout':
        options.log('warn', `Route ${route} did not answer within ${Math.round(cfg.callTimeoutMs / 1000)} s`);
        return CORE_ERRORS.timeout;
      case 'reply': {
        const m = outcome.message;
        if (m.ok) return m.value as ApiResult<unknown>;
        options.log('error', `Route ${route} failed inside the core worker`, { error: m.error });
        return CORE_ERRORS.broken;
      }
    }
  }

  async function shutdownInternal(): Promise<void> {
    const prev = state;
    state = 'stopping';
    const w = current;
    if (w && (prev === 'running' || prev === 'starting')) {
      const outcome = await send(w, { op: 'shutdown' }, [], cfg.shutdownTimeoutMs);
      if (outcome.kind === 'timeout') options.log('warn', `The core did not stop within ${cfg.shutdownTimeoutMs} ms; stopping it now`);
      else if (outcome.kind === 'reply' && !outcome.message.ok) options.log('error', 'The core reported an error while stopping', { error: outcome.message.error });
    }
    if (current === w && w) {
      current = null;
      timers.clearTimeout(w.startupTimer);
      let timer: unknown;
      const bounded = new Promise<void>((resolve) => {
        timer = timers.setTimeout(resolve, cfg.terminateTimeoutMs);
      });
      await Promise.race([w.handle.terminate().then(() => undefined, () => undefined), bounded]);
      timers.clearTimeout(timer);
    }
    settleAll(CORE_ERRORS.closing);
    const waiter = startWaiter;
    startWaiter = null;
    waiter?.reject(new Error('Bahi ERP was closed while the core was starting'));
    state = 'stopped';
    flushLogs(null);
  }

  const app: AppRuntime = {
    get dataDir() {
      return snapshot?.dataDir ?? '';
    },
    appVersion: options.appVersion,
    log: appLog,
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== 'idle') return Promise.reject(new Error(`The core proxy cannot start from state '${state}'`));
      return new Promise<void>((resolve, reject) => {
        startWaiter = { resolve, reject };
        spawnWorker();
      });
    },
    dispatch,
    app,
    shutdown() {
      shutdownPromise ??= shutdownInternal().catch((err: unknown) => {
        state = 'stopped';
        consoleLog('error', 'Core shutdown failed', err);
      });
      return shutdownPromise;
    },
    hasOpenCompany: () => state === 'running' && snapshot?.hasOpenCompany === true,
    getTheme: () => snapshot?.theme ?? 'system',
    setTheme(mode: ThemeMode) {
      if (!isThemeMode(mode)) return;
      if (snapshot) snapshot = { ...snapshot, theme: mode };
      const w = current;
      if (w && (state === 'running' || state === 'starting')) {
        try {
          w.handle.postMessage({ type: 'set-theme', mode });
        } catch (err) {
          options.log('warn', 'Could not save the theme preference', { error: err });
        }
      }
    },
    authorizeChoice(choice: UserChoice) {
      if ((choice.kind !== 'file' && choice.kind !== 'folder') || typeof choice.path !== 'string' || !path.isAbsolute(choice.path)) return;
      const c: UserChoice = { kind: choice.kind, path: choice.path };
      choices.push(c); // replayed into a restarted worker
      const w = current;
      if (w && (state === 'running' || state === 'starting')) {
        try {
          w.handle.postMessage({ type: 'authorize-choice', kind: c.kind, path: c.path });
        } catch (err) {
          options.log('warn', 'Could not pass a chosen file or folder to the core', { error: err });
        }
      }
    },
  };
}

// ───────────────────────────── the real worker ─────────────────────────────

/**
 * Where the bundled worker script lives next to out/main/index.cjs. In a packaged app the main bundle
 * is inside app.asar, but a worker thread loads its script with plain file I/O, so the worker is
 * shipped unpacked (electron-builder.yml → asarUnpack) and loaded from app.asar.unpacked.
 */
export function workerScriptPath(mainDir: string): string {
  const file = path.join(mainDir, 'core-worker.cjs');
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** Spawner backed by node:worker_threads. */
export function nodeWorkerSpawner(scriptPath: string, base: Omit<CoreWorkerInit, 'choices'>): SpawnCoreWorker {
  return (init, events) => {
    const workerData: CoreWorkerInit = { ...base, choices: init.choices };
    const worker = new Worker(scriptPath, { workerData, name: 'bahi-core' });
    worker.on('message', (m: unknown) => events.message(m));
    worker.on('messageerror', (err: unknown) => events.messageError(err));
    worker.on('error', (err: unknown) => events.error(err));
    worker.on('exit', (code: number) => events.exit(code));
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
    };
  };
}
