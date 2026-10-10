/**
 * Lazy feature screens (SPEC D15, docs/ARCHITECTURE.md §9a). A module's index.ts registers a screen
 * whose code is fetched the first time the screen opens:
 *
 *   import { lazyScreen } from '../../app/lazyScreen.tsx';
 *   const BrsScreen = lazyScreen(() => import('./BrsScreen.tsx').then((m) => m.BrsScreen));
 *   … screens: [{ id: 'banking.brs', title: 'Bank Reconciliation', component: BrsScreen, … }]
 *
 * Only the screen component is lazy. Menus, Go To providers, dashboard cards, voucher panels, Home
 * notices, print blocks, module CSS and dialog screens (`presentation: 'dialog'`, which open over a live
 * screen in the same frame as their key) stay eager. While the chunk loads, `ScreenStack` (nav.tsx) shows
 * the screen skeleton inside the screen's error boundary; initial focus follows the content in
 * (nav.tsx initial-focus watch). A file that eager code also imports statically is not split by the
 * bundler — `lazyScreen.test.ts` refuses that, so every lazy screen really leaves the start-up bundle.
 */
import { createElement, use } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createLazyLoader, retryFailedLoads } from './lib/lazyLoader.ts';

/** A plain function component that loads its implementation on first render (or on `preload()`). */
export interface LazyScreen<P extends object> {
  (props: P): ReactNode;
  /** Fetch the screen's code now (idle prefetch). Never rejects; resolves once loaded or failed. */
  preload: () => Promise<void>;
  displayName?: string;
}

export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): LazyScreen<P> {
  const loader = createLazyLoader(load);
  const LazyScreenComponent = (props: P): ReactNode => {
    const now = loader.peek();
    // Loaded → render at once (no fallback flash on re-open or after a prefetch). Otherwise suspend
    // on the cached promise (React's `use`); a failed load throws its error to the screen boundary.
    const Comp = now.status === 'loaded' ? now.value : use(loader.load());
    return createElement(Comp, props);
  };
  const out = LazyScreenComponent as LazyScreen<P>;
  out.preload = () =>
    loader.load().then(
      () => undefined,
      () => undefined,
    );
  out.displayName = 'LazyScreen';
  return out;
}

/** Has this component a `preload()` (a lazy screen)? */
export function isLazyScreen(c: unknown): c is { preload: () => Promise<void> } {
  return typeof c === 'function' && typeof (c as { preload?: unknown }).preload === 'function';
}

/** The screen boundary's "Try again": failed screen loads are attempted again on the next render. */
export function retryLazyScreens(): number {
  return retryFailedLoads();
}

/**
 * Screens prefetched in idle time once the workspace is up (`pevqori:shell-ready`): the lazy targets of
 * Home › Essentials (app/lib/essentials.ts), in Essentials order. Eager screens in the list cost nothing
 * (no `preload`); screens the user cannot open (F11 off, no permission) are skipped by nav.tsx.
 */
export const PREFETCH_SCREENS: readonly string[] = [
  'inventory.item.list',
  'outstanding.receivables',
  'outstanding.payables',
  'reports.profitLoss',
  'reports.balanceSheet',
  'reports.trialBalance',
  'stock.summary',
  'reports.cashBank',
  'gst.gstr1',
  'gst.gstr3b',
  'gst.cmp08',
  'gst.gstr4',
  'data.backup',
];
