/**
 * Home menu's description tooltip (2.1, SPEC-21 §1.3 / D9) — pure, tested in homeTip.test.ts; used by
 * app/Gateway.tsx. One tooltip sits beside the menu column (outside it, so the column's scroll box never
 * clips it) and shows what the hovered or keyboard-reached item is for.
 */

/** The last kind of input seen on the window. */
export type LastInput = 'key' | 'pointer' | null;

/**
 * Whether focusing an item should show its tooltip: only when the user moved there with the keyboard
 * from another element (↑/↓ in the list, Tab from the top bar). Not when Home focuses its first item by
 * itself — on open, after Esc from a screen, after Ctrl+1 / Ctrl+2 — where focus comes from nowhere
 * (`fromElement` false: the previous element was removed or was the page body), nor after a click.
 */
export function tipOnFocus(lastInput: LastInput, fromElement: boolean): boolean {
  return lastInput === 'key' && fromElement;
}

/** Vertical extent of a box (a DOMRect subset). */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * Where the tooltip's vertical centre goes, relative to the Home root: the item's middle — or null when
 * the item's middle is outside the menu column's visible box (scrolled away), so the tip never points at
 * nothing.
 */
export function tipTop(item: Span, root: Span, menu: Span): number | null {
  const mid = (item.top + item.bottom) / 2;
  if (mid < menu.top || mid > menu.bottom) return null;
  return mid - root.top;
}
