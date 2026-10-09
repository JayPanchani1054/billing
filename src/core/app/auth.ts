/**
 * Company-level authentication: login with lockout, session construction, password change.
 *
 * Lockout: 5 consecutive failures lock the account for 5 minutes. The counter resets on success
 * and once a lockout has expired. Unknown usernames spend the same scrypt time as real ones and get
 * the same message, so the login screen does not reveal which usernames exist.
 * Passwords never reach the audit log or the app log. A name typed at the login prompt that is not a
 * known user is recorded only in masked form, because people regularly type their password into the
 * username box and the edit log is permanent.
 */
import { PERMISSIONS, type Permission } from '../../shared/constants.ts';
import type { ChangePasswordInput, SessionInfo } from '../../shared/types/app.ts';
import type { Session } from '../api/context.ts';
import type { Db } from '../db/db.ts';
import { appendAudit } from '../lib/audit.ts';
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from '../lib/crypto.ts';
import { AppError, rule } from '../lib/errors.ts';
import { getLockoutPolicy, isPasswordExpired, isPasswordReused, PASSWORD_REUSED_MESSAGE, passwordProblemFor } from '../modules/security/policy.ts';

/** Defaults; the effective values come from the company's security settings (getLockoutPolicy). */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 5 * 60_000;
export const OWNER_ROLE = 'Owner';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role_id: number;
  is_active: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
}

interface RoleRow {
  name: string;
  permissions: string;
  is_system: number;
}

const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

function parsePermissions(json: string): Set<Permission> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return new Set();
  }
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((p): p is Permission => typeof p === 'string' && ALL_PERMISSIONS.has(p as Permission)));
}

/** True for the built-in Owner role (full access). */
export function isOwnerRole(role: Pick<RoleRow, 'name' | 'is_system'>): boolean {
  return role.is_system === 1 && role.name === OWNER_ROLE;
}

/** Session used when company security is off: a single implicit Owner. */
export function implicitSession(now: Date): Session {
  return {
    userId: null,
    username: 'owner',
    displayName: 'Owner',
    role: OWNER_ROLE,
    permissions: new Set(PERMISSIONS),
    isOwner: true,
    implicit: true,
    startedAt: now.toISOString(),
  };
}

/** Build a session for a user id from users + roles. Throws UNAUTHENTICATED if the user is gone/inactive. */
export function buildSession(db: Db, userId: number, now: Date): Session {
  const row = db.get<UserRow & { role_name: string; role_permissions: string; role_is_system: number }>(
    `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions, r.is_system AS role_is_system
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :userId`,
    { userId },
  );
  if (!row || row.is_active !== 1) throw new AppError('UNAUTHENTICATED', 'This user account is not available. Please log in again.');
  const owner = isOwnerRole({ name: row.role_name, is_system: row.role_is_system });
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role_name,
    permissions: owner ? new Set(PERMISSIONS) : parsePermissions(row.role_permissions),
    isOwner: owner,
    implicit: false,
    startedAt: now.toISOString(),
  };
}

/** Serialisable view of a session for the renderer (permissions in canonical order). */
export function toSessionInfo(session: Session, mustChangePassword = false): SessionInfo {
  return {
    userId: session.userId,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    permissions: PERMISSIONS.filter((p) => session.isOwner || session.permissions.has(p)),
    isOwner: session.isOwner,
    implicit: session.implicit,
    mustChangePassword,
  };
}

/** Minutes (rounded up, ≥ 1) until an ISO timestamp. */
const minutesUntil = (iso: string, now: Date): number => Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 60_000));

const lockedMessage = (minutes: number): string =>
  `Too many failed attempts. This account is locked — try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;

/**
 * Masked form of an unrecognised login name for the edit log: first character + length, e.g.
 * 'n… (6 chars)'. Enough to spot repeated guessing, useless for recovering a mistyped password.
 */
export function maskLoginName(name: string): string {
  const chars = Array.from(name);
  return `${chars[0] ?? ''}… (${chars.length} char${chars.length === 1 ? '' : 's'})`;
}

export interface LoginResult {
  session: Session;
  mustChangePassword: boolean;
}

export async function login(db: Db, username: string, password: string, now: Date): Promise<LoginResult> {
  const name = String(username ?? '').trim();
  if (!name || typeof password !== 'string' || password === '') throw new AppError('VALIDATION', 'Enter your username and password');

  const findUser = (): UserRow | undefined => db.get<UserRow>('SELECT * FROM users WHERE username = :name', { name });
  let user = findUser();

  if (user?.locked_until) {
    if (Date.parse(user.locked_until) > now.getTime()) {
      recordLockedAttempt(db, user, now);
      throw new AppError('LOCKED', lockedMessage(minutesUntil(user.locked_until, now)), { lockedUntil: user.locked_until });
    }
    // Lockout expired: start counting afresh.
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: user.id });
  }

  const ok = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash());
  // Re-read after the async hash: state may have changed meanwhile (another attempt, user edited).
  user = user ? findUser() : undefined;

  if (!user || !ok) {
    if (!user) {
      appendAudit(db, { action: 'login_failed', entityType: 'user', entityLabel: maskLoginName(name), after: { reason: 'unknown_user' } }, null, now);
      throw new AppError('UNAUTHENTICATED', 'Incorrect username or password');
    }
    const { maxFailedAttempts, lockoutMs } = getLockoutPolicy(db);
    const lockedUntil = new Date(now.getTime() + lockoutMs).toISOString();
    const after = db.transaction(() => {
      db.run(
        `UPDATE users SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= :max THEN :lockedUntil ELSE locked_until END
          WHERE id = :id`,
        { max: maxFailedAttempts, lockedUntil, id: user.id },
      );
      const attempts = db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: user.id }) ?? 0;
      appendAudit(
        db,
        { action: 'login_failed', entityType: 'user', entityId: user.id, entityLabel: user.username, after: { reason: 'wrong_password', attempts } },
        null,
        now,
      );
      return attempts;
    });
    if (after >= maxFailedAttempts) throw new AppError('LOCKED', lockedMessage(Math.round(lockoutMs / 60_000)), { lockedUntil });
    const left = maxFailedAttempts - after;
    throw new AppError(
      'UNAUTHENTICATED',
      left <= 2 ? `Incorrect username or password. ${left} attempt${left === 1 ? '' : 's'} left before the account is locked.` : 'Incorrect username or password',
    );
  }

  if (user.is_active !== 1) {
    appendAudit(db, { action: 'login_failed', entityType: 'user', entityId: user.id, entityLabel: user.username, after: { reason: 'inactive' } }, null, now);
    throw new AppError('UNAUTHENTICATED', 'This user account is disabled. Ask the company owner to enable it.');
  }

  const userId = user.id;
  const mustChange = user.must_change_password === 1 || isPasswordExpired(db, userId, now);
  // Transparently upgrade hashes made with weaker parameters (only if nobody changed it meanwhile).
  const oldHash = user.password_hash;
  const upgraded = needsRehash(oldHash) ? await hashPassword(password) : null;
  const session = db.transaction(() => {
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = :ts WHERE id = :id', {
      ts: now.toISOString(),
      id: userId,
    });
    if (upgraded)
      db.run('UPDATE users SET password_hash = :hash WHERE id = :id AND password_hash = :old', { hash: upgraded, id: userId, old: oldHash });
    const s = buildSession(db, userId, now);
    appendAudit(db, { action: 'login', entityType: 'user', entityId: userId, entityLabel: s.username }, s, now);
    return s;
  });
  return { session, mustChangePassword: mustChange };
}

/** Change the logged-in user's own password (current password required). */
export async function changePassword(db: Db, session: Session, input: ChangePasswordInput, now: Date): Promise<{ ok: true }> {
  if (session.implicit || session.userId === null)
    throw rule('Passwords apply only when security is enabled. Turn on security and log in as a user first.');
  const userId = session.userId;
  const user = db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: userId });
  if (!user || user.is_active !== 1) throw new AppError('UNAUTHENTICATED', 'This user account is not available. Please log in again.');

  if (!(await verifyPassword(input.currentPassword, user.password_hash)))
    throw new AppError('VALIDATION', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Current password is incorrect' }]);
  const policy = passwordProblemFor(db, input.newPassword, user.username);
  if (policy) throw new AppError('VALIDATION', policy, [{ path: 'newPassword', message: policy }]);
  if (input.newPassword === input.currentPassword) {
    const msg = 'The new password must be different from the current one';
    throw new AppError('VALIDATION', msg, [{ path: 'newPassword', message: msg }]);
  }
  if (await isPasswordReused(db, userId, input.newPassword))
    throw new AppError('VALIDATION', PASSWORD_REUSED_MESSAGE, [{ path: 'newPassword', message: PASSWORD_REUSED_MESSAGE }]);
  const hash = await hashPassword(input.newPassword);
  db.transaction(() => {
    const changed = db.run(
      'UPDATE users SET password_hash = :hash, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = :ts WHERE id = :id AND password_hash = :old',
      { hash, ts: now.toISOString(), id: userId, old: user.password_hash },
    ).changes;
    // Someone else changed it while we were hashing: refuse rather than silently overwrite.
    if (changed !== 1) throw new AppError('CONFLICT', 'The password was changed elsewhere. Please try again.');
    appendAudit(db, { action: 'security', entityType: 'user', entityId: userId, entityLabel: `Password changed: ${user.username}` }, session, now);
  });
  return { ok: true };
}

/**
 * Record an attempt on a locked account in the edit log — at most ONE entry per lockout window (the
 * log is permanent and append-only: a script hammering a locked account must not bloat it). Attempts
 * on a locked account cost no scrypt time, so without this they could add thousands of rows a second.
 */
export function recordLockedAttempt(db: Db, user: Pick<UserRow, 'id' | 'username' | 'locked_until'>, now: Date, context?: string): void {
  const last = db.get<{ ts: string; after_json: string | null }>(
    `SELECT ts, after_json FROM audit_log WHERE entity_type = 'user' AND entity_id = :id AND action = 'login_failed' ORDER BY id DESC LIMIT 1`,
    { id: user.id },
  );
  if (last && user.locked_until) {
    let reason: unknown;
    try {
      reason = (JSON.parse(last.after_json ?? 'null') as { reason?: unknown } | null)?.reason;
    } catch {
      reason = undefined;
    }
    const windowStart = Date.parse(user.locked_until) - getLockoutPolicy(db).lockoutMs;
    if (reason === 'locked' && Date.parse(last.ts) >= windowStart) return;
  }
  appendAudit(db, { action: 'login_failed', entityType: 'user', entityId: user.id, entityLabel: user.username, after: { reason: 'locked', ...(context ? { context } : {}) } }, null, now);
}

/** What an Owner-password confirmation protects (recorded with failed attempts). */
export type OwnerConfirmContext = 'company.delete' | 'restore.replace';

const ownerLockedMessage = (minutes: number): string => `Too many incorrect owner passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;

/**
 * Confirm a destructive action (deleting a company, restoring over it) with an Owner's password,
 * checked against the TARGET company's own database — with the same DB-backed lockout as its login
 * screen (one shared budget: these paths give no extra guesses, and survive restarts) and every
 * failure recorded as 'login_failed' in that company's edit log. `db` must be writable.
 * Without a username every active Owner is a candidate and a wrong guess counts against each of them.
 */
export async function confirmOwnerPassword(db: Db, input: { password: string; username?: string; context: OwnerConfirmContext }, now: Date): Promise<void> {
  const name = input.username?.trim() || undefined;
  const loadOwners = (): UserRow[] =>
    db.all<UserRow>(
      `SELECT u.* FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = 1 AND r.is_system = 1 AND r.name = :owner ${name ? 'AND u.username = :username' : ''}
        ORDER BY u.id LIMIT 10`,
      name ? { owner: OWNER_ROLE, username: name } : { owner: OWNER_ROLE },
    );
  let owners = loadOwners();
  if (owners.length === 0) {
    await verifyPassword(input.password, dummyPasswordHash()); // same time as a real check
    appendAudit(
      db,
      { action: 'login_failed', entityType: 'user', entityLabel: name ? maskLoginName(name) : OWNER_ROLE, after: { reason: 'unknown_user', context: input.context } },
      null,
      now,
    );
    throw new AppError('UNAUTHENTICATED', 'Owner username or password is incorrect.');
  }
  const nowMs = now.getTime();
  const lockedNow = (u: UserRow): boolean => u.locked_until !== null && Date.parse(u.locked_until) > nowMs;
  // Expired lockouts start a fresh count (as at login).
  for (const o of owners) if (o.locked_until && !lockedNow(o)) db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: o.id });
  owners = loadOwners();
  const open = owners.filter((o) => !lockedNow(o));
  if (open.length === 0) {
    db.transaction(() => {
      for (const o of owners) recordLockedAttempt(db, o, now, input.context);
    });
    const until = owners.map((o) => o.locked_until as string).sort()[0];
    throw new AppError('LOCKED', ownerLockedMessage(minutesUntil(until, now)), { lockedUntil: until });
  }
  for (const o of open) {
    if (await verifyPassword(input.password, o.password_hash)) {
      db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: o.id });
      return;
    }
  }
  const { maxFailedAttempts, lockoutMs } = getLockoutPolicy(db);
  const lockedUntil = new Date(nowMs + lockoutMs).toISOString();
  const worst = db.transaction(() => {
    let max = 0;
    for (const o of open) {
      db.run(
        `UPDATE users SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= :max THEN :lockedUntil ELSE locked_until END
          WHERE id = :id`,
        { max: maxFailedAttempts, lockedUntil, id: o.id },
      );
      const attempts = db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: o.id }) ?? 0;
      appendAudit(
        db,
        { action: 'login_failed', entityType: 'user', entityId: o.id, entityLabel: o.username, after: { reason: 'wrong_password', context: input.context, attempts } },
        null,
        now,
      );
      max = Math.max(max, attempts);
    }
    return max;
  });
  if (worst >= maxFailedAttempts) throw new AppError('LOCKED', ownerLockedMessage(Math.round(lockoutMs / 60_000)), { lockedUntil });
  throw new AppError('UNAUTHENTICATED', 'Owner username or password is incorrect.');
}

/**
 * In-memory limit on how often credentials may be tried per key (company + purpose) — a sliding window.
 * Bounds edit-log growth from unknown-username guesses (each one is a permanent 'login_failed' row) and
 * scripted hammering through a compromised renderer.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  /** Count one attempt; throws LOCKED when the key has used up its window. */
  take(key: string, now: Date): void {
    const t = now.getTime();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const wait = Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000));
      throw new AppError('LOCKED', `Too many attempts in a short time. Wait ${wait} second${wait === 1 ? '' : 's'} and try again.`);
    }
    recent.push(t);
    this.hits.set(key, recent);
  }
}

/** Login / owner-confirmation attempts allowed per company per minute (far above any human typing). */
export const MAX_ATTEMPTS_PER_MINUTE = 20;

/**
 * Verify credentials of an active Owner-role user without touching lockout counters. Prefer
 * confirmOwnerPassword (lockout + edit log) for anything an attacker could repeat.
 */
export async function verifyOwnerCredentials(db: Db, password: string, username?: string): Promise<boolean> {
  const owners = db.all<{ username: string; password_hash: string }>(
    `SELECT u.username, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND r.is_system = 1 AND r.name = :owner ${username ? 'AND u.username = :username' : ''}
      ORDER BY u.id`,
    username ? { owner: OWNER_ROLE, username: username.trim() } : { owner: OWNER_ROLE },
  );
  for (const o of owners.slice(0, 10)) if (await verifyPassword(password, o.password_hash)) return true;
  return false;
}
