/**
 * Layout preferences of 2.0 and 2.1 (docs/ARCHITECTURE.md §7) — pure store, tested in uiPrefs.test.ts; the React
 * hook is `useUiPrefs()` in app/preferences.ts.
 *
 *   localStorage['pevqori.ui'] = { v: 1, homeView, shortcutBar, upgraded, tryHomeDismissed,
 *                                  graphs, detailGraphs, voucherDetailed, moreDetails, dashboardAllCards }
 *
 * - `homeView`: Home shows the short Essentials list or All menus (the full 1.0 Gateway).
 * - `shortcutBar`: the 1.0 right-hand rail of every screen action ("Shortcut bar"). The command bar in
 *   the screen bar is always on.
 * - `upgraded`: decided ONCE, from data, the first time the app state resolves in a profile that has
 *   no `pevqori.ui` yet: a profile that already lists companies was used with 1.0 → All menus +
 *   shortcut bar (the layout its user knows) and a one-time "Try the simpler Home" card; otherwise a
 *   new user → Essentials, no shortcut bar. (1.0 wrote `pevqori.prefs` only when the theme or density
 *   was changed, so that key says nothing.) The decision is written at once.
 * - 2.1 (SPEC-21 §4.5), extend-only — `v` stays 1, so 2.0 reads a 2.1 record (it ignores unknown
 *   fields) and 2.1 reads a 2.0 record (missing fields take their defaults):
 *   `graphs` (true) — graphs on Home, the Dashboard and every report (Ctrl+J, app/lib/graphsToggle.ts);
 *   `detailGraphs` (false) — graphs on drill-down reports; `voucherDetailed` (false) — the voucher view
 *   opens Detailed (Alt+F1); `moreDetails` ({}) — form kind → "More details" open; `dashboardAllCards`
 *   (false) — the full Dashboard shows every card. Each field is parsed on its own: a wrong type falls
 *   back to its default and never invalidates the record.
 * - Remembered per computer profile (the Windows user account), not per Pevqori user.
 * - Storage may be unavailable (blocked, private profile): everything still works for the session.
 */

export type HomeView = 'essentials' | 'all';

export interface UiPrefs {
  v: 1;
  homeView: HomeView;
  shortcutBar: boolean;
  upgraded: boolean;
  tryHomeDismissed: boolean;
  /** 2.1: graphs shown on Home, the full Dashboard and every report ('report' class). */
  graphs: boolean;
  /** 2.1: graphs shown on drill-down reports ('detail' class; folded by default). */
  detailGraphs: boolean;
  /** 2.1: the voucher view opens Detailed (Accounting entries; Alt+F1). */
  voucherDetailed: boolean;
  /** 2.1: master / entry form kind → its "More details" section is open (Ctrl+I). */
  moreDetails: Readonly<Record<string, boolean>>;
  /** 2.1: the full Dashboard shows all its cards. */
  dashboardAllCards: boolean;
}

/** The 2.1 fields and their defaults (the same for new and upgraded profiles). */
const DEFAULTS_21 = { graphs: true, detailGraphs: false, voucherDetailed: false, dashboardAllCards: false } as const;

export const UI_PREFS_KEY = 'pevqori.ui';

/** What the store needs from localStorage (tests pass a fake). */
export interface UiPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Defaults for a new user, or for a profile upgraded from 1.0. */
export function defaultUiPrefs(upgraded: boolean): UiPrefs {
  return upgraded
    ? { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false, ...DEFAULTS_21, moreDetails: {} }
    : { v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false, tryHomeDismissed: false, ...DEFAULTS_21, moreDetails: {} };
}

/** Names that must never become keys of a plain object (prototype pollution through a stored record). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** At most this many form kinds are remembered (a handful exist; a bigger map is not ours). */
const MORE_DETAILS_MAX = 64;

/** `moreDetails` from anything: only string keys with boolean values survive; anything else → {}. */
export function parseMoreDetails(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'boolean' || k === '' || k.length > 64 || UNSAFE_KEYS.has(k)) continue;
    if (++n > MORE_DETAILS_MAX) break;
    out[k] = v;
  }
  return out;
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Stored text → prefs, or null when absent or not a valid v1 record (then the decision is made again). */
export function parseUiPrefs(raw: string | null | undefined): UiPrefs | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  const upgraded = r.upgraded === true;
  const d = defaultUiPrefs(upgraded);
  return {
    v: 1,
    homeView: r.homeView === 'essentials' || r.homeView === 'all' ? r.homeView : d.homeView,
    shortcutBar: typeof r.shortcutBar === 'boolean' ? r.shortcutBar : d.shortcutBar,
    upgraded,
    tryHomeDismissed: r.tryHomeDismissed === true,
    graphs: bool(r.graphs, d.graphs),
    detailGraphs: bool(r.detailGraphs, d.detailGraphs),
    voucherDetailed: bool(r.voucherDetailed, d.voucherDetailed),
    moreDetails: parseMoreDetails(r.moreDetails),
    dashboardAllCards: bool(r.dashboardAllCards, d.dashboardAllCards),
  };
}

/**
 * D5: the preferences for this profile. Stored ones win; without them (or unreadable) the profile is
 * "upgraded" when the app state already lists companies. `write` says whether to store the result.
 */
export function decideUiPrefs(stored: string | null | undefined, companyCount: number): { prefs: UiPrefs; write: boolean } {
  const parsed = parseUiPrefs(stored);
  if (parsed) return { prefs: parsed, write: false };
  return { prefs: defaultUiPrefs(companyCount > 0), write: true };
}

/** Whether Home offers the one-time "Try the simpler Home" card. */
export function showTryHome(p: UiPrefs): boolean {
  return p.upgraded && !p.tryHomeDismissed && p.homeView === 'all';
}

// ───────────────────────────── Store ─────────────────────────────

let current: UiPrefs = defaultUiPrefs(false);
let initialised = false;
let storageOverride: UiPrefsStorage | null | undefined;
const listeners = new Set<() => void>();

function storage(): UiPrefsStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(UI_PREFS_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(p: UiPrefs): void {
  try {
    storage()?.setItem(UI_PREFS_KEY, JSON.stringify(p));
  } catch {
    // not remembered — still applied for this session
  }
}

function emit(): void {
  for (const l of [...listeners]) l();
}

/**
 * Called by the app state provider once the first 'app.state' has resolved (state.tsx). Idempotent:
 * later calls (other companies, other users) change nothing.
 */
export function initUiPrefs(state: { companies: readonly unknown[] }): UiPrefs {
  if (initialised) return current;
  initialised = true;
  const { prefs, write: store } = decideUiPrefs(readStored(), state.companies.length);
  current = prefs;
  if (store) write(prefs);
  emit();
  return current;
}

export function getUiPrefs(): UiPrefs {
  return current;
}

/**
 * Change the layout preferences (stored and announced at once). Choosing a Home view in any way
 * (Ctrl+1 / Ctrl+2, the Home switch, the user menu, Appearance) answers the one-time "Try the simpler
 * Home" card too: it never comes back after the user has picked a view themselves.
 */
export function setUiPrefs(patch: Partial<Omit<UiPrefs, 'v' | 'upgraded'>>): void {
  // Whatever the caller passes, the stored record stays valid (the same rules as parsing it).
  const merged = { ...current, ...patch } as Record<string, unknown>;
  const next: UiPrefs = parseUiPrefs(JSON.stringify({ ...merged, v: 1, upgraded: current.upgraded })) ?? current;
  if (patch.homeView !== undefined && patch.homeView !== current.homeView) next.tryHomeDismissed = true;
  if (samePrefs(next, current)) return;
  current = next;
  write(next);
  emit();
}

/** Open or close a form kind's "More details" (2.1, Ctrl+I), remembered with the other preferences. */
export function setMoreDetailsOpen(kind: string, open: boolean): void {
  setUiPrefs({ moreDetails: { ...current.moreDetails, [kind]: open } });
}

function samePrefs(a: UiPrefs, b: UiPrefs): boolean {
  const ak = Object.keys(a.moreDetails);
  if (ak.length !== Object.keys(b.moreDetails).length || ak.some((k) => a.moreDetails[k] !== b.moreDetails[k])) return false;
  return (
    a.homeView === b.homeView &&
    a.shortcutBar === b.shortcutBar &&
    a.tryHomeDismissed === b.tryHomeDismissed &&
    a.graphs === b.graphs &&
    a.detailGraphs === b.detailGraphs &&
    a.voucherDetailed === b.voucherDetailed &&
    a.dashboardAllCards === b.dashboardAllCards
  );
}

export function subscribeUiPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tests only: start over with the given storage (null = unavailable; undefined = window.localStorage). */
export function resetUiPrefsForTests(s?: UiPrefsStorage | null): void {
  storageOverride = s;
  initialised = false;
  current = defaultUiPrefs(false);
  listeners.clear();
}
