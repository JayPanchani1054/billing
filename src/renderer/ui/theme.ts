/**
 * Theme & density switches. Tokens react to attributes on <html> (or any subtree):
 *   data-theme="light" | "dark"  (always the resolved theme — CSS has one light and one dark block)
 *   data-theme-pref="light" | "dark" | "system"  (what the user chose)
 *   data-density="comfortable" | "compact"
 * The 'system' preference is resolved here in JS and follows OS changes live; index.html carries
 * data-theme="system" only as a pre-bootstrap placeholder (it matches the :root light fallback).
 */
import type { Density } from './types.ts';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Pure resolution of a preference against the OS setting. Anything unknown counts as 'system'. */
export function resolveTheme(pref: ThemePreference, osDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return osDark ? 'dark' : 'light';
}

function darkQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null;
}

/** Live OS-theme subscriptions made by applyTheme('system'), one per root. */
const following = new WeakMap<HTMLElement, () => void>();

export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement): void {
  following.get(root)?.();
  following.delete(root);
  const explicit = theme === 'light' || theme === 'dark';
  const mq = darkQuery();
  const set = (osDark: boolean) => root.setAttribute('data-theme', resolveTheme(theme, osDark));
  root.setAttribute('data-theme-pref', explicit ? theme : 'system');
  set(mq?.matches ?? false);
  if (!explicit && mq) {
    const listener = (e: MediaQueryListEvent) => set(e.matches);
    mq.addEventListener('change', listener);
    following.set(root, () => mq.removeEventListener('change', listener));
  }
}

export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-density', density);
}

/** The theme actually in effect, read from data-theme (resolves the pre-bootstrap 'system' placeholder). */
export function getComputedTheme(root: HTMLElement = document.documentElement): ResolvedTheme {
  const t = root.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return resolveTheme('system', darkQuery()?.matches ?? false);
}

/** Alias of getComputedTheme (1.0 name). */
export const resolvedTheme = getComputedTheme;

/** Subscribe to OS theme changes. Returns an unsubscribe function. */
export function onSystemThemeChange(cb: (dark: boolean) => void): () => void {
  const mq = darkQuery();
  if (!mq) return () => undefined;
  const listener = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/** True when the user asked the OS for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
