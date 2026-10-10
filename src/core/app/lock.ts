/**
 * Company lock file (<companyDir>/company.lock) — prevents two app windows/instances (or two PCs
 * sharing a network data folder) from opening the same company DB at once.
 *
 * The file holds { pid, hostname, startedAt, heartbeatAt, appVersion }. An existing lock is honoured when
 *  - this process holds it; or
 *  - its heartbeat is recent (the holder rewrites it every LOCK_HEARTBEAT_MS) AND, for a lock from
 *    this computer, its pid is still alive. Requiring the heartbeat on this computer too matters on
 *    Windows, where pids are recycled quickly: after a crash the old pid often belongs to some other
 *    program, which must not keep the company "open in another window" forever.
 *  - the file exists but cannot be parsed and was modified recently (a holder mid-write).
 * Anything else is stale (crash, power cut) and is taken over. Heartbeats are written atomically
 * (temp + rename) so a reader never sees a half-written lock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/errors.ts';
import { randomBytes } from 'node:crypto';
import { isPidAlive, writeFileAtomic } from '../lib/fsutil.ts';

export const LOCK_FILE = 'company.lock';
/** Heartbeat interval used by the runtime while a company is open. */
export const LOCK_HEARTBEAT_MS = 5 * 60_000;
/** A lock from another host without a heartbeat for this long is considered stale. */
export const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;
/** Heartbeats further in the future than this (badly set clock on another PC) are not trusted. */
const MAX_CLOCK_SKEW_MS = 60 * 60_000;

export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  appVersion: string;
}

/** Locks held by this process (absolute lock paths). Guards against double-open within one process. */
const heldLocks = new Set<string>();

export interface CompanyLock {
  readonly file: string;
  /** Refresh heartbeatAt (called periodically while open). */
  heartbeat(now: Date): void;
  release(): void;
}

/** Raw lock file text; null when there is no lock file. Unreadable files read as '' (unparsable). */
function readLockText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : '';
  }
}

function parseLock(text: string | null): LockInfo | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.hostname !== 'string') return null;
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      startedAt: String(parsed.startedAt ?? ''),
      heartbeatAt: String(parsed.heartbeatAt ?? parsed.startedAt ?? ''),
      appVersion: String(parsed.appVersion ?? ''),
    };
  } catch {
    return null;
  }
}

const readLock = (file: string): LockInfo | null => parseLock(readLockText(file));

/** A lock file that exists but cannot be parsed: honoured while recently modified (holder mid-write). */
function unreadableLockHolder(file: string): LockInfo | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null; // gone
  }
  // File times come from the OS clock, so compare with the OS clock (not the injectable runtime clock).
  return Date.now() - mtimeMs < LOCK_STALE_MS ? { pid: 0, hostname: '', startedAt: '', heartbeatAt: '', appVersion: '' } : null;
}

/** Evaluate lock file content (already read) against the staleness rules. */
function holderFromText(file: string, text: string, now: Date): LockInfo | null {
  const info = parseLock(text);
  if (!info) return unreadableLockHolder(file);
  const beat = Date.parse(info.heartbeatAt);
  const age = now.getTime() - beat;
  const fresh = Number.isFinite(beat) && age < LOCK_STALE_MS && age > -MAX_CLOCK_SKEW_MS;
  if (!fresh) return null;
  if (info.hostname === os.hostname()) return info.pid !== process.pid && isPidAlive(info.pid) ? info : null;
  return info;
}

/** Why an existing lock blocks us, or null when it is stale/absent. */
export function lockHolder(dir: string, now: Date): LockInfo | null {
  const file = path.join(dir, LOCK_FILE);
  if (heldLocks.has(path.resolve(file))) {
    return readLock(file) ?? { pid: process.pid, hostname: os.hostname(), startedAt: '', heartbeatAt: '', appVersion: '' };
  }
  const text = readLockText(file);
  return text === null ? null : holderFromText(file, text, now);
}

/**
 * Remove a lock file judged stale — but only if it still has the content that was judged. The file is
 * first renamed aside (atomic: exactly one contender gets it); if the moved file turns out to be a
 * fresh lock another opener created in the meantime, it is put back and false is returned.
 * Exported for tests.
 */
export function removeStaleLock(file: string, staleText: string): boolean {
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // already gone
    throw err;
  }
  let moved: string | null = null;
  try {
    moved = fs.readFileSync(aside, 'utf8');
  } catch {
    /* treat as changed */
  }
  if (moved === staleText) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  // We grabbed someone else's fresh lock: restore it without clobbering an even newer one.
  try {
    fs.linkSync(aside, file);
  } catch {
    try {
      if (!fs.existsSync(file)) fs.renameSync(aside, file);
    } catch {
      /* best-effort */
    }
  }
  fs.rmSync(aside, { force: true });
  return false;
}

function lockedError(companyName: string, holder: LockInfo): AppError {
  const where =
    holder.hostname === os.hostname()
      ? 'in another Pevqori window'
      : holder.hostname
        ? `on computer "${holder.hostname}"`
        : 'elsewhere (it is being opened right now)';
  return new AppError('LOCKED', `"${companyName}" is open ${where}. Close it there first, then try again.`, {
    hostname: holder.hostname,
    since: holder.startedAt,
  });
}

export function acquireLock(dir: string, companyName: string, appVersion: string, now: Date): CompanyLock {
  const file = path.resolve(dir, LOCK_FILE);
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    appVersion,
  };
  // Evaluate → remove only the stale lock we evaluated → create exclusively ('wx'). Any interleaving
  // with another opener ends with exactly one holder; the others see its lock on the next round.
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    if (heldLocks.has(file)) throw lockedError(companyName, { ...info, hostname: os.hostname() }); // open in this process
    const text = readLockText(file);
    if (text !== null) {
      const holder = holderFromText(file, text, now);
      if (holder) throw lockedError(companyName, holder);
      if (!removeStaleLock(file, text)) continue;
    }
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  if (!acquired) throw new AppError('LOCKED', `"${companyName}" is being opened in another window. Try again in a moment.`);
  heldLocks.add(file);

  let released = false;
  return {
    file,
    heartbeat(at: Date) {
      if (released) return;
      try {
        writeFileAtomic(file, JSON.stringify({ ...info, heartbeatAt: at.toISOString() }));
      } catch {
        /* best-effort */
      }
    },
    release() {
      if (released) return;
      released = true;
      heldLocks.delete(file);
      const current = readLock(file);
      // Only remove the file if it is still ours.
      if (current && current.pid === info.pid && current.hostname === info.hostname && current.startedAt === info.startedAt) {
        fs.rmSync(file, { force: true });
      }
    },
  };
}
