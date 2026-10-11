/**
 * The graphs toggle of 2.1 (SPEC-21 D28, §4.5) — pure, tested in graphsToggle.test.ts; the React side is
 * `useGraphsToggle()` / `GraphStrip` in app/graphStrip.tsx.
 *
 * Two classes of graph, each remembered on this computer (`pevqori.ui`, lib/uiPrefs.ts):
 * - 'report' — Home, the full Dashboard and every report: shown by default (`graphs`);
 * - 'detail' — drill-down reports (ledger, monthly / group summary, stock item, party statement, GST
 *   e-ledgers, forex ledger): folded by default (`detailGraphs`).
 * Folded = the strip keeps its one-line header (title · takeaway · "Show graphs"); the answer never goes.
 *
 * This file holds the ONLY literal of the toggle key in the renderer (keyConventions.test.ts guards it).
 */

export type GraphKind = 'report' | 'detail';

/** The toggle key (registered by a screen only while it shows a graph). */
export const GRAPHS_KEY = 'Ctrl+J';

/** The same key as `aria-keyshortcuts` writes it. */
export const GRAPHS_ARIA_KEY = 'Control+J';

/** The `pevqori.ui` field that remembers a class. */
export function graphsPrefKey(kind: GraphKind): 'graphs' | 'detailGraphs' {
  return kind === 'detail' ? 'detailGraphs' : 'graphs';
}

/** Whether graphs of this class are shown (unfolded), from the stored preferences. */
export function graphsShown(prefs: { graphs: boolean; detailGraphs: boolean }, kind: GraphKind): boolean {
  return prefs[graphsPrefKey(kind)];
}

/** Which screens one press changes, in the owner's words. */
export function graphsScope(kind: GraphKind): string {
  return kind === 'detail' ? 'detail reports' : 'all reports and Home';
}

/** "Hide graphs" / "Show graphs" — plural: the key changes every screen of the class. */
export function graphsLabel(shown: boolean): string {
  return shown ? 'Hide graphs' : 'Show graphs';
}

/** The toggle's tooltip: "Hide graphs on all reports and Home · Ctrl+J". */
export function graphsTooltip(shown: boolean, kind: GraphKind): string {
  return `${graphsLabel(shown)} on ${graphsScope(kind)} · ${GRAPHS_KEY}`;
}

/** What the live region says after a toggle: "Graphs hidden on all reports and Home". */
export function graphsAnnouncement(shown: boolean, kind: GraphKind): string {
  return `Graphs ${shown ? 'shown' : 'hidden'} on ${graphsScope(kind)}`;
}

/** The screen action (a ScreenActionItem): More ▾ lists it, F1 shows it, its key folds / unfolds the class. */
export interface GraphsAction {
  key: string;
  label: string;
  onClick: () => void;
  group: 'view';
  hint: string;
}

/** The toggle as a screen action for the current state. */
export function graphsAction(shown: boolean, kind: GraphKind, toggle: () => void = () => {}): GraphsAction {
  return { key: GRAPHS_KEY, label: graphsLabel(shown), onClick: toggle, group: 'view', hint: `${graphsLabel(shown)} on ${graphsScope(kind)}` };
}
