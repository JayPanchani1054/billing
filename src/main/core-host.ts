/**
 * Worker-side half of the core protocol (see core-protocol.ts): owns the core Runtime inside the
 * worker thread and answers main's messages. Pure — the worker_threads glue lives in core-worker.ts —
 * so every rule here is unit-tested with a fake runtime (core-host.test.ts).
 *
 * Ordering guarantee: messages are handled in arrival order. A synchronous route runs to completion
 * before the next message is looked at (exactly as it did on the main thread), so an
 * 'authorize-choice' sent before an 'app.dataDir.set' / backup call is always applied first.
 */
import type { ApiResult } from '../shared/api.ts';
import type { PathUse } from '../core/api/context.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { prepareTransfer, serializeError } from './core-protocol.ts';
import type { CoreSnapshot, FromWorker, ToWorker } from './core-protocol.ts';
import { isToWorker } from './core-protocol.ts';
import { PathSet } from './files.ts';
import { isUserChosenPath } from './user-choices.ts';
import type { ChosenSets, UserChoice } from './user-choices.ts';

/** The two path checks main used to pass to createRuntime(), answered from the worker's mirror. */
export interface ChoiceAuthorizers {
  authorizeDataDir(absPath: string): boolean;
  authorizePath(absPath: string, use: PathUse): boolean;
}

export interface CoreHostDeps {
  /** Build the runtime; the authorizers answer from the choices main has reported. */
  createRuntime(authorizers: ChoiceAuthorizers): Runtime;
  post(message: FromWorker, transfer?: ArrayBuffer[]): void;
  /** Files/folders already picked before the worker started. */
  choices?: readonly UserChoice[];
}

export interface CoreHost {
  handle(message: unknown): void;
  /** Report an uncaught exception / unhandled rejection to main (the worker keeps running). */
  fault(kind: string, err: unknown): void;
  /** The runtime, once started (null if start-up failed). */
  readonly runtime: Runtime | null;
}

const CLOSING: ApiResult<never> = {
  ok: false,
  error: { code: 'INTERNAL', message: 'Bahi ERP is closing. Open it again to continue.' },
};

const NOT_RETURNABLE: ApiResult<never> = {
  ok: false,
  error: { code: 'INTERNAL', message: 'The result could not be shown. Details have been written to the application log.' },
};

function isDataCloneError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DataCloneError';
}

export function startCoreHost(deps: CoreHostDeps): CoreHost {
  const sets: ChosenSets = { files: new PathSet(), folders: new PathSet() };
  const remember = (c: UserChoice): void => (c.kind === 'folder' ? sets.folders : sets.files).add(c.path);
  for (const c of deps.choices ?? []) remember(c);

  let runtime: Runtime | null = null;
  let stopping = false;

  try {
    runtime = deps.createRuntime({
      // Only folders picked in the native folder dialog may become the data folder.
      authorizeDataDir: (absPath) => sets.folders.has(absPath),
      // Backup files/folders: only what the user picked in a dialog this session (core/lib/paths.ts).
      authorizePath: (absPath, use) => isUserChosenPath(absPath, use, sets),
    });
  } catch (err) {
    deps.post({ type: 'startup-failed', error: serializeError(err) });
  }

  function snapshot(): CoreSnapshot | null {
    const rt = runtime;
    if (!rt) return null;
    try {
      return { dataDir: rt.app.dataDir, hasOpenCompany: rt.hasOpenCompany(), theme: rt.getTheme() };
    } catch {
      return null;
    }
  }

  function log(level: 'warn' | 'error', message: string, meta?: unknown): void {
    try {
      runtime?.app.log(level, message, meta);
    } catch {
      /* logging never takes the core down */
    }
  }

  function replyOk(id: number, value: unknown): void {
    const prepared = prepareTransfer(value, false);
    try {
      deps.post({ type: 'reply', id, ok: true, value: prepared.value, snapshot: snapshot() }, prepared.transfer);
    } catch (err) {
      if (!isDataCloneError(err)) throw err;
      // A handler returned something that cannot cross threads (a function, a class instance with
      // private state …). The contract says JSON-safe data only — report it instead of hanging the call.
      log('error', 'A route returned a value that cannot be sent to the window', { error: err });
      deps.post({ type: 'reply', id, ok: true, value: NOT_RETURNABLE, snapshot: snapshot() });
    }
  }

  function replyError(id: number, err: unknown): void {
    deps.post({ type: 'reply', id, ok: false, error: serializeError(err), snapshot: snapshot() });
  }

  const startupError = (): Error => new Error('The core runtime is not running');

  function handle(message: unknown): void {
    if (!isToWorker(message)) {
      log('warn', 'Core worker ignored a malformed message');
      return;
    }
    const msg: ToWorker = message;
    switch (msg.type) {
      case 'authorize-choice':
        remember({ kind: msg.kind, path: msg.path });
        return;
      case 'set-theme':
        runtime?.setTheme(msg.mode);
        return;
      case 'log':
        try {
          runtime?.app.log(msg.level, msg.message, msg.meta);
        } catch {
          /* ignore */
        }
        return;
      case 'call':
        break;
    }
    const call = msg;
    const rt = runtime;
    if (!rt) {
      replyError(call.id, startupError());
      return;
    }
    if (call.op === 'shutdown') {
      stopping = true;
      rt.shutdown().then(
        () => deps.post({ type: 'reply', id: call.id, ok: true, value: null, snapshot: snapshot() }),
        (err: unknown) => replyError(call.id, err),
      );
      return;
    }
    if (stopping) {
      replyOk(call.id, CLOSING);
      return;
    }
    let pending: Promise<ApiResult<unknown>>;
    try {
      pending = rt.dispatch(call.route, call.input);
    } catch (err) {
      replyError(call.id, err);
      return;
    }
    pending.then(
      (result) => replyOk(call.id, result),
      (err: unknown) => replyError(call.id, err),
    );
  }

  return {
    handle,
    fault(kind, err) {
      try {
        deps.post({ type: 'fault', kind, error: serializeError(err) });
      } catch {
        log('error', kind, { error: err });
      }
    },
    get runtime() {
      return runtime;
    },
  };
}

/** Send the 'ready' message (separate so the worker glue can attach listeners first). */
export function announceReady(host: CoreHost, post: (message: FromWorker) => void): boolean {
  const rt = host.runtime;
  if (!rt) return false;
  post({ type: 'ready', snapshot: { dataDir: rt.app.dataDir, hasOpenCompany: rt.hasOpenCompany(), theme: rt.getTheme() } });
  return true;
}
