/**
 * DTOs for the security module (src/core/modules/security): users, roles, company security on/off,
 * security settings (password policy, lockout, idle timeout), the edit log (audit trail) viewer and
 * the current session.
 *
 * Route table (all scope 'company'):
 *
 *   'security.user.list'            SecurityUserListInput         → { rows: SecurityUser[], total }   security.manage
 *   'security.user.get'             { id }                        → SecurityUser                      security.manage
 *   'security.user.save'            SecurityUserSaveInput         → SecurityUser                      security.manage
 *   'security.user.resetPassword'   SecurityResetPasswordInput    → SecurityUser                      security.manage
 *   'security.user.unlock'          { id }                        → SecurityUser                      security.manage
 *   'security.user.delete'          { id }                        → always BUSINESS_RULE (details: UserDeleteRefusal)
 *
 *   'security.role.list'            none                          → { rows: SecurityRole[], total }   security.manage
 *   'security.role.get'             { id }                        → SecurityRole                      security.manage
 *   'security.role.save'            SecurityRoleSaveInput         → SecurityRole                      security.manage
 *   'security.role.delete'          { id }                        → { deleted: true, id }             security.manage
 *   'security.permissions.catalog'  none                          → PermissionCatalog                 authenticated
 *
 *   'security.enable'               SecurityEnableInput           → SecurityEnableResult              company.manage (security must be off)
 *   'security.disable'              SecurityDisableInput          → SecurityDisableResult             security.manage + Owner + password
 *
 *   'security.settings.get'         none                          → SecuritySettings                  security.manage
 *   'security.settings.save'        SecuritySettingsInput         → SecuritySettings                  security.manage
 *   'security.passwordPolicy'       none                          → PasswordPolicyInfo                authenticated
 *
 *   'security.audit.list'           AuditListInput                → { rows: AuditListRow[], total }   audit.view
 *   'security.audit.facets'         none                          → AuditFacets                       audit.view
 *   'security.audit.get'            { id }                        → AuditEntryDetail                  audit.view
 *   'security.audit.entityHistory'  AuditEntityHistoryInput       → AuditEntityHistory                audit.view
 *   'security.audit.verify'         none                          → AuditVerifyReport                 audit.view
 *   'security.audit.export'         AuditExportInput              → AuditExportResult                 audit.view + data.export
 *
 *   'security.mySession'            none                          → MySession                         authenticated
 *
 * Timestamps are ISO-8601 UTC strings; dates are 'YYYY-MM-DD' (local calendar dates).
 */
import type { Permission } from '../constants.ts';

// ───────────────────────────── Limits shared with the UI ─────────────────────────────

/** Usernames: 3–32 characters, letters/digits/dot/dash/underscore, starting with a letter or digit. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const DISPLAY_NAME_MAX_LENGTH = 80;
export const ROLE_NAME_MAX_LENGTH = 60;
export const ROLE_DESCRIPTION_MAX_LENGTH = 200;
/** A new password may not equal any of the user's last N passwords (the current one included). */
export const PASSWORD_HISTORY_DEPTH = 3;
/** Edit-log page size limit. */
export const AUDIT_LIST_MAX_LIMIT = 500;
/** Largest edit-log export in one file. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export interface SecuritySettings {
  /** Minutes of inactivity before a logged-in user must log in again. 0 = never; otherwise 5–240. */
  idleTimeoutMinutes: number;
  /** 8–64 characters. Letters and digits are always required. */
  passwordMinLength: number;
  /** Require at least one upper-case and one lower-case letter. */
  requireMixedCase: boolean;
  /** Require at least one symbol (anything that is not a letter, digit or space). */
  requireSymbol: boolean;
  /** Days after which a password must be changed at the next login. 0 = never; at most 365. */
  passwordExpiryDays: number;
  /** Consecutive failed logins that lock an account: 3–10. */
  lockoutThreshold: number;
  /** How long a locked account stays locked: 1–60 minutes. */
  lockoutMinutes: number;
}

export const DEFAULT_SECURITY_SETTINGS: Readonly<SecuritySettings> = Object.freeze({
  idleTimeoutMinutes: 30,
  passwordMinLength: 8,
  requireMixedCase: false,
  requireSymbol: false,
  passwordExpiryDays: 0,
  lockoutThreshold: 5,
  lockoutMinutes: 5,
});

export const SECURITY_SETTINGS_LIMITS = {
  idleTimeoutMinutes: { min: 5, max: 240, zeroAllowed: true },
  passwordMinLength: { min: 8, max: 64 },
  passwordExpiryDays: { min: 0, max: 365 },
  lockoutThreshold: { min: 3, max: 10 },
  lockoutMinutes: { min: 1, max: 60 },
} as const;

/** Partial update: omitted fields keep their current value. */
export type SecuritySettingsInput = Partial<SecuritySettings>;

/** The policy as shown next to a "new password" field. */
export interface PasswordPolicyInfo {
  minLength: number;
  maxLength: number;
  requireMixedCase: boolean;
  requireSymbol: boolean;
  historyDepth: number;
  expiryDays: number;
  /** Human-readable rules, e.g. 'At least 10 characters', 'At least one digit'. */
  rules: string[];
}

// ───────────────────────────── Users ─────────────────────────────

export interface SecurityUser {
  id: number;
  username: string;
  displayName: string;
  roleId: number;
  roleName: string;
  roleIsSystem: boolean;
  /** Holds the built-in Owner role (all permissions). */
  isOwner: boolean;
  isActive: boolean;
  /** Locked out after failed logins (locked_until is in the future). */
  locked: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  /** When the current password was set (best known; account creation for older accounts). */
  passwordChangedAt: string;
  /** null when passwords never expire. */
  passwordExpiresAt: string | null;
  passwordExpired: boolean;
  /** This is the user of the current session. */
  isSelf: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityUserListInput {
  /** Matches username or display name. */
  search?: string;
  roleId?: number;
  /** Only active users (default false: all users). */
  activeOnly?: boolean;
}

export interface SecurityUserSaveInput {
  /** Absent → create; present → alter. */
  id?: number;
  username: string;
  /** Blank → the username. */
  displayName: string;
  roleId: number;
  isActive: boolean;
  /** Required on create. On alter: omitted = keep the current password. */
  password?: string;
  /** Default on create: true (the user picks their own password at first login). On alter: omitted = keep. */
  mustChangePassword?: boolean;
}

export interface SecurityResetPasswordInput {
  id: number;
  newPassword: string;
  /** Ask the user to choose a new password at their next login (default true). */
  mustChange?: boolean;
}

/** `details` of the BUSINESS_RULE error returned by 'security.user.delete'. */
export interface UserDeleteRefusal {
  reason: 'users_are_kept';
  suggestion: 'deactivate';
  userId: number;
  isActive: boolean;
}

// ───────────────────────────── Roles & permissions ─────────────────────────────

export interface SecurityRole {
  id: number;
  name: string;
  description: string | null;
  /** In canonical (PERMISSIONS) order. The Owner role always lists every permission. */
  permissions: Permission[];
  /** Built-in role: read-only. */
  isSystem: boolean;
  /** The built-in Owner role. */
  isOwner: boolean;
  userCount: number;
  activeUserCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityRoleSaveInput {
  id?: number;
  name: string;
  description?: string | null;
  permissions: Permission[];
}

export interface PermissionCatalogItem {
  permission: Permission;
  /** Short label, e.g. 'Create vouchers'. */
  label: string;
  /** Group › label, e.g. 'Vouchers › Create vouchers'. */
  fullLabel: string;
  /** One sentence for a tooltip. */
  description: string;
}

export interface PermissionCatalogGroup {
  key: string;
  label: string;
  items: PermissionCatalogItem[];
}

export interface PermissionCatalog {
  /** Every permission appears exactly once, grouped for display. */
  groups: PermissionCatalogGroup[];
}

// ───────────────────────────── Security on / off ─────────────────────────────

export interface SecurityEnableInput {
  /** New Owner username — or an existing Owner's username, whose password must then be given. */
  username: string;
  /** Used only when a new Owner user is created (blank → username). */
  displayName?: string;
  password: string;
}

export interface SecurityEnableResult {
  securityEnabled: true;
  ownerUserId: number;
  ownerUsername: string;
  /** false when an existing Owner user was reused. */
  createdOwner: boolean;
  /** The implicit session ends: the app now shows the login screen (call 'app.state'). */
  loginRequired: true;
  message: string;
}

export interface SecurityDisableInput {
  /** The current (Owner) user's password, re-entered to confirm. */
  password: string;
}

export interface SecurityDisableResult {
  securityEnabled: false;
  message: string;
}

// ───────────────────────────── Edit log ─────────────────────────────

export type AuditActionName =
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

export const AUDIT_ACTIONS: readonly AuditActionName[] = [
  'create',
  'alter',
  'delete',
  'cancel',
  'login',
  'logout',
  'login_failed',
  'export',
  'import',
  'backup',
  'restore',
  'settings',
  'security',
];

/** Labels for action filters and exports. */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditActionName, string>> = {
  create: 'Created',
  alter: 'Altered',
  delete: 'Deleted',
  cancel: 'Cancelled',
  login: 'Logged in',
  logout: 'Logged out',
  login_failed: 'Failed login',
  export: 'Exported',
  import: 'Imported',
  backup: 'Backup',
  restore: 'Restore',
  settings: 'Settings changed',
  security: 'Security',
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AuditListInput {
  /** Local calendar dates, inclusive. */
  from?: string;
  to?: string;
  userId?: number;
  actions?: AuditActionName[];
  entityType?: string;
  entityId?: number;
  /** Matches record label, username, record type or action. */
  search?: string;
  /** 1–500 (default 100). */
  limit?: number;
  offset?: number;
  /** Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
}

export interface AuditListRow {
  id: number;
  ts: string;
  userId: number | null;
  username: string | null;
  action: AuditActionName;
  entityType: string | null;
  /** Readable record type, e.g. 'Ledger', 'Features (F11)'. */
  entityTypeLabel: string;
  entityId: number | null;
  entityGuid: string | null;
  entityLabel: string | null;
  /** One line, e.g. 'Changed 2 fields: name, openingBalance'. */
  summary: string;
}

export interface AuditListResult {
  rows: AuditListRow[];
  total: number;
}

export interface AuditFacets {
  entityTypes: Array<{ value: string; label: string; count: number }>;
  users: Array<{ userId: number | null; username: string; count: number }>;
  actions: Array<{ value: AuditActionName; count: number }>;
  firstTs: string | null;
  lastTs: string | null;
}

/**
 * One changed field. `path` uses dot/bracket notation ('lines[2].amount', 'gst.rate').
 * added: absent before; removed: absent after; changed: both present and different.
 * Values are leaf values (or a whole sub-tree when its shape changed, e.g. object → null).
 */
export interface AuditFieldChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: JsonValue | null;
  after: JsonValue | null;
}

export interface AuditEntryDetail extends AuditListRow {
  before: JsonValue | null;
  after: JsonValue | null;
  /** Field-level differences between before and after ('updated_at' noise ignored). */
  changes: AuditFieldChange[];
  changesTruncated: boolean;
  prevHash: string;
  hash: string;
}

export interface AuditEntityHistoryInput {
  entityType: string;
  entityId: number;
  /** Optional: restrict to entries of this record guid (ids of deleted records can be reused). */
  entityGuid?: string;
}

export interface AuditHistoryVersion extends AuditListRow {
  changes: AuditFieldChange[];
  changesTruncated: boolean;
}

export interface AuditEntityHistory {
  entityType: string;
  entityTypeLabel: string;
  entityId: number;
  /** Label of the most recent entry. */
  currentLabel: string | null;
  /** Oldest first. */
  versions: AuditHistoryVersion[];
  truncated: boolean;
}

export interface AuditVerifyReport {
  ok: boolean;
  /** Entries verified (before the break, when broken). */
  count: number;
  totalEntries: number;
  brokenAtId: number | null;
  reason: 'prev_hash_mismatch' | 'hash_mismatch' | null;
  /** Headline for the user. */
  message: string;
  /** What it means / what to do next. */
  detail: string;
  checkedAt: string;
  lastEntryId: number | null;
  /** Hash of the newest entry: write it down (or keep the export) to detect truncation later. */
  lastHash: string | null;
}

export interface AuditExportInput {
  from?: string;
  to?: string;
  format: 'xlsx' | 'csv';
  userId?: number;
  actions?: AuditActionName[];
  entityType?: string;
  entityId?: number;
  search?: string;
}

export interface AuditExportResult {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  rowCount: number;
}

// ───────────────────────────── Session ─────────────────────────────

export interface MySession {
  userId: number | null;
  username: string;
  displayName: string;
  role: string;
  permissions: Permission[];
  isOwner: boolean;
  /** Security is off: single implicit Owner session. */
  implicit: boolean;
  startedAt: string;
  securityEnabled: boolean;
  /** Effective idle timeout for this session (0 = none). Every API call restarts the countdown. */
  idleTimeoutMinutes: number;
  /** When the session ends if nothing else happens (null = never). */
  idleExpiresAt: string | null;
  idleTimeoutRemainingMs: number | null;
  /** The login before this session (from the edit log), for "last login" display. */
  previousLoginAt: string | null;
  /** Failed login attempts on this account between the previous login and this one. */
  failedAttemptsSincePreviousLogin: number;
  passwordChangedAt: string | null;
  passwordExpiresAt: string | null;
  /** Whole days left (0 = expires today); null when passwords never expire. */
  passwordExpiresInDays: number | null;
  canManageSecurity: boolean;
  canViewAudit: boolean;
}
