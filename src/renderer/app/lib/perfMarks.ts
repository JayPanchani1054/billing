/**
 * Start-up performance marks (docs/ARCHITECTURE.md §9a). Three User Timing marks, each set once per
 * renderer load:
 *
 *   pevqori:boot          main.tsx, once every module of the entry bundle has been evaluated, just
 *                         before React renders
 *   pevqori:first-screen  App.tsx, when the first real start screen (company list, data-folder setup,
 *                         login, or the workspace) has been committed — the splash does not count
 *   pevqori:shell-ready   App.tsx, when the workspace (the shell with the company open) first mounts
 *
 * plus the measure `pevqori:startup` between them. `e2e/perf.spec.ts` reads them through
 * `performance.getEntriesByName`; nothing in the app depends on them and no user-visible behaviour
 * changes. Pure (the Performance object is a parameter), so the node unit test drives it.
 */

import type { AppPhase } from './appPhase.ts';

export const BOOT_MARK = 'pevqori:boot';
export const FIRST_SCREEN_MARK = 'pevqori:first-screen';
export const SHELL_READY_MARK = 'pevqori:shell-ready';
export const STARTUP_MEASURE = 'pevqori:startup';

/** The part of the User Timing API these helpers use (the browser's and Node's `performance`). */
export interface MarkTarget {
  mark(name: string): unknown;
  measure(name: string, startMark: string, endMark: string): unknown;
  getEntriesByName(name: string, type?: string): ArrayLike<{ startTime: number; duration: number }>;
}

function defaultTarget(): MarkTarget | null {
  const perf = (globalThis as { performance?: Partial<MarkTarget> }).performance;
  return perf && typeof perf.mark === 'function' && typeof perf.getEntriesByName === 'function' && typeof perf.measure === 'function'
    ? (perf as MarkTarget)
    : null;
}

function firstStart(perf: MarkTarget, name: string, type: 'mark' | 'measure'): number | null {
  const entries = perf.getEntriesByName(name, type);
  return entries.length > 0 ? entries[0].startTime : null;
}

/**
 * Set mark `name` unless it is already set (StrictMode runs effects twice; a remount must not move
 * it). Returns true when this call set it. Never throws: timing must not break the app.
 */
export function markOnce(name: string, perf: MarkTarget | null = defaultTarget()): boolean {
  if (!perf) return false;
  try {
    if (perf.getEntriesByName(name, 'mark').length > 0) return false;
    perf.mark(name);
    return true;
  } catch {
    return false;
  }
}

/** `pevqori:boot` — called once from main.tsx. */
export function markBoot(perf: MarkTarget | null = defaultTarget()): boolean {
  return markOnce(BOOT_MARK, perf);
}

/**
 * `pevqori:first-screen` — the first time App.tsx shows a start screen the user can act on (anything
 * but the splash). On a normal start it is the company list, so boot → first-screen is the time the
 * user waits before they can pick a company, without the time they then take to pick one.
 */
export function markFirstScreen(perf: MarkTarget | null = defaultTarget()): boolean {
  return markOnce(FIRST_SCREEN_MARK, perf);
}

/**
 * `pevqori:shell-ready` — the first time the workspace mounts (later company switches, locks and
 * remounts do not move it), and the `pevqori:startup` measure when the boot mark exists.
 */
export function markShellReady(perf: MarkTarget | null = defaultTarget()): boolean {
  const set = markOnce(SHELL_READY_MARK, perf);
  if (set && perf && firstStart(perf, BOOT_MARK, 'mark') !== null) {
    try {
      perf.measure(STARTUP_MEASURE, BOOT_MARK, SHELL_READY_MARK);
    } catch {
      /* the marks stay readable on their own */
    }
  }
  return set;
}

export interface StartupMarks {
  /** ms from navigation start to `pevqori:boot` (HTML, entry bundle download, parse and evaluation). */
  boot: number | null;
  /** ms from navigation start to `pevqori:first-screen`. */
  firstScreen: number | null;
  /** ms from navigation start to `pevqori:shell-ready`. */
  shellReady: number | null;
  /** `pevqori:boot` → `pevqori:shell-ready` in ms, when both are set. */
  bootToShellReady: number | null;
}

/** The marks as numbers (null when not set yet). */
export function readStartupMarks(perf: MarkTarget | null = defaultTarget()): StartupMarks {
  if (!perf) return { boot: null, firstScreen: null, shellReady: null, bootToShellReady: null };
  const boot = firstStart(perf, BOOT_MARK, 'mark');
  const firstScreen = firstStart(perf, FIRST_SCREEN_MARK, 'mark');
  const shellReady = firstStart(perf, SHELL_READY_MARK, 'mark');
  return { boot, firstScreen, shellReady, bootToShellReady: boot !== null && shellReady !== null ? shellReady - boot : null };
}

/**
 * The marks a start-up phase sets (App.tsx calls this from an effect on `app.phase`): any phase but
 * the splash ('loading') is the first screen; 'workspace' is also shell-ready ('locked' is not: the
 * workspace is only reached through 'workspace'). Returns the marks this call set.
 */
export function markPhase(phase: AppPhase, perf: MarkTarget | null = defaultTarget()): string[] {
  const set: string[] = [];
  if (phase === 'loading') return set;
  if (markFirstScreen(perf)) set.push(FIRST_SCREEN_MARK);
  if (phase === 'workspace' && markShellReady(perf)) set.push(SHELL_READY_MARK);
  return set;
}
