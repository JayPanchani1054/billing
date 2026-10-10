import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import type { AppState } from '../../../shared/types/app.ts';
import { phaseOf } from './appPhase.ts';
import { KeyedStore } from './keyedStore.ts';

const base: AppState = {
  appVersion: '0.1.0',
  dataDir: 'D:\\PevqoriData',
  firstRun: false,
  companies: [],
  company: null,
  session: null,
  pendingLogin: null,
};
const company = { id: 'c1', name: 'Sharma Traders', mailingName: null, gstin: null, stateCode: '27', booksFrom: '2026-04-01', fyStartMonth: 4, gstEnabled: false, features: DEFAULT_FEATURES };
const session = { userId: 1, username: 'owner', displayName: 'Owner', role: 'Owner', permissions: [], isOwner: true, implicit: false, mustChangePassword: false };
const ok = { bridge: true, loading: false, error: false };

describe('phaseOf', () => {
  test('routes in priority order', () => {
    assert.equal(phaseOf(null, { ...ok, bridge: false }), 'no-bridge');
    assert.equal(phaseOf(null, { ...ok, loading: true }), 'loading');
    assert.equal(phaseOf(null, { ...ok, error: true }), 'error');
    assert.equal(phaseOf({ ...base, firstRun: true }, ok), 'first-run');
    assert.equal(phaseOf(base, ok), 'select-company');
    assert.equal(phaseOf({ ...base, pendingLogin: { companyId: 'c1', companyName: 'Sharma Traders' } }, ok), 'login');
    assert.equal(phaseOf({ ...base, company, session: { ...session, mustChangePassword: true } }, ok), 'change-password');
    assert.equal(phaseOf({ ...base, company, session }, ok), 'workspace');
    assert.equal(phaseOf({ ...base, company, session: null }, ok), 'select-company');
  });
});

describe('KeyedStore', () => {
  test('notifies on change only, keeps the latest value', () => {
    const s = new KeyedStore<{ n: number; fn: () => number }>();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.set('a', { n: 1, fn: () => 1 });
    const v0 = s.getVersion();
    const latest = { n: 1, fn: () => 2 };
    s.set('a', latest, (x, y) => x.n === y.n);
    assert.equal(calls, 1, 'equal value: no notification');
    assert.equal(s.getVersion(), v0);
    assert.equal(s.get('a'), latest, 'fresh closures kept');
    s.set('a', { n: 2, fn: () => 3 }, (x, y) => x.n === y.n);
    assert.equal(calls, 2);
    s.delete('a');
    s.delete('a');
    assert.equal(calls, 3);
    off();
    s.set('b', { n: 1, fn: () => 1 });
    assert.equal(calls, 3);
    assert.deepEqual(s.entries().map(([k]) => k), ['b']);
  });
});
