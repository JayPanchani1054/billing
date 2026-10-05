import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PasswordPolicyInfo, SecurityRole, SecurityUser } from '../../../../shared/types/security.ts';
import { checkPassword, firstPasswordProblem } from './passwordRules.ts';
import { draftFromUser, emptyUserDraft, isDraftDirty, lastLoginText, toSaveInput, userBadges, userFormWarnings, usernameProblem, validateUserDraft } from './users.ts';

const NOW = new Date(2026, 9, 5, 10, 0, 0); // 5-Oct-2026 10:00 local

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
    passwordChangedAt: NOW.toISOString(),
    passwordExpiresAt: null,
    passwordExpired: false,
    isSelf: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const POLICY: PasswordPolicyInfo = { minLength: 10, maxLength: 256, requireMixedCase: true, requireSymbol: true, historyDepth: 3, expiryDays: 0, rules: [] };

describe('user status badges', () => {
  it('shows the main state first, then flags, always with text', () => {
    assert.deepEqual(userBadges(user(), NOW).map((b) => b.label), ['Active']);
    const lockedUntil = new Date(2026, 9, 5, 10, 4).toISOString();
    assert.deepEqual(userBadges(user({ locked: true, lockedUntil, mustChangePassword: true, isOwner: true, isSelf: true }), NOW).map((b) => b.key), [
      'locked',
      'mustChange',
      'owner',
      'you',
    ]);
    assert.equal(userBadges(user({ locked: true, lockedUntil }), NOW)[0].label, 'Locked until 10:04');
    // A lockout that has ended shows as active.
    assert.equal(userBadges(user({ locked: true, lockedUntil: new Date(2026, 9, 5, 9, 0).toISOString() }), NOW)[0].key, 'active');
    assert.deepEqual(userBadges(user({ isActive: false, mustChangePassword: true }), NOW).map((b) => b.key), ['inactive']);
    assert.deepEqual(userBadges(user({ passwordExpired: true, mustChangePassword: true }), NOW).map((b) => b.key), ['active', 'expired']);
  });

  it('describes the last login', () => {
    assert.equal(lastLoginText(user(), NOW), 'Never');
    assert.equal(lastLoginText(user({ lastLoginAt: new Date(2026, 9, 5, 9, 55).toISOString() }), NOW), '5 min ago');
  });
});

describe('user form validation', () => {
  it('checks usernames like the server', () => {
    assert.equal(usernameProblem(''), 'Enter a username');
    assert.equal(usernameProblem('ab'), 'Use at least 3 characters');
    assert.equal(usernameProblem('a'.repeat(33)), 'Use at most 32 characters');
    assert.match(usernameProblem('ravi kumar') ?? '', /only letters, digits/);
    assert.match(usernameProblem('.ravi') ?? '', /starting with a letter or digit/);
    assert.equal(usernameProblem('r.k_2-x'), null);
  });

  it('requires a password on create, optional on alter; checks policy, confirmation and duplicates', () => {
    const d = { ...emptyUserDraft(3), username: 'sita' };
    assert.deepEqual(validateUserDraft(d, POLICY, []), { password: 'Enter a password for the new user' });
    assert.deepEqual(validateUserDraft({ ...d, password: 'Short1#' }, POLICY, []), { password: 'Password must be at least 10 characters long' });
    assert.deepEqual(validateUserDraft({ ...d, password: 'Sita2026#ok', confirm: 'x' }, POLICY, []), { confirm: 'The two passwords are different' });
    assert.deepEqual(validateUserDraft({ ...d, password: 'Sita2026#ok', confirm: 'Sita2026#ok' }, POLICY, []), {});
    assert.match(validateUserDraft({ ...d, password: 'Sita2026#ok', confirm: 'Sita2026#ok' }, POLICY, ['SITA']).username ?? '', /already exists/);
    assert.deepEqual(validateUserDraft({ ...d, roleId: null, password: 'Sita2026#ok', confirm: 'Sita2026#ok' }, POLICY, []), { roleId: 'Choose a role' });
    const alter = draftFromUser(user());
    assert.deepEqual(validateUserDraft(alter, POLICY, []), {}, 'blank password keeps the current one');
  });

  it('maps the draft to the route input and detects changes', () => {
    const base = draftFromUser(user());
    assert.equal(isDraftDirty(base, base), false);
    assert.equal(isDraftDirty({ ...base, displayName: 'Ravi K' }, base), true);
    assert.deepEqual(toSaveInput({ ...base, username: ' ravi ', displayName: ' Ravi K ' }), {
      id: 2,
      username: 'ravi',
      displayName: 'Ravi K',
      roleId: 3,
      isActive: true,
      password: undefined,
      mustChangePassword: false,
    });
  });

  it('warns about deactivation and role changes', () => {
    const roles = [{ id: 1, name: 'Owner', isOwner: true } as SecurityRole, { id: 3, name: 'Data Entry', isOwner: false } as SecurityRole];
    const existing = user();
    const w = userFormWarnings({ ...draftFromUser(existing), isActive: false, roleId: 1 }, existing, roles);
    assert.equal(w.length, 3);
    assert.match(w[0], /no longer be able to log in/);
    assert.match(w[1], /next login/);
    assert.deepEqual(userFormWarnings(draftFromUser(existing), null, roles), []);
  });
});

describe('password checklist', () => {
  it('lists the configured rules and their state', () => {
    const checks = checkPassword(POLICY, 'abcdefgh12', 'ravi');
    assert.deepEqual(checks.map((c) => `${c.id}:${c.ok}`), ['length:true', 'letter:true', 'digit:true', 'case:false', 'symbol:false', 'spaces:true', 'username:true']);
    assert.equal(firstPasswordProblem(POLICY, 'abcdefgh12', 'ravi'), 'Password must contain both upper-case and lower-case letters');
    assert.equal(firstPasswordProblem(POLICY, 'Abcdefgh1#', 'ravi'), null);
    assert.equal(firstPasswordProblem(null, 'Ravi2026x', 'ravi2026x'), 'Password must not be the same as the username');
    assert.equal(firstPasswordProblem(null, ' Ravi2026x', 'ravi'), 'Password must not start or end with a space');
    assert.deepEqual(checkPassword(null, 'x', 'u').map((c) => c.id), ['length', 'letter', 'digit', 'spaces', 'username'], 'fallback policy has no case/symbol rules');
  });
});
