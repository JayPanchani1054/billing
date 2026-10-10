/**
 * Per-user display preferences (theme, density), remembered in localStorage and mirrored to the
 * native window theme (pevqori.native('theme.set')). Changes made from the native side arrive as
 * 'theme-changed' events and are adopted here. The 2.0 layout preferences (Home view, shortcut bar)
 * live in lib/uiPrefs.ts and are read here with `useUiPrefs()`.
 */
import { useSyncExternalStore } from 'react';
import { applyDensity, applyTheme } from '../ui/index.ts';
import type { Density, ThemePreference } from '../ui/index.ts';
import { getBridge, native, onBridgeEvent } from './bridge.ts';
import { getUiPrefs, subscribeUiPrefs } from './lib/uiPrefs.ts';
import type { UiPrefs } from './lib/uiPrefs.ts';

export interface Preferences {
  theme: ThemePreference;
  density: Density;
}

const KEY = 'pevqori.prefs';
const DEFAULTS: Preferences = { theme: 'system', density: 'comfortable' };

let current: Preferences = DEFAULTS;
const listeners = new Set<() => void>();

function read(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: p.theme === 'light' || p.theme === 'dark' || p.theme === 'system' ? p.theme : DEFAULTS.theme,
      density: p.density === 'compact' || p.density === 'comfortable' ? p.density : DEFAULTS.density,
    };
  } catch {
    return DEFAULTS;
  }
}

function write(p: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // not remembered — still applied for this session
  }
}

function emit(): void {
  for (const l of [...listeners]) l();
}

function apply(p: Preferences): void {
  applyTheme(p.theme);
  applyDensity(p.density);
}

let booted = false;

/** Apply stored preferences before the first render (no flash of the wrong theme). */
export function bootstrapPreferences(): void {
  if (booted) return;
  booted = true;
  current = read();
  apply(current);
  if (getBridge()) {
    void native('theme.set', { mode: current.theme }).catch(() => undefined);
    onBridgeEvent('theme-changed', ({ dark }) => {
      // In 'system' mode CSS follows prefers-color-scheme by itself. An explicit mode that disagrees
      // with the native theme means the user changed it elsewhere (e.g. the window menu): adopt it.
      if (current.theme !== 'system' && (current.theme === 'dark') !== dark) {
        setPreferences({ theme: dark ? 'dark' : 'light' }, { syncNative: false });
      }
    });
  }
}

export function getPreferences(): Preferences {
  return current;
}

export function setPreferences(patch: Partial<Preferences>, opts: { syncNative?: boolean } = {}): void {
  const next = { ...current, ...patch };
  if (next.theme === current.theme && next.density === current.density) return;
  const themeChanged = next.theme !== current.theme;
  current = next;
  apply(next);
  write(next);
  if (themeChanged && opts.syncNative !== false && getBridge()) void native('theme.set', { mode: next.theme }).catch(() => undefined);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, getPreferences);
}

// ───────────────────────────── 2.0 layout preferences ─────────────────────────────
// Home view (Essentials / All menus) and the shortcut bar, per user profile (lib/uiPrefs.ts).

export { setUiPrefs, getUiPrefs } from './lib/uiPrefs.ts';
export type { HomeView, UiPrefs } from './lib/uiPrefs.ts';

/** The layout preferences, re-rendering on change. */
export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(subscribeUiPrefs, getUiPrefs, getUiPrefs);
}
