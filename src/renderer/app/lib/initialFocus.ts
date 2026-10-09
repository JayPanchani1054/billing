/**
 * Initial focus of a newly opened screen — ranking and the "upgrade" rule (pure; tested in
 * initialFocus.test.ts). The DOM side lives in nav.tsx (ScreenHost).
 *
 * On push the shell focuses the best candidate: [data-autofocus] → first editable field → first
 * grid → first tabbable → the heading. Many screens render a loading skeleton first, so the first
 * pick is often only the heading (or a toolbar button). Until the user does something, the shell
 * keeps watching the screen and moves focus to a better candidate as soon as it appears — e.g.
 * the Name field of Ledger Creation once its groups have loaded.
 */
export const FOCUS_RANK = { heading: 0, tabbable: 1, grid: 2, field: 3, autofocus: 4 } as const;
export type FocusRank = (typeof FOCUS_RANK)[keyof typeof FOCUS_RANK];

/** Stop watching after this long even if nothing better appeared (ms). */
export const INITIAL_FOCUS_WATCH_MS = 10_000;

/**
 * Move focus from the current provisional pick to `candidate`? Only while the shell's own pick
 * still has focus (the user, or the screen itself, has not moved it) and the candidate is a real
 * starting point (a grid, a field or [data-autofocus]) that ranks higher.
 */
export function shouldUpgradeFocus(current: { rank: number; stillFocused: boolean }, candidateRank: number | null): boolean {
  if (!current.stillFocused || candidateRank === null) return false;
  return candidateRank >= FOCUS_RANK.grid && candidateRank > current.rank;
}

/** Keep watching for a better candidate after the first pick? */
export function needsFocusWatch(rank: number): boolean {
  return rank < FOCUS_RANK.autofocus;
}
