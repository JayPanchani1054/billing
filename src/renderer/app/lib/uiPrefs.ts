/**
 * Per-user layout preferences of 2.0 (docs/ARCHITECTURE.md §7) — pure store, tested in uiPrefs.test.ts; the React
 * hook is `useUiPrefs()` in app/preferences.ts.
 *
 *   localStorage['pevqori.ui'] = { v: 1, homeView, shortcutBar, upgraded, tryHomeDismissed }
 *
 * - `homeView`: Home shows the short Essentials list or All menus (the full 1.0 Gateway).
 * - `shortcutBar`: the 1.0 right-hand rail of every screen action ("Shortcut bar"). The command bar in
 *   the screen bar is always on.
 * - `upgraded`: decided ONCE, from data, the first time the app state resolves in a profile that has
 *   no `pevqori.ui` yet: a profile that already lists companies was used with 1.0 → All menus +
 *   shortcut bar (the layout its user knows) and a one-time "Try the simpler Home" card; otherwise a
 *   new user → Essentials, no shortcut bar. (1.0 wrote `pevqori.prefs` only when the theme or density
 *   was changed, so that key says nothing.) The decision is written at once.
 * - Storage may be unavailable (blocked, private profile): everything still works for the session.
 */

export type HomeView = 'essentials' | 'all';

export interface UiPrefs {
  v: 1;
  homeView: HomeView;
  shortcutBar: boolean;
  upgraded: boolean;
  tryHomeDismissed: boolean;
}

export const UI_PREFS_KEY = 'pevqori.ui';

/** What the store needs from localStorage (tests pass a fake). */
export interface UiPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Defaults for a new user, or for a profile upgraded from 1.0. */
export function defaultUiPrefs(upgraded: boolean): UiPrefs {
  return upgraded
    ? { v: 1, homeView: 'all', shortcutBar: true, upgraded: true, tryHomeDismissed: false }
    : { v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false, tryHomeDismissed: false };
}

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
  const next: UiPrefs = { ...current, ...patch, v: 1, upgraded: current.upgraded };
  if (patch.homeView !== undefined && patch.homeView !== current.homeView) next.tryHomeDismissed = true;
  if (next.homeView === current.homeView && next.shortcutBar === current.shortcutBar && next.tryHomeDismissed === current.tryHomeDismissed) return;
  current = next;
  write(next);
  emit();
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
