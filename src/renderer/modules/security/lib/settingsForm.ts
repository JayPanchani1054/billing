/**
 * Security settings form: validation mirroring the server limits, change detection and plain-language
 * explanations for small-business owners. Pure.
 */
import type { SecuritySettings, SecuritySettingsInput } from '../../../../shared/types/security.ts';
import { SECURITY_SETTINGS_LIMITS } from '../../../../shared/types/security.ts';
import { formatMinutes } from './time.ts';

export type SettingsKey = keyof SecuritySettings;
export type SettingsErrors = Partial<Record<SettingsKey, string>>;

export const SETTINGS_KEYS: readonly SettingsKey[] = [
  'idleTimeoutMinutes',
  'passwordMinLength',
  'requireMixedCase',
  'requireSymbol',
  'passwordExpiryDays',
  'lockoutThreshold',
  'lockoutMinutes',
];

/** Quick choices for the idle timeout (minutes; 0 = never). */
export const IDLE_PRESETS: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 240];
export const EXPIRY_PRESETS: readonly number[] = [0, 30, 60, 90, 180, 365];

const whole = (n: number | null): n is number => n !== null && Number.isSafeInteger(n);

/** Same ranges and wording as the server (core/modules/security/settings.ts). */
export function settingsErrors(d: { [K in SettingsKey]: SecuritySettings[K] | null }): SettingsErrors {
  const e: SettingsErrors = {};
  const L = SECURITY_SETTINGS_LIMITS;
  const idle = d.idleTimeoutMinutes;
  if (!whole(idle) || !(idle === 0 || (idle >= L.idleTimeoutMinutes.min && idle <= L.idleTimeoutMinutes.max)))
    e.idleTimeoutMinutes = `Idle timeout must be 0 (never) or between ${L.idleTimeoutMinutes.min} and ${L.idleTimeoutMinutes.max} minutes`;
  const len = d.passwordMinLength;
  if (!whole(len) || len < L.passwordMinLength.min || len > L.passwordMinLength.max)
    e.passwordMinLength = `Minimum password length must be between ${L.passwordMinLength.min} and ${L.passwordMinLength.max} characters`;
  const exp = d.passwordExpiryDays;
  if (!whole(exp) || exp < 0 || exp > L.passwordExpiryDays.max) e.passwordExpiryDays = `Password expiry must be 0 (never) or up to ${L.passwordExpiryDays.max} days`;
  const th = d.lockoutThreshold;
  if (!whole(th) || th < L.lockoutThreshold.min || th > L.lockoutThreshold.max)
    e.lockoutThreshold = `Lock the account after ${L.lockoutThreshold.min} to ${L.lockoutThreshold.max} failed attempts`;
  const lm = d.lockoutMinutes;
  if (!whole(lm) || lm < L.lockoutMinutes.min || lm > L.lockoutMinutes.max) e.lockoutMinutes = `Lockout duration must be between ${L.lockoutMinutes.min} and ${L.lockoutMinutes.max} minutes`;
  return e;
}

export type SettingsDraft = { [K in SettingsKey]: SecuritySettings[K] | null };

export const draftOf = (s: SecuritySettings): SettingsDraft => ({ ...s });

export function changedKeys(saved: SecuritySettings, draft: SettingsDraft): SettingsKey[] {
  return SETTINGS_KEYS.filter((k) => draft[k] !== saved[k]);
}

/** Partial input with only the changed fields (call after settingsErrors() is empty). */
export function patchOf(saved: SecuritySettings, draft: SettingsDraft): SecuritySettingsInput {
  const out: SecuritySettingsInput = {};
  for (const k of changedKeys(saved, draft)) (out as Record<string, unknown>)[k] = draft[k];
  return out;
}

export function describeIdle(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes === 0) return 'Never log out automatically. Anyone at an unattended computer can use the company.';
  return `Log out after ${formatMinutes(minutes)} without any activity. Unsaved work in an open form is lost, so do not set this too short.`;
}

export function describeLockout(threshold: number | null, minutes: number | null): string {
  if (threshold === null || minutes === null) return '';
  return `After ${threshold} wrong passwords in a row the account is locked for ${formatMinutes(minutes)}. An Owner can unlock it sooner from Users.`;
}

export function describeExpiry(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'Passwords never expire. Recommended when people choose long passwords.';
  return `Everyone must choose a new password every ${days} days (asked at login).`;
}

export function describeStrength(d: Pick<SettingsDraft, 'passwordMinLength' | 'requireMixedCase' | 'requireSymbol'>): string {
  const parts = [`at least ${d.passwordMinLength ?? '?'} characters`, 'letters and digits'];
  if (d.requireMixedCase) parts.push('upper- and lower-case letters');
  if (d.requireSymbol) parts.push('a symbol');
  return `New passwords need ${parts.join(', ')}. Existing passwords keep working until they are next changed.`;
}

/** Friendly recommendations for weak settings (shown as tips, never enforced). */
export function recommendations(s: SettingsDraft, ctx: { securityEnabled: boolean; activeOwners: number }): string[] {
  const out: string[] = [];
  if (!ctx.securityEnabled) {
    out.push('Security is off: anyone who opens this company can see and change everything. Turn it on if more than one person uses this computer.');
    return out;
  }
  if (ctx.activeOwners < 2) out.push('Only one active Owner. If that password is forgotten nobody can manage users — consider a second Owner (for example a partner) kept for emergencies.');
  if (s.idleTimeoutMinutes === 0) out.push('No idle timeout: set one (15–30 minutes) so an unattended computer locks itself.');
  else if (s.idleTimeoutMinutes !== null && s.idleTimeoutMinutes > 60) out.push('An idle timeout of an hour or more leaves an unattended computer open for long.');
  if (s.passwordMinLength !== null && s.passwordMinLength < 10) out.push('Longer passwords are much harder to guess: 10 or more characters is a good minimum.');
  return out;
}
