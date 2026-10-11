import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { decideUiPrefs, defaultUiPrefs, getUiPrefs, initUiPrefs, parseMoreDetails, parseUiPrefs, resetUiPrefsForTests, setMoreDetailsOpen, setUiPrefs, showTryHome, subscribeUiPrefs, UI_PREFS_KEY } from './uiPrefs.ts';
import type { UiPrefs, UiPrefsStorage } from './uiPrefs.ts';

/** The 2.1 fields at their defaults (SPEC-21 §4.5): graphs shown, detail graphs folded, the rest off / empty. */
const V21 = { graphs: true, detailGraphs: false, voucherDetailed: false, moreDetails: {}, dashboardAllCards: false } as const;

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
    assert.deepEqual(decideUiPrefs(null, 2), { prefs: { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false, ...V21 }, write: true });
  });

  test('no stored record and no company → new user (Essentials, no shortcut bar)', () => {
    assert.deepEqual(decideUiPrefs(null, 0), { prefs: { v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false, tryHomeDismissed: false, ...V21 }, write: true });
  });

  test('a stored record wins over the data and is not rewritten', () => {
    const stored = JSON.stringify({ v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true, ...V21 });
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
    assert.deepEqual(JSON.parse(s.map.get(UI_PREFS_KEY) ?? ''), { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false, ...V21 });
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
    assert.deepEqual(stored, { v: 1, homeView: 'all', shortcutBar: true, upgraded: false, tryHomeDismissed: true, ...V21 });
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
    s.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true, ...V21, graphs: false }));
    resetUiPrefsForTests(s);
    const p = initUiPrefs(state(5));
    assert.deepEqual(p, { v: 1, homeView: 'essentials', shortcutBar: true, upgraded: true, tryHomeDismissed: true, ...V21, graphs: false });
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

describe('2.1 fields (SPEC-21 §4.5)', () => {
  beforeEach(() => resetUiPrefsForTests(new MemoryStorage()));

  test('defaults: graphs shown, detail graphs folded, voucher view not detailed, no More details, not all cards — for new and upgraded profiles', () => {
    for (const upgraded of [false, true]) {
      const d = defaultUiPrefs(upgraded);
      assert.equal(d.graphs, true);
      assert.equal(d.detailGraphs, false);
      assert.equal(d.voucherDetailed, false);
      assert.deepEqual(d.moreDetails, {});
      assert.equal(d.dashboardAllCards, false);
    }
  });

  test('a 2.0 record (no 2.1 fields) parses: its choices kept, the 2.1 fields at their defaults, not rewritten', () => {
    const v20 = JSON.stringify({ v: 1, homeView: 'all', shortcutBar: false, upgraded: true, tryHomeDismissed: true });
    assert.deepEqual(parseUiPrefs(v20), { v: 1, homeView: 'all', shortcutBar: false, upgraded: true, tryHomeDismissed: true, ...V21 });
    assert.equal(decideUiPrefs(v20, 0).write, false);
  });

  test('a 2.1 record keeps every field it can read (a 2.0 build reading it ignores the new ones)', () => {
    const rec: UiPrefs = { v: 1, homeView: 'essentials', shortcutBar: true, upgraded: false, tryHomeDismissed: false, graphs: false, detailGraphs: true, voucherDetailed: true, moreDetails: { ledger: true, item: false }, dashboardAllCards: true };
    assert.deepEqual(parseUiPrefs(JSON.stringify(rec)), rec);
    // What 2.0's parser reads of it: the same five fields, the record stays valid (v 1).
    const asRead = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    assert.equal(asRead.v, 1);
    assert.equal(asRead.homeView, 'essentials');
  });

  test('garbage in one field falls back to that field\'s default and never invalidates the record', () => {
    for (const bad of ['yes', 1, 0, null, [], {}, 'true']) {
      const raw = JSON.stringify({ v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false, graphs: bad, detailGraphs: bad, voucherDetailed: bad, dashboardAllCards: bad, moreDetails: bad });
      const p = parseUiPrefs(raw);
      assert.ok(p, JSON.stringify(bad));
      assert.equal(p.homeView, 'all');
      assert.equal(p.graphs, true);
      assert.equal(p.detailGraphs, false);
      assert.equal(p.voucherDetailed, false);
      assert.equal(p.dashboardAllCards, false);
      assert.deepEqual(p.moreDetails, {});
    }
  });

  test('moreDetails: only string keys with boolean values survive; arrays, numbers and unsafe names are dropped', () => {
    assert.deepEqual(parseMoreDetails({ ledger: true, item: false, voucher: 'yes', group: 1, unit: null, cat: {} }), { ledger: true, item: false });
    assert.deepEqual(parseMoreDetails([true, false]), {});
    assert.deepEqual(parseMoreDetails('ledger'), {});
    assert.deepEqual(parseMoreDetails(null), {});
    const polluted = parseMoreDetails(JSON.parse('{"__proto__": true, "constructor": true, "prototype": true, "ledger": true}'));
    assert.deepEqual(Object.keys(polluted), ['ledger']);
    assert.equal(({} as Record<string, unknown>).ledger, undefined, 'Object.prototype untouched');
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, true]));
    assert.equal(Object.keys(parseMoreDetails(many)).length, 64);
  });

  test('each field toggles, is stored and announced; a no-op change writes nothing', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(0));
    const writes = s.writes;
    let calls = 0;
    subscribeUiPrefs(() => calls++);
    setUiPrefs({ graphs: false });
    setUiPrefs({ detailGraphs: true });
    setUiPrefs({ voucherDetailed: true });
    setUiPrefs({ dashboardAllCards: true });
    setUiPrefs({ graphs: false }); // no change
    assert.equal(calls, 4);
    assert.equal(s.writes, writes + 4);
    const stored = JSON.parse(s.map.get(UI_PREFS_KEY) ?? '');
    assert.deepEqual(stored, { v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false, tryHomeDismissed: false, graphs: false, detailGraphs: true, voucherDetailed: true, moreDetails: {}, dashboardAllCards: true });
    setUiPrefs({ graphs: true });
    assert.equal(getUiPrefs().graphs, true);
    assert.equal(calls, 5);
  });

  test('setMoreDetailsOpen remembers per form kind and keeps the others', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(0));
    setMoreDetailsOpen('ledger', true);
    setMoreDetailsOpen('item', false);
    setMoreDetailsOpen('ledger', true); // no change
    assert.deepEqual(getUiPrefs().moreDetails, { ledger: true, item: false });
    assert.deepEqual(JSON.parse(s.map.get(UI_PREFS_KEY) ?? '').moreDetails, { ledger: true, item: false });
    setMoreDetailsOpen('ledger', false);
    assert.deepEqual(getUiPrefs().moreDetails, { ledger: false, item: false });
    setMoreDetailsOpen('__proto__', true);
    assert.deepEqual(getUiPrefs().moreDetails, { ledger: false, item: false });
  });

  test('a caller passing a wrong type cannot corrupt the stored record', () => {
    const s = new MemoryStorage();
    resetUiPrefsForTests(s);
    initUiPrefs(state(0));
    setUiPrefs({ graphs: 'no' as unknown as boolean, moreDetails: { ledger: 'open' } as unknown as Record<string, boolean> });
    assert.equal(getUiPrefs().graphs, true);
    assert.deepEqual(getUiPrefs().moreDetails, {});
  });

  test('`upgraded` stays immutable through the 2.1 setters', () => {
    resetUiPrefsForTests(new MemoryStorage());
    initUiPrefs(state(0));
    setUiPrefs({ graphs: false, upgraded: true } as Parameters<typeof setUiPrefs>[0]);
    setMoreDetailsOpen('ledger', true);
    assert.equal(getUiPrefs().upgraded, false);
  });

  test('storage that throws: the 2.1 choices still apply for the session', () => {
    resetUiPrefsForTests(throwing);
    initUiPrefs(state(1));
    setUiPrefs({ detailGraphs: true });
    setMoreDetailsOpen('item', true);
    assert.equal(getUiPrefs().detailGraphs, true);
    assert.deepEqual(getUiPrefs().moreDetails, { item: true });
  });
});
