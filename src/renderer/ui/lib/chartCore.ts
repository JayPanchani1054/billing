/**
 * The graph code the start-up bundle needs (SPEC-21 §4.7): Home's mini columns and the KPI sparkline,
 * the lazy door's placeholder height (`ui/lazyChart.tsx`), and the spec helpers of the builders that
 * run on eager screens (Home, Bills pending, Quotations). Everything else — the kit's geometry
 * (`chart.ts`) and the builders' folding and colour rules (`chartSpec.ts`) — is reached only from
 * lazy screens and loads with the first graph. `chart.ts` and `chartSpec.ts` re-export all of this,
 * so lazy code and tests keep importing from them; eager code imports from here
 * (`app/lib/chartImports.test.ts` holds the rule). Pure — no React, no DOM.
 */
import { formatCompactINR, formatIndianNumber, formatPercent } from '../../../shared/format.ts';
import type { ChartSeries, ChartSpec, ValueFormat } from './chartSpec.ts';

// ---------------------------------------------------------------------------------------------
// Geometry: the sparkline, plot heights and the graph keyboard model
// ---------------------------------------------------------------------------------------------

export type Scale = (value: number) => number;

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export interface Point {
  x: number;
  y: number;
}

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** 'M x y L x y …' through the points (skipping null gaps → new subpath). */
export function linePath(points: ReadonlyArray<Point | null>): string {
  const segs: string[] = [];
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    segs.push(`${pen ? 'L' : 'M'}${r2(p.x)} ${r2(p.y)}`);
    pen = true;
  }
  return segs.join(' ');
}

/** Closed area under a line down to `baseY` (contiguous points only). */
export function areaPath(points: readonly Point[], baseY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  let d = `M${r2(first.x)} ${r2(baseY)} L${r2(first.x)} ${r2(first.y)}`;
  for (let i = 1; i < points.length; i++) d += ` L${r2(points[i].x)} ${r2(points[i].y)}`;
  d += ` L${r2(last.x)} ${r2(baseY)} Z`;
  return d;
}

export interface SparkGeometry {
  line: string;
  area: string;
  points: Point[];
  last: Point | null;
  min: number;
  max: number;
}

/** Sparkline geometry inside width×height with `pad` px inset (so the end dot is not clipped). */
export function sparkline(values: readonly number[], width: number, height: number, pad = 2): SparkGeometry {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { line: '', area: '', points: [], last: null, min: 0, max: 0 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const x = linearScale([0, Math.max(1, values.length - 1)], [pad, width - pad]);
  const y = min === max ? () => height / 2 : linearScale([min, max], [height - pad, pad]);
  const points: Point[] = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) points.push({ x: values.length === 1 ? width / 2 : x(i), y: y(v) });
  });
  return {
    line: linePath(points),
    area: areaPath(points, height - pad),
    points,
    last: points[points.length - 1] ?? null,
    min,
    max,
  };
}

/** Default plot height (px) of each kind — the strip's 20 px header line is not included. */
export function plotHeight(kind: 'column' | 'bar' | 'line' | 'share' | 'meter', rows = 0): number {
  if (kind === 'bar') return Math.max(1, rows) * HBAR_PITCH + 8;
  if (kind === 'share') return 52;
  if (kind === 'meter') return 44;
  return 148;
}

/**
 * CSS height of a column or line plot given no `height`: the strip's `--graph-h` (168 px, 152
 * compact — styles/report.css) minus its 20 px header line, i.e. `plotHeight('column')` at the
 * comfortable density. The strip's plot box sizes to its content (no fixed height), so the graph
 * carries its own height and never collapses inside an unsized host.
 */
export const STRIP_PLOT_HEIGHT = 'calc(var(--graph-h, 168px) - 20px)';

/**
 * The one keyboard model of every interactive graph (SPEC-21 §4.4; ui/Chart.tsx and ui/MiniColumns.tsx):
 * the next highlighted index for `key`, or null when the key is not a graph key (it then keeps its
 * global meaning). ←/→ step (↑/↓ for horizontal bars); from no highlight, → (↓) starts at the first
 * category and ← (↑) at the last; Home/End jump; the index stays inside [0, n − 1].
 */
export function graphKeyStep(key: string, cur: number, n: number, vertical = false): number | null {
  if (n <= 0) return null;
  const next = vertical ? 'ArrowDown' : 'ArrowRight';
  const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === next) return cur < 0 ? 0 : Math.min(n - 1, cur + 1);
  if (key === prev) return cur < 0 ? n - 1 : Math.max(0, cur - 1);
  return null;
}

/** Horizontal bars: 20 px row pitch, 12 px thick (§4.2). */
export const HBAR_PITCH = 20;
export const HBAR_THICKNESS = 12;

// ---------------------------------------------------------------------------------------------
// Spec helpers: limits, the Top-N fold, totals and gates
// ---------------------------------------------------------------------------------------------

/** Longest takeaway the strip header shows on one line at 1366 px. */
export const TAKEAWAY_MAX = 90;

export const OTHER_LABEL = 'Other';

/**
 * Top `n` items by |value| (ties keep input order) and the rest summed into one "Other" category,
 * last. Σ of the values is preserved exactly. "Other" is never a single item in disguise: when only
 * one item would fall into it, that item is shown by name instead (so 7 items at n = 6 are 7 bars,
 * the same count as 6 + Other). No "Other" when n ≥ length. A fold therefore always shows fewer
 * categories than there are items — `inlineBars` relies on that. When a kept item is itself named
 * like the fold (a POS tender "Other"), the fold says how many it holds: "Other (5)".
 */
export function foldTop<T>(items: readonly T[], n: number, value: (t: T) => number, label: (t: T) => string, otherLabel: string = OTHER_LABEL): { categories: string[]; values: number[] } {
  const ranked = items.map((t, i) => ({ v: value(t), name: label(t), i })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i);
  const keep = Math.max(0, Math.floor(Number.isFinite(n) ? n : items.length));
  const head = ranked.length > keep + 1 ? ranked.slice(0, keep) : ranked;
  const tail = ranked.length > keep + 1 ? ranked.slice(keep) : [];
  const categories = head.map((r) => r.name);
  const values = head.map((r) => r.v);
  if (tail.length > 0) {
    categories.push(categories.includes(otherLabel) ? `${otherLabel} (${tail.length})` : otherLabel);
    values.push(tail.reduce((s, r) => s + r.v, 0));
  }
  return { categories, values };
}

// ---------------------------------------------------------------------------------------------
// Totals and gates
// ---------------------------------------------------------------------------------------------

/** The series the graph measures: the first one not marked as context ('other'). */
export function measuredSeries(spec: ChartSpec): ChartSeries | null {
  return spec.series.find((s) => s.slot !== 'other') ?? null;
}

function drawn(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * What the drawing adds up to, to compare with the table: Σ of the measured series for column, bar
 * and share; the last drawn point of a line (a running balance ends on the table's closing); the
 * whole (`max`) of a meter.
 */
export function drawnTotal(spec: ChartSpec): number {
  if (spec.kind === 'meter') return spec.max ?? 0;
  const s = measuredSeries(spec);
  if (!s) return 0;
  const vals = drawn(s.values);
  if (spec.kind === 'line') return vals.length ? vals[vals.length - 1] : 0;
  return vals.reduce((a, b) => a + b, 0);
}

/**
 * Minimum data (D26): bar / column / share need ≥ 3 categories with a non-zero value; a line ≥ 3
 * points; a meter both parts (the fill and the track) > 0. Below that a builder returns null.
 */
export function enoughData(spec: ChartSpec): boolean {
  const s = measuredSeries(spec);
  if (!s) return false;
  if (spec.kind === 'meter') {
    const v = s.values[0];
    return typeof v === 'number' && v > 0 && (spec.max ?? 0) > 0;
  }
  const vals = drawn(s.values);
  if (spec.kind === 'line') return vals.length >= 3;
  return vals.filter((v) => v !== 0).length >= 3;
}

/**
 * D24: a stat never repeats a visible table total. True when a shown (non-zero) stat value equals a
 * table total, sign ignored (a Cr total and its owner's-words amount are the same number).
 */
export function statRepeatsTotal(statValues: readonly number[], tableTotals: readonly number[]): boolean {
  const totals = new Set(tableTotals.filter((t) => Number.isFinite(t) && t !== 0).map((t) => Math.abs(t)));
  return statValues.some((s) => Number.isFinite(s) && s !== 0 && totals.has(Math.abs(s)));
}

// ---------------------------------------------------------------------------------------------
// Takeaway templates (Indian compact money)
// ---------------------------------------------------------------------------------------------

/** Compact value for a takeaway or tick: ₹87.4 K · 1.2 L · 12.5 %. */
export function compactValue(v: number, f: ValueFormat = 'inr'): string {
  if (typeof f === 'object') return f.tick(v);
  if (f === 'inr') return formatCompactINR(v);
  if (f === 'percent') return formatPercent(v);
  const a = Math.abs(v);
  if (a >= 1e7) return `${formatIndianNumber(v / 1e7, 1)} Cr`;
  if (a >= 1e5) return `${formatIndianNumber(v / 1e5, 1)} L`;
  return formatIndianNumber(v, Number.isInteger(v) ? 0 : 2);
}

/** Keeps a takeaway within TAKEAWAY_MAX (an ellipsis replaces the overflow). */
export function clipTakeaway(s: string, max = TAKEAWAY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function grainWord(category: string): string | null {
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{2,4})?$/.test(category)) return 'month';
  if (/^Q[1-4] \d{2}-\d{2}$/.test(category)) return 'quarter';
  if (/^FY \d{2}-\d{2}$/.test(category)) return 'year';
  return null;
}

export const take = {
  /** "Best month Sep ₹87.4 K · Oct so far ₹42.3 K" (the running period is never the "best"). */
  max(spec: ChartSpec): string {
    const s = measuredSeries(spec);
    if (!s) return '';
    const f = spec.valueFormat ?? 'inr';
    const lastIdx = spec.categories.length - 1;
    const partial = !!spec.partialLast && spec.kind === 'column';
    let best = -1;
    s.values.forEach((v, i) => {
      if (v === null || (partial && i === lastIdx)) return;
      if (best < 0 || v > (s.values[best] ?? -Infinity)) best = i;
    });
    const parts: string[] = [];
    if (best >= 0) {
      const cat = spec.categories[best];
      const word = grainWord(cat);
      parts.push(`${word ? `Best ${word}` : 'Highest'} ${cat} ${compactValue(s.values[best] ?? 0, f)}`);
    }
    const last = s.values[lastIdx];
    if (partial && last !== null && last !== undefined) parts.push(`${spec.categories[lastIdx]} so far ${compactValue(last, f)}`);
    return clipTakeaway(parts.join(' · '));
  },
  /** "Wood Primer 1L holds 70 % of stock value". */
  share(name: string, pct: number, of: string): string {
    const tail = ` holds ${Math.round(pct)} % of ${of}`;
    const room = TAKEAWAY_MAX - tail.length;
    return clipTakeaway(`${name.length > room ? clipTakeaway(name, Math.max(8, room)) : name}${tail}`);
  },
  /** "₹1.67 L on 10-Oct, up ₹1.67 L since 1-Apr" (`delta` = "up ₹1.67 L since 1-Apr", or ''). */
  last(value: string, date: string, delta: string): string {
    return clipTakeaway(delta ? `${value} on ${date}, ${delta}` : `${value} on ${date}`);
  },
  /**
   * "Loss in 6 of 7 months; smallest in Sep (₹12.4 K)" (`best` = the closing phrase, or ''). Pass
   * `foldMonths(…).grain` when the period was folded: "Loss in 2 of 8 quarters".
   */
  polarity(lossMonths: number, months: number, best: string, grain: 'month' | 'quarter' | 'year' = 'month'): string {
    const unit = `${grain}s`;
    const head = lossMonths <= 0 ? `Profit in all ${months} ${unit}` : lossMonths >= months ? `Loss in all ${months} ${unit}` : `Loss in ${lossMonths} of ${months} ${unit}`;
    return clipTakeaway(best ? `${head}; ${best}` : head);
  },
  /** "Of ₹4.66 L in unpaid bills, ₹1.91 L is over 90 days". */
  ordinal(old: string, base: string, threshold: string): string {
    return clipTakeaway(`Of ${base}, ${old} is over ${threshold}`);
  },
};

// ---------------------------------------------------------------------------------------------
// The 2.0 chart props, as a spec (ui/BarChart.tsx and ui/LineChart.tsx adapters)
// ---------------------------------------------------------------------------------------------

/**
 * A 2.0 `BarChart` / `LineChart` call as a spec for the 2.1 kit, or null when there is nothing to
 * draw (no category, or no finite value — the 2.0 empty rule). The first series is the measured one;
 * a later series keeps an explicit slot 2 (the full Dashboard's Purchases, until it becomes context)
 * and is context ('other') otherwise. Not asserted: 2.0 callers predate the 2.1 rules.
 */
export function legacySpec(
  kind: 'column' | 'line',
  p: { title: string; description?: string; categories: readonly string[]; series: readonly ChartSeries[]; valueFormat?: ValueFormat; label?: 'max' | 'last' | 'none'; activate?: (index: number) => void },
): ChartSpec | null {
  const hasData = p.categories.length > 0 && p.series.some((s) => s.values.some((v) => typeof v === 'number' && Number.isFinite(v)));
  if (!hasData) return null;
  const series = p.series.map((s, i): ChartSeries => ({ name: s.name, values: s.values, slot: i === 0 ? 1 : s.slot === 2 ? 2 : 'other' }));
  const spec: ChartSpec = { kind, title: p.title, takeaway: clipTakeaway(p.description ?? ''), categories: p.categories, series, valueFormat: p.valueFormat ?? 'inr', label: p.label, activate: p.activate, total: 0 };
  return { ...spec, total: drawnTotal(spec) };
}
