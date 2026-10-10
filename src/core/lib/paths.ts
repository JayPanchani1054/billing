/**
 * Authorisation of file-system paths that come from the renderer (ARCHITECTURE §8, SECURITY.md §3.5).
 *
 * The renderer is untrusted: a path it sends may be read or written only when
 *   1. it lies inside the data folder (company folders, <data>/backups/…), or
 *   2. it lies inside a `trusted` root the caller vouches for (e.g. the company's configured backup
 *      folder, itself authorised when it was saved), or
 *   3. Electron main approves it (AppRuntime.authorizePath: files and folders the user picked in a
 *      native dialog during this session).
 * UNC and device paths (\\server\share, \\?\…, \\.\…, //server/share) are refused unless (1)–(3)
 * explicitly cover them: reaching a remote share leaks the Windows user's NTLM hash and could ship
 * the books off the machine. Without an authorizer (tests, headless use) ordinary local paths pass.
 */
import path from 'node:path';
import type { AppRuntime, PathUse } from '../api/context.ts';
import { AppError, validation } from './errors.ts';

/** True for UNC (\\server\share, //server/share) and Win32 device/namespace paths (\\?\, \\.\). */
export function isUncOrDevicePath(raw: string): boolean {
  return /^[\\/]{2}/.test(raw.trim());
}

const isWindows = process.platform === 'win32';
const key = (p: string): string => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));

/** `candidate` equals `root` or lies inside it (after normalisation; case-insensitive on Windows). */
export function isWithin(root: string, candidate: string): boolean {
  const r = key(root);
  const c = key(candidate);
  if (r === c) return true;
  const rel = path.relative(r, c);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface AuthorizePathOptions {
  /** Input field for VALIDATION issues ('folder', 'path', …). */
  field: string;
  /** What the path is, for messages: 'backup folder', 'backup file'. */
  what: string;
  /** Extra roots the caller trusts (null/undefined entries are ignored). */
  trusted?: ReadonlyArray<string | null | undefined>;
}

/**
 * Validate and authorise a renderer-supplied absolute path. Returns the normalised path; throws
 * VALIDATION for a malformed path and FORBIDDEN for one the user did not choose.
 */
export function authorizeUserPath(app: Pick<AppRuntime, 'dataDir' | 'authorizePath' | 'log'>, raw: string, use: PathUse, opts: AuthorizePathOptions): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text.includes('\0') || !path.isAbsolute(text)) {
    throw validation([{ path: opts.field, message: `Choose the ${opts.what} with the Browse button (a full path is required)` }]);
  }
  const resolved = path.resolve(text);
  const roots = [app.dataDir, ...(opts.trusted ?? [])].filter((r): r is string => typeof r === 'string' && r !== '' && path.isAbsolute(r));
  if (roots.some((r) => isWithin(r, resolved))) return resolved;
  if (app.authorizePath) {
    if (app.authorizePath(resolved, use)) return resolved;
  } else if (!isUncOrDevicePath(text)) {
    return resolved;
  }
  app.log('warn', 'Refused a path the user did not choose', { use, unc: isUncOrDevicePath(text) });
  throw new AppError('FORBIDDEN', `Choose the ${opts.what} with the Browse button.`);
}

/**
 * Is `folder` (a company's F12 backup folder) approved for that company on this installation
 * (AppRuntime.backupFolders)? Without an approvals store (tests, headless use) every folder counts.
 */
export function isBackupFolderApproved(app: Pick<AppRuntime, 'backupFolders'>, companyGuid: string | null | undefined, folder: string): boolean {
  if (!app.backupFolders) return true;
  return typeof companyGuid === 'string' && companyGuid !== '' && app.backupFolders.isApproved(companyGuid, folder);
}
