/**
 * "My Session" presentation: idle-timeout countdown, password-expiry wording and the permission
 * summary (what this user may and may not do, grouped like the role editor). Pure.
 */
import type { Permission } from '../../../../shared/constants.ts';
import type { MySession, PermissionCatalog } from '../../../../shared/types/security.ts';
import { formatDateTime, formatMinutes, relativeTime } from './time.ts';

/**
 * The shell's keep-alive ('app.session.touch') reports activity at most once a minute, so a key press
 * may not have reached the server yet. The countdown therefore assumes the last press reached it up to
 * this long before it happened (it may show a little less time than there really is — never more).
 */
export const KEEPALIVE_THROTTLE_MS = 60_000;

/**
 * When the session ends if nothing else happens (epoch ms), or null when there is no idle timeout.
 * `expiresAt` is the server's answer at fetch time; `lastActivityAt` the latest local key press /
 * click since then (epoch ms, or null).
 */
export function idleDeadline(s: Pick<MySession, 'idleTimeoutMinutes' | 'idleExpiresAt'>, lastActivityAt: number | null): number | null {
  if (s.idleTimeoutMinutes <= 0 || s.idleExpiresAt === null) return null;
  const fetched = Date.parse(s.idleExpiresAt);
  if (Number.isNaN(fetched)) return null;
  if (lastActivityAt === null) return fetched;
  const fromActivity = lastActivityAt - KEEPALIVE_THROTTLE_MS + s.idleTimeoutMinutes * 60_000;
  return Math.max(fetched, fromActivity);
}

export type IdleLevel = 'none' | 'ok' | 'low' | 'expired';

/** 'low' in the last 2 minutes (or the last fifth of a short timeout). */
export function idleLevel(deadline: number | null, timeoutMinutes: number, now: number): IdleLevel {
  if (deadline === null) return 'none';
  const left = deadline - now;
  if (left <= 0) return 'expired';
  const lowAt = Math.min(2 * 60_000, (timeoutMinutes * 60_000) / 5);
  return left <= lowAt ? 'low' : 'ok';
}

export function idleExplanation(s: Pick<MySession, 'idleTimeoutMinutes' | 'implicit' | 'securityEnabled'>): string {
  if (!s.securityEnabled || s.implicit) return 'Security is off, so there is no login and no automatic logout.';
  if (s.idleTimeoutMinutes <= 0) return 'Automatic logout is off for this company. Lock the computer (Windows+L) when you step away.';
  return `You are logged out after ${formatMinutes(s.idleTimeoutMinutes)} without any key press or click. Any activity in Bahi starts the countdown again.`;
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** 'just now' / '5 min ago' / 'yesterday 18:05' / 'on 05-Oct-2026' — to follow a verb. */
export function whenPhrase(iso: string, now: Date): string {
  const rel = relativeTime(iso, now);
  if (!rel) return '';
  if (/^\d{2}-/.test(rel)) return `on ${rel}`;
  return rel[0].toLowerCase() + rel.slice(1);
}

/** Password age / expiry line and its tone. */
export function passwordStatus(s: Pick<MySession, 'passwordChangedAt' | 'passwordExpiresAt' | 'passwordExpiresInDays' | 'implicit'>, now: Date): { text: string; tone: Tone } {
  if (s.implicit) return { text: 'No password while security is off.', tone: 'neutral' };
  const set = s.passwordChangedAt ? `Set ${whenPhrase(s.passwordChangedAt, now)}` : 'Set date unknown';
  const days = s.passwordExpiresInDays;
  if (days === null || s.passwordExpiresAt === null) return { text: `${set}. Passwords do not expire in this company.`, tone: 'neutral' };
  if (days < 0) return { text: `${set}. It has expired — you will be asked for a new one at the next login.`, tone: 'danger' };
  if (days === 0) return { text: `${set}. It expires today — change it now to avoid being asked at the next login.`, tone: 'warning' };
  if (days <= 7) return { text: `${set}. It expires in ${days} day${days === 1 ? '' : 's'} (${formatDateTime(s.passwordExpiresAt)}). Change it soon.`, tone: 'warning' };
  return { text: `${set}. It expires in ${days} days.`, tone: 'success' };
}

/** "Previous login" line, with a warning when someone tried wrong passwords in between. */
export function previousLoginStatus(s: Pick<MySession, 'previousLoginAt' | 'failedAttemptsSincePreviousLogin' | 'implicit'>, now: Date): { text: string; tone: Tone } {
  if (s.implicit) return { text: 'Not recorded while security is off.', tone: 'neutral' };
  const prev = s.previousLoginAt ? `${formatDateTime(s.previousLoginAt)} (${relativeTime(s.previousLoginAt, now)})` : 'This is your first login.';
  const n = s.failedAttemptsSincePreviousLogin;
  if (n > 0)
    return {
      text: `${prev} Since then there ${n === 1 ? 'was 1 failed attempt' : `were ${n} failed attempts`} to log in as you. If that was not you, change your password and tell the Owner.`,
      tone: 'warning',
    };
  return { text: prev, tone: 'neutral' };
}

export interface PermissionSummaryItem {
  permission: Permission;
  label: string;
  description: string;
  held: boolean;
}

export interface PermissionSummaryGroup {
  key: string;
  label: string;
  items: PermissionSummaryItem[];
  heldCount: number;
}

/** Catalogue groups with "held" flags (an Owner holds everything). */
export function permissionSummary(catalog: PermissionCatalog | undefined, held: readonly Permission[], isOwner: boolean): PermissionSummaryGroup[] {
  const set = new Set(held);
  return (catalog?.groups ?? []).map((g) => {
    const items = g.items.map((i) => ({ permission: i.permission, label: i.label, description: i.description, held: isOwner || set.has(i.permission) }));
    return { key: g.key, label: g.label, items, heldCount: items.filter((i) => i.held).length };
  });
}

/** One line: "14 of 22 permissions" / "Full access". */
export function permissionCountText(groups: readonly PermissionSummaryGroup[], isOwner: boolean): string {
  if (isOwner) return 'Full access (Owner)';
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const heldCount = groups.reduce((n, g) => n + g.heldCount, 0);
  return `${heldCount} of ${total} permission${total === 1 ? '' : 's'}`;
}
