/**
 * The command bar's selection rule (docs/ARCHITECTURE.md §7) — pure, tested in commandBar.test.ts; rendered by
 * ui/CommandBar.tsx in the screen bar (Workspace). It only DISPLAYS the top screen's actions: their
 * keys are registered by `useScreenActions` (nav.tsx) whether or not a button shows them, so a key
 * works the same with the command bar, the shortcut bar, both or neither.
 *
 * 1. The `primary` action (at most one) is the filled button.
 * 2. Up to N secondary buttons: first the actions marked `prominent` (declaration order), then the
 *    convention list Alter (Alt+A), Print (Alt+P), Share (Alt+W), Export (Alt+E), More details
 *    (Ctrl+I), Create (Alt+C). Hidden actions never count; enabled ones are preferred over disabled.
 *    N = 3 when the bar is at least 900 px wide, 2 from 640 px, else 1.
 * 3. Everything else — then the shell's globals (F11, F12, F1) whose key no screen action uses — goes
 *    to "More".
 */

/** The fields of an action the rule reads (ActionRailItem satisfies it). */
export interface CommandBarAction {
  key: string;
  label: string;
  hidden?: boolean;
  disabled?: boolean;
  primary?: boolean;
  prominent?: boolean;
  id?: string;
}

/** Convention keys that earn a button, in priority order. */
export const COMMAND_BAR_CONVENTIONS: readonly string[] = ['Alt+A', 'Alt+P', 'Alt+W', 'Alt+E', 'Ctrl+I', 'Alt+C'];

/** Width breakpoints of the screen bar (px) → number of secondary buttons. */
export const COMMAND_BAR_BREAKPOINTS = { wide: 900, medium: 640 } as const;

export function commandBarSlots(width: number): number {
  if (width >= COMMAND_BAR_BREAKPOINTS.wide) return 3;
  if (width >= COMMAND_BAR_BREAKPOINTS.medium) return 2;
  return 1;
}

export interface CommandBarLayout<T extends CommandBarAction> {
  primary: T | null;
  buttons: T[];
  /** Screen actions not shown as buttons (declaration order), then the globals. */
  more: T[];
}

const norm = (key: string): string => key.replace(/\s+/g, '').toLowerCase();

export function layoutCommandBar<T extends CommandBarAction>(screen: readonly T[], globals: readonly T[], slots: number): CommandBarLayout<T> {
  const visible = screen.filter((a) => !a.hidden);
  const primary = visible.find((a) => a.primary) ?? null;

  const candidates: T[] = [];
  const seen = new Set<T>();
  const consider = (a: T | undefined) => {
    if (!a || a === primary || seen.has(a)) return;
    seen.add(a);
    candidates.push(a);
  };
  for (const a of visible) if (a.prominent) consider(a);
  for (const key of COMMAND_BAR_CONVENTIONS) for (const a of visible) if (norm(a.key) === norm(key)) consider(a);

  const n = Math.max(0, Math.floor(slots));
  const chosen = new Set<T>([...candidates.filter((a) => !a.disabled), ...candidates.filter((a) => a.disabled)].slice(0, n));
  const buttons = candidates.filter((a) => chosen.has(a));

  const taken = new Set(visible.map((a) => norm(a.key)));
  const more = [...visible.filter((a) => a !== primary && !chosen.has(a)), ...globals.filter((g) => !g.hidden && !taken.has(norm(g.key)))];
  return { primary, buttons, more };
}
