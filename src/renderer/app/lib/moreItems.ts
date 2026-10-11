/**
 * Ready-made More ▾ items for the 2.1 report template (SPEC-21 §1.2, §2.3, D24) — pure, tested in
 * moreItems.test.ts. Each returns a screen action (ScreenActionItem-shaped) that a screen passes in its
 * `actions`; the shell lists it under More ▾ (and in F1 / the shortcut bar).
 *
 * - `aboutItem(open)` — "About this report": notes, legal lines and footnotes moved off the screen.
 *   `ReportScreen`'s `about` prop adds it (and the drawer) by itself.
 * - `columnsItem(columns, hidden, setHidden)` — "Columns…": a checklist of the table's columns over
 *   DataTable's `hiddenColumns`. The checklist dialog is opened by `ColumnsHost` (app/ReportScreen.tsx,
 *   subscribed with `onColumnsRequest` while its screen is on top): every ReportScreen renders one; a
 *   plain `Screen` that offers the item renders `<ColumnsHost />` itself.
 * - `checkItem(label, checked, onToggle)` — a checkable view option ("Show empty tables", "Only parties
 *   over their credit limit") rendered as `menuitemcheckbox`.
 *
 * Menu-only items have no key: `key: MENU_ONLY` (`''`, the same value as `NO_KEY` of ui/ActionRail.tsx),
 * so nothing is registered for them and no key text shows. New action fields are written after
 * `onClick` (the key-convention scan reads `key, label, onClick…`).
 */

/** The key of a menu-only item (= `NO_KEY` of ui/ActionRail.tsx): registers nothing, shows no key. */
export const MENU_ONLY = '';

/** A More ▾ item. Structurally a ScreenActionItem (2.1 fields `checked` / `demoted` included). */
export interface MoreItem {
  key: string;
  label: string;
  onClick: () => void;
  group?: string;
  hint?: string;
  id?: string;
  disabled?: boolean;
  /** Checkable view option (rendered as menuitemcheckbox). */
  checked?: boolean;
  /** A convention-key action that goes to More instead of a button (its key stays registered). */
  demoted?: boolean;
}

/** "About this report" — opens the report's notes (a drawer). */
export function aboutItem(open: () => void, label = 'About this report'): MoreItem {
  return { key: MENU_ONLY, label, onClick: open, group: 'help', id: 'about' };
}

/** A checkable, keyless (unless given a key) view option. */
export function checkItem(label: string, checked: boolean, onToggle: (next: boolean) => void, key: string = MENU_ONLY): MoreItem {
  return { key, label, onClick: () => onToggle(!checked), group: 'view', checked, id: `check:${label}` };
}

// ───────────────────────────── Columns… ─────────────────────────────

/** What "Columns…" needs of a DataTable column. */
export interface ColumnLike {
  key: string;
  header?: unknown;
  headerLabel?: string;
  hidden?: boolean;
}

export interface ColumnChoice {
  key: string;
  label: string;
  shown: boolean;
  /** The first column (the row's name) and the last shown column cannot be hidden. */
  locked: boolean;
}

/** The plain-text name of a column (headerLabel, a string header, else its key). */
export function columnLabel(c: ColumnLike): string {
  if (c.headerLabel) return c.headerLabel;
  if (typeof c.header === 'string' && c.header.trim()) return c.header.trim();
  return c.key;
}

/** The checklist: every column the table can show (columns with `hidden: true` never show). */
export function columnChoices(columns: readonly ColumnLike[], hidden: readonly string[]): ColumnChoice[] {
  const available = columns.filter((c) => !c.hidden);
  const off = new Set(hidden);
  const shownCount = available.filter((c) => !off.has(c.key)).length;
  return available.map((c, i) => {
    const shown = !off.has(c.key);
    return { key: c.key, label: columnLabel(c), shown, locked: i === 0 || (shown && shownCount <= 1) };
  });
}

/** `hidden` after toggling one column — never the first column, never the last one shown; unknown keys ignored. */
export function toggleColumn(columns: readonly ColumnLike[], hidden: readonly string[], key: string): string[] {
  const choice = columnChoices(columns, hidden).find((c) => c.key === key);
  const clean = hidden.filter((k, i) => hidden.indexOf(k) === i);
  if (!choice || choice.locked) return clean;
  return choice.shown ? [...clean, key] : clean.filter((k) => k !== key);
}

/** What the host dialog receives when "Columns…" is chosen. */
export interface ColumnsRequest {
  columns: readonly ColumnLike[];
  hidden: readonly string[];
  setHidden: (next: string[]) => void;
}

const columnListeners = new Set<(r: ColumnsRequest) => void>();

/** A host (`ColumnsHost` of the top screen) listens for "Columns…"; returns the unsubscribe. */
export function onColumnsRequest(cb: (r: ColumnsRequest) => void): () => void {
  columnListeners.add(cb);
  return () => {
    columnListeners.delete(cb);
  };
}

/** Ask the host to open the checklist. False when no host is listening. */
export function requestColumns(r: ColumnsRequest): boolean {
  if (columnListeners.size === 0) return false;
  for (const l of [...columnListeners]) l(r);
  return true;
}

/** "Columns…" — keyless; its hint counts the hidden columns ("2 hidden"). */
export function columnsItem(columns: readonly ColumnLike[], hidden: readonly string[], setHidden: (next: string[]) => void): MoreItem {
  const n = columnChoices(columns, hidden).filter((c) => !c.shown).length;
  return {
    key: MENU_ONLY,
    label: 'Columns…',
    onClick: () => void requestColumns({ columns, hidden, setHidden }),
    group: 'view',
    id: 'columns',
    ...(n > 0 ? { hint: `${n} hidden` } : {}),
  };
}
