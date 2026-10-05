/**
 * Theme & density switches. Tokens react to attributes on <html> (or any subtree):
 *   data-theme="light" | "dark" | "system"   data-density="comfortable" | "compact"
 */
import type { Density } from './types.ts';

export type ThemePreference = 'light' | 'dark' | 'system';

export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
}

export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-density', density);
}

/** The theme actually in effect (resolves 'system' via prefers-color-scheme). */
export function resolvedTheme(root: HTMLElement = document.documentElement): 'light' | 'dark' {
  const t = root.getAttribute('data-theme');
  if (t === 'dark') return 'dark';
  if (t === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

/** Subscribe to OS theme changes (only matters for 'system'). Returns an unsubscribe function. */
export function onSystemThemeChange(cb: (dark: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const listener = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/** True when the user asked the OS for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
