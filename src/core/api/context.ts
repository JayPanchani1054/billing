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
export interface AppRuntime {
  readonly dataDir: string;
  readonly appVersion: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void;
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
