/**
 * The title row's pure rules (2.1, SPEC-21 §1.1–§1.2, WP-B1) — tested in screenHead.test.ts; rendered by
 * ui/PageHeader.tsx (the row) and app/Workspace.tsx (top bar, command bar, window title).
 *
 * - The `‹` back button exists from stack depth 2: its name is "Back to <previous title>", its tooltip the
 *   whole path ("Home › Profit & Loss A/c · Esc").
 * - The context run is one line of words after the h1 (PageHeader joins the non-empty `subtitle` and
 *   `meta` with " · "); while the screen has unsaved changes it ends with NOT_SAVED, which never
 *   ellipsizes away.
 * - The command bar of the title row shows at most one filled primary and three secondary buttons.
 * - The top bar's working date: "Sat 10-Oct-26", named "Working date Sat 10-Oct-26" for assistive
 *   technology. Tooltips ("Print · Alt+P") come from ui's `keyTip` (ui/lib/keyText.ts).
 */

/** Separator between the parts of the context run, the back path and a tooltip's label and key. */
export const CONTEXT_SEP = ' · ';
export const PATH_SEP = ' › ';

/** The word the context run ends with while the screen has unsaved changes (and the hidden status says). */
export const NOT_SAVED = 'Not saved';

/** At most one filled primary and three secondary buttons in the title row (D2). */
export const TITLE_ROW_CAPS = { primary: 1, secondary: 3 } as const;

export interface BackTarget {
  /** Accessible name of the `‹` button: "Back to Home". */
  label: string;
  /** Its tooltip: the whole path and the key, "Home › Profit & Loss A/c · Esc". */
  tip: string;
}

/**
 * The back button of the screen at `index` in a stack whose titles are `titles` (root first), or null at
 * the root (Home has no back button).
 */
export function backTarget(titles: readonly string[], index: number): BackTarget | null {
  if (index < 1 || index >= titles.length) return null;
  const previous = titles[index - 1] || 'previous screen';
  return { label: `Back to ${previous}`, tip: `${titles.slice(0, index + 1).join(PATH_SEP)}${CONTEXT_SEP}Esc` };
}

/** The fields of a laid-out command bar the caps read (CommandBarLayout satisfies it). */
export interface TitleRowLayout<T> {
  primary: T | null;
  buttons: T[];
  more: T[];
}

/**
 * Apply the title row's caps to a command-bar layout: secondaries beyond three move to the front of More
 * (in their order), so nothing is lost. `layoutCommandBar` already gives at most `commandBarSlots(width)`
 * ≤ 3 — this keeps the promise whatever the slot count.
 */
export function capTitleRow<T>(layout: TitleRowLayout<T>): TitleRowLayout<T> {
  if (layout.buttons.length <= TITLE_ROW_CAPS.secondary) return layout;
  return {
    primary: layout.primary,
    buttons: layout.buttons.slice(0, TITLE_ROW_CAPS.secondary),
    more: [...layout.buttons.slice(TITLE_ROW_CAPS.secondary), ...layout.more],
  };
}

/** Window title: "• " first while anything is unsaved, then screen · company · Pevqori. */
export function windowTitle(title: string, company: string, dirty: boolean): string {
  return `${dirty ? '• ' : ''}${[title, company, 'Pevqori'].filter(Boolean).join(CONTEXT_SEP)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The top bar's working date: "Sat 10-Oct-26" ({ weekday, date } so the weekday can hide on a narrow
 * window). An invalid ISO date gives empty strings.
 */
export function workingDateLabel(iso: string): { weekday: string; date: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return { weekday: '', date: '' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return { weekday: '', date: '' };
  return { weekday: WEEKDAYS[t.getUTCDay()], date: `${d}-${MONTHS[mo - 1]}-${String(y).slice(-2)}` };
}

/**
 * Accessible name of the working-date button: its visible words after "Working date" (label-in-name), so
 * a screen reader says what the date is, not only "Sat 10-Oct-26".
 */
export function workingDateName(day: { weekday: string; date: string }, isToday: boolean): string {
  return ['Working date', day.weekday, day.date, isToday ? '' : 'not today'].filter(Boolean).join(' ');
}

/** How long a request runs before the top bar's working hairline shows (D33). */
export const WORKING_DELAY_MS = 400;
