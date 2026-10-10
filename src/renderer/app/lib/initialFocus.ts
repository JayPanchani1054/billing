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

/**
 * Elements the shell itself focused as a screen's provisional starting point (nav.tsx). A screen that
 * places its own cursor once its form renders (e.g. Voucher Entry: number / party / Account / first
 * line, as accountants expect) must treat focus on one of these as "not chosen by the user" and move it;
 * focus anywhere else means the user already moved and must be left alone.
 */
const shellPicks = new WeakSet<object>();

export function markShellFocus(el: object): void {
  shellPicks.add(el);
}

export function isShellFocus(el: object | null | undefined): boolean {
  return el != null && shellPicks.has(el);
}

/**
 * A lazy screen's code has arrived (nav.tsx): has the user put focus somewhere else on purpose while it
 * loaded, so the screen must not take it? Only a move made during the load counts. Focus still on the
 * element that held it when the screen opened — e.g. the topbar "Search or jump to…" button that Go To
 * handed focus back to, or the shortcut-bar button that was clicked — is focus an eager screen takes at
 * once, so the lazy screen takes it too. Nothing focused, the page body, the screen itself or an element
 * that is no longer shown (inside the hidden screen that opened this one) is never a choice.
 */
export function keepUserFocusAfterLazyLoad(f: { active: object | null; atOpen: object | null; isBody: boolean; inScreen: boolean; shown: boolean }): boolean {
  if (f.active === null || f.isBody || f.inScreen || !f.shown) return false;
  return f.active !== f.atOpen;
}
