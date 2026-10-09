/**
 * Idle lock — pure rules (tested in sessionLock.test.ts).
 *
 * When a secured company's session times out (the shell's idle timer → 'app.session.lock', or the
 * server refusing a call with reason 'idle'), the workspace is NOT torn down: it stays mounted,
 * hidden and inert behind a lock screen, and the renderer keeps a snapshot of the company and the
 * user it belonged to. Logging in again as the same user resumes exactly where they left off
 * (unsaved entries included); anyone else gets a fresh workspace (nothing of the previous user's
 * work is shown to them); closing the company discards it. An explicit logout never locks.
 */
import type { AppState, OpenCompanySummary, SessionInfo } from '../../../shared/types/app.ts';

export interface LockSnapshot {
  companyId: string;
  company: OpenCompanySummary;
  session: SessionInfo;
}

/** How often the shell checks for inactivity (ms). */
export const IDLE_CHECK_INTERVAL_MS = 5_000;

/** True when the user has been inactive for at least the session's idle timeout (0 = never). */
export function shouldLock(nowMs: number, lastInputMs: number, idleTimeoutMs: number | undefined): boolean {
  if (!idleTimeoutMs || idleTimeoutMs <= 0 || !Number.isFinite(idleTimeoutMs)) return false;
  return nowMs - lastInputMs >= idleTimeoutMs;
}

export function sameUser(a: SessionInfo | null | undefined, b: SessionInfo | null | undefined): boolean {
  if (!a || !b) return false;
  return a.userId === b.userId && a.username.toLowerCase() === b.username.toLowerCase() && a.implicit === b.implicit;
}

/**
 * The lock after adopting `next`:
 *  - a lock request (idle) while a real user worked in this company → snapshot of that workspace;
 *  - still waiting for a login in the locked company → keep the lock;
 *  - anything else (logged in again, company closed or switched, explicit logout) → no lock.
 */
export function nextLock(prevLock: LockSnapshot | null, prevState: AppState | null, next: AppState, lockRequested: boolean): LockSnapshot | null {
  const pending = next.pendingLogin;
  if (!pending) return null;
  if (prevLock) return prevLock.companyId === pending.companyId ? prevLock : null;
  if (!lockRequested) return null;
  const company = prevState?.company;
  const session = prevState?.session;
  if (!company || !session || session.implicit || company.id !== pending.companyId) return null;
  return { companyId: company.id, company, session };
}

/** "Bahi ERP locked after 30 minutes without activity." */
export function lockReasonText(idleTimeoutMs: number | undefined): string {
  const minutes = idleTimeoutMs && idleTimeoutMs > 0 ? Math.max(1, Math.round(idleTimeoutMs / 60_000)) : 0;
  return minutes > 0 ? `Locked after ${minutes} minute${minutes === 1 ? '' : 's'} without activity.` : 'Locked because the session ended.';
}
