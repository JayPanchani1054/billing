/**
 * User accounts: list, get, create/alter, password reset, unlock — and the refusal to delete.
 *
 * Rules (all enforced here, not only in the UI):
 *  - Usernames: 3–32 characters [A-Za-z0-9._-] starting with a letter or digit, unique ignoring case.
 *  - Passwords follow the company's configured policy (policy.ts) and may not repeat the last
 *    PASSWORD_HISTORY_DEPTH passwords. Hashing is synchronous (hashPasswordSync) because these routes
 *    run inside the dispatcher's transaction.
 *  - There is always at least one active Owner: the last one cannot be deactivated or moved to another role.
 *  - You cannot deactivate yourself, change your own role, or reset your own password here (use
 *    "Change password", which asks for the current one).
 *  - No privilege escalation: only an Owner may create, change or reset Owner accounts; anyone else may
 *    only manage users (and hand out roles) whose permissions they hold themselves.
 *  - Users are never deleted: the edit log refers to them. Deactivate instead.
 */
import type {
  SecurityResetPasswordInput,
  SecurityUser,
  SecurityUserListInput,
  SecurityUserSaveInput,
  SecuritySettings,
  UserDeleteRefusal,
} from '../../../shared/types/security.ts';
import type { CompanyCtx, Session } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { hashPasswordSync } from '../../lib/crypto.ts';
import { AppError, forbidden, notFound, rule, validation } from '../../lib/errors.ts';
import { assertCanGrant, countActiveOwners, getRoleRow, isOwnerRole, likePattern, rolePermissions } from './common.ts';
import { isPasswordReusedSync, PASSWORD_REUSED_MESSAGE, passwordExpiresAt, passwordProblem } from './policy.ts';
import { getSecuritySettings } from './settings.ts';

interface UserDbRow {
  id: number;
  username: string;
  display_name: string;
  role_id: number;
  is_active: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  role_name: string;
  role_is_system: number;
  role_permissions: string;
  password_changed_at: string;
}

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.role_id, u.is_active, u.must_change_password, u.failed_attempts,
         u.locked_until, u.last_login_at, u.created_at, u.updated_at,
         r.name AS role_name, r.is_system AS role_is_system, r.permissions AS role_permissions,
         COALESCE((SELECT MAX(h.replaced_at) FROM password_history h WHERE h.user_id = u.id), u.created_at) AS password_changed_at
    FROM users u JOIN roles r ON r.id = u.role_id`;

const isLocked = (row: Pick<UserDbRow, 'locked_until'>, now: Date): boolean =>
  row.locked_until !== null && Date.parse(row.locked_until) > now.getTime();

const rowIsOwner = (row: UserDbRow): boolean => isOwnerRole({ name: row.role_name, is_system: row.role_is_system });

const isSelf = (session: Session, id: number): boolean => !session.implicit && session.userId === id;

function toUser(row: UserDbRow, settings: SecuritySettings, session: Session, now: Date): SecurityUser {
  const expiresAt = passwordExpiresAt(settings, row.password_changed_at);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleName: row.role_name,
    roleIsSystem: row.role_is_system === 1,
    isOwner: rowIsOwner(row),
    isActive: row.is_active === 1,
    locked: isLocked(row, now),
    lockedUntil: isLocked(row, now) ? row.locked_until : null,
    failedAttempts: row.failed_attempts,
    lastLoginAt: row.last_login_at,
    mustChangePassword: row.must_change_password === 1,
    passwordChangedAt: row.password_changed_at,
    passwordExpiresAt: expiresAt,
    passwordExpired: expiresAt !== null && Date.parse(expiresAt) <= now.getTime(),
    isSelf: isSelf(session, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userRow(db: Db, id: number): UserDbRow {
  const row = db.get<UserDbRow>(`${USER_SELECT} WHERE u.id = :id`, { id });
  if (!row) throw notFound('User');
  return row;
}

/** Stable view of a user for the edit log (no hashes, no volatile login counters). */
const auditView = (row: UserDbRow): Record<string, unknown> => ({
  username: row.username,
  displayName: row.display_name,
  roleId: row.role_id,
  role: row.role_name,
  isActive: row.is_active === 1,
  mustChangePassword: row.must_change_password === 1,
});

export function listUsers(ctx: CompanyCtx, input: SecurityUserListInput = {}): { rows: SecurityUser[]; total: number } {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (input.search) {
    where.push(`(u.username LIKE :q ESCAPE '\\' OR u.display_name LIKE :q ESCAPE '\\')`);
    params.q = likePattern(input.search);
  }
  if (input.roleId !== undefined) {
    where.push('u.role_id = :roleId');
    params.roleId = input.roleId;
  }
  if (input.activeOnly) where.push('u.is_active = 1');
  const rows = ctx.db.all<UserDbRow>(
    `${USER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.is_active DESC, u.username COLLATE NOCASE`,
    params,
  );
  const settings = getSecuritySettings(ctx.db);
  const now = ctx.clock.now();
  return { rows: rows.map((r) => toUser(r, settings, ctx.session, now)), total: rows.length };
}

export function getUser(ctx: CompanyCtx, id: number): SecurityUser {
  return toUser(userRow(ctx.db, id), getSecuritySettings(ctx.db), ctx.session, ctx.clock.now());
}

/** Only an Owner manages Owner accounts; others only users whose permissions they hold themselves. */
function assertCanManageUser(session: Session, target: UserDbRow): void {
  if (session.isOwner) return;
  if (rowIsOwner(target)) throw forbidden('Only an Owner can change Owner accounts.');
  assertCanGrant(session, rolePermissions({ name: target.role_name, is_system: target.role_is_system, permissions: target.role_permissions }), `"${target.username}"'s role`);
}

function checkNewPassword(db: Db, settings: SecuritySettings, password: string, username: string, userId: number | null, path: string): void {
  const problem = passwordProblem(settings, password, username);
  if (problem) throw validation([{ path, message: problem }]);
  if (userId !== null && isPasswordReusedSync(db, userId, password)) throw validation([{ path, message: PASSWORD_REUSED_MESSAGE }]);
}

function assertUsernameFree(db: Db, username: string, exceptId: number | null): void {
  const clash = db.get<{ id: number; username: string }>('SELECT id, username FROM users WHERE username = :username AND id <> :except', {
    username,
    except: exceptId ?? -1,
  });
  if (clash) {
    const message = `A user named "${clash.username}" already exists (usernames are not case-sensitive). Choose another username.`;
    throw new AppError('CONFLICT', message, [{ path: 'username', message }]);
  }
}

export function saveUser(ctx: CompanyCtx, input: SecurityUserSaveInput): SecurityUser {
  const { db, session } = ctx;
  const now = ctx.clock.now();
  const ts = now.toISOString();
  const settings = getSecuritySettings(db);
  const username = input.username.trim();
  const displayName = input.displayName.trim() || username;

  const role = getRoleRow(db, input.roleId);
  if (!role) throw validation([{ path: 'roleId', message: 'Choose a role for this user' }]);
  const roleIsOwner = isOwnerRole(role);

  if (input.id === undefined) {
    if (roleIsOwner && !session.isOwner) throw forbidden('Only an Owner can create Owner accounts.');
    assertUsernameFree(db, username, null);
    assertCanGrant(session, rolePermissions(role), `The role "${role.name}"`);
    if (!input.password) throw validation([{ path: 'password', message: 'Enter a password for the new user' }]);
    checkNewPassword(db, settings, input.password, username, null, 'password');
    const hash = hashPasswordSync(input.password);
    const id = db.run(
      `INSERT INTO users (username, display_name, password_hash, role_id, is_active, must_change_password, created_at, updated_at)
       VALUES (:username, :displayName, :hash, :roleId, :active, :mustChange, :ts, :ts)`,
      { username, displayName, hash, roleId: role.id, active: input.isActive, mustChange: input.mustChangePassword ?? true, ts },
    ).lastInsertRowid;
    const created = userRow(db, id);
    ctx.audit({ action: 'create', entityType: 'user', entityId: id, entityLabel: username, after: auditView(created) });
    return toUser(created, settings, session, now);
  }

  const id = input.id;
  const existing = userRow(db, id);
  assertCanManageUser(session, existing);
  assertUsernameFree(db, username, id);
  const self = isSelf(session, id);
  const roleChanged = existing.role_id !== role.id;
  const wasActiveOwner = existing.is_active === 1 && rowIsOwner(existing);

  if (roleChanged) {
    if (self) throw rule('You cannot change your own role. Ask another Owner to do it.');
    if (roleIsOwner && !session.isOwner) throw forbidden('Only an Owner can give someone the Owner role.');
    assertCanGrant(session, rolePermissions(role), `The role "${role.name}"`);
  }
  if (self && !input.isActive) throw rule('You cannot deactivate your own account while you are logged in with it. Ask another Owner to do it.');
  if (wasActiveOwner && (!input.isActive || !roleIsOwner) && countActiveOwners(db, id) === 0) {
    throw rule(
      `"${existing.username}" is the only active Owner. Make another user an Owner first — otherwise nobody could manage users or turn security off.`,
    );
  }

  let hash: string | null = null;
  if (input.password !== undefined && input.password !== '') {
    if (self) throw rule('To change your own password use "Change password" — it asks for your current password.');
    checkNewPassword(db, settings, input.password, username, id, 'password');
    hash = hashPasswordSync(input.password);
  }
  const mustChange = input.mustChangePassword ?? existing.must_change_password === 1;
  const changed =
    hash !== null ||
    existing.username !== username ||
    existing.display_name !== displayName ||
    roleChanged ||
    (existing.is_active === 1) !== input.isActive ||
    (existing.must_change_password === 1) !== mustChange;
  if (!changed) return toUser(existing, settings, session, now);

  db.run(
    `UPDATE users SET username = :username, display_name = :displayName, role_id = :roleId, is_active = :active,
            must_change_password = :mustChange, updated_at = :ts WHERE id = :id`,
    { username, displayName, roleId: role.id, active: input.isActive, mustChange, ts, id },
  );
  if (hash !== null)
    db.run('UPDATE users SET password_hash = :hash, failed_attempts = 0, locked_until = NULL, updated_at = :ts WHERE id = :id', { hash, ts, id });

  const after = userRow(db, id);
  ctx.audit({
    action: 'alter',
    entityType: 'user',
    entityId: id,
    entityLabel: after.username,
    before: auditView(existing),
    after: hash !== null ? { ...auditView(after), passwordChanged: true } : auditView(after),
  });
  return toUser(after, settings, session, now);
}

export function resetUserPassword(ctx: CompanyCtx, input: SecurityResetPasswordInput): SecurityUser {
  const { db, session } = ctx;
  const now = ctx.clock.now();
  const ts = now.toISOString();
  const settings = getSecuritySettings(db);
  const existing = userRow(db, input.id);
  assertCanManageUser(session, existing);
  if (isSelf(session, input.id)) throw rule('To change your own password use "Change password" — it asks for your current password.');
  checkNewPassword(db, settings, input.newPassword, existing.username, existing.id, 'newPassword');

  const mustChange = input.mustChange ?? true;
  const wasLocked = isLocked(existing, now);
  db.run(
    `UPDATE users SET password_hash = :hash, must_change_password = :mustChange, failed_attempts = 0, locked_until = NULL,
            updated_at = :ts WHERE id = :id`,
    { hash: hashPasswordSync(input.newPassword), mustChange, ts, id: existing.id },
  );
  ctx.audit({
    action: 'security',
    entityType: 'user',
    entityId: existing.id,
    entityLabel: `Password reset: ${existing.username}`,
    after: { mustChangePassword: mustChange, unlocked: wasLocked },
  });
  return toUser(userRow(db, existing.id), settings, session, now);
}

export function unlockUser(ctx: CompanyCtx, id: number): SecurityUser {
  const { db, session } = ctx;
  const now = ctx.clock.now();
  const settings = getSecuritySettings(db);
  const existing = userRow(db, id);
  if (rowIsOwner(existing) && !session.isOwner) throw forbidden('Only an Owner can change Owner accounts.');
  if (existing.failed_attempts === 0 && existing.locked_until === null) return toUser(existing, settings, session, now);
  db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id });
  ctx.audit({
    action: 'security',
    entityType: 'user',
    entityId: id,
    entityLabel: `Account unlocked: ${existing.username}`,
    before: { failedAttempts: existing.failed_attempts, lockedUntil: existing.locked_until },
    after: { failedAttempts: 0, lockedUntil: null },
  });
  return toUser(userRow(db, id), settings, session, now);
}

/** Users are kept forever (the edit log refers to them): always refuses, suggesting deactivation. */
export function refuseUserDelete(ctx: CompanyCtx, id: number): never {
  const row = userRow(ctx.db, id);
  const details: UserDeleteRefusal = { reason: 'users_are_kept', suggestion: 'deactivate', userId: row.id, isActive: row.is_active === 1 };
  if (row.is_active !== 1)
    throw rule(`"${row.username}" is already deactivated and cannot log in. Users are never deleted so the edit log can always show who did what.`, details);
  throw rule(
    `Users cannot be deleted — the edit log must always show who did what. Deactivate "${row.username}" instead: they will no longer be able to log in.`,
    details,
  );
}
