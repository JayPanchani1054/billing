/**
 * Security settings (settings key 'security'): idle timeout, password policy, password expiry and
 * login lockout.
 *
 * Storage compatibility: the AppController reads `settings['security'].idleTimeoutMinutes` (a number
 * ≥ 0, 0 = no timeout) on every call — see idleTimeoutFor() in core/app/controller.ts. This module
 * writes the same key and MERGES into the stored object, so that field keeps its meaning and any keys
 * written by other code are preserved. When idleTimeoutMinutes has never been saved the controller
 * uses its runtime default (DEFAULT_IDLE_TIMEOUT_MS = 30 minutes), which is what get() reports.
 *
 * Kept free of imports from core/app so core/app/auth.ts can import it (see README: requested change).
 */
import {
  DEFAULT_SECURITY_SETTINGS,
  SECURITY_SETTINGS_LIMITS,
  type SecuritySettings,
  type SecuritySettingsInput,
} from '../../../shared/types/security.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { readSetting, writeSetting } from '../company/service.ts';

export const SECURITY_SETTINGS_KEY = 'security';

type NumericKey = 'idleTimeoutMinutes' | 'passwordMinLength' | 'passwordExpiryDays' | 'lockoutThreshold' | 'lockoutMinutes';

/** User-facing range check for one numeric setting; null when acceptable. */
export function settingProblem(key: NumericKey, value: number): string | null {
  if (!Number.isSafeInteger(value)) return 'Enter a whole number';
  switch (key) {
    case 'idleTimeoutMinutes': {
      const { min, max } = SECURITY_SETTINGS_LIMITS.idleTimeoutMinutes;
      return value === 0 || (value >= min && value <= max) ? null : `Idle timeout must be 0 (never) or between ${min} and ${max} minutes`;
    }
    case 'passwordMinLength': {
      const { min, max } = SECURITY_SETTINGS_LIMITS.passwordMinLength;
      return value >= min && value <= max ? null : `Minimum password length must be between ${min} and ${max} characters`;
    }
    case 'passwordExpiryDays': {
      const { max } = SECURITY_SETTINGS_LIMITS.passwordExpiryDays;
      return value >= 0 && value <= max ? null : `Password expiry must be 0 (never) or up to ${max} days`;
    }
    case 'lockoutThreshold': {
      const { min, max } = SECURITY_SETTINGS_LIMITS.lockoutThreshold;
      return value >= min && value <= max ? null : `Lock the account after ${min} to ${max} failed attempts`;
    }
    case 'lockoutMinutes': {
      const { min, max } = SECURITY_SETTINGS_LIMITS.lockoutMinutes;
      return value >= min && value <= max ? null : `Lockout duration must be between ${min} and ${max} minutes`;
    }
  }
}

const NUMERIC_KEYS: readonly NumericKey[] = ['idleTimeoutMinutes', 'passwordMinLength', 'passwordExpiryDays', 'lockoutThreshold', 'lockoutMinutes'];
const BOOLEAN_KEYS = ['requireMixedCase', 'requireSymbol'] as const;

function storedObject(db: Db): Record<string, unknown> {
  const raw = readSetting(db, SECURITY_SETTINGS_KEY);
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

/**
 * Effective settings: stored values over defaults. A stored value that is missing or out of range
 * (hand-edited file, older version) falls back to the default for that field only. The idle timeout
 * accepts any whole number ≥ 0 here, exactly like the controller does, so this never disagrees with
 * what is enforced.
 */
export function getSecuritySettings(db: Db): SecuritySettings {
  const stored = storedObject(db);
  const out: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS };
  for (const key of NUMERIC_KEYS) {
    const val = stored[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) continue;
    if (key === 'idleTimeoutMinutes') {
      if (val >= 0) out.idleTimeoutMinutes = Math.round(val);
    } else if (settingProblem(key, val) === null) out[key] = val;
  }
  for (const key of BOOLEAN_KEYS) if (typeof stored[key] === 'boolean') out[key] = stored[key] as boolean;
  return out;
}

/** Validate and merge a partial update; writes only the security fields and keeps any other stored keys. */
export function saveSecuritySettings(ctx: CompanyCtx, input: SecuritySettingsInput): SecuritySettings {
  const issues: Array<{ path: string; message: string }> = [];
  for (const key of NUMERIC_KEYS) {
    const val = input[key];
    if (val === undefined) continue;
    const problem = settingProblem(key, val);
    if (problem) issues.push({ path: key, message: problem });
  }
  if (issues.length) throw validation(issues);

  const before = getSecuritySettings(ctx.db);
  const next: SecuritySettings = { ...before };
  for (const key of NUMERIC_KEYS) if (input[key] !== undefined) next[key] = input[key] as number;
  for (const key of BOOLEAN_KEYS) if (input[key] !== undefined) next[key] = input[key] as boolean;

  const changed = (Object.keys(next) as Array<keyof SecuritySettings>).some((k) => next[k] !== before[k]);
  const stored = storedObject(ctx.db);
  // Persist every field explicitly the first time, so the controller sees the idle timeout even if it was the default.
  const missing = (Object.keys(next) as Array<keyof SecuritySettings>).some((k) => stored[k] !== next[k]);
  if (!changed && !missing) return next;

  writeSetting(ctx.db, SECURITY_SETTINGS_KEY, { ...stored, ...next }, ctx.clock.now());
  if (changed)
    ctx.audit({ action: 'security', entityType: 'security_settings', entityLabel: 'Security settings', before, after: next });
  return next;
}
