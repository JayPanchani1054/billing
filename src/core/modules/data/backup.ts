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
import { formatDate, localDateOf } from '../../../shared/dates.ts';
import {
  BACKUP_EXTENSION,
  type BackupAutoInput,
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
import type { AppRuntime, Clock, CompanyCtx, PathUse, Session } from '../../api/context.ts';
import { COMPANY_DB_FILE, COMPANY_ID_RE } from '../../app/companies.ts';
import { controllerFor } from '../../app/controller.ts';
import { confirmOwnerPassword } from '../../app/auth.ts';
import { Db } from '../../db/db.ts';
import { assertSupportedVersion, getSchemaVersion, SCHEMA_VERSION } from '../../db/migrate.ts';
import { UNEXPECTED_OBJECTS_MESSAGE, validateCompanySchema } from '../../db/schemaCheck.ts';
import { BACKUP_HISTORY_DDL } from '../../db/migrations/120_data.ts';
import { appendAudit, verifyAuditChain } from '../../lib/audit.ts';
import { auditHead } from '../../lib/auditAnchor.ts';
import { randomToken } from '../../lib/crypto.ts';
import { AppError, notFound, validation } from '../../lib/errors.ts';
import { ensureDir, exists, probeWritable } from '../../lib/fsutil.ts';
import { authorizeUserPath, isUncOrDevicePath, isWithin } from '../../lib/paths.ts';
import { getConfig, readSetting, writeSetting } from '../company/service.ts';
import { localStamp, safeFileNamePart } from './common.ts';
import { describeBlobs, embedAttachmentsInSnapshot, inspectAttachmentBlobs, unpackAttachmentBlobs, type EmbedResult } from '../attachments/backup.ts';
import { BackupFileError, checkPayloadDigest, extractPayload, readContainerInfo, writeContainer, type ContainerInfo } from './container.ts';

export const BACKUP_PASSWORD_MIN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── Folders & history ─────────────────────────────

/** The F12 backup folder when one is configured (authorised when it was saved), else null. */
export function configuredBackupFolder(db: Db): string | null {
  const configured = getConfig(db).backup.folder;
  return configured && path.isAbsolute(configured) ? path.resolve(configured) : null;
}

/** F12 backup folder, else <data folder>/backups/<company id>. */
export function defaultBackupFolder(ctx: Pick<CompanyCtx, 'db' | 'app' | 'company'>): string {
  return configuredBackupFolder(ctx.db) ?? path.join(ctx.app.dataDir, 'backups', ctx.company.id);
}

/**
 * The default folder, or a renderer-supplied one that the user picked in a dialog this session (or that
 * lies in the data folder / the configured backup folder) — see core/lib/paths.ts.
 */
function resolveFolder(ctx: Pick<CompanyCtx, 'db' | 'app' | 'company'>, folder: string | undefined, use: PathUse): string {
  if (folder === undefined) return defaultBackupFolder(ctx);
  return authorizeUserPath(ctx.app, folder, use, { field: 'folder', what: 'backup folder', trusted: [configuredBackupFolder(ctx.db)] });
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
/**
 * Pages copied per sqlite3_backup_step: more than any company file has, so the whole copy is one step.
 * Must be a positive 32-bit integer — newer Node (Electron 44) rejects SQLite's own "-1 = all pages"
 * with ERR_OUT_OF_RANGE, which made every backup fail in the packaged app.
 */
export const BACKUP_PAGES_PER_STEP = 0x7fffffff;

async function snapshotDatabase(ctx: Pick<CompanyCtx, 'db' | 'company'>, target: string): Promise<void> {
  const live = ctx.company.dbPath;
  const backupFn = (sqlite as { backup?: typeof sqlite.backup }).backup;
  if (live !== ':memory:' && exists(live) && typeof backupFn === 'function') {
    const reader = new DatabaseSync(live, { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout = 10000');
      // All pages in one step = one read transaction → a consistent snapshot even while the main
      // connection keeps writing (WAL readers never block writers).
      await backupFn(reader, target, { rate: BACKUP_PAGES_PER_STEP });
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

/**
 * Newest edit-log entry of the snapshot, signed with this installation's anchor key (the key is never
 * written into the backup), for BackupManifest.auditHead.
 */
function snapshotAuditHead(ctx: Pick<CompanyCtx, 'app' | 'company'>, snapshot: string, companyGuid: string, at: string): BackupManifest['auditHead'] | null {
  const db = new Db(snapshot, { readOnly: true });
  try {
    const head = auditHead(db);
    if (!head) return null;
    const store = ctx.app.auditAnchors;
    return { ...head, mac: store ? store.sign({ companyId: ctx.company.id, companyGuid, ...head, at }) : null };
  } finally {
    db.close();
  }
}

/** Edit-log check of an extracted (schema-validated) backup database; see verifyBackup. */
function backupEditLogCheck(app: Pick<AppRuntime, 'auditAnchors'>, file: string, m: BackupManifest): { ok: boolean; message: string; signedMismatch: boolean } {
  const db = new Db(file, { readOnly: true });
  try {
    const signed = signedHeadMatches(app, db, m);
    if (signed === false) return { ok: false, signedMismatch: true, message: 'The edit log inside this backup was changed after the backup was made. Do not restore it; use another backup.' };
    const chain = verifyAuditChain(db);
    if (!chain.ok) return { ok: false, signedMismatch: false, message: `The edit log inside this backup has been tampered with (entry #${chain.brokenAtId}).` };
    return {
      ok: true,
      signedMismatch: false,
      message: `The edit log (${chain.count.toLocaleString('en-IN')} entries) is intact${signed === true ? ' and matches the fingerprint recorded when this backup was made' : ''}.`,
    };
  } finally {
    db.close();
  }
}

/**
 * true/false when the manifest's signed edit-log head can be checked on this installation (it was signed
 * here) and does / does not match the data; null when it cannot be checked (older backup, made on
 * another computer, or no anchor key).
 */
function signedHeadMatches(app: Pick<AppRuntime, 'auditAnchors'>, db: Db, m: BackupManifest): boolean | null {
  const h = m.auditHead;
  const store = app.auditAnchors;
  if (!h || !h.mac || !store) return null;
  if (!store.verify({ companyId: m.companyId, companyGuid: m.companyGuid, lastId: h.lastId, lastHash: h.lastHash, at: m.createdAt, mac: h.mac })) return null;
  const row = db.get<{ hash: string }>('SELECT hash FROM audit_log WHERE id = :id', { id: h.lastId });
  return row?.hash === h.lastHash;
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
  const folder = resolveFolder(ctx, input.folder, 'write-dir');
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
  let attached: EmbedResult;
  try {
    await snapshotDatabase(ctx, snapshot);
    // Attached files travel inside the snapshot (attachment_blobs), covered by its checksums / encryption.
    attached = embedAttachmentsInSnapshot(snapshot, ctx.company.dir);
    const auditHead = snapshotAuditHead(ctx, snapshot, facts.guid, createdAt);
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
        ...(auditHead ? { auditHead } : {}),
      },
    });
  } finally {
    await fsp.rm(snapshot, { force: true }).catch(() => undefined);
    await fsp.rm(`${snapshot}-journal`, { force: true }).catch(() => undefined);
  }

  // Read the new file back before "keep last N" deletes anything: a backup that did not land on the
  // disk intact (full or failing drive, network folder) must never cost the user an older good one.
  let removed: string[] = [];
  try {
    const info = readContainerInfo(target);
    await checkPayloadDigest(target, info);
    removed = applyRetention(ctx, folder, facts.guid, target);
  } catch (err) {
    ctx.app.log('error', 'The new backup could not be read back; old backups were kept', { company: ctx.company.id, file: path.basename(target), error: err });
    throw new AppError('BUSINESS_RULE', `The backup ${path.basename(target)} could not be read back from ${folder}, so it may be damaged. Older backups were kept. Check the drive and back up again.`);
  }

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
      after: {
        file: path.basename(target),
        folder,
        sizeBytes: written.sizeBytes,
        encrypted: Boolean(password),
        kind,
        note,
        removed: removed.length,
        ...(attached.files > 0 || attached.missing.length > 0 ? { attachments: attached.files, attachmentsMissing: attached.missing.length } : {}),
      },
    });
  });
  // No file name: it carries the company name, and business data stays out of the app log (§8).
  ctx.app.log('info', 'Backup written', { company: ctx.company.id, bytes: written.sizeBytes, kind });

  if (attached.missing.length > 0) ctx.app.log('warn', 'Backup written without some attached files (missing or changed)', { company: ctx.company.id, count: attached.missing.length });
  return {
    path: target,
    fileName: path.basename(target),
    folder,
    sizeBytes: written.sizeBytes,
    createdAt,
    encrypted: Boolean(password),
    removed,
    ...(attached.files > 0 || attached.missing.length > 0 ? { attachments: { files: attached.files, missing: attached.missing.slice(0, 50) } } : {}),
  };
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
  const folder = resolveFolder(ctx, folderInput, 'read-dir');
  const facts = companyFacts(ctx.db);
  const backups = scanFolder(folder, { companyId: ctx.company.id, companyGuid: facts.guid }).sort(
    (a, b) => (b.manifest?.createdAt ?? b.modifiedAt).localeCompare(a.manifest?.createdAt ?? a.modifiedAt) || a.fileName.localeCompare(b.fileName),
  );
  return { folder, backups, lastBackupAt: lastBackupAt(ctx.db) };
}

/** Where a backup file may be read from: the app (data folder + dialog choices) plus trusted roots. */
export interface BackupFileAccess {
  app: Pick<AppRuntime, 'dataDir' | 'authorizePath' | 'log' | 'auditAnchors'>;
  /** Extra trusted roots, e.g. the open company's configured backup folder. */
  trusted?: ReadonlyArray<string | null>;
}

export function inspectBackupFile(access: BackupFileAccess, rawPath: string): BackupFileInfo {
  const file = backupPath(access, rawPath);
  const info = describeBackupFile(file);
  if (!info.manifest) throw new AppError('VALIDATION', info.problem ?? 'This is not a Bahi ERP backup file.');
  return info;
}

function backupPath(access: BackupFileAccess, raw: string): string {
  const file = authorizeUserPath(access.app, raw, 'read-file', { field: 'path', what: 'backup file', trusted: access.trusted });
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
  /** Unexpected schema objects (views, foreign triggers, …): when non-empty nothing else was queried. */
  schemaProblems: string[];
  counts: { ledgers: number; vouchers: number; stockItems: number } | null;
}

/**
 * Read facts from an extracted (UNTRUSTED) database file, read-only. `full` runs integrity_check, else
 * quick_check. The schema is validated before any table is queried (schemaCheck.ts): a view shadowing
 * `ledgers` could otherwise hang the process, and a foreign trigger would survive a restore.
 */
function inspectDatabase(file: string, full: boolean): ExtractedFacts {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF');
    const pragma = full ? 'PRAGMA integrity_check(50)' : 'PRAGMA quick_check(50)';
    const integrity = db
      .prepare(pragma)
      .all()
      .map((r) => String(Object.values(r)[0]));
    const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const schemaProblems = validateCompanySchema(db);
    if (schemaProblems.length > 0) return { name: null, guid: null, schemaVersion, integrity, schemaProblems, counts: null };
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
    return { name, guid, schemaVersion, integrity, schemaProblems, counts };
  } catch {
    return { name: null, guid: null, schemaVersion: 0, integrity: ['The file is not a readable SQLite database'], schemaProblems: [], counts: null };
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
  const when = formatDate(localDateOf(m.createdAt)); // local day, not the UTC one
  return `Backup of "${m.companyName}" made on ${when}${m.createdBy ? ` by ${m.createdBy}` : ''} (Bahi ERP ${m.appVersion})${m.encrypted ? ', password-protected' : ''}.`;
}

/** Full verification of a backup file. Never throws for problems with the file — they come back as checks. */
export async function verifyBackup(access: BackupFileAccess, rawPath: string, password: string | undefined): Promise<BackupVerifyResult> {
  const dataDir = access.app.dataDir;
  const file = backupPath(access, rawPath);
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
    if (facts.schemaProblems.length > 0) {
      checks.push({ name: 'schema', ok: false, message: `${UNEXPECTED_OBJECTS_MESSAGE} (${facts.schemaProblems.slice(0, 5).join(', ')})` });
      return result(m, { supported: false });
    }
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
    if (intact && facts.name !== null) {
      const log = backupEditLogCheck(access.app, out, m);
      checks.push({ name: 'edit_log', ok: log.ok, message: log.message });
      // Attached files carried in the backup (dataplus): present and unchanged.
      const blobDb = new Db(out, { readOnly: true });
      try {
        const blobs = inspectAttachmentBlobs(blobDb);
        if (blobs && (blobs.files > 0 || blobs.referenced > 0)) checks.push({ name: 'attachments', ...describeBlobs(blobs) });
      } finally {
        blobDb.close();
      }
    }
    return result(m, { companyName: facts.name ?? m.companyName, schemaVersion: facts.schemaVersion, supported, counts: facts.counts });
  });
}

// ───────────────────────────── Auto backup ─────────────────────────────

/**
 * The F12 automatic backup (`data.backup.auto`): at most one per 24 hours, written when the shell
 * opens the company ('open': catch-up after a session that ended without one) and before it closes
 * the company or quits ('close'). A brand-new company (created < 24 h ago, never backed up) is not
 * copied on open — it is on close. Never throws: failures come back as reason 'failed'.
 */
export function autoBackup(ctx: CompanyCtx, input: BackupAutoInput = {}): Promise<BackupAutoResult> {
  // One automatic backup at a time per open company: the 'open' catch-up, a 'close' the shell
  // stopped waiting for, and the runtime's shutdown step may overlap — they share the run in
  // progress instead of writing two copies side by side (and pruning the folder concurrently).
  const running = autoBackupsInFlight.get(ctx.db);
  if (running) return running;
  const run = runAutoBackup(ctx, input).finally(() => {
    if (autoBackupsInFlight.get(ctx.db) === run) autoBackupsInFlight.delete(ctx.db);
  });
  autoBackupsInFlight.set(ctx.db, run);
  return run;
}

/** Automatic backups being written, by open company database (see autoBackup). */
const autoBackupsInFlight = new WeakMap<object, Promise<BackupAutoResult>>();

async function runAutoBackup(ctx: CompanyCtx, input: BackupAutoInput): Promise<BackupAutoResult> {
  const cfg = getConfig(ctx.db).backup;
  const last = lastBackupAt(ctx.db);
  if (!cfg.auto) return { ran: false, reason: 'disabled', lastBackupAt: last };
  const nowMs = ctx.clock.now().getTime();
  if (last !== null) {
    const age = nowMs - Date.parse(last);
    if (Number.isFinite(age) && age < DAY_MS) return { ran: false, reason: 'recent', lastBackupAt: last };
  } else if (input.trigger === 'open') {
    const created = ctx.db.value<string>('SELECT created_at FROM company WHERE id = 1');
    const age = typeof created === 'string' ? nowMs - Date.parse(created) : Number.NaN;
    if (Number.isFinite(age) && age < DAY_MS) return { ran: false, reason: 'new', lastBackupAt: null };
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

/**
 * Replacing a password-protected company needs one of its Owners' passwords, checked against that
 * company's own database with its login lockout (shared budget, survives restarts) and recorded in its
 * edit log (auth.ts confirmOwnerPassword).
 */
async function assertOwnerForReplace(dbPath: string, input: BackupRestoreInput, clock: Clock): Promise<void> {
  const db = new Db(dbPath, { timeoutMs: 2000 });
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
    try {
      await confirmOwnerPassword(db, { password: input.ownerPassword, username: input.ownerUsername, context: 'restore.replace' }, clock.now());
    } catch (err) {
      if (err instanceof AppError && err.code === 'UNAUTHENTICATED') {
        throw new AppError('UNAUTHENTICATED', 'Owner username or password of the company being replaced is incorrect.');
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * The F12 backup folder stored INSIDE a backup file is untrusted: a crafted backup could name a remote
 * share (\\host\share) or any other folder, and automatic backups (data.backup.auto, run after every
 * login) and the folder's "trusted root" status would then keep copying the books there — the hole
 * company.config.save closes for the renderer. A restore keeps the folder only when this installation
 * vouches for it: it lies in the data folder, the user picked it in a dialog this session, or (local
 * folders only) the backup being restored was itself chosen from inside it, or it is the folder the
 * replaced company already used. Otherwise it is cleared
 * (automatic backups go to the default folder until the user picks a folder in F12 again) and the
 * folder dropped is returned, for the restore's edit-log entry. `db` is the extracted, writable copy.
 */
function dropUntrustedBackupFolder(app: AppRuntime, db: Db, restoredFile: string, trusted: string | null, now: Date): string | null {
  const stored = readSetting(db, 'config');
  if (!stored || typeof stored !== 'object') return null;
  const backup = (stored as { backup?: unknown }).backup;
  if (!backup || typeof backup !== 'object') return null;
  const folder = (backup as { folder?: unknown }).folder;
  if (folder === null || folder === undefined) return null;
  if (typeof folder === 'string' && path.isAbsolute(folder) && !folder.includes('\0')) {
    if (!isUncOrDevicePath(folder) && isWithin(folder, restoredFile)) return null;
    try {
      authorizeUserPath(app, folder, 'write-dir', { field: 'backup.folder', what: 'backup folder', trusted: [trusted] });
      return null;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  writeSetting(db, 'config', { ...(stored as Record<string, unknown>), backup: { ...(backup as Record<string, unknown>), folder: null } }, now);
  return typeof folder === 'string' ? folder.slice(0, 500) : String(folder).slice(0, 500);
}

export interface RestoreEnv {
  app: AppRuntime;
  clock: Clock;
  session: Session | null;
  /** Company open in this window (refused as a replace target), or null. */
  openCompanyId: string | null;
  /** Extra roots the backup file may come from (the open company's configured backup folder). */
  trusted?: ReadonlyArray<string | null>;
}

export async function restoreBackup(env: RestoreEnv, input: BackupRestoreInput): Promise<BackupRestoreResult> {
  const file = backupPath({ app: env.app, trusted: env.trusted }, input.path);
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

  let replaceGuid: string | undefined;
  let replacedBackupFolder: string | null = null;
  if (replaceDbPath && input.replaceId) {
    const target = new Db(replaceDbPath, { readOnly: true, timeoutMs: 2000 });
    let targetGuid: string | undefined;
    let targetName: string | undefined;
    try {
      if (validateCompanySchema(target).length > 0) throw new AppError('CONFLICT', UNEXPECTED_OBJECTS_MESSAGE);
      const row = target.get<{ guid: string; name: string }>('SELECT guid, name FROM company WHERE id = 1');
      targetGuid = row?.guid;
      targetName = row?.name;
      replacedBackupFolder = configuredBackupFolder(target);
    } finally {
      target.close();
    }
    replaceGuid = targetGuid;
    if (targetGuid !== undefined && targetGuid !== m.companyGuid) {
      throw new AppError(
        'CONFLICT',
        `This backup belongs to "${m.companyName}", not to "${targetName ?? input.replaceId}". Restore it as a new company instead.`,
      );
    }
    controllerFor(env.app).throttleCredentialCheck(input.replaceId, 'owner');
    await assertOwnerForReplace(replaceDbPath, input, env.clock);
  }

  await checkPayloadDigest(file, info);
  return withWorkDir(env.app.dataDir, async (dir) => {
    const extracted = path.join(dir, COMPANY_DB_FILE);
    const restoredFiles = path.join(dir, 'attachments');
    await extractPayload(file, info, input.password, extracted);
    const facts = inspectDatabase(extracted, false);
    if (!(facts.integrity.length === 1 && facts.integrity[0] === 'ok')) {
      throw new AppError('CONFLICT', 'The data inside this backup is damaged and cannot be restored. Use another backup.');
    }
    if (facts.schemaProblems.length > 0) {
      env.app.log('warn', 'Refused a backup with unexpected database objects', { objects: facts.schemaProblems.slice(0, 20) });
      throw new AppError('VALIDATION', `${UNEXPECTED_OBJECTS_MESSAGE} Use another backup.`);
    }
    if (facts.name === null) throw new AppError('VALIDATION', 'This backup does not contain Bahi ERP company data.');
    {
      const check = new Db(extracted, { readOnly: true });
      try {
        if (signedHeadMatches(env.app, check, m) === false) {
          throw new AppError('CONFLICT', 'The edit log inside this backup was changed after the backup was made, so it was not restored. Use another backup.');
        }
      } finally {
        check.close();
      }
    }
    assertSupportedVersion(facts.schemaVersion);
    // The manifest is plain JSON (not covered by AES-GCM): check the company inside the data itself
    // before it replaces anything.
    if (replaceGuid !== undefined && facts.guid !== replaceGuid) {
      throw new AppError('CONFLICT', `The data in this backup belongs to "${facts.name}", not to the company being replaced. Restore it as a new company instead.`);
    }

    // The restored company keeps its edit log; record the restore in it (hash-chained like any entry).
    const db = new Db(extracted);
    try {
      const droppedBackupFolder = dropUntrustedBackupFolder(env.app, db, file, replacedBackupFolder, env.clock.now());
      if (droppedBackupFolder !== null) env.app.log('warn', 'A restored backup named a backup folder this computer has not approved; it was cleared', {});
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
            ...(droppedBackupFolder !== null ? { backupFolderNotKept: droppedBackupFolder } : {}),
          },
        },
        env.session,
        env.clock.now(),
      );
      // Attached files carried in the backup go to the restored company's attachments folder.
      unpackAttachmentBlobs(db, restoredFiles);
    } finally {
      db.close();
    }

    const installed = await controllerFor(env.app).installCompanyDatabase(extracted, {
      ...(input.mode === 'replace' ? { replaceId: input.replaceId } : {}),
      attachmentsDir: restoredFiles,
    });
    env.app.log('info', 'Backup restored', { company: installed.company.id, mode: input.mode });
    return { company: installed.company, replacedTo: installed.replacedTo, restoredFrom: file, manifest: m };
  });
}
