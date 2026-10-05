/**
 * Copy or move the contents of one data folder to another (Settings › Data folder).
 *
 * Safety rules:
 *  - No company may be open anywhere (checked by the caller for this process, here via lock files).
 *  - Destination must not already contain a company with the same folder id.
 *  - Every copied company.db is opened and integrity-checked before anything at the source is removed.
 *  - On any failure, everything copied so far is removed again and the source is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { ensureDir, exists, readJsonFile, writeJsonAtomic } from '../lib/fsutil.ts';
import { COMPANY_DB_FILE, CompanyStore } from './companies.ts';
import { LOCK_FILE, lockHolder } from './lock.ts';
import type { Logger } from './logger.ts';
import type { Clock } from '../api/context.ts';

export interface TransferOptions {
  from: CompanyStore;
  to: string;
  mode: 'copy' | 'move';
  clock: Clock;
  log: Logger['log'];
}

export interface TransferResult {
  companies: string[];
}

/** Open a copied database and run SQLite's quick integrity check. Returns an error message or null. */
function verifyCompanyDb(dbPath: string): string | null {
  let db: Db | null = null;
  try {
    db = new Db(dbPath, { readOnly: true });
    const check = db.value<string>('PRAGMA quick_check');
    if (check !== 'ok') return `integrity check failed (${String(check)})`;
    if (db.value('SELECT name FROM company WHERE id = 1') === undefined) return 'company record missing';
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function mergeRegistry(fromFile: string, toFile: string): void {
  const src = readJsonFile<{ companies?: Record<string, unknown> }>(fromFile);
  if (src.status !== 'ok' || !src.value?.companies) return;
  const dst = readJsonFile<{ companies?: Record<string, unknown> }>(toFile);
  const merged = { version: 1, companies: { ...(dst.status === 'ok' ? (dst.value?.companies ?? {}) : {}), ...src.value.companies } };
  writeJsonAtomic(toFile, merged);
}

export function transferDataDir(opts: TransferOptions): TransferResult {
  const { from, mode, log } = opts;
  const to = path.resolve(opts.to);
  const ids = from.ids();
  const destCompanies = path.join(to, 'companies');

  // Pre-flight: nothing open elsewhere, no id collisions.
  for (const id of ids) {
    if (lockHolder(from.paths(id).dir, opts.clock.now()))
      throw new AppError('LOCKED', 'A company in the current data folder is open in another window. Close it first.');
    if (exists(path.join(destCompanies, id)))
      throw new AppError('CONFLICT', `The new folder already contains a company folder named "${id}". Choose an empty folder.`);
  }

  ensureDir(destCompanies);
  const copied: string[] = [];
  try {
    for (const id of ids) {
      const src = from.paths(id).dir;
      const dst = path.join(destCompanies, id);
      copied.push(dst);
      fs.cpSync(src, dst, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (p) => path.basename(p) !== LOCK_FILE,
      });
      const problem = verifyCompanyDb(path.join(dst, COMPANY_DB_FILE));
      if (problem) {
        let name = id;
        try {
          name = from.readMeta(id).name;
        } catch {
          /* keep id */
        }
        throw new AppError('CONFLICT', `Copy of "${name}" could not be verified (${problem}). The data folder was not changed.`);
      }
    }
    // Backups and trash are merged (existing files at the destination are kept).
    for (const sub of ['backups', 'trash']) {
      const src = path.join(from.dataDir, sub);
      if (exists(src)) fs.cpSync(src, path.join(to, sub), { recursive: true, force: false, errorOnExist: false });
    }
    mergeRegistry(path.join(from.dataDir, 'registry.json'), path.join(to, 'registry.json'));
  } catch (err) {
    for (const dst of copied) fs.rmSync(dst, { recursive: true, force: true });
    if (err instanceof AppError) throw err;
    log('error', 'Data folder copy failed', { error: err });
    throw new AppError('CONFLICT', `Copying the data failed: ${(err as Error).message}. The data folder was not changed.`);
  }

  if (mode === 'move') {
    // Verified copies exist; now remove the originals. Failures here leave a harmless duplicate.
    for (const id of ids) {
      try {
        fs.rmSync(from.paths(id).dir, { recursive: true, force: true });
      } catch (err) {
        log('warn', 'Could not remove old company folder after move', { id, error: err });
      }
    }
    for (const sub of ['backups', 'trash', 'registry.json']) {
      try {
        fs.rmSync(path.join(from.dataDir, sub), { recursive: true, force: true });
      } catch (err) {
        log('warn', 'Could not remove old data after move', { item: sub, error: err });
      }
    }
  }
  log('info', `Data folder ${mode === 'move' ? 'moved' : 'copied'}`, { companies: ids.length });
  return { companies: ids };
}
