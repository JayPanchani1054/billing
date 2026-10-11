/**
 * The command bar's selection rule (docs/ARCHITECTURE.md §7) — pure, tested in commandBar.test.ts; rendered by
 * ui/CommandBar.tsx in the top screen's title row (2.1: the shell portals it into PageHeader's
 * `[data-actions-slot]`). It only DISPLAYS the top screen's actions: their keys are registered by
 * `useScreenActions` (nav.tsx) whether or not a button shows them, so a key works the same with the
 * command bar, the shortcut bar, both or neither.
 *
 * 1. The `primary` action (at most one) is the filled button.
 * 2. Up to N secondary buttons: first the actions marked `prominent` (declaration order), then the
 *    conventions — matched by key AND verb, so "Payables Alt+W" or "Compare Alt+C" never take a
 *    convention slot unless `prominent`: Alter (Alt+A), Print (Alt+P), Share (Alt+W), Export (Alt+E),
 *    More details (Ctrl+I), Create (Alt+C). Hidden actions never count; enabled ones are preferred over
 *    disabled. N = commandBarSlots(width of the title row): 3 from 900 px, 2 from 640 px, else 1.
 * 3. `demoted` actions (2.1) are never buttons — not even as primary, prominent or convention — and go to
 *    "More" with their key (still registered). Menu-only items (`key: NO_KEY`, i.e. '') are never
 *    promoted and never block a global's key.
 * 4. Everything else — then the shell's globals (F11, F12, F1) whose key no screen action uses — goes
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
  /** (2.1) Never a button: listed under More with its key (SPEC-21 §3.1 rule 2b). */
  demoted?: boolean;
  /** (2.1) A checkable item (More renders it as a menuitemcheckbox). */
  checked?: boolean;
  id?: string;
}

/** Convention keys that earn a button, in priority order. */
export const COMMAND_BAR_CONVENTIONS: readonly string[] = ['Alt+A', 'Alt+P', 'Alt+W', 'Alt+E', 'Ctrl+I', 'Alt+C'];

/**
 * The verb each convention key must carry in its label (2.1): an action with the key but another meaning
 * (Tick all Alt+A, Payables Alt+W, Compare Alt+C) is an ordinary action — a button only when `prominent`.
 */
export const COMMAND_BAR_VERBS: Readonly<Record<string, RegExp>> = {
  'alt+a': /^alter\b/i,
  'alt+p': /^(re)?print\b/i,
  'alt+w': /^share\b/i,
  'alt+e': /^(export\b|save( \w+)? as pdf\b)/i,
  'ctrl+i': /^more details\b/i,
  'alt+c': /^create\b/i,
};

/** Width breakpoints of the title row (px) → number of secondary buttons. */
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

/** A menu-only item (`key: NO_KEY`): no key to register, show or promote. */
export function isKeyless(a: { key: string }): boolean {
  return norm(a.key) === '';
}

/** Does this action fill the convention slot of `key` (the key and the verb both match)? */
export function isConvention(a: CommandBarAction, key: string): boolean {
  const k = norm(key);
  if (norm(a.key) !== k) return false;
  const verb = COMMAND_BAR_VERBS[k];
  return verb ? verb.test(a.label.trim()) : true;
}

export function layoutCommandBar<T extends CommandBarAction>(screen: readonly T[], globals: readonly T[], slots: number): CommandBarLayout<T> {
  const visible = screen.filter((a) => !a.hidden);
  const promotable = (a: T): boolean => !a.demoted && !isKeyless(a);
  const primary = visible.find((a) => a.primary && promotable(a)) ?? null;

  const candidates: T[] = [];
  const seen = new Set<T>();
  const consider = (a: T | undefined) => {
    if (!a || a === primary || seen.has(a) || !promotable(a)) return;
    seen.add(a);
    candidates.push(a);
  };
  for (const a of visible) if (a.prominent) consider(a);
  for (const key of COMMAND_BAR_CONVENTIONS) for (const a of visible) if (isConvention(a, key)) consider(a);

  const n = Math.max(0, Math.floor(slots));
  const chosen = new Set<T>([...candidates.filter((a) => !a.disabled), ...candidates.filter((a) => a.disabled)].slice(0, n));
  const buttons = candidates.filter((a) => chosen.has(a));

  const taken = new Set(visible.filter((a) => !isKeyless(a)).map((a) => norm(a.key)));
  const more = [...visible.filter((a) => a !== primary && !chosen.has(a)), ...globals.filter((g) => !g.hidden && !taken.has(norm(g.key)))];
  return { primary, buttons, more };
}

/** The fields of an action that decide what the bars draw (ActionRailItem satisfies it). */
export interface ShownAction extends CommandBarAction {
  group?: string;
  icon?: string;
  hint?: string;
}

/**
 * The identity of a screen's action list for the bars (`useScreenActions` republishes only when it
 * changes): every field that changes what a bar draws or where — including the 2.1 `prominent`, `demoted`
 * and `checked` — but never the handlers (those are looked up fresh on click).
 */
export function actionsSignature(items: readonly ShownAction[]): string {
  return items
    .map((i) =>
      [i.id ?? '', i.key, i.label, i.disabled ? 1 : 0, i.hidden ? 1 : 0, i.group ?? '', i.icon ?? '', i.hint ?? '', i.primary ? 1 : 0, i.prominent ? 1 : 0, i.demoted ? 1 : 0, i.checked === undefined ? '' : i.checked ? 1 : 0].join('\u0001'),
    )
    .join('\u0002');
}

/**
 * The actions whose key `useScreenActions` registers as a screen hotkey: not hidden (rule 2: hiding an
 * action unregisters its key), not disabled, and not menu-only (`NO_KEY`). `demoted` and non-promoted
 * actions keep their key — a button's absence never changes what a key does.
 */
export function hotkeyActions<T extends CommandBarAction>(items: readonly T[]): T[] {
  return items.filter((it) => !it.hidden && !it.disabled && !isKeyless(it));
}
