/**
 * The graph strip of a report (2.1, SPEC-21 §4.1 / §4.5).
 *
 * WP-0b STUB: the final signatures, so wave-1 lanes can build against them; WP-B2 fills it in
 * (header line, fold toggle, `data-graphs` on the report body, the remembered `graphs` /
 * `detailGraphs` preferences and the toggle action from `app/lib/graphsToggle.ts`). Until then
 * no strip renders and no toggle action is offered — screens look exactly as in 2.0.
 */
import type { ReactNode } from 'react';
import type { ScreenActionItem } from './nav.tsx';

/**
 * What `Screen` / `ReportScreen`'s `graph` prop takes. Structurally the same object `reportGraph()`
 * (ui/lazyChart.tsx) returns: the strip's title and one-sentence takeaway, whether the table carries
 * the bars inline (then `render` draws nothing), and the plot itself.
 */
export interface ReportGraph {
  title: string;
  takeaway: string;
  inline: boolean;
  render: (ids: { describedBy: string }) => ReactNode;
}

/** Which preference folds the graph: 'report' (shown by default) or 'detail' (folded by default). */
export type GraphKind = 'report' | 'detail';

export interface GraphsToggle {
  /** Whether graphs of this kind are shown (unfolded). */
  shown: boolean;
  /** Flip the remembered preference for this kind. */
  toggle: () => void;
  /** The screen action that toggles graphs, or null when there is none (stub: always null). */
  action: ScreenActionItem | null;
}

/** The strip above a report's table: header line (title · takeaway · toggle) and, when shown, the plot. */
export function GraphStrip(p: { graph: ReportGraph | null; kind?: GraphKind }): ReactNode {
  void p;
  return null;
}

/** The remembered show/hide state for a graph kind, and the action that toggles it. */
export function useGraphsToggle(kind: GraphKind): GraphsToggle {
  void kind;
  return { shown: true, toggle: () => {}, action: null };
}
