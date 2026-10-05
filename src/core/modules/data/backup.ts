/**
 * Backup, verification and restore of company data (.bahibak containers, see container.ts).
 *
 *  - createBackup: consistent snapshot of the live database → container in the backup folder →
 *    "keep last N" retention for this company's files only → backup_history row + 'backup' audit entry.
 *    The snapshot comes from a separate read-only connection through SQLite's online backup API in a
 *    single step (one read transaction, on Node's thread pool), so it is consistent and does not block
 *    the main process; in-memory databases (tests) use VACUUM INTO. Memory use is constant: the snapshot
 *    is streamed through gzip (and AES-GCM) in 64 KiB chunks. Disk use: one temporary copy of the
 *    database in the company folder plus the container being written.
 *  - verifyBackup: container header → payload checksum → (password) → decompression → database checksum
 *    → SQLite integrity_check on a temporary copy → schema version supported → company name.
 *  - restoreBackup: verify + extract to a temporary database, append a 'restore' entry to its edit log,
 *    then hand it to the app controller (installCompanyDatabase) as a new company or over a closed one.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { formatDate } from '../../../shared/dates.ts';
import {
  BACKUP_EXTENSION,
  type BackupAutoResult,
  type BackupCheck,
  type BackupCreateInput,
  type BackupCreateResult,
  type BackupFileInfo,
  type BackupListResult,
  type BackupManifest,
  type BackupRestoreInput,
  type BackupRestoreResult,
  type BackupVerifyResult,
} from '../../../shared/types/data.ts';
import type { AppRuntime, Clock, CompanyCtx, Session } from '../../api/context.ts';
import { COMPANY_DB_FILE, COMPANY_ID_RE } from '../../app/companies.ts';
import { controllerFor } from '../../app/controller.ts';
import { verifyOwnerCredentials } from '../../app/auth.ts';
import { Db } from '../../db/db.ts';
import { assertSupportedVersion, getSchemaVersion, SCHEMA_VERSION } from '../../db/migrate.ts';
import { BACKUP_HISTORY_DDL } from '../../db/migrations/120_data.ts';
import { appendAudit } from '../../lib/audit.ts';
import { randomToken } from '../../lib/crypto.ts';
import { AppError, notFound, validation } from '../../lib/errors.ts';
import { ensureDir, exists, probeWritable } from '../../lib/fsutil.ts';
import { getConfig } from '../company/service.ts';
import { absolutePath, localStamp, safeFileNamePart } from './common.ts';
import { BackupFileError, checkPayloadDigest, extractPayload, readContainerInfo, writeContainer, type ContainerInfo } from './container.ts';

export const BACKUP_PASSWORD_MIN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── Folders & history ─────────────────────────────

/** F12 backup folder, else <data folder>/backups/<company id>. */
export function defaultBackupFolder(ctx: Pick<CompanyCtx, 'db' | 'app' | 'company'>): string {
  const configured = getConfig(ctx.db).backup.folder;
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(ctx.app.dataDir, 'backups', ctx.company.id);
}

function resolveFolder(ctx: Pick<CompanyCtx, 'db' | 'app' | 'company'>, folder: string | undefined): string {
  return folder === undefined ? defaultBackupFolder(ctx) : absolutePath(folder, 'folder', 'backup folder');
}

function hasHistoryTable(db: Db): boolean {
  return db.value(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_history'`) !== undefined;
}

/** Most recent backup of this company (backup_history, falling back to the edit log). */
export function lastBackupAt(db: Db): string | null {
  if (hasHistoryTable(db)) {
    const last = db.value<string>('SELECT MAX(created_at) FROM backup_history');
    if (typeof last === 'string') return last;
  }
  const fromAudit = db.value<string>(`SELECT MAX(ts) FROM audit_log WHERE action = 'backup'`);
  return typeof fromAudit === 'string' ? fromAudit : null;
}

interface CompanyFacts {
  guid: string;
  name: string;
  gstin: string | null;
  booksFrom: string;
}

function companyFacts(db: Db): CompanyFacts {
  const r = db.get<{ guid: string; name: string; gstin: string | null; books_from: string }>('SELECT guid, name, gstin, books_from FROM company WHERE id = 1');
  if (!r) throw notFound('Company');
  return { guid: r.guid, name: r.name, gstin: r.gstin, booksFrom: r.books_from };
}

// ───────────────────────────── Create ─────────────────────────────

/** Consistent copy of the live database into `target` (rollback-journal mode, self-contained). */
async function snapshotDatabase(ctx: Pick<CompanyCtx, 'db' | 'company'>, target: string): Promise<void> {
  const live = ctx.company.dbPath;
  const backupFn = (sqlite as { backup?: typeof sqlite.backup }).backup;
  if (live !== ':memory:' && exists(live) && typeof backupFn === 'function') {
    const reader = new DatabaseSync(live, { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout = 10000');
      // rate -1: all pages in one step = one read transaction → a consistent snapshot even while the
      // main connection keeps writing (WAL readers never block writers).
      await backupFn(reader, target, { rate: -1 });
    } finally {
      reader.close();
    }
  } else {
    ctx.db.run('VACUUM INTO ?', [target]);
  }
  const snap = new DatabaseSync(target);
  try {
    snap.exec('PRAGMA journal_mode = DELETE');
  } finally {
    snap.close();
  }
}

function uniqueTarget(folder: string, base: string): string {
  let candidate = path.join(folder, `${base}${BACKUP_EXTENSION}`);
  for (let i = 2; exists(candidate); i++) candidate = path.join(folder, `${base}-${i}${BACKUP_EXTENSION}`);
  return candidate;
}

export async function createBackup(ctx: CompanyCtx, input: BackupCreateInput, kind: 'manual' | 'auto' = 'manual'): Promise<BackupCreateResult> {
  const password = input.password && input.password.length > 0 ? input.password : undefined;
  if (password !== undefined && password.length < BACKUP_PASSWORD_MIN) {
    throw validation([{ path: 'password', message: `The backup password must be at least ${BACKUP_PASSWORD_MIN} characters long` }]);
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 1000) : null;
  const folder = resolveFolder(ctx, input.folder);
  const problem = probeWritable(folder);
  if (problem) throw new AppError('BUSINESS_RULE', `Bahi ERP cannot write to the backup folder ${folder} (${problem}). Choose another folder or reconnect the drive.`);

  const facts = companyFacts(ctx.db);
  const now = ctx.clock.now();
  const createdAt = now.toISOString();
  const target = uniqueTarget(folder, `${safeFileNamePart(facts.name)}_${localStamp(now)}`);

  const workDir = ctx.company.dir;
  ensureDir(workDir);
  const snapshot = path.join(workDir, `.backup-${randomToken(6)}.db`);
  let written: { manifest: BackupManifest; sizeBytes: number };
  try {
    await snapshotDatabase(ctx, snapshot);
    written = await writeContainer({
      dbPath: snapshot,
      target,
      password,
      manifest: {
        appVersion: ctx.app.appVersion,
        schemaVersion: getSchemaVersion(ctx.db),
        companyId: ctx.company.id,
        companyGuid: facts.guid,
        companyName: facts.name,
        gstin: facts.gstin,
        booksFrom: facts.booksFrom,
        createdAt,
        createdBy: ctx.session.displayName || ctx.session.username || null,
        note,
        kind,
      },
    });
  } finally {
    await fsp.rm(snapshot, { force: true }).catch(() => undefined);
    await fsp.rm(`${snapshot}-journal`, { force: true }).catch(() => undefined);
  }

  const removed = applyRetention(ctx, folder, facts.guid, target);

  ctx.db.transaction(() => {
    if (!hasHistoryTable(ctx.db)) ctx.db.exec(BACKUP_HISTORY_DDL);
    ctx.db.run(
      `INSERT INTO backup_history (created_at, file_name, folder, size_bytes, encrypted, kind, payload_sha256, note, user_id, username)
       VALUES (:createdAt, :fileName, :folder, :size, :enc, :kind, :sha, :note, :userId, :username)`,
      {
        createdAt,
        fileName: path.basename(target),
        folder,
        size: written.sizeBytes,
        enc: Boolean(password),
        kind,
        sha: written.manifest.payloadSha256,
        note,
        userId: ctx.session.userId,
        username: ctx.session.username,
      },
    );
    ctx.audit({
      action: 'backup',
      entityType: 'company',
      entityId: 1,
      entityGuid: facts.guid,
      entityLabel: path.basename(target),
      after: { file: path.basename(target), folder, sizeBytes: written.sizeBytes, encrypted: Boolean(password), kind, note, removed: removed.length },
    });
  });
  ctx.app.log('info', 'Backup written', { company: ctx.company.id, file: path.basename(target), bytes: written.sizeBytes, kind });

  return { path: target, fileName: path.basename(target), folder, sizeBytes: written.sizeBytes, createdAt, encrypted: Boolean(password), removed };
}

/** "Keep last N": delete older backups of THIS company (same id and guid) in `folder`. */
function applyRetention(ctx: CompanyCtx, folder: string, companyGuid: string, keep: string): string[] {
  const keepLast = getConfig(ctx.db).backup.keepLast;
  if (!Number.isInteger(keepLast) || keepLast < 1) return [];
  const mine = scanFolder(folder)
    .filter((b) => b.manifest && b.manifest.companyId === ctx.company.id && b.manifest.companyGuid === companyGuid)
    .sort((a, b) => (b.manifest?.createdAt ?? '').localeCompare(a.manifest?.createdAt ?? '') || b.fileName.localeCompare(a.fileName));
  const removed: string[] = [];
  let kept = 0;
  for (const b of mine) {
    if (path.resolve(b.path) === path.resolve(keep) || kept < keepLast) {
      kept++;
      continue;
    }
    try {
      fs.rmSync(b.path, { force: true });
      removed.push(b.fileName);
    } catch (err) {
      ctx.app.log('warn', 'Could not remove an old backup', { file: b.fileName, error: err });
    }
  }
  return removed;
}

// ───────────────────────────── List / inspect ─────────────────────────────

/** Describe one backup file (manifest only; the payload is not read or decrypted). */
export function describeBackupFile(file: string, current?: { companyId: string; companyGuid: string }): BackupFileInfo {
  let sizeBytes = 0;
  let modifiedAt = '';
  try {
    const st = fs.statSync(file);
    sizeBytes = st.size;
    modifiedAt = st.mtime.toISOString();
  } catch {
    /* reported below */
  }
  let manifest: BackupManifest | null = null;
  let problem: string | null = null;
  try {
    manifest = readContainerInfo(file).manifest;
  } catch (err) {
    problem = err instanceof AppError ? err.message : 'The file cannot be read.';
  }
  return {
    path: file,
    fileName: path.basename(file),
    sizeBytes,
    modifiedAt,
    manifest,
    problem,
    isCurrentCompany: Boolean(manifest && current && manifest.companyId === current.companyId && manifest.companyGuid === current.companyGuid),
  };
}

function scanFolder(folder: string, current?: { companyId: string; companyGuid: string }): BackupFileInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const out: BackupFileInfo[] = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith(BACKUP_EXTENSION) || n.startsWith('.')) continue;
    const p = path.join(folder, n);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    out.push(describeBackupFile(p, current));
  }
  return out;
}

export function listBackups(ctx: CompanyCtx, folderInput: string | undefined): BackupListResult {
  const folder = resolveFolder(ctx, folderInput);
  const facts = companyFacts(ctx.db);
  const backups = scanFolder(folder, { companyId: ctx.company.id, companyGuid: facts.guid }).sort(
    (a, b) => (b.manifest?.createdAt ?? b.modifiedAt).localeCompare(a.manifest?.createdAt ?? a.modifiedAt) || a.fileName.localeCompare(b.fileName),
  );
  return { folder, backups, lastBackupAt: lastBackupAt(ctx.db) };
}

export function inspectBackupFile(rawPath: string): BackupFileInfo {
  const file = backupPath(rawPath);
  const info = describeBackupFile(file);
  if (!info.manifest) throw new AppError('VALIDATION', info.problem ?? 'This is not a Bahi ERP backup file.');
  return info;
}

function backupPath(raw: string): string {
  const file = absolutePath(raw, 'path', 'backup file');
  if (!file.toLowerCase().endsWith(BACKUP_EXTENSION)) {
    throw validation([{ path: 'path', message: `Choose a Bahi ERP backup file (*${BACKUP_EXTENSION})` }]);
  }
  if (!exists(file)) throw new AppError('NOT_FOUND', 'The backup file no longer exists. Choose it again.');
  return file;
}

// ───────────────────────────── Verify / extract ─────────────────────────────

interface ExtractedFacts {
  name: string | null;
  guid: string | null;
  schemaVersion: number;
  integrity: string[];
  counts: { ledgers: number; vouchers: number; stockItems: number } | null;
}

/** Read facts from an extracted database file (read-only). `full` runs integrity_check, else quick_check. */
function inspectDatabase(file: string, full: boolean): ExtractedFacts {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const pragma = full ? 'PRAGMA integrity_check(50)' : 'PRAGMA quick_check(50)';
    const integrity = db
      .prepare(pragma)
      .all()
      .map((r) => String(Object.values(r)[0]));
    const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    let name: string | null = null;
    let guid: string | null = null;
    let counts: ExtractedFacts['counts'] = null;
    try {
      const row = db.prepare('SELECT name, guid FROM company WHERE id = 1').get() as { name: string; guid: string } | undefined;
      name = row?.name ?? null;
      guid = row?.guid ?? null;
      const count = (table: string): number => Number((db as DatabaseSync).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
      counts = { ledgers: count('ledgers'), vouchers: count('vouchers'), stockItems: count('stock_items') };
    } catch {
      /* not a company database — reported by the caller */
    }
    return { name, guid, schemaVersion, integrity, counts };
  } catch {
    return { name: null, guid: null, schemaVersion: 0, integrity: ['The file is not a readable SQLite database'], counts: null };
  } finally {
    db?.close();
  }
}

async function withWorkDir<T>(dataDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  ensureDir(dataDir);
  const dir = path.join(dataDir, `.restore-${randomToken(6)}`);
  fs.mkdirSync(dir);
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function describeManifest(m: BackupManifest): string {
  const when = formatDate(m.createdAt.slice(0, 10));
  return `Backup of "${m.companyName}" made on ${when}${m.createdBy ? ` by ${m.createdBy}` : ''} (Bahi ERP ${m.appVersion})${m.encrypted ? ', password-protected' : ''}.`;
}

/** Full verification of a backup file. Never throws for problems with the file — they come back as checks. */
export async function verifyBackup(dataDir: string, rawPath: string, password: string | undefined): Promise<BackupVerifyResult> {
  const file = backupPath(rawPath);
  const checks: BackupCheck[] = [];
  const result = (manifest: BackupManifest | null, extra: Partial<BackupVerifyResult> = {}): BackupVerifyResult => ({
    ok: checks.length > 0 && checks.every((c) => c.ok === true),
    path: file,
    manifest,
    checks,
    needsPassword: false,
    companyName: manifest?.companyName ?? null,
    schemaVersion: manifest?.schemaVersion ?? null,
    supported: manifest ? manifest.schemaVersion <= SCHEMA_VERSION : false,
    counts: null,
    ...extra,
  });

  let info: ContainerInfo;
  try {
    info = readContainerInfo(file);
  } catch (err) {
    if (!(err instanceof AppError) || err.code === 'INTERNAL') throw err;
    checks.push({ name: 'container', ok: false, message: err.message });
    return result(null);
  }
  const m = info.manifest;
  checks.push({ name: 'container', ok: true, message: describeManifest(m) });
  try {
    await checkPayloadDigest(file, info);
    checks.push({ name: 'checksum', ok: true, message: 'The file is complete and unchanged (checksum matches).' });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    checks.push({ name: 'checksum', ok: false, message: err.message });
    return result(m);
  }
  if (m.encrypted && !password) {
    checks.push({ name: 'password', ok: null, message: 'This backup is password-protected. Enter the password to check its contents.' });
    return result(m, { needsPassword: true });
  }

  return withWorkDir(dataDir, async (dir) => {
    const out = path.join(dir, COMPANY_DB_FILE);
    try {
      await extractPayload(file, info, password, out);
    } catch (err) {
      if (!(err instanceof BackupFileError)) throw err;
      checks.push({ name: err.stage === 'password' ? 'password' : err.stage === 'database_checksum' ? 'database_checksum' : 'decompress', ok: false, message: err.message });
      return result(m);
    }
    if (m.encrypted) checks.push({ name: 'password', ok: true, message: 'The password is correct.' });
    checks.push({ name: 'decompress', ok: true, message: `The data unpacks to ${(m.dbBytes / 1_048_576).toFixed(1)} MB.` });
    checks.push({ name: 'database_checksum', ok: true, message: 'The unpacked data matches the recorded checksum.' });
    const facts = inspectDatabase(out, true);
    const intact = facts.integrity.length === 1 && facts.integrity[0] === 'ok';
    checks.push({
      name: 'integrity',
      ok: intact,
      message: intact ? 'The database passed SQLite’s integrity check.' : `The database is damaged: ${facts.integrity.slice(0, 3).join('; ')}`,
    });
    const supported = facts.schemaVersion > 0 && facts.schemaVersion <= SCHEMA_VERSION;
    checks.push({
      name: 'schema',
      ok: supported,
      message: supported
        ? facts.schemaVersion < SCHEMA_VERSION
          ? `Data version ${facts.schemaVersion} — it will be upgraded to version ${SCHEMA_VERSION} when the company is opened.`
          : `Data version ${facts.schemaVersion} (current).`
        : facts.schemaVersion > SCHEMA_VERSION
          ? `This backup was made by a newer version of Bahi ERP (data version ${facts.schemaVersion}; this app supports up to ${SCHEMA_VERSION}). Update Bahi ERP to restore it.`
          : 'The backup does not contain Bahi ERP company data.',
    });
    checks.push({
      name: 'company',
      ok: facts.name !== null,
      message: facts.name !== null ? `Company "${facts.name}" with ${facts.counts?.ledgers ?? 0} ledgers and ${facts.counts?.vouchers ?? 0} vouchers.` : 'The company details are missing.',
    });
    return result(m, { companyName: facts.name ?? m.companyName, schemaVersion: facts.schemaVersion, supported, counts: facts.counts });
  });
}

// ───────────────────────────── Auto backup ─────────────────────────────

export async function autoBackup(ctx: CompanyCtx): Promise<BackupAutoResult> {
  const cfg = getConfig(ctx.db).backup;
  const last = lastBackupAt(ctx.db);
  if (!cfg.auto) return { ran: false, reason: 'disabled', lastBackupAt: last };
  if (last !== null) {
    const age = ctx.clock.now().getTime() - Date.parse(last);
    if (Number.isFinite(age) && age < DAY_MS) return { ran: false, reason: 'recent', lastBackupAt: last };
  }
  try {
    const backup = await createBackup(ctx, {}, 'auto');
    return { ran: true, reason: 'created', lastBackupAt: backup.createdAt, backup };
  } catch (err) {
    ctx.app.log('warn', 'Automatic backup failed', { company: ctx.company.id, error: err });
    return { ran: false, reason: 'failed', lastBackupAt: last, error: err instanceof AppError ? err.message : 'The automatic backup could not be written.' };
  }
}

// ───────────────────────────── Restore ─────────────────────────────

/** Owner-password guesses when replacing a secured company (same policy as login: 5 → 5 minutes). */
const replaceFailures = new Map<string, { count: number; lockedUntil: number }>();
const MAX_OWNER_FAILURES = 5;
const OWNER_LOCKOUT_MS = 5 * 60_000;

async function assertOwnerForReplace(dbPath: string, companyId: string, input: BackupRestoreInput, clock: Clock): Promise<void> {
  const db = new Db(dbPath, { readOnly: true, timeoutMs: 2000 });
  try {
    let secured = false;
    const raw = db.value<string>(`SELECT value FROM settings WHERE key = 'features'`);
    try {
      secured = typeof raw === 'string' && (JSON.parse(raw) as { security?: unknown }).security === true;
    } catch {
      secured = false;
    }
    if (!secured) return;
    if (!input.ownerPassword) {
      throw validation([{ path: 'ownerPassword', message: 'The company being replaced is password-protected. Enter its owner password.' }]);
    }
    const nowMs = clock.now().getTime();
    const f = replaceFailures.get(companyId);
    if (f && f.lockedUntil > nowMs) {
      const minutes = Math.max(1, Math.ceil((f.lockedUntil - nowMs) / 60_000));
      throw new AppError('LOCKED', `Too many incorrect owner passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    if (!(await verifyOwnerCredentials(db, input.ownerPassword, input.ownerUsername))) {
      const count = (f && f.lockedUntil === 0 ? f.count : 0) + 1;
      const locked = count >= MAX_OWNER_FAILURES;
      replaceFailures.set(companyId, { count: locked ? 0 : count, lockedUntil: locked ? nowMs + OWNER_LOCKOUT_MS : 0 });
      throw new AppError('UNAUTHENTICATED', 'Owner username or password of the company being replaced is incorrect.');
    }
    replaceFailures.delete(companyId);
  } finally {
    db.close();
  }
}

export interface RestoreEnv {
  app: AppRuntime;
  clock: Clock;
  session: Session | null;
  /** Company open in this window (refused as a replace target), or null. */
  openCompanyId: string | null;
}

export async function restoreBackup(env: RestoreEnv, input: BackupRestoreInput): Promise<BackupRestoreResult> {
  const file = backupPath(input.path);
  let replaceDbPath: string | null = null;
  if (input.mode === 'replace') {
    const id = input.replaceId;
    if (!id) throw validation([{ path: 'replaceId', message: 'Choose the company to replace' }]);
    if (env.openCompanyId !== null && id === env.openCompanyId) {
      throw new AppError(
        'CONFLICT',
        'The company you want to replace is open. Close it (F3 → Close company) and use "Restore a backup" on the Company Select screen.',
      );
    }
    if (!COMPANY_ID_RE.test(id)) throw notFound('Company', id);
    replaceDbPath = path.join(env.app.dataDir, 'companies', id, COMPANY_DB_FILE);
    if (!exists(replaceDbPath)) throw notFound('Company', id);
  } else if (input.replaceId) {
    throw validation([{ path: 'replaceId', message: 'A company to replace is given only with mode "replace"' }]);
  }

  const info = readContainerInfo(file);
  const m = info.manifest;
  assertSupportedVersion(m.schemaVersion);

  if (replaceDbPath && input.replaceId) {
    const target = new Db(replaceDbPath, { readOnly: true, timeoutMs: 2000 });
    let targetGuid: string | undefined;
    let targetName: string | undefined;
    try {
      const row = target.get<{ guid: string; name: string }>('SELECT guid, name FROM company WHERE id = 1');
      targetGuid = row?.guid;
      targetName = row?.name;
    } finally {
      target.close();
    }
    if (targetGuid !== undefined && targetGuid !== m.companyGuid) {
      throw new AppError(
        'CONFLICT',
        `This backup belongs to "${m.companyName}", not to "${targetName ?? input.replaceId}". Restore it as a new company instead.`,
      );
    }
    await assertOwnerForReplace(replaceDbPath, input.replaceId, input, env.clock);
  }

  await checkPayloadDigest(file, info);
  return withWorkDir(env.app.dataDir, async (dir) => {
    const extracted = path.join(dir, COMPANY_DB_FILE);
    await extractPayload(file, info, input.password, extracted);
    const facts = inspectDatabase(extracted, false);
    if (!(facts.integrity.length === 1 && facts.integrity[0] === 'ok')) {
      throw new AppError('CONFLICT', 'The data inside this backup is damaged and cannot be restored. Use another backup.');
    }
    if (facts.name === null) throw new AppError('VALIDATION', 'This backup does not contain Bahi ERP company data.');
    assertSupportedVersion(facts.schemaVersion);

    // The restored company keeps its edit log; record the restore in it (hash-chained like any entry).
    const db = new Db(extracted);
    try {
      appendAudit(
        db,
        {
          action: 'restore',
          entityType: 'company',
          entityId: 1,
          entityGuid: facts.guid ?? undefined,
          entityLabel: facts.name,
          after: {
            file: path.basename(file),
            backupCreatedAt: m.createdAt,
            backupCreatedBy: m.createdBy,
            backupAppVersion: m.appVersion,
            mode: input.mode,
            replacedCompanyId: input.mode === 'replace' ? (input.replaceId ?? null) : null,
            restoredBy: env.session ? env.session.displayName || env.session.username : null,
            restoredByApp: env.app.appVersion,
          },
        },
        env.session,
        env.clock.now(),
      );
    } finally {
      db.close();
    }

    const installed = await controllerFor(env.app).installCompanyDatabase(extracted, input.mode === 'replace' ? { replaceId: input.replaceId } : {});
    env.app.log('info', 'Backup restored', { company: installed.company.id, mode: input.mode });
    return { company: installed.company, replacedTo: installed.replacedTo, restoredFrom: file, manifest: m };
  });
}
