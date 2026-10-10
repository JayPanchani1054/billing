/**
 * Theme resolution (2.0): 'system' is resolved in JS to data-theme="light" | "dark" and follows OS
 * changes live; CSS keeps one light and one dark block (no prefers-color-scheme duplicate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, getComputedTheme, resolveTheme, resolvedTheme } from './theme.ts';
import type { ThemePreference } from './theme.ts';

class FakeRoot {
  attrs = new Map<string, string>();
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
}

type Listener = (e: { matches: boolean }) => void;

/** Installs a controllable `matchMedia('(prefers-color-scheme: dark)')`. */
function fakeOs(dark: boolean) {
  const listeners = new Set<Listener>();
  const mq = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  const g = globalThis as { matchMedia?: unknown };
  const previous = g.matchMedia;
  g.matchMedia = (q: string) => {
    assert.equal(q, '(prefers-color-scheme: dark)');
    return mq;
  };
  return {
    listeners,
    set(next: boolean) {
      dark = next;
      for (const l of [...listeners]) l({ matches: next });
    },
    restore() {
      g.matchMedia = previous;
    },
  };
}

const asRoot = (r: FakeRoot) => r as unknown as HTMLElement;

test('resolveTheme: explicit preferences ignore the OS; system follows it', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('bogus' as ThemePreference, true), 'dark', 'unknown values behave like system');
});

test("applyTheme('system') writes the resolved theme and follows OS changes live", () => {
  const os = fakeOs(true);
  try {
    const root = new FakeRoot();
    applyTheme('system', asRoot(root));
    assert.equal(root.getAttribute('data-theme'), 'dark');
    assert.equal(root.getAttribute('data-theme-pref'), 'system');
    assert.equal(getComputedTheme(asRoot(root)), 'dark');
    os.set(false);
    assert.equal(root.getAttribute('data-theme'), 'light');
    os.set(true);
    assert.equal(root.getAttribute('data-theme'), 'dark');
    assert.equal(os.listeners.size, 1);
  } finally {
    os.restore();
  }
});

test('explicit light/dark are unchanged by OS changes and drop the system subscription', () => {
  const os = fakeOs(true);
  try {
    const root = new FakeRoot();
    applyTheme('system', asRoot(root));
    applyTheme('light', asRoot(root));
    assert.equal(os.listeners.size, 0, 'switching away from system unsubscribes');
    assert.equal(root.getAttribute('data-theme'), 'light');
    assert.equal(root.getAttribute('data-theme-pref'), 'light');
    os.set(false);
    os.set(true);
    assert.equal(root.getAttribute('data-theme'), 'light');
    applyTheme('dark', asRoot(root));
    os.set(false);
    assert.equal(root.getAttribute('data-theme'), 'dark');
    assert.equal(os.listeners.size, 0);
  } finally {
    os.restore();
  }
});

test("re-applying 'system' never stacks listeners", () => {
  const os = fakeOs(false);
  try {
    const root = new FakeRoot();
    for (let i = 0; i < 5; i++) applyTheme('system', asRoot(root));
    assert.equal(os.listeners.size, 1);
    assert.equal(root.getAttribute('data-theme'), 'light');
  } finally {
    os.restore();
  }
});

test('without matchMedia, system resolves to light and nothing subscribes', () => {
  const g = globalThis as { matchMedia?: unknown };
  const previous = g.matchMedia;
  delete g.matchMedia;
  try {
    const root = new FakeRoot();
    applyTheme('system', asRoot(root));
    assert.equal(root.getAttribute('data-theme'), 'light');
    assert.equal(getComputedTheme(asRoot(root)), 'light');
  } finally {
    g.matchMedia = previous;
  }
});

test('getComputedTheme reads data-theme; the pre-bootstrap "system" placeholder resolves via the OS', () => {
  const os = fakeOs(true);
  try {
    const root = new FakeRoot();
    root.setAttribute('data-theme', 'system');
    assert.equal(getComputedTheme(asRoot(root)), 'dark');
    root.setAttribute('data-theme', 'light');
    assert.equal(getComputedTheme(asRoot(root)), 'light');
    assert.equal(resolvedTheme, getComputedTheme, '1.0 name kept as an alias');
  } finally {
    os.restore();
  }
});
