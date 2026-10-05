/**
 * Dependency-free chart math: nice axis ticks, linear scales, band layout, SVG path builders.
 * Pure — unit tested in chart.test.ts.
 */

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
