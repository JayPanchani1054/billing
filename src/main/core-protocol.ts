/**
 * Wire protocol between the Electron main thread (src/main/core-proxy.ts) and the core worker thread
 * (src/main/core-worker.ts → src/main/core-host.ts). Pure TypeScript with no Electron and no
 * worker_threads imports, so both ends and the unit tests share it.
 *
 *   main ──{ call dispatch | call shutdown | set-theme | log | authorize-choice }──▶ worker
 *   main ◀──{ ready | startup-failed | reply | fault }───────────────────────────── worker
 *
 * Every `call` carries a numeric id; the worker answers each with exactly one `reply` of the same id.
 * Replies also carry a CoreSnapshot (data folder, open company, theme), so main can answer the few
 * synchronous Runtime getters (app.dataDir, hasOpenCompany, getTheme) without a round trip.
 *
 * Messages travel by structured clone. Byte arrays are moved, not copied twice: see prepareTransfer().
 */
import type { LogLevel } from './log.ts';
import type { UserChoice } from './user-choices.ts';

export type ThemeMode = 'system' | 'light' | 'dark';

/** Facts main needs synchronously; refreshed with every reply. */
export interface CoreSnapshot {
  dataDir: string;
  hasOpenCompany: boolean;
  theme: ThemeMode;
}

/** An Error reduced to cloneable fields (stack only ever goes to the log file). */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/** Start-up parameters handed to the worker as `workerData`. */
export interface CoreWorkerInit {
  userDataDir: string;
  defaultDataDir: string;
  appVersion: string;
  logDir: string;
  consoleLog: boolean;
  /** Files/folders the user already picked in a native dialog (see 'authorize-choice'). */
  choices: UserChoice[];
}

// ───────────────────────────── main → worker ─────────────────────────────

export type CoreCall = { type: 'call'; id: number; op: 'dispatch'; route: string; input: unknown } | { type: 'call'; id: number; op: 'shutdown' };

export type ToWorker =
  | CoreCall
  /** Persist the UI theme (fire and forget; main caches the value). */
  | { type: 'set-theme'; mode: ThemeMode }
  /** A main-process log line for the shared rotating log file (the worker owns the file). */
  | { type: 'log'; level: LogLevel; message: string; meta?: unknown }
  /**
   * The user picked this file/folder in a native dialog (user-choices.ts): a folder may become the
   * data folder or a backup folder, a file may be read (e.g. a backup to restore).
   */
  | { type: 'authorize-choice'; kind: 'file' | 'folder'; path: string };

// ───────────────────────────── worker → main ─────────────────────────────

export type FromWorker =
  | { type: 'ready'; snapshot: CoreSnapshot }
  | { type: 'startup-failed'; error: SerializedError }
  | { type: 'reply'; id: number; ok: true; value: unknown; snapshot: CoreSnapshot | null }
  | { type: 'reply'; id: number; ok: false; error: SerializedError; snapshot: CoreSnapshot | null }
  /** Uncaught exception / unhandled rejection inside the worker (it keeps running). */
  | { type: 'fault'; kind: string; error: SerializedError };

// ───────────────────────────── guards ─────────────────────────────

const LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);
const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && THEMES.has(v);
}

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && LOG_LEVELS.has(v);
}

function isCallId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function isSnapshot(v: unknown): v is CoreSnapshot {
  return isRecord(v) && typeof v.dataDir === 'string' && typeof v.hasOpenCompany === 'boolean' && isThemeMode(v.theme);
}

function isSerializedError(v: unknown): v is SerializedError {
  return isRecord(v) && typeof v.name === 'string' && typeof v.message === 'string';
}

/** Shape check for messages arriving at the worker (main is trusted, but a typo must not crash the core). */
export function isToWorker(v: unknown): v is ToWorker {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case 'call':
      if (!isCallId(v.id)) return false;
      if (v.op === 'dispatch') return typeof v.route === 'string';
      return v.op === 'shutdown';
    case 'set-theme':
      return isThemeMode(v.mode);
    case 'log':
      return isLogLevel(v.level) && typeof v.message === 'string';
    case 'authorize-choice':
      return (v.kind === 'file' || v.kind === 'folder') && typeof v.path === 'string' && v.path.length > 0;
    default:
      return false;
  }
}

/** Shape check for messages arriving at main. */
export function isFromWorker(v: unknown): v is FromWorker {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case 'ready':
      return isSnapshot(v.snapshot);
    case 'startup-failed':
      return isSerializedError(v.error);
    case 'reply':
      if (!isCallId(v.id) || (v.snapshot !== null && !isSnapshot(v.snapshot))) return false;
      return v.ok === true ? 'value' in v : v.ok === false && isSerializedError(v.error);
    case 'fault':
      return typeof v.kind === 'string' && isSerializedError(v.error);
    default:
      return false;
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (typeof err.stack === 'string') out.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    return out;
  }
  return { name: 'NonError', message: String(err) };
}

// ───────────────────────────── transfer ─────────────────────────────

const MAX_DEPTH = 64;

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True when the view covers its whole (non-shared) ArrayBuffer, i.e. moving the buffer moves only these bytes. */
export function isStandaloneBytes(v: Uint8Array): boolean {
  return v.buffer instanceof ArrayBuffer && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength;
}

export interface PreparedMessage {
  value: unknown;
  transfer: ArrayBuffer[];
}

/**
 * Prepare a value for postMessage so every Uint8Array crosses the thread boundary exactly once and
 * carries only its own bytes:
 *
 *  - `owned: true` (main → worker, the IPC input belongs to this call alone): a standalone array's
 *    buffer is transferred as is (zero copy, the sender's view becomes detached);
 *  - `owned: false` (worker → main, a handler may return a view of a cached or pooled buffer): every
 *    array is copied once into a fresh buffer, which is then transferred. The original is never
 *    detached or mutated, and a view into a larger buffer (Node's 8 KB Buffer pool) never drags the
 *    unrelated bytes around it along (structured clone would serialise the whole backing buffer).
 *
 * Containers are copied on write: plain objects and arrays are rebuilt only along the paths that lead
 * to a byte array, so the caller's value is never modified. Other values pass through unchanged.
 */
export function prepareTransfer(value: unknown, owned: boolean): PreparedMessage {
  const transfer: ArrayBuffer[] = [];
  const moved = new Set<ArrayBuffer>();

  function visit(v: unknown, depth: number): unknown {
    if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
    if (v instanceof Uint8Array) {
      if (owned && isStandaloneBytes(v)) {
        const buf = v.buffer as ArrayBuffer;
        if (!moved.has(buf)) {
          moved.add(buf);
          transfer.push(buf);
        }
        return v;
      }
      const copy = new Uint8Array(v.byteLength);
      copy.set(v);
      transfer.push(copy.buffer);
      return copy;
    }
    if (Array.isArray(v)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        const next = visit(item, depth + 1);
        if (next !== item) {
          out ??= v.slice();
          out[i] = next;
        }
      }
      return out ?? v;
    }
    if (!isPlainObject(v)) return v;
    let out: Record<string, unknown> | null = null;
    const src = v as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const item = src[key];
      const next = visit(item, depth + 1);
      if (next !== item) {
        out ??= { ...src };
        out[key] = next;
      }
    }
    return out ?? v;
  }

  return { value: visit(value, 0), transfer };
}
