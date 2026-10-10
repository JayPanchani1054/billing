/**
 * Handler contexts. Built by the dispatcher (src/core/api/dispatch.ts) for every call.
 * Stable surface used by all modules — extend, don't rename.
 */
import type { Permission } from '../../shared/constants.ts';
import type { Db } from '../db/db.ts';

export interface Clock {
  now(): Date;
  /** Local calendar date 'YYYY-MM-DD' (system time zone; India is UTC+05:30). */
  today(): string;
}

export interface Session {
  /** null when company security is disabled (implicit owner session). */
  userId: number | null;
  username: string;
  displayName: string;
  role: string;
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
  implicit: boolean;
  startedAt: string;
}

export type AuditAction =
  | 'create'
  | 'alter'
  | 'delete'
  | 'cancel'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'export'
  | 'import'
  | 'backup'
  | 'restore'
  | 'settings'
  | 'security';

export interface AuditEntry {
  action: AuditAction;
  entityType?: string;
  entityId?: number;
  entityGuid?: string;
  entityLabel?: string;
  before?: unknown;
  after?: unknown;
}

export interface OpenCompanyInfo {
  /** Folder id under <dataDir>/companies/ (stable, filesystem-safe). */
  id: string;
  name: string;
  /** Absolute path of company.db */
  dbPath: string;
  /** Absolute path of the company folder (attachments, exports). */
  dir: string;
  gstEnabled: boolean;
  securityEnabled: boolean;
}

/** App-level services implemented in src/core/app (data path, company registry, logger). */
/**
 * How a renderer-supplied path will be used (see AppRuntime.authorizePath and core/lib/paths.ts):
 * read one file, list a folder, or write files into a folder.
 */
export type PathUse = 'read-file' | 'read-dir' | 'write-dir';

export interface AppRuntime {
  readonly dataDir: string;
  readonly appVersion: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void;
  /**
   * Approves a path that came from the renderer (§8: the renderer never supplies arbitrary paths).
   * Electron main answers from the files/folders the user picked in a native dialog this session.
   * Absent (tests, headless use): ordinary local paths are allowed, UNC/device paths are refused.
   * Use core/lib/paths.ts authorizeUserPath() rather than calling this directly.
   */
  authorizePath?(absPath: string, use: PathUse): boolean;
  /**
   * Out-of-database anchor store for the edit-log hash chain (app config under userData). Absent in
   * tests that do not exercise it. See core/lib/auditAnchor.ts.
   */
  readonly auditAnchors?: AuditAnchorStore;
  /**
   * Backup folders the user approved on THIS installation, per company (app/backupFolders.ts, under
   * userData). A company's F12 backup folder is written to — by automatic or manual backups, and as a
   * trusted root — only when it is approved here. Absent (tests, headless use): every configured
   * folder counts as approved.
   */
  readonly backupFolders?: BackupFolderApprovals;
}

/** Per-installation approvals of company backup folders (see AppRuntime.backupFolders). */
export interface BackupFolderApprovals {
  isApproved(companyGuid: string, folder: string): boolean;
  /** Record that the user picked `folder` for this company on this installation. */
  approve(companyGuid: string, folder: string, now: Date): void;
}

/**
 * Latest known head of one company's edit log, kept OUTSIDE the company database (core/lib/auditAnchor.ts).
 * Keyed by company folder id; the MAC is HMAC-SHA256 with a per-installation key that is never stored
 * in a company file or a backup.
 */
export interface AuditAnchor {
  companyId: string;
  companyGuid: string;
  lastId: number;
  lastHash: string;
  /** When this head was recorded (ISO). */
  at: string;
  mac: string;
}

export interface AuditAnchorStore {
  get(companyId: string): AuditAnchor | null;
  /** Record (replace) the head of a company's edit log; computes the MAC. */
  put(head: Omit<AuditAnchor, 'mac' | 'at'>, now: Date): AuditAnchor;
  /** Remove the anchor (company deleted). */
  remove(companyId: string): void;
  /** HMAC over any anchor-shaped record (false: edited, or made with another installation's key). */
  verify(anchor: AuditAnchor): boolean;
  /** MAC for a head that is not stored here (e.g. the one written into a backup manifest). */
  sign(head: Omit<AuditAnchor, 'mac'>): string;
}

export interface AppCtx {
  app: AppRuntime;
  clock: Clock;
  session: Session | null;
  company: OpenCompanyInfo | null;
}

export interface CompanyCtx extends AppCtx {
  company: OpenCompanyInfo;
  session: Session;
  db: Db;
  /** Append to the tamper-evident edit log (same transaction as the change). */
  audit(entry: AuditEntry): void;
}
