/**
 * User list presentation and form validation (mirrors the server rules for instant feedback; the
 * server remains the authority). Pure.
 */
import type { PasswordPolicyInfo, SecurityRole, SecurityUser, SecurityUserSaveInput } from '../../../../shared/types/security.ts';
import { DISPLAY_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN } from '../../../../shared/types/security.ts';
import { firstPasswordProblem } from './passwordRules.ts';
import { formatTime, relativeTime } from './time.ts';

export type BadgeTone = 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface StatusBadge {
  key: 'active' | 'inactive' | 'locked' | 'mustChange' | 'expired' | 'owner' | 'you';
  label: string;
  tone: BadgeTone;
  /** Longer explanation (tooltip / screen readers). */
  title: string;
}

/** Status badges in display order: the main state first, then flags. Colour is never the only signal (text). */
export function userBadges(u: SecurityUser, now: Date): StatusBadge[] {
  const out: StatusBadge[] = [];
  const lockedNow = u.locked && u.lockedUntil !== null && Date.parse(u.lockedUntil) > now.getTime();
  if (!u.isActive) out.push({ key: 'inactive', label: 'Deactivated', tone: 'neutral', title: 'Cannot log in. Kept so the edit log can show who did what.' });
  else if (lockedNow)
    out.push({ key: 'locked', label: `Locked until ${formatTime(u.lockedUntil)}`, tone: 'danger', title: 'Too many wrong passwords. Unlock now or wait until the lockout ends.' });
  else out.push({ key: 'active', label: 'Active', tone: 'success', title: 'Can log in.' });
  if (u.isActive && u.passwordExpired) out.push({ key: 'expired', label: 'Password expired', tone: 'warning', title: 'Must choose a new password at the next login.' });
  else if (u.isActive && u.mustChangePassword)
    out.push({ key: 'mustChange', label: 'Must change password', tone: 'warning', title: 'Will be asked to choose a new password at the next login.' });
  if (u.isOwner) out.push({ key: 'owner', label: 'Owner', tone: 'brand', title: 'Full access, including security.' });
  if (u.isSelf) out.push({ key: 'you', label: 'You', tone: 'info', title: 'The user you are logged in as.' });
  return out;
}

/** 'Never' / '5 min ago' … for the Last login column. */
export function lastLoginText(u: Pick<SecurityUser, 'lastLoginAt'>, now: Date): string {
  return u.lastLoginAt ? relativeTime(u.lastLoginAt, now) : 'Never';
}

/** Sort key for status (problems first among active users). */
export function statusRank(u: SecurityUser): number {
  if (!u.isActive) return 4;
  if (u.locked) return 0;
  if (u.passwordExpired || u.mustChangePassword) return 1;
  return 2;
}

/** Client-side username check with the same rules and wording as the server. */
export function usernameProblem(username: string): string | null {
  const u = username.trim();
  if (u.length === 0) return 'Enter a username';
  if (u.length < USERNAME_MIN_LENGTH) return `Use at least ${USERNAME_MIN_LENGTH} characters`;
  if (u.length > USERNAME_MAX_LENGTH) return `Use at most ${USERNAME_MAX_LENGTH} characters`;
  if (!USERNAME_PATTERN.test(u)) return 'Use only letters, digits, dot, dash and underscore, starting with a letter or digit';
  return null;
}

export interface UserDraft {
  id?: number;
  username: string;
  displayName: string;
  roleId: number | null;
  isActive: boolean;
  password: string;
  confirm: string;
  mustChangePassword: boolean;
}

export function emptyUserDraft(defaultRoleId: number | null): UserDraft {
  return { username: '', displayName: '', roleId: defaultRoleId, isActive: true, password: '', confirm: '', mustChangePassword: true };
}

export function draftFromUser(u: SecurityUser): UserDraft {
  return { id: u.id, username: u.username, displayName: u.displayName, roleId: u.roleId, isActive: u.isActive, password: '', confirm: '', mustChangePassword: u.mustChangePassword };
}

export type UserDraftErrors = Partial<Record<'username' | 'displayName' | 'roleId' | 'password' | 'confirm', string>>;

/**
 * Validation before calling the server. On alter the password is optional (blank = keep).
 * `others` = existing usernames (case-insensitive duplicate check).
 */
export function validateUserDraft(d: UserDraft, policy: PasswordPolicyInfo | null, others: readonly string[]): UserDraftErrors {
  const e: UserDraftErrors = {};
  const u = usernameProblem(d.username);
  if (u) e.username = u;
  else if (others.some((o) => o.toLowerCase() === d.username.trim().toLowerCase())) e.username = 'A user with this name already exists (names are not case-sensitive)';
  if (d.displayName.trim().length > DISPLAY_NAME_MAX_LENGTH) e.displayName = `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters`;
  if (d.roleId === null) e.roleId = 'Choose a role';
  const creating = d.id === undefined;
  if (creating || d.password !== '') {
    if (d.password === '') e.password = 'Enter a password for the new user';
    else {
      const p = firstPasswordProblem(policy, d.password, d.username);
      if (p) e.password = p;
      else if (d.confirm !== d.password) e.confirm = 'The two passwords are different';
    }
  }
  return e;
}

/** Server input from a draft (blank password on alter = keep). */
export function toSaveInput(d: UserDraft): SecurityUserSaveInput {
  return {
    id: d.id,
    username: d.username.trim(),
    displayName: d.displayName.trim(),
    roleId: d.roleId ?? 0,
    isActive: d.isActive,
    password: d.password === '' ? undefined : d.password,
    mustChangePassword: d.mustChangePassword,
  };
}

export function isDraftDirty(d: UserDraft, base: UserDraft): boolean {
  return (
    d.username !== base.username ||
    d.displayName !== base.displayName ||
    d.roleId !== base.roleId ||
    d.isActive !== base.isActive ||
    d.password !== '' ||
    d.confirm !== '' ||
    d.mustChangePassword !== base.mustChangePassword
  );
}

/** Roles a user may be given, system roles first (as listed by the server), with a one-line summary. */
export function roleOptionLabel(r: SecurityRole): string {
  return r.isOwner ? `${r.name} — full access` : `${r.name} — ${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`;
}

/** Warnings shown in the form before saving (not errors). */
export function userFormWarnings(d: UserDraft, existing: SecurityUser | null, roles: readonly SecurityRole[]): string[] {
  const out: string[] = [];
  if (!existing) return out;
  const role = roles.find((r) => r.id === d.roleId);
  if (existing.isActive && !d.isActive) out.push(`“${existing.username}” will no longer be able to log in. Their entries in the edit log are kept.`);
  if (role && role.id !== existing.roleId) out.push(`The new role applies from ${existing.username}’s next login.`);
  if (role?.isOwner && role.id !== existing.roleId) out.push('Owners have full access, including users, security and the edit log.');
  return out;
}
