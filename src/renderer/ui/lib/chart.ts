/**
 * Dependency-free chart math: nice axis ticks, linear scales, band layout, SVG path builders.
 * Pure — unit tested in chart.test.ts.
 */
import { markColor } from './chartSpec.ts';
import type { ChartSpec, MarkColor } from './chartSpec.ts';

/** "Nice" step ≥ rough: 1, 2, 2.5, 5 × 10^k. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const f = rough / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * Evenly spaced round tick values covering [min, max], always including 0 when the data spans or
 * touches it. `count` is a target, not a guarantee.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo > 0) lo = 0; // bar/line charts of amounts read best from zero
  if (hi < 0) hi = 0;
  if (lo === hi) hi = lo === 0 ? 1 : lo + Math.abs(lo);
  const step = niceStep((hi - lo) / Math.max(1, count - 1));
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start, guard = 0; v <= end + step / 2 && guard < 100; v += step, guard++) {
    const r = Math.round(v / step) * step; // kill float drift
    ticks.push(r === 0 ? 0 : Number(r.toPrecision(12)));
  }
  return ticks;
}

export type Scale = (value: number) => number;

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export interface Band {
  step: number;
  bandwidth: number;
  /** Left edge of band i. */
  start: (i: number) => number;
  /** Centre of band i. */
  center: (i: number) => number;
}

/** Split [x0, x1] into `count` bands with inner/outer padding ratios (0–1 of a step). */
export function bandLayout(count: number, x0: number, x1: number, paddingInner = 0.3, paddingOuter = 0.15): Band {
  const n = Math.max(1, count);
  const step = (x1 - x0) / Math.max(1e-9, n - paddingInner + paddingOuter * 2);
  const bandwidth = step * (1 - paddingInner);
  const offset = x0 + step * paddingOuter;
  return {
    step,
    bandwidth,
    start: (i) => offset + i * step,
    center: (i) => offset + i * step + bandwidth / 2,
  };
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

/**
 * Bar/column path with a rounded data-end (radius ≤ 4, clamped to the bar) and a square baseline.
 * Vertical bars: x/width horizontal, grows from `base` to `value` (y coordinates, either direction).
 */
export function barPath(x: number, width: number, base: number, value: number, radius = 4): string {
  const h = Math.abs(base - value);
  if (width <= 0 || h <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, h));
  const up = value < base; // SVG y grows downward → positive values go up
  const tip = value;
  const k = up ? 1 : -1; // direction from tip back toward base
  const x2 = x + width;
  return [
    `M${r2(x)} ${r2(base)}`,
    `V${r2(tip + k * r)}`,
    `Q${r2(x)} ${r2(tip)} ${r2(x + r)} ${r2(tip)}`,
    `H${r2(x2 - r)}`,
    `Q${r2(x2)} ${r2(tip)} ${r2(x2)} ${r2(tip + k * r)}`,
    `V${r2(base)}`,
    'Z',
  ].join(' ');
}

/** Index of the category band nearest to a pointer x (for crosshair snapping). */
export function nearestIndex(x: number, centers: readonly number[]): number {
  let best = -1;
  let dist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(centers[i] - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// 2.1 kit geometry (SPEC-21 §4.2): text fitting, horizontal bars, share bar, polarity ticks, heights
// ---------------------------------------------------------------------------------------------

/** Rough text width (px) for layout decisions (Segoe UI ≈ 0.6em per character at small sizes). */
export function textWidth(s: string, fontPx = 11): number {
  return s.length * fontPx * 0.6;
}

/** `s`, or its longest prefix + '…' that fits `maxPx` (measured with `textWidth`). */
export function fitText(s: string, maxPx: number, fontPx = 11): string {
  if (textWidth(s, fontPx) <= maxPx) return s;
  const chars = Math.max(0, Math.floor(maxPx / (fontPx * 0.6)) - 1);
  return chars > 0 ? `${s.slice(0, chars).trimEnd()}…` : '';
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

/**
 * Indexes of the direct labels a column or line carries (§4.2): the extreme (`max`: the largest |value|,
 * zeros never), the endpoint (`last`: the last drawn point) or none — never every mark; a running
 * period (`partialLast` column) is always labelled ("so far"). Reads the measured (first) series.
 */
export function labelIndexes(spec: ChartSpec, fallback: 'max' | 'last'): number[] {
  const s = spec.series[0];
  if (!s) return [];
  const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const mode = spec.label ?? fallback;
  const out: number[] = [];
  if (mode === 'max') {
    let best = -1;
    s.values.forEach((v, i) => {
      if (ok(v) && v !== 0 && (best < 0 || Math.abs(v) > Math.abs(s.values[best] as number))) best = i;
    });
    if (best >= 0) out.push(best);
  } else if (mode === 'last') {
    for (let i = s.values.length - 1; i >= 0; i--) {
      if (ok(s.values[i])) {
        out.push(i);
        break;
      }
    }
  }
  const last = spec.categories.length - 1;
  if (spec.partialLast && spec.kind === 'column' && ok(s.values[last]) && !out.includes(last)) out.push(last);
  return out;
}

/** Horizontal bars: 20 px row pitch, 12 px thick (§4.2). */
export const HBAR_PITCH = 20;
export const HBAR_THICKNESS = 12;
/** The bar-name column of a horizontal bar graph. */
export const HBAR_NAME_WIDTH = 200;

export interface HBarRow {
  /** Top of the bar (px) and its thickness. */
  y: number;
  height: number;
  /** Left and right edge of the bar; equal for a zero value (no mark). */
  x0: number;
  x1: number;
  /** Centre line of the row (names, labels, the row wash). */
  cy: number;
  /** The value label sits outside the tip: right of a positive bar, left of a negative one. */
  labelX: number;
  labelAnchor: 'start' | 'end';
  negative: boolean;
}

/**
 * Rows of a horizontal bar graph inside `width`: names in the first `nameWidth` px, then the value
 * axis with room for an outside tip label of `labelWidth` px on each side that has bars. Bars grow
 * from one zero line (polarity: negatives to the left of it). Pitch 20, thickness 12, from `top`.
 */
export function hbarLayout(values: readonly (number | null)[], opts: { width: number; nameWidth?: number; labelWidth?: number; top?: number }): { rows: HBarRow[]; zeroX: number; plotLeft: number; plotRight: number; height: number } {
  const nameWidth = opts.nameWidth ?? HBAR_NAME_WIDTH;
  const labelWidth = Math.max(0, opts.labelWidth ?? 0);
  const top = opts.top ?? 4;
  const vals = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const plotLeft = nameWidth + 8 + (min < 0 ? labelWidth + 4 : 0);
  const plotRight = Math.max(plotLeft + 24, opts.width - (max > 0 ? labelWidth + 4 : 0));
  const x = linearScale([min, max === min ? min + 1 : max], [plotLeft, plotRight]);
  const zeroX = x(0);
  const rows = vals.map((v, i) => {
    const y = top + i * HBAR_PITCH + (HBAR_PITCH - HBAR_THICKNESS) / 2;
    const end = x(v);
    const negative = v < 0;
    return {
      y,
      height: HBAR_THICKNESS,
      x0: Math.min(zeroX, end),
      x1: Math.max(zeroX, end),
      cy: top + i * HBAR_PITCH + HBAR_PITCH / 2,
      labelX: negative ? Math.min(zeroX, end) - 4 : Math.max(zeroX, end) + 4,
      labelAnchor: negative ? ('end' as const) : ('start' as const),
      negative,
    };
  });
  return { rows, zeroX, plotLeft, plotRight, height: top + vals.length * HBAR_PITCH + 4 };
}

/** Horizontal bar path with a rounded data end (radius ≤ 4) and a square end at the zero line. */
export function hbarPath(y: number, height: number, zeroX: number, endX: number, radius = 4): string {
  const w = Math.abs(endX - zeroX);
  if (height <= 0 || w <= 0) return '';
  const r = Math.max(0, Math.min(radius, height / 2, w));
  const k = endX > zeroX ? -1 : 1; // direction from the tip back toward zero
  const y2 = y + height;
  return [`M${r2(zeroX)} ${r2(y)}`, `H${r2(endX + k * r)}`, `Q${r2(endX)} ${r2(y)} ${r2(endX)} ${r2(y + r)}`, `V${r2(y2 - r)}`, `Q${r2(endX)} ${r2(y2)} ${r2(endX + k * r)} ${r2(y2)}`, `H${r2(zeroX)}`, 'Z'].join(' ');
}

export interface ShareSegment {
  /** Category index the segment draws. */
  index: number;
  x: number;
  width: number;
}

/**
 * One 100 % bar split into segments (§4.2 share): a `gap` px surface gap between drawn segments,
 * every drawn segment at least `min` px (taken from the larger ones), zero / negative values not
 * drawn. Σ widths = width − gaps exactly (up to floating point).
 */
export function shareSegments(values: readonly (number | null)[], width: number, gap = 2, min = 4): ShareSegment[] {
  const drawnIdx = values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? i : -1)).filter((i) => i >= 0);
  if (drawnIdx.length === 0 || width <= 0) return [];
  const avail = Math.max(0, width - gap * (drawnIdx.length - 1));
  const val = (i: number) => values[i] as number;
  const floor = Math.min(min, avail / drawnIdx.length);
  const pinned = new Set<number>();
  let widths = new Map<number, number>();
  // Segments under the floor are pinned at it; the others share what is left by value. Pinning only
  // shrinks the others, so repeat until no free segment falls under the floor.
  for (let guard = 0; guard <= drawnIdx.length; guard++) {
    const free = drawnIdx.filter((i) => !pinned.has(i));
    const freeSum = free.reduce((s, i) => s + val(i), 0);
    const room = avail - pinned.size * floor;
    widths = new Map(drawnIdx.map((i) => [i, pinned.has(i) ? floor : (val(i) / freeSum) * room]));
    const under = free.filter((i) => (widths.get(i) ?? 0) < floor);
    if (under.length === 0) break;
    for (const i of under) pinned.add(i);
  }
  const out: ShareSegment[] = [];
  let x = 0;
  for (const i of drawnIdx) {
    const w = widths.get(i) ?? 0;
    out.push({ index: i, x, width: w });
    x += w + gap;
  }
  return out;
}

/**
 * Ticks of a polarity column (profit up, loss down from one zero line): values from `niceTicks`,
 * labels of the absolute value — the axis captions ("Profit ↑" / "Loss ↓") carry the sign, so a
 * label never shows a minus.
 */
export function polarityTicks(min: number, max: number, format: (v: number) => string, count = 5): { value: number; label: string }[] {
  return niceTicks(min, max, count).map((value) => ({ value, label: format(Math.abs(value)).replace(/^[-−]/, '') }));
}

/**
 * Axis tick text, Indian compact without the currency sign (the title says what is measured):
 * 0 · 500 · 50 K · 1 L · 1.5 L · 2.25 Cr. `n` is in display units (rupees for money).
 */
export function compactTick(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const a = Math.abs(n);
  const trim = (x: number) => String(Number(x.toFixed(2)));
  const body = a >= 1e7 ? `${trim(a / 1e7)} Cr` : a >= 1e5 ? `${trim(a / 1e5)} L` : a >= 1e3 ? `${trim(a / 1e3)} K` : trim(a);
  return n < 0 ? `-${body}` : body;
}

/**
 * The colour of one mark of a spec (D29 `markColor`). A 2.0 caller of the BarChart/LineChart
 * adapters may still name slot 2 for its second series (the full Dashboard's Purchases until it
 * becomes context); that explicit choice is kept so the two series stay apart.
 */
export function seriesColor(spec: ChartSpec, categoryIndex: number, seriesIndex = 0): MarkColor {
  const s = spec.series[seriesIndex];
  if (seriesIndex > 0 && s && s.slot === 2) return 2;
  return markColor(spec, categoryIndex, seriesIndex);
}

/** CSS class (styles/charts.css) that sets `--series` for a mark colour: bx-chart--s-1 … bx-chart--o-5. */
export function colorClass(c: MarkColor): string {
  if (typeof c === 'string' && /^o[1-5]$/.test(c)) return `bx-chart--o-${c.slice(1)}`;
  return `bx-chart--s-${c}`;
}
