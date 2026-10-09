/**
 * Turning company security on and off.
 *
 * Enable (security off → on): creates the Owner user — or reuses an existing Owner user by username
 * once its password is verified — then sets features.security = true through the company service
 * (which also checks that an active Owner exists). From the next call on, the AppController drops the
 * implicit owner session (controller.ts effectiveSession) and the app shows the login screen.
 *
 * Disable (on → off): only an Owner, re-entering their own password. Users and roles are kept and
 * apply again when security is turned back on. The Owner's current session simply continues; after a
 * logout the implicit owner session returns (controller.ts).
 *
 * Both handlers are asynchronous (scrypt off the main thread), so their routes are
 * `transactional: false`: password checks happen first, then every write happens in ONE transaction
 * that re-checks the state (other calls may have run during the await). A wrong password counts as a
 * failed attempt on that account, with the same lockout policy as the login screen.
 */
import type { SecurityDisableInput, SecurityDisableResult, SecurityEnableInput, SecurityEnableResult } from '../../../shared/types/security.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { hashPassword, verifyPassword } from '../../lib/crypto.ts';
import { AppError, forbidden, rule, validation } from '../../lib/errors.ts';
import { getFeatures, saveFeatures } from '../company/service.ts';
import { isOwnerRole, OWNER_ROLE } from './common.ts';
import { getLockoutPolicy, passwordProblem } from './policy.ts';
import { getSecuritySettings } from './settings.ts';

interface AccountRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_active: number;
  failed_attempts: number;
  locked_until: string | null;
  role_name: string;
  role_is_system: number;
}

const ACCOUNT_SELECT = `SELECT u.id, u.username, u.display_name, u.password_hash, u.is_active, u.failed_attempts, u.locked_until,
                               r.name AS role_name, r.is_system AS role_is_system
                          FROM users u JOIN roles r ON r.id = u.role_id`;

const minutesUntil = (iso: string, now: Date): number => Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 60_000));

function assertNotLocked(account: AccountRow, now: Date): void {
  if (account.locked_until && Date.parse(account.locked_until) > now.getTime()) {
    const m = minutesUntil(account.locked_until, now);
    throw new AppError('LOCKED', `Too many incorrect passwords for "${account.username}". Try again in ${m} minute${m === 1 ? '' : 's'}.`, {
      lockedUntil: account.locked_until,
    });
  }
}

/** Count a wrong password against the account (lockout policy as for login) and throw the matching error. */
function failWrongPassword(ctx: CompanyCtx, account: AccountRow, context: 'security.enable' | 'security.disable'): never {
  const { db } = ctx;
  const now = ctx.clock.now();
  const policy = getLockoutPolicy(db);
  const lockedUntil = new Date(now.getTime() + policy.lockoutMs).toISOString();
  const attempts = db.transaction(() => {
    // An expired lockout starts a fresh count (as at login).
    if (account.locked_until && Date.parse(account.locked_until) <= now.getTime())
      db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: account.id });
    db.run(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= :max THEN :lockedUntil ELSE locked_until END
        WHERE id = :id`,
      { max: policy.maxFailedAttempts, lockedUntil, id: account.id },
    );
    const n = db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: account.id }) ?? 0;
    ctx.audit({ action: 'login_failed', entityType: 'user', entityId: account.id, entityLabel: account.username, after: { reason: 'wrong_password', context, attempts: n } });
    return n;
  });
  if (attempts >= policy.maxFailedAttempts) {
    const m = Math.round(policy.lockoutMs / 60_000);
    throw new AppError('LOCKED', `Too many incorrect passwords. "${account.username}" is locked for ${m} minute${m === 1 ? '' : 's'}.`, { lockedUntil });
  }
  const left = policy.maxFailedAttempts - attempts;
  const message = `Incorrect password for "${account.username}".${left <= 2 ? ` ${left} attempt${left === 1 ? '' : 's'} left before the account is locked.` : ''}`;
  throw validation([{ path: 'password', message }]);
}

function ownerRoleId(db: Db): number {
  const id = db.value<number>('SELECT id FROM roles WHERE is_system = 1 AND name = :owner', { owner: OWNER_ROLE });
  if (id === undefined) throw rule('The built-in Owner role is missing from this company. Restore it from a backup or contact support.');
  return id;
}

export async function enableSecurity(ctx: CompanyCtx, input: SecurityEnableInput): Promise<SecurityEnableResult> {
  const { db } = ctx;
  const alreadyOn = (): AppError => rule('Security is already on for this company.');
  if (getFeatures(db).security) throw alreadyOn();
  const username = input.username.trim();
  const findAccount = (): AccountRow | undefined => db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.username = :username`, { username });

  const existing = findAccount();
  let newHash: string | null = null;
  if (existing) {
    if (!isOwnerRole({ name: existing.role_name, is_system: existing.role_is_system })) {
      throw validation([
        {
          path: 'username',
          message: `"${existing.username}" is an existing user with the ${existing.role_name} role. Enter an Owner's username, or a new username to create the Owner.`,
        },
      ]);
    }
    assertNotLocked(existing, ctx.clock.now());
    if (!(await verifyPassword(input.password, existing.password_hash))) failWrongPassword(ctx, existing, 'security.enable');
  } else {
    const problem = passwordProblem(getSecuritySettings(db), input.password, username);
    if (problem) throw validation([{ path: 'password', message: problem }]);
    newHash = await hashPassword(input.password);
  }

  return db.transaction((): SecurityEnableResult => {
    if (getFeatures(db).security) throw alreadyOn();
    const ts = ctx.clock.now().toISOString();
    const current = findAccount();
    let owner: { id: number; username: string };
    if (newHash !== null) {
      if (current) throw new AppError('CONFLICT', `A user named "${current.username}" was just created. Please try again.`);
      const displayName = input.displayName?.trim() || username;
      const id = db.run(
        `INSERT INTO users (username, display_name, password_hash, role_id, is_active, must_change_password, created_at, updated_at)
         VALUES (:username, :displayName, :hash, :roleId, 1, 0, :ts, :ts)`,
        { username, displayName, hash: newHash, roleId: ownerRoleId(db), ts },
      ).lastInsertRowid;
      ctx.audit({
        action: 'create',
        entityType: 'user',
        entityId: id,
        entityLabel: username,
        after: { username, displayName, roleId: ownerRoleId(db), role: OWNER_ROLE, isActive: true, mustChangePassword: false },
      });
      owner = { id, username };
    } else {
      const before = existing as AccountRow;
      // The password (or role) changed while it was being checked: start again rather than trust a stale check.
      if (!current || current.password_hash !== before.password_hash || !isOwnerRole({ name: current.role_name, is_system: current.role_is_system }))
        throw new AppError('CONFLICT', 'This user was changed meanwhile. Please try again.');
      db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: current.id });
      if (current.is_active !== 1) {
        db.run('UPDATE users SET is_active = 1, updated_at = :ts WHERE id = :id', { ts, id: current.id });
        ctx.audit({
          action: 'alter',
          entityType: 'user',
          entityId: current.id,
          entityLabel: current.username,
          before: { isActive: false },
          after: { isActive: true },
        });
      }
      owner = { id: current.id, username: current.username };
    }
    saveFeatures(ctx, { security: true }, { securityToggle: true });
    ctx.audit({
      action: 'security',
      entityType: 'company_security',
      entityLabel: 'Security turned on',
      before: { securityEnabled: false },
      after: { securityEnabled: true, ownerUsername: owner.username, createdOwner: newHash !== null },
    });
    return {
      securityEnabled: true,
      ownerUserId: owner.id,
      ownerUsername: owner.username,
      createdOwner: newHash !== null,
      loginRequired: true,
      message: `Security is on. Log in as "${owner.username}" to continue; add users and roles under Security › Users.`,
    };
  });
}

export async function disableSecurity(ctx: CompanyCtx, input: SecurityDisableInput): Promise<SecurityDisableResult> {
  const { db, session } = ctx;
  const alreadyOff = (): AppError => rule('Security is already off for this company.');
  if (!getFeatures(db).security) throw alreadyOff();
  if (session.implicit || session.userId === null || !session.isOwner) throw forbidden('Only an Owner can turn security off. Log in as an Owner.');
  const userId = session.userId;
  const findAccount = (): AccountRow | undefined => db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = :id`, { id: userId });
  const account = findAccount();
  if (!account || account.is_active !== 1) throw new AppError('UNAUTHENTICATED', 'This user account is not available. Please log in again.');
  assertNotLocked(account, ctx.clock.now());
  if (!(await verifyPassword(input.password, account.password_hash))) failWrongPassword(ctx, account, 'security.disable');

  db.transaction(() => {
    if (!getFeatures(db).security) throw alreadyOff();
    const current = findAccount();
    if (!current || current.password_hash !== account.password_hash || current.is_active !== 1)
      throw new AppError('CONFLICT', 'Your account was changed meanwhile. Please try again.');
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = :id', { id: userId });
    saveFeatures(ctx, { security: false }, { securityToggle: true });
    ctx.audit({
      action: 'security',
      entityType: 'company_security',
      entityLabel: 'Security turned off',
      before: { securityEnabled: true },
      after: { securityEnabled: false },
    });
  });
  return {
    securityEnabled: false,
    message:
      'Security is off: anyone who opens this company has full access. Users, roles and the edit log are kept, and apply again when security is turned back on.',
  };
}
