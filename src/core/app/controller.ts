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
import type { AppRuntime, AuditAnchorStore, BackupFolderApprovals, Clock, OpenCompanyInfo, PathUse, Session } from '../api/context.ts';
import type { DispatchState } from '../api/dispatch.ts';
import { exclusiveJobFor, whenJobDone } from '../api/jobs.ts';
import { Db } from '../db/db.ts';
import { appendAudit } from '../lib/audit.ts';
import { auditHead, checkAuditAnchor, type AuditHead } from '../lib/auditAnchor.ts';
import { hashPassword } from '../lib/crypto.ts';
import { AppError, validation } from '../lib/errors.ts';
import { isInside, probeWritable, samePath } from '../lib/fsutil.ts';
import { getFeatures, getOpenCompanySummary, readSetting } from '../modules/company/service.ts';
import { normalizeCompanyIdentity } from '../modules/company/validation.ts';
import { AttemptLimiter, buildSession, changePassword, confirmOwnerPassword, implicitSession, login, MAX_ATTEMPTS_PER_MINUTE, toSessionInfo } from './auth.ts';
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
  /** Approves other renderer-supplied paths (backup files/folders); exposed as AppRuntime.authorizePath. */
  authorizePath?: (absPath: string, use: PathUse) => boolean;
  /** Out-of-database edit-log anchors (exposed as AppRuntime.auditAnchors). Omitted: no anchoring. */
  auditAnchors?: AuditAnchorStore;
  /** Backup folders approved on this installation (exposed as AppRuntime.backupFolders). */
  backupFolders?: BackupFolderApprovals;
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
  /** company.guid (anchors are bound to it). */
  companyGuid: string;
  /** Edit-log head last written to the anchor store (null: nothing anchored yet). */
  anchored: AuditHead | null;
  /**
   * The edit log no longer contains the anchored entry (rewritten or truncated outside the app): the
   * old anchor is kept as evidence and not refreshed until an Owner resets it (security.audit.resetAnchor)
   * or the company is restored from a backup.
   */
  anchorFrozen: boolean;
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
  if (!c) throw new AppError('INTERNAL', 'App routes require the Pevqori runtime');
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
  private readonly anchors: AuditAnchorStore | undefined;
  private store: CompanyStore;
  private open: OpenState | null = null;
  private session: Session | null = null;
  private mustChangePassword = false;
  private lastActivityMs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** In-flight asynchronous company route calls (settled-or-not), see drainInflight(). */
  private readonly inflight = new Set<Promise<void>>();
  /** Per-company rate limit on credential checks (login, owner confirmations); see auth.ts. */
  private readonly attempts = new AttemptLimiter(MAX_ATTEMPTS_PER_MINUTE, 60_000);

  constructor(opts: ControllerOptions) {
    this.config = opts.config;
    this.appVersion = opts.appVersion;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.defaultIdleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.authorizeDataDir = opts.authorizeDataDir;
    this.anchors = opts.auditAnchors;
    this.store = this.makeStore(this.config.dataDir);
    const self = this;
    const authorizePath = opts.authorizePath;
    this.app = {
      get dataDir() {
        return self.store.dataDir;
      },
      appVersion: opts.appVersion,
      log: (level, message, meta) => self.logger.log(level, message, meta),
      ...(authorizePath ? { authorizePath: (absPath: string, use: PathUse) => authorizePath(absPath, use) } : {}),
      ...(opts.auditAnchors ? { auditAnchors: opts.auditAnchors } : {}),
      ...(opts.backupFolders ? { backupFolders: opts.backupFolders } : {}),
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
    try {
      store.sweepTemporaryFiles(); // plaintext leftovers of a crash (decrypted backup copies, snapshots)
    } catch (err) {
      this.logger.log('warn', 'Could not clean up temporary files', { error: err });
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
      session: session ? this.sessionInfo(session, o, info) : null,
      pendingLogin: o && !session && info ? { companyId: o.opened.id, companyName: info.name } : null,
      dataDirError: this.store.availabilityProblem(),
    };
  }

  /** Per-call snapshot for the dispatcher. */
  dispatchState(): DispatchState {
    const o = this.open;
    if (o) this.refreshAnchor(o); // records what the previous calls committed
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

  /** SessionInfo for the renderer, with the idle timeout the shell's lock timer uses. */
  private sessionInfo(session: Session, o: OpenState | null, info: OpenCompanyInfo | null): SessionInfo {
    const idleTimeoutMs = !session.implicit && o && info?.securityEnabled ? o.idleTimeoutMs : 0;
    return { ...toSessionInfo(session, this.mustChangePassword), idleTimeoutMs };
  }

  touchSession(): SessionInfo | null {
    const st = this.dispatchState();
    const s = st.session;
    if (!s) return null;
    this.lastActivityMs = this.clock.now().getTime();
    return this.sessionInfo(s, this.open, st.company);
  }

  /**
   * The shell's idle timer fired (no keyboard/mouse input for the idle timeout): end a real user's
   * session as 'idle' (audited) — the company stays open and the renderer shows its lock screen.
   * Background API calls (refetches, polling) keep the server-side clock alive, so the user's own
   * inactivity is decided by the renderer; the dispatcher's lazy check stays the authority for
   * every call. The implicit session (security off) never locks.
   */
  lockSession(): Promise<AppState> {
    return this.exclusive(() => {
      if (this.session && !this.session.implicit) this.endSession('idle');
      return this.state();
    });
  }

  // ───────────────────────────── Edit-log anchor ─────────────────────────────

  /**
   * Compare the opened company's edit log with its stored anchor; freeze anchoring on a mismatch so
   * the evidence is kept (security.audit.verify reports it). Never throws: the books stay usable.
   */
  private initAnchor(id: string, db: Db): { companyGuid: string; anchored: AuditHead | null; anchorFrozen: boolean } {
    const companyGuid = db.value<string>('SELECT guid FROM company WHERE id = 1') ?? '';
    const store = this.anchors;
    if (!store) return { companyGuid, anchored: null, anchorFrozen: false };
    try {
      const anchor = store.get(id);
      const check = checkAuditAnchor(db, anchor, anchor ? store.verify(anchor) : false, companyGuid);
      if (check.status === 'mismatch' || check.status === 'invalid') {
        this.logger.log('warn', 'The edit log does not match its saved check-point', { id, reason: check.reason, anchoredId: check.anchoredId });
        return { companyGuid, anchored: null, anchorFrozen: true };
      }
      return { companyGuid, anchored: anchor && check.status === 'match' ? { lastId: anchor.lastId, lastHash: anchor.lastHash } : null, anchorFrozen: false };
    } catch (err) {
      this.logger.log('warn', 'Could not check the edit-log check-point', { id, error: err });
      return { companyGuid, anchored: null, anchorFrozen: false };
    }
  }

  /** Record the current head of the open company's edit log outside the database (if it moved). */
  private refreshAnchor(o: OpenState): void {
    const store = this.anchors;
    if (!store || o.anchorFrozen || o.readFailed) return;
    const db = o.opened.db;
    if (db.inTransaction) return; // only committed heads are anchored
    try {
      const head = auditHead(db);
      if (!head || (o.anchored && head.lastId === o.anchored.lastId && head.lastHash === o.anchored.lastHash)) return;
      // The previously anchored entry must still be there, unchanged (the file may be written by
      // another process while open): otherwise keep the old anchor as evidence.
      if (o.anchored) {
        const still = db.value<string>('SELECT hash FROM audit_log WHERE id = :id', { id: o.anchored.lastId });
        if (still !== o.anchored.lastHash || head.lastId < o.anchored.lastId) {
          o.anchorFrozen = true;
          this.logger.log('warn', 'The edit log changed outside Pevqori while the company was open', { id: o.opened.id });
          return;
        }
      }
      store.put({ companyId: o.opened.id, companyGuid: o.companyGuid, ...head }, this.clock.now());
      o.anchored = head;
    } catch (err) {
      this.logger.log('warn', 'Could not record the edit-log check-point', { id: o.opened.id, error: err });
    }
  }

  /**
   * Owner action after a reported mismatch (e.g. the company files were copied back by hand): accept
   * the current edit log as the new check-point. The caller appends an audit entry first.
   */
  resetAuditAnchor(): { anchoredId: number | null } {
    const o = this.open;
    if (!o) throw new AppError('NO_COMPANY', 'Open a company first.');
    if (!this.anchors) return { anchoredId: null };
    o.anchorFrozen = false;
    o.anchored = null;
    this.refreshAnchor(o);
    return { anchoredId: o.anchored ? (o.anchored as AuditHead).lastId : null };
  }

  /** Anchor a company that is not open (after a restore installed its database). */
  private anchorInstalled(id: string, dbPath: string): void {
    const store = this.anchors;
    if (!store) return;
    try {
      const db = new Db(dbPath, { readOnly: true, timeoutMs: 2000 });
      try {
        const head = auditHead(db);
        const companyGuid = db.value<string>('SELECT guid FROM company WHERE id = 1') ?? '';
        if (head) store.put({ companyId: id, companyGuid, ...head }, this.clock.now());
        else store.remove(id);
      } finally {
        db.close();
      }
    } catch (err) {
      this.logger.log('warn', 'Could not record the edit-log check-point of the restored company', { id, error: err });
    }
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
    let anchor: ReturnType<AppController['initAnchor']>;
    try {
      info = this.readInfo(opened);
      summary = getOpenCompanySummary(opened.db, id);
      idleTimeoutMs = this.idleTimeoutFor(opened.db);
      anchor = this.initAnchor(id, opened.db);
    } catch (err) {
      this.store.close(opened);
      throw err;
    }
    if (this.open) this.closeInternal();
    const heartbeat = setInterval(() => opened.lock.heartbeat(this.clock.now()), LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    this.open = { opened, heartbeat, info, summary, idleTimeoutMs, readFailed: false, ...anchor };
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
    this.refreshAnchor(o); // the final head (including the logout entry)
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
      const db = o.opened.db;
      const at = this.clock.now();
      const record = (): void => {
        try {
          if (!db.isOpen) throw new Error('the company database was closed');
          appendAudit(db, { action: 'logout', entityType: 'user', entityId: s.userId ?? undefined, entityLabel: s.username, after: { reason } }, s, at);
        } catch (err) {
          this.logger.log('warn', 'Could not record logout', { error: err });
        }
      };
      // An import job holds one open transaction on this connection (api/jobs.ts): written now, the
      // entry would join it — and vanish when a preview (always) or a failed import rolls back. The
      // session ends at once; only its edit-log entry waits for the job to finish.
      if (exclusiveJobFor(db)) void whenJobDone(db).then(record);
      else record();
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
        // The company's own login lockout (DB-backed, shared with its login screen) and edit log.
        this.throttleCredentialCheck(req.id, 'owner');
        const db = new Db(this.store.paths(req.id).dbPath, { timeoutMs: 2000 });
        try {
          await confirmOwnerPassword(db, { password: req.password, username: req.username, context: 'company.delete' }, this.clock.now());
        } catch (err) {
          if (err instanceof AppError) this.logger.log('warn', 'Company deletion refused: owner password not confirmed', { id: req.id, code: err.code });
          throw err;
        } finally {
          db.close();
        }
      }
      this.store.moveToTrash(req.id, req.confirmName);
      try {
        this.anchors?.remove(req.id);
      } catch (err) {
        this.logger.log('warn', 'Could not remove the edit-log check-point of a deleted company', { error: err });
      }
      try {
        this.config.forget(req.id);
      } catch (err) {
        this.logger.log('warn', 'Could not update recent companies', { error: err });
      }
      return this.store.list();
    });
  }

  // ───────────────────────────── Authentication ─────────────────────────────

  /**
   * Login and password changes write to the company database outside the dispatcher. While an import
   * job holds the connection's one open transaction (api/jobs.ts) those writes would join it and be
   * rolled back with it — the edit-log entries AND the failed-attempt counters (a lockout bypass) —
   * so they are refused with the job's message until it finishes.
   */
  private refuseDuringJob(o: OpenState): void {
    const job = exclusiveJobFor(o.opened.db);
    if (job) throw new AppError('CONFLICT', job.message);
  }

  /** Count one credential check against a company (rate limit, see AttemptLimiter); throws LOCKED. */
  throttleCredentialCheck(companyId: string, purpose: 'login' | 'owner'): void {
    this.attempts.take(`${companyId}|${purpose}`, this.clock.now());
  }

  loginUser(input: LoginInput): Promise<AppState> {
    return this.exclusive(async () => {
      const o = this.open;
      if (!o) throw new AppError('NO_COMPANY', 'Open a company first.');
      // Bounds scripted guessing (each unknown-username attempt is a permanent edit-log row).
      this.refuseDuringJob(o);
      this.throttleCredentialCheck(o.opened.id, 'login');
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
      this.refuseDuringJob(o);
      const r = await changePassword(o.opened.db, s, input, this.clock.now());
      this.mustChangePassword = false;
      return r;
    });
  }

  // ───────────────────────────── Data folder ─────────────────────────────

  setDataDir(input: DataDirChangeInput): Promise<AppState> {
    return this.exclusive(() => {
      if (this.open) throw new AppError('CONFLICT', 'Close the company before changing the data folder.');
      if (!path.isAbsolute(input.path)) throw validation([{ path: 'path', message: 'Choose a full folder path (for example D:\\PevqoriData)' }]);
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
      if (problem) throw validation([{ path: 'path', message: `Pevqori cannot write to this folder (${problem})` }]);

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
  installCompanyDatabase(sourceDbPath: string, opts: { replaceId?: string; attachmentsDir?: string } = {}): Promise<InstallCompanyResult> {
    return this.exclusive(() => {
      if (!path.isAbsolute(sourceDbPath)) throw validation([{ path: 'file', message: 'A full file path is required' }]);
      if (opts.replaceId !== undefined && this.open?.opened.id === opts.replaceId)
        throw new AppError('CONFLICT', 'Close this company before restoring over it.');
      const r = this.store.install(sourceDbPath, opts);
      // A restore legitimately replaces the edit log (it records the restore itself): start a new anchor.
      this.anchorInstalled(r.paths.id, r.paths.dbPath);
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
