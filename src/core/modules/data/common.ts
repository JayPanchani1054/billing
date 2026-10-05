/**
 * Small helpers shared by the data module's services.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Permission } from '../../../shared/constants.ts';
import type { AppCtx, CompanyCtx } from '../../api/context.ts';
import { AppError, forbidden, validation } from '../../lib/errors.ts';

const PERMISSION_TEXT: Partial<Record<Permission, string>> = {
  'data.export': 'export data',
  'data.import': 'import data',
  'data.backup': 'take backups',
  'data.restore': 'restore backups',
};

export function hasPermission(ctx: Pick<CompanyCtx, 'session'>, perm: Permission): boolean {
  return ctx.session.isOwner || ctx.session.permissions.has(perm);
}

export function requirePermission(ctx: Pick<CompanyCtx, 'session'>, perm: Permission): void {
  if (!hasPermission(ctx, perm)) throw forbidden(`You do not have permission to ${PERMISSION_TEXT[perm] ?? perm}. Ask the owner to grant "${perm}".`);
}

/** Windows-safe file name part: no reserved characters, no trailing dots/spaces, bounded length. */
export function safeFileNamePart(name: string, fallback = 'Company', max = 80): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/g, '')
    .trim();
  if (!cleaned || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned)) return fallback;
  return cleaned;
}

/** 'Trial Balance (Detailed)' → 'Trial-Balance-Detailed' (same rule as the renderer's exportFileName). */
export function fileSlug(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 80) || 'Report';
}

/** Local-time stamp for file names: 20261005-143005. */
export function localStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** An absolute path given by the renderer (chosen in a native dialog) — normalised, never relative. */
export function absolutePath(raw: string, field: string, what: string): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0') || !path.isAbsolute(raw.trim())) {
    throw validation([{ path: field, message: `Choose the ${what} with the Browse button (a full path is required)` }]);
  }
  return path.resolve(raw.trim());
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Refuse app-scope data routes while a company is open (they act on the company list). */
export function assertNoCompanyOpen(ctx: AppCtx, action: string): void {
  if (ctx.company) {
    throw new AppError('CONFLICT', `Close the company "${ctx.company.name}" first: ${action} is available on the Company Select screen.`);
  }
}

/** Yield to the event loop (keeps Electron's main process responsive during long jobs). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? singular : pluralForm}`;
}

/** Normalise a master name for case-insensitive lookups (SQLite NOCASE folds ASCII only). */
export function nameKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
