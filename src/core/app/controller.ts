/**
 * AppController: the stateful heart of the runtime. Owns the data folder, the open company
 * (DB + lock), the session and the idle timer. App routes reach it through controllerFor(ctx.app).
 *
 * State machine:
 *   no company ──open/create──▶ company open ──(security on)──▶ pendingLogin ──login──▶ session
 *                                     │ (security off) ─────────────────────────────▶ implicit session
 *   close / switching company / shutdown → back to "no company" (session dropped, lock released)
 *   logout / idle timeout → pendingLogin (company stays open)
 *
 * Lifecycle operations are serialised (one at a time) so double-clicks or overlapping IPC calls
 * cannot open two companies or interleave a login with a close. Operations that close the database
 * first wait (bounded) for in-flight asynchronous company routes (`transactional: false`) to finish.
 *
 * Resilience: if the open company's database becomes unreadable (network drive gone, USB stick
 * removed) the last known company facts are used, so app routes — including close — keep working.
 */
import path from 'node:path';
import type {
  AppState,
  ChangePasswordInput,
  CompanyListItem,
  CreateCompanyInput,
  DataDirChangeInput,
  LoginInput,
  OpenCompanySummary,
  SessionInfo,
} from '../../shared/types/app.ts';
import type { AppRuntime, Clock, OpenCompanyInfo, Session } from '../api/context.ts';
import type { DispatchState } from '../api/dispatch.ts';
import { Db } from '../db/db.ts';
import { appendAudit } from '../lib/audit.ts';
import { hashPassword } from '../lib/crypto.ts';
import { AppError, validation } from '../lib/errors.ts';
import { isInside, probeWritable, samePath } from '../lib/fsutil.ts';
import { getFeatures, getOpenCompanySummary, readSetting } from '../modules/company/service.ts';
import { normalizeCompanyIdentity } from '../modules/company/validation.ts';
import { buildSession, changePassword, implicitSession, LOCKOUT_MS, login, MAX_FAILED_ATTEMPTS, toSessionInfo, verifyOwnerCredentials } from './auth.ts';
import { CompanyStore, type CompanyPaths, type OpenedCompany } from './companies.ts';
import type { AppConfigStore } from './config.ts';
import { transferDataDir } from './datadir.ts';
import { LOCK_HEARTBEAT_MS } from './lock.ts';
import type { Logger } from './logger.ts';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Longest a close/switch waits for in-flight async company routes before closing anyway. */
export const DRAIN_TIMEOUT_MS = 30_000;

export interface ControllerOptions {
  config: AppConfigStore;
  appVersion: string;
  clock: Clock;
  logger: Logger;
  /** Default idle timeout for secured companies (ms). A company may override it via settings 'security'.idleTimeoutMinutes. */
  idleTimeoutMs?: number;
  /**
   * Approves a new data folder chosen by the user (Electron main passes a check against folders the
   * user picked in a native dialog, so a compromised renderer cannot redirect — or 'move' — the data
   * to an arbitrary location). The current folder is always allowed. Omitted: every path is allowed.
   */
  authorizeDataDir?: (absPath: string) => boolean;
}

export interface DeleteCompanyRequest {
  id: string;
  confirmName: string;
  username?: string;
  password?: string;
}

interface OpenState {
  opened: OpenedCompany;
  heartbeat: ReturnType<typeof setInterval>;
  /** Last successfully read company facts (fallback when the DB cannot be read). */
  info: OpenCompanyInfo;
  summary: OpenCompanySummary;
  idleTimeoutMs: number;
  /** Set once a read failure has been logged (avoid flooding the log on every call). */
  readFailed: boolean;
}

export interface InstallCompanyResult {
  company: CompanyListItem;
  paths: CompanyPaths;
  replacedTo: string | null;
}

const controllers = new WeakMap<AppRuntime, AppController>();

/** Resolve the controller behind an AppCtx.app (app routes only). */
export function controllerFor(app: AppRuntime): AppController {
  const c = controllers.get(app);
  if (!c) throw new AppError('INTERNAL', 'App routes require the Bahi runtime');
  return c;
}

export class AppController {
  readonly app: AppRuntime;
  readonly clock: Clock;
  private readonly config: AppConfigStore;
  private readonly appVersion: string;
  private readonly logger: Logger;
  private readonly defaultIdleMs: number;
  private readonly authorizeDataDir: ((absPath: string) => boolean) | undefined;
  private store: CompanyStore;
  private open: OpenState | null = null;
  private session: Session | null = null;
  private mustChangePassword = false;
  private lastActivityMs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** In-flight asynchronous company route calls (settled-or-not), see drainInflight(). */
  private readonly inflight = new Set<Promise<void>>();
  /** Failed owner-password confirmations for company deletion, per company id (in memory). */
  private readonly deleteFailures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(opts: ControllerOptions) {
    this.config = opts.config;
    this.appVersion = opts.appVersion;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.defaultIdleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.authorizeDataDir = opts.authorizeDataDir;
    this.store = this.makeStore(this.config.dataDir);
    const self = this;
    this.app = {
      get dataDir() {
        return self.store.dataDir;
      },
      appVersion: opts.appVersion,
      log: (level, message, meta) => self.logger.log(level, message, meta),
    };
    controllers.set(this.app, this);
  }

  private makeStore(dataDir: string): CompanyStore {
    const store = new CompanyStore({ dataDir, appVersion: this.appVersion, clock: this.clock, log: (l, m, meta) => this.logger.log(l, m, meta) });
    try {
      store.ensureLayout();
    } catch (err) {
      this.logger.log('error', 'Data folder is not usable', { dataDir, error: err });
    }
    return store;
  }

  /** Run lifecycle operations one at a time. */
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Register an in-flight async company route call (the dispatcher calls this). */
  private track(work: Promise<unknown>): void {
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    void settled.then(() => this.inflight.delete(settled));
  }

  /** Wait (bounded) for in-flight async company routes before the database is closed under them. */
  private async drainInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
    });
    await Promise.race([Promise.all([...this.inflight]), timeout]);
    clearTimeout(timer);
    if (this.inflight.size > 0) this.logger.log('warn', 'Closing the company while background work is still running', { pending: this.inflight.size });
  }

  // ───────────────────────────── State ─────────────────────────────

  hasOpenCompany(): boolean {
    return this.open !== null;
  }

  get dataDir(): string {
    return this.store.dataDir;
  }

  listCompanies(): CompanyListItem[] {
    return this.store.list();
  }

  private readInfo(opened: OpenedCompany): OpenCompanyInfo {
    const db = opened.db;
    const features = getFeatures(db);
    return {
      id: opened.id,
      name: (db.value<string>('SELECT name FROM company WHERE id = 1') ?? opened.name) as string,
      dbPath: opened.dbPath,
      dir: opened.dir,
      gstEnabled: features.gst,
      securityEnabled: features.security,
    };
  }

  /** Read fresh company facts; fall back to the last good ones if the database cannot be read. */
  private refresh(o: OpenState): OpenCompanyInfo {
    try {
      o.info = this.readInfo(o.opened);
      o.idleTimeoutMs = this.idleTimeoutFor(o.opened.db);
      o.readFailed = false;
    } catch (err) {
      if (!o.readFailed) this.logger.log('error', 'Open company could not be read', { id: o.opened.id, error: err });
      o.readFailed = true;
    }
    return o.info;
  }

  private summaryFor(o: OpenState): OpenCompanySummary {
    if (o.readFailed) return o.summary;
    try {
      o.summary = getOpenCompanySummary(o.opened.db, o.opened.id);
    } catch (err) {
      this.logger.log('error', 'Open company summary could not be read', { id: o.opened.id, error: err });
    }
    return o.summary;
  }

  /**
   * Effective session for the open company:
   *  - an implicit session is dropped as soon as security gets switched on (login required);
   *  - with security off there is always a session: after a logout (or the end of a real user's
   *    session) the implicit owner session returns, instead of a login prompt nobody needs.
   */
  private effectiveSession(info: OpenCompanyInfo | null): Session | null {
    if (!info) return this.session;
    if (this.session?.implicit && info.securityEnabled) this.session = null;
    else if (!this.session && !info.securityEnabled) {
      this.session = implicitSession(this.clock.now());
      this.mustChangePassword = false;
    }
    return this.session;
  }

  state(): AppState {
    const cfg = this.config.get();
    const o = this.open;
    const info = o ? this.refresh(o) : null;
    const session = this.effectiveSession(info);
    return {
      appVersion: this.appVersion,
      dataDir: this.store.dataDir,
      firstRun: !cfg.firstRunComplete,
      companies: this.store.list(),
      company: o && session ? this.summaryFor(o) : null,
      session: session ? toSessionInfo(session, this.mustChangePassword) : null,
      pendingLogin: o && !session && info ? { companyId: o.opened.id, companyName: info.name } : null,
    };
  }

  /** Per-call snapshot for the dispatcher. */
  dispatchState(): DispatchState {
    const o = this.open;
    const info = o ? this.refresh(o) : null;
    return {
      app: this.app,
      clock: this.clock,
      company: info,
      db: o ? o.opened.db : null,
      session: this.effectiveSession(info),
      mustChangePassword: this.mustChangePassword,
      // The idle timeout protects secured companies only (the implicit session never expires anyway).
      idleTimeoutMs: o && info?.securityEnabled ? o.idleTimeoutMs : 0,
      lastActivityMs: this.lastActivityMs,
      touch: (ms) => {
        this.lastActivityMs = ms;
      },
      expireSession: () => this.endSession('idle'),
      track: (work) => this.track(work),
    };
  }

  touchSession(): SessionInfo | null {
    const s = this.dispatchState().session;
    if (!s) return null;
    this.lastActivityMs = this.clock.now().getTime();
    return toSessionInfo(s, this.mustChangePassword);
  }

  // ───────────────────────────── Company lifecycle ─────────────────────────────

  private idleTimeoutFor(db: Db): number {
    const sec = readSetting(db, 'security') as { idleTimeoutMinutes?: unknown } | undefined;
    const minutes = sec?.idleTimeoutMinutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) return Math.round(minutes * 60_000);
    return this.defaultIdleMs;
  }

  /**
   * Open `id`, replacing the current company only once the new one has opened successfully (a locked,
   * missing or too-new company leaves the current one open and usable).
   */
  private openInternal(id: string): void {
    if (this.open?.opened.id === id) return;
    const opened = this.store.open(id);
    let info: OpenCompanyInfo;
    let summary: OpenCompanySummary;
    let idleTimeoutMs: number;
    try {
      info = this.readInfo(opened);
      summary = getOpenCompanySummary(opened.db, id);
      idleTimeoutMs = this.idleTimeoutFor(opened.db);
    } catch (err) {
      this.store.close(opened);
      throw err;
    }
    if (this.open) this.closeInternal();
    const heartbeat = setInterval(() => opened.lock.heartbeat(this.clock.now()), LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    this.open = { opened, heartbeat, info, summary, idleTimeoutMs, readFailed: false };
    this.session = info.securityEnabled ? null : implicitSession(this.clock.now());
    this.mustChangePassword = false;
    this.lastActivityMs = this.clock.now().getTime();
    this.store.registry.touch(id, this.clock.now());
    try {
      this.config.noteOpened(id);
    } catch (err) {
      this.logger.log('warn', 'Could not update recent companies', { error: err });
    }
    this.logger.log('info', 'Company opened', { id });
  }

  private closeInternal(): void {
    const o = this.open;
    if (!o) return;
    this.endSession('close');
    clearInterval(o.heartbeat);
    this.open = null;
    this.session = null;
    this.mustChangePassword = false;
    try {
      this.store.close(o.opened);
    } catch (err) {
      this.logger.log('error', 'Error while closing company', { id: o.opened.id, error: err });
    }
    this.logger.log('info', 'Company closed', { id: o.opened.id });
  }

  /** Drop a real user's session (audited). The implicit session is kept unless the company closes. */
  private endSession(reason: 'logout' | 'idle' | 'close' | 'switch'): void {
    const s = this.session;
    const o = this.open;
    if (!s || s.implicit) {
      if (reason === 'close') this.session = null;
      return;
    }
    if (o) {
      try {
        appendAudit(o.opened.db, { action: 'logout', entityType: 'user', entityId: s.userId ?? undefined, entityLabel: s.username, after: { reason } }, s, this.clock.now());
      } catch (err) {
        this.logger.log('warn', 'Could not record logout', { error: err });
      }
    }
    this.session = null;
    this.mustChangePassword = false;
  }

  private markFirstRunComplete(): void {
    if (!this.config.get().firstRunComplete) this.config.update({ firstRunComplete: true });
  }

  createCompany(input: CreateCompanyInput): Promise<AppState> {
    return this.exclusive(async () => {
      normalizeCompanyIdentity(input); // fail fast on GSTIN/PAN rules
      const hash = input.owner ? await hashPassword(input.owner.password) : undefined;
      // Create first: the current company stays open if creation fails.
      const created = this.store.create(input, hash);
      this.markFirstRunComplete();
      await this.drainInflight();
      this.openInternal(created.id);
      const o = this.open as OpenState | null;
      if (!o) throw new AppError('INTERNAL', 'Company was created but could not be opened');
      const db = o.opened.db;
      const now = this.clock.now();
      if (created.ownerUserId !== null) {
        // The person who just chose the owner password is logged in straight away.
        const session = buildSession(db, created.ownerUserId, now);
        db.run('UPDATE users SET last_login_at = :ts WHERE id = :id', { ts: now.toISOString(), id: created.ownerUserId });
        this.session = session;
      }
      const summary = getOpenCompanySummary(db, created.id);
      appendAudit(
        db,
        { action: 'create', entityType: 'company', entityId: 1, entityGuid: created.companyGuid, entityLabel: summary.name, after: summary },
        this.session,
        now,
      );
      if (this.session && !this.session.implicit)
        appendAudit(db, { action: 'login', entityType: 'user', entityId: this.session.userId ?? undefined, entityLabel: this.session.username }, this.session, now);
      return this.state();
    });
  }

  openCompany(id: string): Promise<AppState> {
    return this.exclusive(async () => {
      if (this.open && this.open.opened.id !== id) await this.drainInflight();
      this.openInternal(id);
      return this.state();
    });
  }

  closeCompany(): Promise<AppState> {
    return this.exclusive(async () => {
      await this.drainInflight();
      this.closeInternal();
      return this.state();
    });
  }

  deleteCompany(req: DeleteCompanyRequest): Promise<CompanyListItem[]> {
    return this.exclusive(async () => {
      if (this.open?.opened.id === req.id) throw new AppError('CONFLICT', 'Close this company before deleting it.');
      const meta = this.store.readMeta(req.id);
      if (req.confirmName.trim() !== meta.name.trim())
        throw validation([{ path: 'confirmName', message: 'Type the company name exactly as shown to confirm deletion' }]);
      if (meta.securityEnabled) {
        if (!req.password) throw validation([{ path: 'password', message: 'Enter the owner password to delete a secured company' }]);
        // Same lockout policy as login (5 failures → 5 minutes), kept in memory per company.
        const nowMs = this.clock.now().getTime();
        const failures = this.deleteFailures.get(req.id);
        if (failures && failures.lockedUntil > nowMs) {
          const minutes = Math.max(1, Math.ceil((failures.lockedUntil - nowMs) / 60_000));
          throw new AppError('LOCKED', `Too many incorrect owner passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        }
        const db = new Db(this.store.paths(req.id).dbPath, { readOnly: true });
        let ok = false;
        try {
          ok = await verifyOwnerCredentials(db, req.password, req.username);
        } finally {
          db.close();
        }
        if (!ok) {
          // An expired lockout starts a fresh count; otherwise keep counting.
          const count = (failures && failures.lockedUntil === 0 ? failures.count : 0) + 1;
          const locked = count >= MAX_FAILED_ATTEMPTS;
          this.deleteFailures.set(req.id, { count: locked ? 0 : count, lockedUntil: locked ? nowMs + LOCKOUT_MS : 0 });
          this.logger.log('warn', 'Company deletion refused: owner password incorrect', { id: req.id, locked });
          if (locked) throw new AppError('LOCKED', `Too many incorrect owner passwords. Try again in ${Math.round(LOCKOUT_MS / 60_000)} minutes.`);
          throw new AppError('UNAUTHENTICATED', 'Owner username or password is incorrect');
        }
        this.deleteFailures.delete(req.id);
      }
      this.store.moveToTrash(req.id, req.confirmName);
      try {
        this.config.forget(req.id);
      } catch (err) {
        this.logger.log('warn', 'Could not update recent companies', { error: err });
      }
      return this.store.list();
    });
  }

  // ───────────────────────────── Authentication ─────────────────────────────

  loginUser(input: LoginInput): Promise<AppState> {
    return this.exclusive(async () => {
      const o = this.open;
      if (!o) throw new AppError('NO_COMPANY', 'Open a company first.');
      if (this.session && !this.session.implicit) this.endSession('switch');
      const result = await login(o.opened.db, input.username, input.password, this.clock.now());
      if (this.open !== o) throw new AppError('CONFLICT', 'The company was closed while logging in. Please open it again.');
      this.session = result.session;
      this.mustChangePassword = result.mustChangePassword;
      this.lastActivityMs = this.clock.now().getTime();
      return this.state();
    });
  }

  logout(): Promise<AppState> {
    return this.exclusive(() => {
      this.endSession('logout');
      return this.state();
    });
  }

  changeOwnPassword(input: ChangePasswordInput): Promise<{ ok: true }> {
    return this.exclusive(async () => {
      const o = this.open;
      const s = this.session;
      if (!o || !s) throw new AppError('UNAUTHENTICATED', 'Please log in to continue.');
      const r = await changePassword(o.opened.db, s, input, this.clock.now());
      this.mustChangePassword = false;
      return r;
    });
  }

  // ───────────────────────────── Data folder ─────────────────────────────

  setDataDir(input: DataDirChangeInput): Promise<AppState> {
    return this.exclusive(() => {
      if (this.open) throw new AppError('CONFLICT', 'Close the company before changing the data folder.');
      if (!path.isAbsolute(input.path)) throw validation([{ path: 'path', message: 'Choose a full folder path (for example D:\\BahiData)' }]);
      const target = path.resolve(input.path);
      if (samePath(target, this.store.dataDir)) {
        this.markFirstRunComplete();
        return this.state();
      }
      if (this.authorizeDataDir && !this.authorizeDataDir(target))
        throw new AppError('FORBIDDEN', 'Choose the new data folder with the Browse button.');
      if (input.mode !== 'use' && isInside(target, this.store.dataDir))
        throw validation([{ path: 'path', message: 'The new folder cannot be inside the current data folder' }]);
      const problem = probeWritable(target);
      if (problem) throw validation([{ path: 'path', message: `Bahi ERP cannot write to this folder (${problem})` }]);

      if (input.mode === 'copy' || input.mode === 'move') {
        transferDataDir({ from: this.store, to: target, mode: input.mode, clock: this.clock, log: this.app.log });
      }
      this.config.update({ dataDir: target, firstRunComplete: true });
      this.store = this.makeStore(target);
      this.logger.log('info', 'Data folder changed', { mode: input.mode });
      return this.state();
    });
  }

  // ───────────────────────────── Restore / install ─────────────────────────────

  /**
   * Install a company database file (e.g. a decrypted backup) into the data folder — for the data
   * module's restore. See CompanyStore.install. Replacing the company that is open here is refused;
   * the caller should ask the user to close it first. Usable from a `transactional: false` company
   * route via controllerFor(ctx.app).
   */
  installCompanyDatabase(sourceDbPath: string, opts: { replaceId?: string } = {}): Promise<InstallCompanyResult> {
    return this.exclusive(() => {
      if (!path.isAbsolute(sourceDbPath)) throw validation([{ path: 'file', message: 'A full file path is required' }]);
      if (opts.replaceId !== undefined && this.open?.opened.id === opts.replaceId)
        throw new AppError('CONFLICT', 'Close this company before restoring over it.');
      const r = this.store.install(sourceDbPath, opts);
      if (r.replacedTo) {
        try {
          this.config.forget(r.paths.id);
        } catch (err) {
          this.logger.log('warn', 'Could not update recent companies', { error: err });
        }
      }
      const company = this.store.list().find((c) => c.id === r.paths.id);
      if (!company) throw new AppError('INTERNAL', 'The restored company could not be read back');
      return { company, paths: r.paths, replacedTo: r.replacedTo };
    });
  }

  // ───────────────────────────── Shutdown ─────────────────────────────

  shutdown(): Promise<void> {
    return this.exclusive(async () => {
      await this.drainInflight();
      this.closeInternal();
    });
  }
}
