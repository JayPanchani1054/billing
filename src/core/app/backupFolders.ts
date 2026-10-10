/**
 * Backup folders approved on THIS installation (follow-up to SECURITY.md §3.5).
 *
 *   <userDataDir>/backup-folders.json   { v: 1, approved: [{ companyGuid, folder, at }] }
 *
 * A company's F12 backup folder lives inside the company file, so it travels with a restored backup,
 * a company folder copied from another computer or a data folder shared between PCs. Automatic
 * backups (after every login and on close) would then copy the books to wherever that file says —
 * possibly a remote share. The folder is therefore written to only after the user picked it on this
 * installation (F12 › Backup, folder dialog), recorded here per company GUID. The file is never in the
 * data folder, a company file or a backup.
 *
 * A file that cannot be read right now is never overwritten (approvals are kept in memory only), and a
 * corrupt one is kept aside: in both cases folders simply need confirming again — the safe direction.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BackupFolderApprovals } from '../api/context.ts';
import { fileTimestamp, readJsonFile, writeJsonAtomic } from '../lib/fsutil.ts';
import type { Logger } from './logger.ts';

export const BACKUP_FOLDERS_FILE = 'backup-folders.json';
/** Oldest approvals are dropped beyond this (one per company and folder). */
export const MAX_APPROVED_FOLDERS = 500;

interface Approval {
  companyGuid: string;
  folder: string;
  at: string;
}

const isWindows = process.platform === 'win32';

/** Comparison key of a folder: resolved, without a trailing separator; case-insensitive on Windows. */
export function folderKey(folder: string): string {
  const resolved = path.resolve(folder);
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isApproval(v: unknown): v is Approval {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return typeof a.companyGuid === 'string' && a.companyGuid !== '' && typeof a.folder === 'string' && path.isAbsolute(a.folder) && typeof a.at === 'string';
}

export class FileBackupFolderApprovals implements BackupFolderApprovals {
  readonly file: string;
  private readonly log: Logger['log'];
  private list: Approval[] | null = null;
  /** The file exists but could not be read: approvals made now stay in memory only. */
  private unreadable = false;

  constructor(opts: { dir: string; log: Logger['log'] }) {
    this.file = path.join(opts.dir, BACKUP_FOLDERS_FILE);
    this.log = opts.log;
  }

  private all(): Approval[] {
    if (this.list && !this.unreadable) return this.list;
    const r = readJsonFile<{ approved?: unknown }>(this.file);
    const out: Approval[] = [];
    this.unreadable = r.status === 'unreadable';
    if (r.status === 'ok' && r.value && Array.isArray(r.value.approved)) {
      for (const a of r.value.approved) if (isApproval(a)) out.push({ companyGuid: a.companyGuid, folder: a.folder, at: a.at });
    } else if (r.status === 'corrupt') {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${fileTimestamp()}`);
      } catch {
        /* ignore */
      }
      this.log('warn', 'Approved backup folders file was unreadable; kept aside (folders must be confirmed again)');
    } else if (r.status === 'unreadable') {
      this.log('warn', 'Approved backup folders could not be read; automatic backups use the default folder for now');
    }
    // Keep approvals made in memory while the file was unreadable.
    if (this.list) for (const a of this.list) if (!out.some((b) => b.companyGuid === a.companyGuid && folderKey(b.folder) === folderKey(a.folder))) out.push(a);
    this.list = out;
    return out;
  }

  isApproved(companyGuid: string, folder: string): boolean {
    if (!companyGuid || !path.isAbsolute(folder)) return false;
    const k = folderKey(folder);
    return this.all().some((a) => a.companyGuid === companyGuid && folderKey(a.folder) === k);
  }

  approve(companyGuid: string, folder: string, now: Date): void {
    if (!companyGuid || !path.isAbsolute(folder)) return;
    const k = folderKey(folder);
    const rest = this.all().filter((a) => !(a.companyGuid === companyGuid && folderKey(a.folder) === k));
    const next = [...rest, { companyGuid, folder: path.resolve(folder), at: now.toISOString() }].slice(-MAX_APPROVED_FOLDERS);
    this.list = next;
    if (this.unreadable) {
      this.log('warn', 'Backup folder approval kept for this session only (backup-folders.json cannot be read)');
      return;
    }
    try {
      writeJsonAtomic(this.file, { v: 1, approved: next });
    } catch (err) {
      this.log('warn', 'Could not record the approved backup folder; it is approved for this session only', { error: err });
    }
  }
}

/** In-memory approvals (tests, headless tools). */
export class MemoryBackupFolderApprovals implements BackupFolderApprovals {
  private readonly keys = new Set<string>();
  isApproved(companyGuid: string, folder: string): boolean {
    return path.isAbsolute(folder) && this.keys.has(`${companyGuid}\n${folderKey(folder)}`);
  }
  approve(companyGuid: string, folder: string): void {
    if (path.isAbsolute(folder)) this.keys.add(`${companyGuid}\n${folderKey(folder)}`);
  }
}
