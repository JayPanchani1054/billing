/** Helpers shared by the user and role services. */
import { PERMISSIONS, type Permission } from '../../../shared/constants.ts';
import type { Session } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { isOwnerRole, OWNER_ROLE } from '../../app/auth.ts';
import { forbidden } from '../../lib/errors.ts';
import { describePermission } from './catalog.ts';

export { isOwnerRole, OWNER_ROLE };

export interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  permissions: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

/** Permissions of a role in canonical order (the Owner role always has all of them). */
export function rolePermissions(role: Pick<RoleRow, 'name' | 'is_system' | 'permissions'>): Permission[] {
  if (isOwnerRole(role)) return [...PERMISSIONS];
  let raw: unknown;
  try {
    raw = JSON.parse(role.permissions);
  } catch {
    return [];
  }
  const set = new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && KNOWN.has(p)) : []);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Canonical order, duplicates removed. */
export const canonicalPermissions = (list: readonly Permission[]): Permission[] => {
  const set = new Set(list);
  return PERMISSIONS.filter((p) => set.has(p));
};

export function getRoleRow(db: Db, id: number): RoleRow | undefined {
  return db.get<RoleRow>('SELECT * FROM roles WHERE id = :id', { id });
}

/** Active users holding the built-in Owner role, optionally ignoring one user. */
export function countActiveOwners(db: Db, exceptUserId?: number): number {
  return (
    db.value<number>(
      `SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = 1 AND r.is_system = 1 AND r.name = :owner AND u.id <> :except`,
      { owner: OWNER_ROLE, except: exceptUserId ?? -1 },
    ) ?? 0
  );
}

/**
 * No privilege escalation: a session that is not an Owner may only hand out permissions it holds
 * itself (when saving a role, or assigning a role to a user).
 */
export function assertCanGrant(session: Session, permissions: readonly Permission[], what: string): void {
  if (session.isOwner) return;
  const missing = permissions.filter((p) => !session.permissions.has(p));
  if (missing.length === 0) return;
  const names = missing.map((p) => describePermission(p).fullLabel);
  throw forbidden(
    `You can only grant permissions you hold yourself. ${what} includes: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. Ask an Owner to do this.`,
  );
}

/** Escape LIKE wildcards for use with ESCAPE '\'. */
export const likePattern = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
