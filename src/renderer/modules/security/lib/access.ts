/**
 * What the current session may do to a user or with a role — mirrors the server's anti-escalation
 * rules (core/modules/security/users.ts, common.ts) so the UI does not offer actions that will be
 * refused, and explains why. The server stays the authority. Pure.
 *
 * Server rules mirrored:
 *  - Only an Owner manages Owner accounts (save, reset password, unlock).
 *  - Anyone else manages only users whose role's permissions they all hold (save, reset password).
 *  - Only an Owner gives the Owner role; others assign only roles whose permissions they all hold.
 *  - Nobody deactivates or re-roles themselves; the last active Owner cannot be deactivated or moved.
 */
import type { Permission } from '../../../../shared/constants.ts';
import type { SecurityRole, SecurityUser } from '../../../../shared/types/security.ts';

/** The parts of the app session these checks need (SessionInfo). */
export interface AccessSession {
  isOwner: boolean;
  permissions: readonly Permission[];
}

export type UserAction = 'alter' | 'resetPassword' | 'unlock' | 'deactivate' | 'reactivate';

/** Permissions of `role` that `session` does not hold (empty for an Owner session). */
export function missingPermissions(session: AccessSession | null, role: Pick<SecurityRole, 'permissions' | 'isOwner'>): Permission[] {
  if (!session || session.isOwner) return [];
  const held = new Set(session.permissions);
  return role.permissions.filter((p) => !held.has(p));
}

/** Why `session` may not assign `role` to someone (null = allowed). */
export function roleAssignBlock(session: AccessSession | null, role: Pick<SecurityRole, 'permissions' | 'isOwner'>): string | null {
  if (!session || session.isOwner) return null;
  if (role.isOwner) return 'Only an Owner can give someone the Owner role.';
  if (missingPermissions(session, role).length) return 'This role has permissions you do not have yourself, so you cannot give it to anyone.';
  return null;
}

/** Active Owners other than `exceptId`. */
export function otherActiveOwners(users: readonly Pick<SecurityUser, 'id' | 'isOwner' | 'isActive'>[], exceptId: number): number {
  return users.filter((u) => u.id !== exceptId && u.isOwner && u.isActive).length;
}

/**
 * Why `session` may not perform `action` on `user` (null = allowed, the server may still refuse for
 * reasons only it can see). `roles` resolves the user's role permissions; `users` is the full user list
 * (for the last-Owner rule — pass it when known).
 */
export function userActionBlock(
  session: AccessSession | null,
  user: SecurityUser,
  action: UserAction,
  roles: readonly Pick<SecurityRole, 'id' | 'permissions' | 'isOwner'>[],
  users?: readonly Pick<SecurityUser, 'id' | 'isOwner' | 'isActive'>[],
): string | null {
  if (user.isSelf) {
    if (action === 'resetPassword') return 'Use Change Password for your own account — it asks for your current password.';
    if (action === 'deactivate') return 'You cannot deactivate your own account while you are logged in with it.';
  }
  if (session && !session.isOwner) {
    if (user.isOwner) return 'Only an Owner can change Owner accounts.';
    if (action !== 'unlock' && !user.isSelf) {
      const role = roles.find((r) => r.id === user.roleId);
      if (role && missingPermissions(session, role).length)
        return `“${user.username}” has permissions you do not have yourself. Ask an Owner to do this.`;
    }
  }
  if (action === 'deactivate' && user.isOwner && user.isActive && users && otherActiveOwners(users, user.id) === 0)
    return `“${user.username}” is the only active Owner. Make another user an Owner first.`;
  return null;
}
