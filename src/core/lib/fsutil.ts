/**
 * Small, synchronous filesystem helpers used by the app runtime (config, registry, company folders).
 * All writes of small JSON state files go through writeFileAtomic so a crash or power cut can never
 * leave a half-written file behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const isWindows = process.platform === 'win32';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Block the current thread for `ms` (used only for short retry back-offs in synchronous code). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Errors Windows raises transiently while an antivirus/indexer/backup agent has the target open. */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** rename() that retries briefly on transient Windows sharing violations (≈ 0.5 s worst case). */
export function renameWithRetry(from: string, to: string, attempts = 6): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts || !TRANSIENT_RENAME_ERRORS.has(code)) throw err;
      sleepSync(15 * i);
    }
  }
}

/** Write via temp file + fsync + rename (atomic replace on NTFS and POSIX filesystems). */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  /** The file was read but is not valid JSON. */
  | { status: 'corrupt'; error: string }
  /** The file exists but could not be read (permissions, sharing violation, I/O error) — it may be fine. */
  | { status: 'unreadable'; error: string };

/** Read and parse a JSON file, distinguishing "missing", "corrupt" and "unreadable". */
export function readJsonFile<T = unknown>(file: string): JsonReadResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: (err as Error).message };
  }
  try {
    return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) as T };
  } catch (err) {
    return { status: 'corrupt', error: (err as Error).message };
  }
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Create the folder if needed and prove we can create + delete a file in it. Returns an error message or null. */
export function probeWritable(dir: string): string | null {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.bahi-write-test-${randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Total size in bytes of a file or folder tree (symlinks not followed). Missing → 0. */
export function sizeOf(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  let total = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return 0;
  }
  for (const e of entries) total += sizeOf(path.join(p, e));
  return total;
}

function normalizeForCompare(p: string): string {
  const r = path.resolve(p);
  return isWindows ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/** True when `child` is strictly inside `parent` (not equal). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Whether a process id is alive on this machine. EPERM means it exists but belongs to another user. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Filesystem-safe lowercase slug: 'Sharma & Sons Pvt. Ltd.' → 'sharma-sons-pvt-ltd'. */
export function slugify(name: string, maxLength = 40): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return s || 'company';
}

/** Timestamp safe for file names: 2026-10-05T12-30-45-123Z */
export function fileTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}
