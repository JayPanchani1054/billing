/**
 * The graph strip of a report (2.1, SPEC-21 §1.9, §4.1, §4.5): one header line — the graph's title, its
 * one-sentence takeaway and a "Hide graphs" / "Show graphs" text button — and, while graphs of the
 * screen's class are shown, the plot. Folded (the toggle key, or a detail report by default) the header line
 * stays, so the answer never disappears. A graph drawn inline in the table (short tables, D26) shows the
 * header line only; `data-graphs="on|off"` on the report body hides or shows those inline bars.
 *
 * The class decides which remembered preference folds it (`pevqori.ui`, lib/uiPrefs.ts): 'report'
 * (Home, the full Dashboard, every report — shown by default) or 'detail' (drill-down reports — folded
 * by default). The toggle key and every text about it come from lib/graphsToggle.ts.
 *
 * No skeleton and no aria-busy here: while the lazy chart loads, its own placeholder holds the height;
 * while the report refetches, the body (and so the strip) dims to 0.6 and keeps the last render.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ScreenActionItem } from './nav.tsx';
import { getUiPrefs, setUiPrefs, useUiPrefs } from './preferences.ts';
import { GRAPHS_ARIA_KEY, graphsAction, graphsAnnouncement, graphsLabel, graphsPrefKey, graphsShown, graphsTooltip } from './lib/graphsToggle.ts';

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
  /** The screen action that toggles graphs (the toggle key; More ▾, F1). Add it only while the screen shows a graph. */
  action: ScreenActionItem | null;
}

/** The strip above a report's table: header line (title · takeaway · toggle) and, when shown, the plot. */
export function GraphStrip(p: { graph: ReportGraph | null; kind?: GraphKind }): ReactNode {
  const { graph, kind = 'report' } = p;
  const { shown, toggle } = useGraphsToggle(kind);
  const takeawayId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const announcement = useToggleAnnouncement(shown, kind);
  const state = shown ? 'on' : 'off';
  const plotFocus = usePlotFocus(shown, toggleRef);

  // A host that does not render `data-graphs` itself (a plain Screen body) gets it from the strip, so
  // inline bars follow the toggle there too. ReportFrame's body declares it.
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host || host.classList.contains('bx-report__body')) return undefined;
    host.setAttribute('data-graphs', state);
    return () => host.removeAttribute('data-graphs');
  }, [state, graph !== null]);

  if (!graph) return null;
  // The plot itself defers its spec (ui/lazyChart.tsx `useDeferredValue`), so the table paints and takes
  // focus first (SPEC-21 §4.7). Deferring here as well would render the strip twice per screen render:
  // `reportGraph()` returns a new object every time.
  const plot = shown && !graph.inline ? graph : null;
  return (
    <div ref={ref} className="bx-report__graph">
      <div className="bx-report__graph-head">
        <span className="bx-report__graph-title">{graph.title}</span>
        <span id={takeawayId} className="bx-report__graph-takeaway" title={graph.takeaway}>
          {graph.takeaway}
        </span>
        <button ref={toggleRef} type="button" className="bx-report__graph-toggle" onClick={toggle} title={graphsTooltip(shown, kind)} aria-keyshortcuts={GRAPHS_ARIA_KEY}>
          {graphsLabel(shown)}
        </button>
      </div>
      {plot ? (
        <div className="bx-report__graph-plot" onFocus={plotFocus.onFocus} onBlur={plotFocus.onBlur}>
          {plot.render({ describedBy: takeawayId })}
        </div>
      ) : null}
      <span className="bx-sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

/** The remembered show/hide state for a graph kind, and the action that toggles it. */
export function useGraphsToggle(kind: GraphKind): GraphsToggle {
  const prefs = useUiPrefs();
  const shown = graphsShown(prefs, kind);
  const toggle = useCallback(() => {
    const field = graphsPrefKey(kind);
    // Read the store, not the render: two quick presses must flip twice.
    setUiPrefs(field === 'graphs' ? { graphs: !getUiPrefs().graphs } : { detailGraphs: !getUiPrefs().detailGraphs });
  }, [kind]);
  const action = useMemo<ScreenActionItem>(() => graphsAction(shown, kind, toggle), [shown, kind, toggle]);
  return { shown, toggle, action };
}

/**
 * Folding the graphs with the toggle key while the graph has focus removes the focused element: focus would fall
 * to <body>, where only global keys work. It moves to the strip's own "Show graphs" button instead.
 */
function usePlotFocus(shown: boolean, toggleRef: { current: HTMLButtonElement | null }) {
  const inPlot = useRef(false);
  useLayoutEffect(() => {
    if (shown || !inPlot.current) return;
    inPlot.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) toggleRef.current?.focus();
  }, [shown, toggleRef]);
  return {
    onFocus: () => {
      inPlot.current = true;
    },
    // A move to another element clears it; a blur without a new target (the plot being removed) does not.
    onBlur: (e: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) inPlot.current = false;
    },
  };
}

/** "Graphs hidden on all reports and Home" after a change — never on first render. */
function useToggleAnnouncement(shown: boolean, kind: GraphKind): string {
  const [text, setText] = useState('');
  const prev = useRef(shown);
  useEffect(() => {
    if (prev.current === shown) return;
    prev.current = shown;
    setText(graphsAnnouncement(shown, kind));
  }, [shown, kind]);
  return text;
}
