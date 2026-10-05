/**
 * Password policy, password history, password expiry and lockout policy — driven by the company's
 * security settings (settings.ts).
 *
 * The base rules come from core/lib/crypto.ts passwordPolicy() (≥ 8 characters, ≤ 256, a letter, a
 * digit, no leading/trailing space); the configured policy adds a longer minimum, mixed case and a
 * symbol. Used by user save / password reset here, and offered to core/app/auth.ts (login lockout,
 * password change, expiry) — see README "Requested change in auth/controller".
 *
 * This file must not import core/app/* (auth.ts is expected to import it).
 */
import { PASSWORD_HISTORY_DEPTH, type PasswordPolicyInfo, type SecuritySettings } from '../../../shared/types/security.ts';
import type { Db } from '../../db/db.ts';
import { PASSWORD_MAX_LENGTH, passwordPolicy, verifyPassword, verifyPasswordSync } from '../../lib/crypto.ts';
import { getSecuritySettings } from './settings.ts';

const DAY_MS = 86_400_000;

/**
 * User-facing problem with a proposed password under `settings`, or null when acceptable.
 * `username` (optional) refuses a password equal to the username (case-insensitive).
 */
export function passwordProblem(settings: SecuritySettings, password: string, username?: string): string | null {
  const base = passwordPolicy(password);
  if (base) {
    // Report the configured minimum rather than the built-in 8 when the password is simply too short.
    if (typeof password === 'string' && password.length < settings.passwordMinLength && password.length <= PASSWORD_MAX_LENGTH)
      return `Password must be at least ${settings.passwordMinLength} characters long`;
    return base;
  }
  if (password.length < settings.passwordMinLength) return `Password must be at least ${settings.passwordMinLength} characters long`;
  if (settings.requireMixedCase && !(/\p{Lu}/u.test(password) && /\p{Ll}/u.test(password)))
    return 'Password must contain both upper-case and lower-case letters';
  if (settings.requireSymbol && !/[^\p{L}\p{N}\s]/u.test(password)) return 'Password must contain at least one symbol, e.g. @ # $ % &';
  if (username && password.trim().toLowerCase() === username.trim().toLowerCase()) return 'Password must not be the same as the username';
  return null;
}

/** passwordProblem() with the company's current settings. */
export function passwordProblemFor(db: Db, password: string, username?: string): string | null {
  return passwordProblem(getSecuritySettings(db), password, username);
}

/** Human-readable policy for a password form. */
export function describePasswordPolicy(settings: SecuritySettings): PasswordPolicyInfo {
  const rules = [`At least ${settings.passwordMinLength} characters`, 'At least one letter and one digit'];
  if (settings.requireMixedCase) rules.push('Both upper-case and lower-case letters');
  if (settings.requireSymbol) rules.push('At least one symbol, e.g. @ # $ % &');
  rules.push('No space at the start or end', 'Not the same as the username', `Different from your last ${PASSWORD_HISTORY_DEPTH} passwords`);
  if (settings.passwordExpiryDays > 0) rules.push(`Must be changed every ${settings.passwordExpiryDays} days`);
  return {
    minLength: settings.passwordMinLength,
    maxLength: PASSWORD_MAX_LENGTH,
    requireMixedCase: settings.requireMixedCase,
    requireSymbol: settings.requireSymbol,
    historyDepth: PASSWORD_HISTORY_DEPTH,
    expiryDays: settings.passwordExpiryDays,
    rules,
  };
}

export const PASSWORD_REUSED_MESSAGE = `This password was used recently. Choose one that is different from the last ${PASSWORD_HISTORY_DEPTH} passwords.`;

/** Hashes to compare against: the current password and up to (DEPTH − 1) previous ones. */
function recentHashes(db: Db, userId: number): string[] {
  const current = db.value<string>('SELECT password_hash FROM users WHERE id = :userId', { userId });
  const previous = db
    .all<{ password_hash: string }>('SELECT password_hash FROM password_history WHERE user_id = :userId ORDER BY id DESC LIMIT :n', {
      userId,
      n: PASSWORD_HISTORY_DEPTH - 1,
    })
    .map((r) => r.password_hash);
  return current === undefined ? previous : [current, ...previous];
}

/** True when `password` matches the current or one of the recent previous passwords (blocks ~100 ms per hash). */
export function isPasswordReusedSync(db: Db, userId: number, password: string): boolean {
  return recentHashes(db, userId).some((h) => verifyPasswordSync(password, h));
}

/** Async variant (for async code such as core/app/auth.ts changePassword). */
export async function isPasswordReused(db: Db, userId: number, password: string): Promise<boolean> {
  for (const h of recentHashes(db, userId)) if (await verifyPassword(password, h)) return true;
  return false;
}

/** When the user's current password was set: newest history entry, else account creation. */
export function passwordChangedAt(db: Db, userId: number): string | null {
  const row = db.get<{ changed: string | null; created: string }>(
    `SELECT (SELECT MAX(replaced_at) FROM password_history WHERE user_id = u.id) AS changed, u.created_at AS created
       FROM users u WHERE u.id = :userId`,
    { userId },
  );
  if (!row) return null;
  return row.changed ?? row.created;
}

/** Expiry instant for a password set at `changedAt` (null when passwords never expire). */
export function passwordExpiresAt(settings: SecuritySettings, changedAt: string | null): string | null {
  if (settings.passwordExpiryDays <= 0 || !changedAt) return null;
  const ms = Date.parse(changedAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + settings.passwordExpiryDays * DAY_MS).toISOString();
}

/** True when the company expires passwords and this user's password is older than allowed. */
export function isPasswordExpired(db: Db, userId: number, now: Date): boolean {
  const expires = passwordExpiresAt(getSecuritySettings(db), passwordChangedAt(db, userId));
  return expires !== null && Date.parse(expires) <= now.getTime();
}

export interface LockoutPolicy {
  /** Consecutive failures that lock the account. */
  maxFailedAttempts: number;
  lockoutMs: number;
}

/** Lockout policy from the security settings (defaults: 5 failures → 5 minutes). */
export function getLockoutPolicy(db: Db): LockoutPolicy {
  const s = getSecuritySettings(db);
  return { maxFailedAttempts: s.lockoutThreshold, lockoutMs: s.lockoutMinutes * 60_000 };
}
