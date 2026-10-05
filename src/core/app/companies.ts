/**
 * Company folders inside a data directory:
 *
 *   <dataDir>/companies/<id>/company.db      one SQLite database per company (WAL)
 *   <dataDir>/companies/<id>/company.lock    present while open (see lock.ts)
 *   <dataDir>/companies/<id>/attachments/    files attached to vouchers/masters
 *   <dataDir>/backups/                       backups (and pre-upgrade safety copies)
 *   <dataDir>/trash/                         deleted companies (never hard-deleted by the app)
 *   <dataDir>/registry.json                  last-opened timestamps
 *
 * Company ids are slug(name) + '-' + 6 random base-36 chars, validated against ID_RE everywhere
 * they are turned into paths (no traversal possible).
 */
import fs from 'node:fs';
import path from 'node:path';
import { financialYear, maxDate } from '../../shared/dates.ts';
import type { CompanyListItem, CreateCompanyInput } from '../../shared/types/app.ts';
import type { Clock } from '../api/context.ts';
import { Db } from '../db/db.ts';
import { getSchemaVersion, migrate, SCHEMA_VERSION, assertSupportedVersion, type MigrateResult } from '../db/migrate.ts';
import { seedCompany } from '../db/seed.ts';
import { randomBase36, randomToken } from '../lib/crypto.ts';
import { AppError, notFound, validation } from '../lib/errors.ts';
import { ensureDir, exists, fileTimestamp, sizeOf, slugify } from '../lib/fsutil.ts';
import { acquireLock, lockHolder, type CompanyLock } from './lock.ts';
import type { Logger } from './logger.ts';
import { CompanyRegistry } from './registry.ts';

export const COMPANY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const COMPANY_DB_FILE = 'company.db';

export interface CompanyPaths {
  id: string;
  dir: string;
  dbPath: string;
  attachmentsDir: string;
}

/** Minimal facts read from a company DB without opening it for writing. */
export interface CompanyMeta {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  booksFrom: string;
  fyStartMonth: number;
  schemaVersion: number;
  securityEnabled: boolean;
}

export interface OpenedCompany extends CompanyPaths {
  name: string;
  db: Db;
  lock: CompanyLock;
  migration: MigrateResult;
}

export interface InstallResult {
  paths: CompanyPaths;
  /** Where the replaced company folder was moved (trash), or null for a new company. */
  replacedTo: string | null;
}

export interface CompanyStoreOptions {
  dataDir: string;
  appVersion: string;
  clock: Clock;
  log: Logger['log'];
}

export class CompanyStore {
  readonly dataDir: string;
  readonly companiesDir: string;
  readonly backupsDir: string;
  readonly trashDir: string;
  readonly registry: CompanyRegistry;
  private readonly appVersion: string;
  private readonly clock: Clock;
  private readonly log: Logger['log'];

  constructor(opts: CompanyStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.companiesDir = path.join(this.dataDir, 'companies');
    this.backupsDir = path.join(this.dataDir, 'backups');
    this.trashDir = path.join(this.dataDir, 'trash');
    this.appVersion = opts.appVersion;
    this.clock = opts.clock;
    this.log = opts.log;
    this.registry = new CompanyRegistry(this.dataDir, opts.log);
  }

  /** Create the standard sub-folders (idempotent). */
  ensureLayout(): void {
    ensureDir(this.companiesDir);
    ensureDir(this.backupsDir);
    ensureDir(this.trashDir);
  }

  paths(id: string): CompanyPaths {
    if (typeof id !== 'string' || !COMPANY_ID_RE.test(id)) throw notFound('Company', id);
    const dir = path.join(this.companiesDir, id);
    return { id, dir, dbPath: path.join(dir, COMPANY_DB_FILE), attachmentsDir: path.join(dir, 'attachments') };
  }

  /** Ids of folders that look like companies (valid id + company.db present). */
  ids(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.companiesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!COMPANY_ID_RE.test(e.name)) {
        this.log('warn', 'Skipping folder with an unexpected name in companies/', { folder: e.name });
        continue;
      }
      if (exists(path.join(this.companiesDir, e.name, COMPANY_DB_FILE))) out.push(e.name);
    }
    return out;
  }

  /** Read company facts through a read-only connection. Throws if the DB is unreadable. */
  readMeta(id: string): CompanyMeta {
    const p = this.paths(id);
    if (!exists(p.dbPath)) throw notFound('Company', id);
    const db = new Db(p.dbPath, { readOnly: true, timeoutMs: 2000 });
    try {
      const row = db.get<{ name: string; gstin: string | null; state_code: string | null; books_from: string; fy_start_month: number }>(
        'SELECT name, gstin, state_code, books_from, fy_start_month FROM company WHERE id = 1',
      );
      if (!row) throw new Error('company row missing');
      let securityEnabled = false;
      const raw = db.value<string>(`SELECT value FROM settings WHERE key = 'features'`);
      if (raw) {
        try {
          securityEnabled = (JSON.parse(raw) as { security?: unknown }).security === true;
        } catch {
          /* default false */
        }
      }
      return {
        id,
        name: row.name,
        gstin: row.gstin,
        stateCode: row.state_code,
        booksFrom: row.books_from,
        fyStartMonth: row.fy_start_month,
        schemaVersion: getSchemaVersion(db),
        securityEnabled,
      };
    } finally {
      db.close();
    }
  }

  toListItem(meta: CompanyMeta, lastOpenedAt: string | null): CompanyListItem {
    const ref = maxDate(this.clock.today(), meta.booksFrom);
    return {
      id: meta.id,
      name: meta.name,
      gstin: meta.gstin,
      stateCode: meta.stateCode,
      booksFrom: meta.booksFrom,
      fyLabel: financialYear(ref, meta.fyStartMonth).label,
      securityEnabled: meta.securityEnabled,
      lastOpenedAt,
      sizeBytes: sizeOf(this.paths(meta.id).dir),
      schemaVersion: meta.schemaVersion,
      needsUpgrade: meta.schemaVersion < SCHEMA_VERSION,
    };
  }

  /** All readable companies, most recently opened first, then by name. Broken folders are skipped (logged). */
  list(): CompanyListItem[] {
    const reg = this.registry.all();
    const items: CompanyListItem[] = [];
    for (const id of this.ids()) {
      try {
        const last = reg[id]?.lastOpenedAt;
        items.push(this.toListItem(this.readMeta(id), typeof last === 'string' ? last : null));
      } catch (err) {
        this.log('warn', 'Skipping unreadable company folder', { id, error: err });
      }
    }
    return items.sort(
      (a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    );
  }

  newId(name: string): string {
    for (let i = 0; i < 20; i++) {
      const id = `${slugify(name)}-${randomBase36(6)}`;
      if (!exists(path.join(this.companiesDir, id))) return id;
    }
    throw new AppError('CONFLICT', 'Could not allocate a folder for the company. Please try again.');
  }

  /**
   * Create a company folder + database (migrated and seeded). The DB is closed afterwards; call open().
   * On any failure the half-created folder is removed.
   */
  create(input: CreateCompanyInput, ownerPasswordHash?: string): CompanyPaths & { ownerUserId: number | null; companyGuid: string } {
    this.ensureLayout();
    const p = this.paths(this.newId(input.name));
    fs.mkdirSync(p.dir);
    let db: Db | null = null;
    try {
      ensureDir(p.attachmentsDir);
      db = new Db(p.dbPath);
      migrate(db);
      const seeded = seedCompany(db, input, { now: this.clock.now(), ownerPasswordHash });
      db.close();
      db = null;
      this.log('info', 'Company created', { id: p.id });
      return { ...p, ownerUserId: seeded.ownerUserId, companyGuid: seeded.companyGuid };
    } catch (err) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(p.dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Open a company for read/write: refuse newer schemas, take the lock, keep a safety copy before
   * upgrading an older schema, then migrate.
   */
  open(id: string): OpenedCompany {
    const p = this.paths(id);
    if (!exists(p.dbPath)) throw notFound('Company', id);
    let meta: CompanyMeta;
    try {
      meta = this.readMeta(id);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.log('error', 'Company database could not be read', { id, error: err });
      throw new AppError('CONFLICT', 'This company’s data file could not be read. It may be damaged — restore it from a backup.');
    }
    assertSupportedVersion(meta.schemaVersion);

    const lock = acquireLock(p.dir, meta.name, this.appVersion, this.clock.now());
    let db: Db | null = null;
    try {
      db = new Db(p.dbPath);
      const before = getSchemaVersion(db);
      if (before > 0 && before < SCHEMA_VERSION) this.safetyCopy(db, id, before);
      const migration = migrate(db);
      if (migration.applied.length) this.log('info', 'Company data upgraded', { id, from: migration.from, to: migration.to });
      ensureDir(p.attachmentsDir);
      return { ...p, name: meta.name, db, lock, migration };
    } catch (err) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      lock.release();
      throw err;
    }
  }

  /** Consistent copy of the DB before a schema upgrade: backups/<id>/pre-upgrade-v<N>-<ts>.db */
  private safetyCopy(db: Db, id: string, version: number): void {
    const dir = path.join(this.backupsDir, id);
    ensureDir(dir);
    const target = path.join(dir, `pre-upgrade-v${version}-${fileTimestamp(this.clock.now())}.db`);
    db.run('VACUUM INTO ?', [target]);
    this.log('info', 'Safety copy written before upgrade', { id, file: target });
  }

  close(opened: OpenedCompany): void {
    try {
      opened.db.close();
    } finally {
      opened.lock.release();
    }
  }

  /**
   * Check that a file is a usable company database (SQLite, intact, has a company row, not from a newer
   * app version). Returns its name and schema version; throws VALIDATION/CONFLICT otherwise.
   */
  inspectDatabaseFile(file: string): { name: string; schemaVersion: number } {
    const notCompany = (): AppError => new AppError('VALIDATION', 'This file is not a valid Bahi ERP company data file.');
    if (!exists(file)) throw notFound('File');
    let db: Db | null = null;
    let found: { name: string; schemaVersion: number };
    try {
      db = new Db(file, { readOnly: true, timeoutMs: 2000 });
      if (db.value<string>('PRAGMA quick_check') !== 'ok') throw notCompany();
      const name = db.value<string>('SELECT name FROM company WHERE id = 1');
      if (typeof name !== 'string' || name.trim() === '') throw notCompany();
      found = { name, schemaVersion: getSchemaVersion(db) };
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.log('warn', 'Rejected company data file', { error: err });
      throw notCompany();
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
    assertSupportedVersion(found.schemaVersion);
    return found;
  }

  /**
   * Install a company database file (e.g. a decrypted backup being restored) into this data folder.
   * The source is verified and copied with VACUUM INTO (a compact, consistent copy that includes any
   * WAL content); it is never moved or modified. The copy is staged inside the data folder and only
   * renamed into place after it passes an integrity check.
   *  - without `replaceId`: becomes a new company with a fresh id;
   *  - with `replaceId`: that company must not be open anywhere; its folder is moved to the trash
   *    (never deleted) and the restored data takes over the same id.
   * Older schemas are upgraded the next time the company is opened (with the usual safety copy).
   */
  install(sourceDbPath: string, opts: { replaceId?: string } = {}): InstallResult {
    const { name } = this.inspectDatabaseFile(sourceDbPath);
    const replace = opts.replaceId !== undefined ? this.paths(opts.replaceId) : null;
    if (replace) {
      if (!exists(replace.dir)) throw notFound('Company', opts.replaceId);
      if (lockHolder(replace.dir, this.clock.now()))
        throw new AppError('LOCKED', 'The company being replaced is open in another window. Close it there first.');
    }
    this.ensureLayout();
    const staging = path.join(this.dataDir, `.staging-${randomToken(6)}`);
    fs.mkdirSync(staging);
    let installed = false;
    try {
      const stagedDb = path.join(staging, COMPANY_DB_FILE);
      let src: Db | null = new Db(sourceDbPath, { readOnly: true, timeoutMs: 2000 });
      try {
        src.run('VACUUM INTO ?', [stagedDb]);
      } finally {
        src.close();
        src = null;
      }
      ensureDir(path.join(staging, 'attachments'));
      const check = new Db(stagedDb, { readOnly: true });
      try {
        if (check.value<string>('PRAGMA quick_check') !== 'ok') throw new AppError('CONFLICT', 'The restored copy failed its integrity check.');
      } finally {
        check.close();
      }

      if (!replace) {
        const p = this.paths(this.newId(name));
        fs.renameSync(staging, p.dir);
        installed = true;
        this.log('info', 'Company installed from file', { id: p.id });
        return { paths: p, replacedTo: null };
      }
      const trashTarget = path.join(this.trashDir, `${replace.id}--${fileTimestamp(this.clock.now())}--replaced`);
      fs.renameSync(replace.dir, trashTarget);
      try {
        fs.renameSync(staging, replace.dir);
      } catch (err) {
        fs.renameSync(trashTarget, replace.dir); // put the original back
        throw err;
      }
      installed = true;
      this.log('info', 'Company replaced from file', { id: replace.id, previous: trashTarget });
      return { paths: replace, replacedTo: trashTarget };
    } finally {
      if (!installed) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Move a company folder to <dataDir>/trash/<id>--<timestamp>. `confirmName` must equal the company
   * name. The caller is responsible for ensuring it is not open in this process.
   */
  moveToTrash(id: string, confirmName: string): string {
    const p = this.paths(id);
    const meta = this.readMeta(id);
    if (confirmName.trim() !== meta.name.trim())
      throw validation([{ path: 'confirmName', message: 'Type the company name exactly as shown to confirm deletion' }]);
    const holder = lockHolder(p.dir, this.clock.now());
    if (holder) throw new AppError('LOCKED', `"${meta.name}" is open in another window. Close it there first.`);
    ensureDir(this.trashDir);
    const target = path.join(this.trashDir, `${id}--${fileTimestamp(this.clock.now())}`);
    try {
      fs.renameSync(p.dir, target);
    } catch (err) {
      this.log('error', 'Could not move company to trash', { id, error: err });
      throw new AppError('CONFLICT', 'The company folder could not be moved to the trash. Close any program using it and try again.');
    }
    this.registry.remove(id);
    this.log('info', 'Company moved to trash', { id, target });
    return target;
  }
}
