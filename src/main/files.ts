/**
 * File-system helpers for the main process: atomic writes, safe default file names and
 * path-containment checks. Pure node:* — no Electron imports, so they are easy to reason about.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Write `data` to `target` atomically: write a sibling temp file, fsync it, then rename over the
 * target. A crash mid-write never leaves a truncated file behind.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, target);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Synchronous variant for shutdown paths (window state on close). */
export function writeFileAtomicSync(target: string, data: string): void {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Read and JSON-parse a small settings file; returns null when missing or corrupt. */
export function readJsonFile(file: string, maxBytes = 64 * 1024): unknown {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Windows device names (CON, PRN, AUX, NUL, COM0–9, LPT0–9 incl. the superscript digits, CONIN$ /
 * CONOUT$). Windows treats a name as the device when the part before the first dot, with trailing
 * spaces and dots removed, is one of them: 'CON.pdf', 'con .pdf' and 'NUL..txt' are all devices.
 */
const WINDOWS_DEVICE_STEM = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
const isWindowsDeviceName = (name: string): boolean => WINDOWS_DEVICE_STEM.test(name.split('.')[0].replace(/[ .]+$/, ''));

/**
 * Turn a renderer-suggested name into a safe default file name for a save dialog: no directory
 * components, no characters Windows forbids, no reserved device names, bounded length.
 */
export function sanitizeFileName(name: string, fallback = 'export'): string {
  const base = name.replace(/[\\/]+/g, ' ').trim();
  let cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (cleaned.length > 180) {
    const ext = path.extname(cleaned).slice(0, 12);
    cleaned = cleaned.slice(0, 180 - ext.length).trim() + ext;
  }
  if (!cleaned || cleaned === '.' || cleaned === '..' || isWindowsDeviceName(cleaned)) return fallback;
  return cleaned;
}

/** Case-insensitive on Windows (NTFS default), case-sensitive elsewhere. */
function samePathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** True when `candidate` is `root` itself or lies underneath it (after normalisation). */
export function isPathInside(root: string, candidate: string): boolean {
  const r = samePathKey(path.resolve(root));
  const c = samePathKey(path.resolve(candidate));
  if (r === c) return true;
  const rel = path.relative(r, c);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Set of absolute paths with platform-appropriate case handling. */
export class PathSet {
  private readonly keys = new Set<string>();

  add(p: string): void {
    this.keys.add(samePathKey(path.resolve(p)));
  }

  has(p: string): boolean {
    return this.keys.has(samePathKey(path.resolve(p)));
  }

  /** True when `p` equals, or lies inside, any remembered path. */
  covers(p: string): boolean {
    const key = samePathKey(path.resolve(p));
    if (this.keys.has(key)) return true;
    for (const k of this.keys) if (isPathInside(k, key)) return true;
    return false;
  }
}
