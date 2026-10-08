import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Permission } from '../../../../shared/constants.ts';
import type { SecurityRole, SecurityUser } from '../../../../shared/types/security.ts';
import { missingPermissions, otherActiveOwners, roleAssignBlock, userActionBlock } from './access.ts';
import type { AccessSession } from './access.ts';

const TS = '2026-10-05T04:30:00.000Z';

function user(over: Partial<SecurityUser> = {}): SecurityUser {
  return {
    id: 2,
    username: 'ravi',
    displayName: 'Ravi',
    roleId: 3,
    roleName: 'Data Entry',
    roleIsSystem: true,
    isOwner: false,
    isActive: true,
    locked: false,
    lockedUntil: null,
    failedAttempts: 0,
    lastLoginAt: null,
    mustChangePassword: false,
    passwordChangedAt: TS,
    passwordExpiresAt: null,
    passwordExpired: false,
    isSelf: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function role(id: number, permissions: Permission[], over: Partial<SecurityRole> = {}): SecurityRole {
  return { id, name: `Role ${id}`, description: null, permissions, isSystem: false, isOwner: false, userCount: 0, activeUserCount: 0, createdAt: TS, updatedAt: TS, ...over };
}

const OWNER_ROLE = role(1, ['vouchers.view', 'vouchers.create', 'security.manage', 'audit.view'], { isOwner: true, isSystem: true, name: 'Owner' });
const DATA_ENTRY = role(3, ['vouchers.view', 'vouchers.create']);
const ACCOUNTANT = role(4, ['vouchers.view', 'vouchers.create', 'reports.financial']);
const ROLES = [OWNER_ROLE, DATA_ENTRY, ACCOUNTANT];

const OWNER: AccessSession = { isOwner: true, permissions: [] };
/** A manager (security.manage) who is not an Owner and lacks 'reports.financial'. */
const MANAGER: AccessSession = { isOwner: false, permissions: ['security.manage', 'vouchers.view', 'vouchers.create'] };

describe('access: assigning roles', () => {
  it('an Owner may give any role; a manager only roles whose permissions they all hold, never Owner', () => {
    for (const r of ROLES) assert.equal(roleAssignBlock(OWNER, r), null);
    assert.equal(roleAssignBlock(MANAGER, DATA_ENTRY), null);
    assert.match(roleAssignBlock(MANAGER, OWNER_ROLE) ?? '', /Only an Owner/);
    assert.match(roleAssignBlock(MANAGER, ACCOUNTANT) ?? '', /permissions you do not have/);
    assert.deepEqual(missingPermissions(MANAGER, ACCOUNTANT), ['reports.financial']);
    assert.deepEqual(missingPermissions(OWNER, ACCOUNTANT), []);
  });
});

describe('access: actions on a user', () => {
  it('a manager cannot touch Owner accounts (not even unlock)', () => {
    const owner = user({ id: 1, username: 'owner', isOwner: true, roleId: 1 });
    for (const a of ['alter', 'resetPassword', 'unlock', 'deactivate'] as const) assert.match(userActionBlock(MANAGER, owner, a, ROLES) ?? '', /Only an Owner/, a);
  });

  it('a manager cannot alter or reset a user with more permissions, but may unlock them (as the server allows)', () => {
    const accountant = user({ id: 5, username: 'meena', roleId: 4 });
    assert.match(userActionBlock(MANAGER, accountant, 'resetPassword', ROLES) ?? '', /“meena” has permissions you do not have/);
    assert.match(userActionBlock(MANAGER, accountant, 'alter', ROLES) ?? '', /Ask an Owner/);
    assert.equal(userActionBlock(MANAGER, accountant, 'unlock', ROLES), null);
    assert.equal(userActionBlock(MANAGER, user(), 'resetPassword', ROLES), null, 'same or weaker role is fine');
    assert.equal(userActionBlock(OWNER, accountant, 'resetPassword', ROLES), null);
  });

  it('nobody resets their own password here or deactivates themselves', () => {
    const me = user({ isSelf: true });
    assert.match(userActionBlock(OWNER, me, 'resetPassword', ROLES) ?? '', /Change Password/);
    assert.match(userActionBlock(OWNER, me, 'deactivate', ROLES) ?? '', /your own account/);
    assert.equal(userActionBlock(MANAGER, me, 'alter', ROLES), null, 'editing your own name is allowed');
  });

  it('the only active Owner cannot be deactivated', () => {
    const a = user({ id: 1, username: 'owner', isOwner: true, roleId: 1 });
    const b = user({ id: 7, username: 'partner', isOwner: true, roleId: 1, isActive: false });
    // b is deactivated → a is the only active Owner.
    assert.equal(otherActiveOwners([a, b], 1), 0);
    assert.match(userActionBlock(OWNER, a, 'deactivate', ROLES, [a, b]) ?? '', /only active Owner/);
    // With b active there are two Owners → allowed.
    const bActive = { ...b, isActive: true };
    assert.equal(userActionBlock(OWNER, a, 'deactivate', ROLES, [a, bActive]), null);
    // Without the user list the check is left to the server.
    assert.equal(userActionBlock(OWNER, a, 'deactivate', ROLES), null);
  });

  it('security off (implicit Owner session) and a missing session block nothing on their own', () => {
    assert.equal(userActionBlock(null, user(), 'resetPassword', ROLES), null);
    assert.equal(roleAssignBlock(null, OWNER_ROLE), null);
  });
});
