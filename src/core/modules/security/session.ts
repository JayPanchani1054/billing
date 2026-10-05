/**
 * 'security.mySession': the current session for the UI — who is logged in, their permissions, the
 * idle timeout in force, the previous login (from the edit log) and password expiry.
 *
 * Idle timeout: the dispatcher restarts the countdown on every authorised call (this one included),
 * so the remaining time returned is the full timeout measured from now. The renderer restarts its own
 * countdown after any call (or uses 'app.session.touch' as a keep-alive).
 */
import { PERMISSIONS } from '../../../shared/constants.ts';
import type { MySession } from '../../../shared/types/security.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { getFeatures } from '../company/service.ts';
import { passwordChangedAt, passwordExpiresAt } from './policy.ts';
import { getSecuritySettings } from './settings.ts';

const DAY_MS = 86_400_000;

export function mySession(ctx: CompanyCtx): MySession {
  const { db, session } = ctx;
  const now = ctx.clock.now();
  const securityEnabled = getFeatures(db).security;
  const settings = getSecuritySettings(db);
  const idleTimeoutMinutes = securityEnabled && !session.implicit ? settings.idleTimeoutMinutes : 0;
  const idleMs = idleTimeoutMinutes * 60_000;

  let previousLoginAt: string | null = null;
  let failedAttemptsSincePreviousLogin = 0;
  let changedAt: string | null = null;
  let expiresAt: string | null = null;
  if (!session.implicit && session.userId !== null) {
    const uid = session.userId;
    // The login that started this session is the newest one recorded at or before startedAt (ids, not
    // timestamps, order entries made within the same millisecond).
    const currentLoginId =
      db.value<number>(
        `SELECT MAX(id) FROM audit_log WHERE entity_type = 'user' AND entity_id = :uid AND action = 'login' AND ts <= :started`,
        { uid, started: session.startedAt },
      ) ?? Number.MAX_SAFE_INTEGER;
    const previous = db.get<{ id: number; ts: string }>(
      `SELECT id, ts FROM audit_log WHERE entity_type = 'user' AND entity_id = :uid AND action = 'login' AND id < :current ORDER BY id DESC LIMIT 1`,
      { uid, current: currentLoginId },
    );
    previousLoginAt = previous?.ts ?? null;
    failedAttemptsSincePreviousLogin =
      db.value<number>(
        `SELECT COUNT(*) FROM audit_log WHERE entity_type = 'user' AND entity_id = :uid AND action = 'login_failed' AND id > :prev AND id < :current`,
        { uid, prev: previous?.id ?? 0, current: currentLoginId },
      ) ?? 0;
    changedAt = passwordChangedAt(db, session.userId);
    expiresAt = securityEnabled ? passwordExpiresAt(settings, changedAt) : null;
  }

  const has = (p: (typeof PERMISSIONS)[number]): boolean => session.isOwner || session.permissions.has(p);
  return {
    userId: session.userId,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    permissions: PERMISSIONS.filter(has),
    isOwner: session.isOwner,
    implicit: session.implicit,
    startedAt: session.startedAt,
    securityEnabled,
    idleTimeoutMinutes,
    idleExpiresAt: idleMs > 0 ? new Date(now.getTime() + idleMs).toISOString() : null,
    idleTimeoutRemainingMs: idleMs > 0 ? idleMs : null,
    previousLoginAt,
    failedAttemptsSincePreviousLogin,
    passwordChangedAt: changedAt,
    passwordExpiresAt: expiresAt,
    passwordExpiresInDays: expiresAt === null ? null : Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / DAY_MS)),
    canManageSecurity: has('security.manage'),
    canViewAudit: has('audit.view'),
  };
}
