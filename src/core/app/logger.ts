/**
 * Application log: append-only JSON lines at <logDir>/bahi.log with size-based rotation
 * (bahi.log → bahi.log.1 → … → bahi.log.<keep>). Never throws; never records secrets —
 * any key matching /password|secret|token/i is redacted recursively.
 *
 * Callers must not pass voucher payloads, GSTIN/PAN lists or other bulk business data as meta.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, meta?: unknown): void;
  /** Absolute path of the active log file, or null when logging to console only. */
  readonly file: string | null;
}

export interface LoggerOptions {
  /** Folder for bahi.log; omit for console-only logging. */
  dir?: string;
  /** Also write to the console (development). */
  console?: boolean;
  /** Rotate when the file would exceed this many bytes (default 5 MB). */
  maxBytes?: number;
  /** Rotated files to keep (default 3). */
  keep?: number;
  /** Minimum level written (default 'info'; 'debug' when console is on). */
  minLevel?: LogLevel;
  now?: () => Date;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /password|secret|token/i;

/** Recursively redact secret-looking keys and serialise Errors. Pure. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[…]';
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1);
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, opts.keep ?? 3);
  const now = opts.now ?? (() => new Date());
  const minLevel = LEVELS[opts.minLevel ?? (opts.console ? 'debug' : 'info')];
  let file: string | null = null;
  let size = 0;

  if (opts.dir) {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      file = path.join(opts.dir, 'bahi.log');
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
    } catch (err) {
      file = null;
      if (opts.console) console.error('[bahi] cannot create log folder', err);
    }
  }

  const rotate = (target: string): void => {
    try {
      fs.rmSync(`${target}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${target}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${target}.${i + 1}`);
      }
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.1`);
    } catch {
      /* rotation is best-effort */
    }
    size = 0;
  };

  return {
    get file() {
      return file;
    },
    log(level, message, meta) {
      if (LEVELS[level] < minLevel) return;
      const entry: Record<string, unknown> = { ts: now().toISOString(), level, msg: message };
      if (meta !== undefined) entry.meta = redact(meta);
      let line: string;
      try {
        line = `${JSON.stringify(entry)}\n`;
      } catch {
        line = `${JSON.stringify({ ts: entry.ts, level, msg: message, meta: '[unserialisable]' })}\n`;
      }
      if (opts.console) {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[bahi] ${level} ${message}`, meta === undefined ? '' : entry.meta);
      }
      if (!file) return;
      try {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate(file);
        fs.appendFileSync(file, line);
        size += bytes;
      } catch {
        /* never let logging break the app */
      }
    },
  };
}
