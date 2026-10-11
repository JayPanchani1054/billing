/**
 * The only door to ui/Chart.tsx (SPEC-21 §4.1, §4.7, D27). Imported by path
 * (`import { reportGraph } from '../../ui/lazyChart.tsx'`), never through the ui barrel, and the
 * barrel never re-exports it — so the graph kit stays in its own chunk, fetched when the first graph
 * renders (chartImports.test.ts holds the rule).
 *
 * While the chunk loads, the place of the plot is an empty box of the final height: no `.bx-skeleton`
 * and no `aria-busy` (e2e/perf.spec.ts reads those as "the screen is still loading"). A chunk that
 * fails to load draws nothing — the table below is the truth.
 */
import { Suspense, lazy, useDeferredValue, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { STRIP_PLOT_HEIGHT, plotHeight } from './lib/chart.ts';
import { enoughData, legacySpec } from './lib/chartSpec.ts';
import type { ChartSpec } from './lib/chartSpec.ts';
import type { ChartProps } from './chartParts.tsx';

export type { ChartProps } from './chartParts.tsx';

function Nothing(): ReactNode {
  return null;
}

const ChartLazy = lazy(() =>
  import('./Chart.tsx').then(
    (m) => ({ default: m.Chart }),
    () => ({ default: Nothing as (p: ChartProps) => ReactNode }),
  ),
);

/** The placeholder's height: the plot's own (`height`, or the kind's; column and line the strip's). */
function placeholderHeight(spec: ChartSpec, height: number | undefined): number | string {
  if (height !== undefined) return height;
  if (spec.kind === 'column' || spec.kind === 'line') return STRIP_PLOT_HEIGHT;
  return plotHeight(spec.kind, spec.categories.length);
}

/**
 * `Chart`, loaded on first use. Renders from `useDeferredValue(spec)`, so the table paints and takes
 * focus first; the graph follows.
 */
export function LazyChart(p: ChartProps): ReactNode {
  const spec = useDeferredValue(p.spec);
  const fallback = <div className="bx-chart" style={{ height: placeholderHeight(spec, p.height) }} />;
  return (
    <Suspense fallback={fallback}>
      <ChartLazy {...p} spec={spec} />
    </Suspense>
  );
}

/** What Screen / ReportScreen's `graph` prop takes (structurally `ReportGraph` of app/graphStrip.tsx). */
export interface ReportGraphOf {
  title: string;
  takeaway: string;
  /** The table carries the bars (D26): `render` draws nothing, the strip shows its header line only. */
  inline: boolean;
  render: (ids: { describedBy: string }) => ReactNode;
}

/**
 * A report's graph for the strip: null when there is no spec or too little data (`enoughData`) — then
 * no strip and no Ctrl+J item. `inline` (from `inlineBars(spec, rows)`) keeps the header line only.
 */
export function reportGraph(spec: ChartSpec | null, opts: { inline?: boolean } = {}): ReportGraphOf | null {
  if (!spec || !enoughData(spec)) return null;
  const inline = !!opts.inline;
  return {
    title: spec.title,
    takeaway: spec.takeaway,
    inline,
    render: ({ describedBy }) => (inline ? null : <LazyChart spec={spec} describedBy={describedBy} />),
  };
}

/**
 * The 2.0 `BarChart` / `LineChart` props as a spec (ui/lib/chartSpec.ts `legacySpec`), memoised. 2.0
 * callers pass `onCategoryActivate` as an inline arrow; it is read through a ref, so a parent render
 * does not hand the graph a new spec (and a second, deferred render) each time.
 */
export function useLegacySpec(kind: 'column' | 'line', p: Omit<Parameters<typeof legacySpec>[1], 'activate'> & { onCategoryActivate?: (index: number) => void }): ChartSpec | null {
  const act = useRef(p.onCategoryActivate);
  act.current = p.onCategoryActivate;
  const can = p.onCategoryActivate !== undefined;
  const { title, description, categories, series, valueFormat, label } = p;
  return useMemo(
    () => legacySpec(kind, { title, description, categories, series, valueFormat, label, activate: can ? (i) => act.current?.(i) : undefined }),
    [kind, title, description, categories, series, valueFormat, label, can],
  );
}
