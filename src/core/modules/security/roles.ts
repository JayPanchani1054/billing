/**
 * Roles: list (with user counts), get, create/alter custom roles, delete unused custom roles.
 *
 *  - Built-in roles (Owner, Accountant, Data Entry, Auditor) are read-only. Owner always has every
 *    permission (also for permissions added in later versions).
 *  - Custom role permissions are validated against PERMISSIONS (by the route schema) and stored in
 *    canonical order without duplicates.
 *  - Someone who is not an Owner can only grant permissions they hold themselves.
 *  - Role changes apply to a user from their next login (permissions are captured at login).
 */
import type { SecurityRole, SecurityRoleSaveInput } from '../../../shared/types/security.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, notFound, rule } from '../../lib/errors.ts';
import { assertCanGrant, canonicalPermissions, getRoleRow, isOwnerRole, rolePermissions, type RoleRow } from './common.ts';

interface RoleListRow extends RoleRow {
  user_count: number;
  active_user_count: number;
}

const ROLE_SELECT = `
  SELECT r.*,
         (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count,
         (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS active_user_count
    FROM roles r`;

function toRole(row: RoleListRow): SecurityRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: rolePermissions(row),
    isSystem: row.is_system === 1,
    isOwner: isOwnerRole(row),
    userCount: row.user_count,
    activeUserCount: row.active_user_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roleListRow(db: Db, id: number): RoleListRow {
  const row = db.get<RoleListRow>(`${ROLE_SELECT} WHERE r.id = :id`, { id });
  if (!row) throw notFound('Role');
  return row;
}

const auditView = (r: SecurityRole): Record<string, unknown> => ({ name: r.name, description: r.description, permissions: r.permissions });

/** System roles first (in seeding order), then custom roles by name. */
export function listRoles(db: Db): { rows: SecurityRole[]; total: number } {
  const rows = db.all<RoleListRow>(`${ROLE_SELECT} ORDER BY r.is_system DESC, CASE WHEN r.is_system = 1 THEN r.id END, r.name COLLATE NOCASE`).map(toRole);
  return { rows, total: rows.length };
}

export function getRole(db: Db, id: number): SecurityRole {
  return toRole(roleListRow(db, id));
}

export function saveRole(ctx: CompanyCtx, input: SecurityRoleSaveInput): SecurityRole {
  const { db, session } = ctx;
  const ts = ctx.clock.now().toISOString();
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const permissions = canonicalPermissions(input.permissions);

  const clash = db.get<{ id: number; name: string }>('SELECT id, name FROM roles WHERE name = :name AND id <> :id', { name, id: input.id ?? -1 });
  if (clash) {
    const message = `A role named "${clash.name}" already exists. Choose another name.`;
    throw new AppError('CONFLICT', message, [{ path: 'name', message }]);
  }

  if (input.id === undefined) {
    assertCanGrant(session, permissions, 'This role');
    const id = db.run(
      `INSERT INTO roles (name, description, permissions, is_system, created_at, updated_at)
       VALUES (:name, :description, :permissions, 0, :ts, :ts)`,
      { name, description, permissions: JSON.stringify(permissions), ts },
    ).lastInsertRowid;
    const created = getRole(db, id);
    ctx.audit({ action: 'create', entityType: 'role', entityId: id, entityLabel: name, after: auditView(created) });
    return created;
  }

  const existing = getRoleRow(db, input.id);
  if (!existing) throw notFound('Role');
  if (existing.is_system === 1)
    throw rule(`"${existing.name}" is a built-in role and cannot be changed. Create a new role instead — you can start from the same permissions.`);
  const before = getRole(db, existing.id);
  // Adding permissions is granting them; removing ones the editor does not hold is allowed.
  const added = permissions.filter((p) => !before.permissions.includes(p));
  assertCanGrant(session, added, 'This change');

  if (before.name === name && before.description === description && before.permissions.join() === permissions.join()) return before;
  db.run('UPDATE roles SET name = :name, description = :description, permissions = :permissions, updated_at = :ts WHERE id = :id', {
    name,
    description,
    permissions: JSON.stringify(permissions),
    ts,
    id: existing.id,
  });
  const after = getRole(db, existing.id);
  ctx.audit({ action: 'alter', entityType: 'role', entityId: existing.id, entityLabel: name, before: auditView(before), after: auditView(after) });
  return after;
}

export function deleteRole(ctx: CompanyCtx, id: number): { deleted: true; id: number } {
  const { db } = ctx;
  const role = getRole(db, id);
  if (role.isSystem) throw rule(`"${role.name}" is a built-in role and cannot be deleted.`);
  if (role.userCount > 0) {
    throw rule(
      `"${role.name}" is assigned to ${role.userCount} user${role.userCount === 1 ? '' : 's'}${role.activeUserCount < role.userCount ? ' (including deactivated users)' : ''}. Move them to another role first.`,
      { userCount: role.userCount },
    );
  }
  db.run('DELETE FROM roles WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'role', entityId: id, entityLabel: role.name, before: auditView(role) });
  return { deleted: true, id };
}
