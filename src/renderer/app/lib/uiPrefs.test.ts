import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { decideUiPrefs, defaultUiPrefs, getUiPrefs, initUiPrefs, parseUiPrefs, resetUiPrefsForTests, setUiPrefs, showTryHome, subscribeUiPrefs, UI_PREFS_KEY } from './uiPrefs.ts';
import type { UiPrefsStorage } from './uiPrefs.ts';

class MemoryStorage implements UiPrefsStorage {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.writes++;
    this.map.set(k, v);
  }
}

const throwing: UiPrefsStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

const state = (n: number) => ({ companies: Array.from({ length: n }, (_, i) => ({ id: String(i) })) });

describe('D5 decision (pure)', () => {
  test('no stored record: companies already listed → upgraded 1.0 profile (All menus + shortcut bar)', () => {
    assert.deepEqual(decideUiPrefs(null, 2), { prefs: { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false }, write: true });
  });

  test('no stored record and no company → new user (Essentials, no shortcut bar)', () => {
    assert.deepEqual(decideUiPrefs(null, 0), { prefs: { v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false, tryHomeDismissed: false }, write: true });
  });

  test('a stored record wins over the data and is not rewritten', () => {
    const stored = JSON.stringify({ v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true });
    assert.deepEqual(decideUiPrefs(stored, 0), { prefs: JSON.parse(stored), write: false });
  });

  test('malformed or foreign records are decided again from data', () => {
    for (const raw of ['', 'not json', '[]', 'null', '42', JSON.stringify({ v: 2, homeView: 'all' })]) {
      assert.equal(parseUiPrefs(raw), null, raw);
      assert.equal(decideUiPrefs(raw, 3).prefs.upgraded, true);
    }
    // Unknown values fall back to that profile's defaults.
    assert.deepEqual(parseUiPrefs(JSON.stringify({ v: 1, homeView: 'grid', shortcutBar: 'yes', upgraded: true })), defaultUiPrefs(true));
  });

  test('the "Try the simpler Home" card: upgraded, not dismissed, still on All menus', () => {
    assert.equal(showTryHome(defaultUiPrefs(true)), true);
    assert.equal(showTryHome(defaultUiPrefs(false)), false);
    assert.equal(showTryHome({ ...defaultUiPrefs(true), tryHomeDismissed: true }), false);
    assert.equal(showTryHome({ ...defaultUiPrefs(true), homeView: 'essentials' }), false);
  });
});

describe('store', () => {
  beforeEach(() => resetUiPrefsForTests(new MemoryStorage()));

  test('the first app state decides and writes at once; later states change nothing', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    assert.equal(initUiPrefs(state(1)).homeView, 'all');
    assert.equal(s.writes, 1);
    assert.deepEqual(JSON.parse(s.map.get(UI_PREFS_KEY) ?? ''), { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false });
    // Another company opens, or the company list empties: the decision stands.
    assert.equal(initUiPrefs(state(0)).upgraded, true);
    assert.equal(s.writes, 1);
  });

  test('a new profile with no company: Essentials, stored', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(0));
    assert.equal(getUiPrefs().homeView, 'essentials');
    assert.equal(getUiPrefs().shortcutBar, false);
    assert.ok(s.map.has(UI_PREFS_KEY));
  });

  test('changes are stored and announced; `upgraded` cannot be changed', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(0));
    let calls = 0;
    subscribeUiPrefs(() => calls++);
    setUiPrefs({ shortcutBar: true });
    setUiPrefs({ shortcutBar: true }); // no change → no write, no event
    setUiPrefs({ homeView: 'all', upgraded: true } as Parameters<typeof setUiPrefs>[0]);
    assert.equal(calls, 2);
    const stored = JSON.parse(s.map.get(UI_PREFS_KEY) ?? '');
    // Picking a view answers the "Try the simpler Home" card as well (it is only ever offered once).
    assert.deepEqual(stored, { v: 1, homeView: 'all', shortcutBar: true, upgraded: false, tryHomeDismissed: true });
  });

  test('an upgraded profile that switches view (Ctrl+1, then back with Ctrl+2) never sees the card again', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(2));
    assert.equal(showTryHome(getUiPrefs()), true);
    setUiPrefs({ homeView: 'essentials' });
    setUiPrefs({ homeView: 'all' });
    assert.equal(showTryHome(getUiPrefs()), false);
    assert.equal(JSON.parse(s.map.get(UI_PREFS_KEY) ?? '').tryHomeDismissed, true);
    // Other changes leave the card alone.
    resetUiPrefsForTests(new MemoryStorage());
    initUiPrefs(state(2));
    setUiPrefs({ shortcutBar: false });
    setUiPrefs({ homeView: 'all' }); // the view it already shows: not a choice
    assert.equal(showTryHome(getUiPrefs()), true);
  });

  test('a later session reads the stored choice', () => {
    const s = new MemoryStorage();
    s.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true }));
    resetUiPrefsForTests(s);
    const p = initUiPrefs(state(5));
    assert.deepEqual(p, { v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true });
  });

  test('storage that throws (blocked site data): decided from data for the session, nothing breaks', () => {
    resetUiPrefsForTests(throwing);
    assert.equal(initUiPrefs(state(2)).homeView, 'all');
    setUiPrefs({ homeView: 'essentials', tryHomeDismissed: true });
    assert.equal(getUiPrefs().homeView, 'essentials');
    assert.equal(getUiPrefs().tryHomeDismissed, true);
  });

  test('no storage at all (null): new-user defaults until the app state says otherwise', () => {
    resetUiPrefsForTests(null);
    assert.equal(getUiPrefs().homeView, 'essentials');
    assert.equal(initUiPrefs(state(1)).homeView, 'all');
  });
});
