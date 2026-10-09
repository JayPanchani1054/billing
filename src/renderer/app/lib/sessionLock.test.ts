import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import type { AppState, SessionInfo } from '../../../shared/types/app.ts';
import { phaseOf } from './appPhase.ts';
import { lockReasonText, nextLock, sameUser, shouldLock } from './sessionLock.ts';

const company = { id: 'c1', name: 'Sharma Traders', mailingName: null, gstin: null, stateCode: '27', booksFrom: '2026-04-01', fyStartMonth: 4, gstEnabled: false, features: DEFAULT_FEATURES };
const accountant: SessionInfo = { userId: 2, username: 'meena', displayName: 'Meena', role: 'Accountant', permissions: [], isOwner: false, implicit: false, mustChangePassword: false, idleTimeoutMs: 30 * 60_000 };
const base: AppState = { appVersion: '1', dataDir: 'D:\\Bahi', firstRun: false, companies: [], company: null, session: null, pendingLogin: null };
const working: AppState = { ...base, company, session: accountant };
const pending: AppState = { ...base, pendingLogin: { companyId: 'c1', companyName: 'Sharma Traders' } };

describe('shouldLock', () => {
  test('after the idle timeout without input; never when the timeout is 0/absent', () => {
    const t0 = 1_000_000;
    assert.equal(shouldLock(t0 + 29 * 60_000, t0, 30 * 60_000), false);
    assert.equal(shouldLock(t0 + 30 * 60_000, t0, 30 * 60_000), true);
    assert.equal(shouldLock(t0 + 999 * 60_000, t0, 0), false);
    assert.equal(shouldLock(t0 + 999 * 60_000, t0, undefined), false);
  });
});

describe('nextLock', () => {
  test('an idle timeout locks the workspace of the user who was working', () => {
    const lock = nextLock(null, working, pending, true);
    assert.deepEqual(lock, { companyId: 'c1', company, session: accountant });
    assert.equal(phaseOf(pending, { bridge: true, loading: false, error: false, locked: lock !== null }), 'locked');
  });

  test('an explicit logout does not lock (the login screen replaces the workspace)', () => {
    const lock = nextLock(null, working, pending, false);
    assert.equal(lock, null);
    assert.equal(phaseOf(pending, { bridge: true, loading: false, error: false, locked: false }), 'login');
  });

  test('stays locked while waiting for a login in the same company; ends on login, close or switch', () => {
    const lock = nextLock(null, working, pending, true);
    assert.equal(nextLock(lock, pending, pending, false), lock);
    assert.equal(nextLock(lock, pending, working, false), null, 'logged in again');
    assert.equal(nextLock(lock, pending, base, false), null, 'company closed');
    assert.equal(nextLock(lock, pending, { ...base, pendingLogin: { companyId: 'c2', companyName: 'Other' } }, true), null, 'another company');
  });

  test('never for the implicit session or without a workspace', () => {
    assert.equal(nextLock(null, { ...working, session: { ...accountant, implicit: true } }, pending, true), null);
    assert.equal(nextLock(null, base, pending, true), null);
    assert.equal(nextLock(null, { ...working, company: { ...company, id: 'c9' } }, pending, true), null);
  });
});

describe('sameUser / text', () => {
  test('same user id and name (case-insensitive) resumes; anyone else does not', () => {
    assert.equal(sameUser(accountant, { ...accountant, username: 'MEENA' }), true);
    assert.equal(sameUser(accountant, { ...accountant, userId: 3, username: 'ravi' }), false);
    assert.equal(sameUser(accountant, null), false);
  });

  test('lock reason', () => {
    assert.equal(lockReasonText(30 * 60_000), 'Locked after 30 minutes without activity.');
    assert.equal(lockReasonText(60_000), 'Locked after 1 minute without activity.');
    assert.equal(lockReasonText(0), 'Locked because the session ended.');
  });
});
