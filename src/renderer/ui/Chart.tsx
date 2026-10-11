/**
 * The 2.1 graph (SPEC-21 §4): one component for the five kinds — column, bar (horizontal), line,
 * share and meter — on the pure contract of ui/lib/chartSpec.ts and the geometry of ui/lib/chart.ts.
 * Hand-rolled SVG, React + plain CSS (styles/charts.css), no dependency.
 *
 * NEVER imported statically and NEVER exported from ui/index.ts: only ui/lazyChart.tsx loads it,
 * through import(), so no eager screen pulls it into the start-up bundle (chartImports.test.ts).
 *
 * Roles (§4.4): an interactive graph is one Tab stop — `role="listbox"`, `aria-roledescription
 * ="graph"`, named by the title, described by the takeaway, one `option` per category followed by
 * `aria-activedescendant`; the SVG is `aria-hidden`; a visually hidden data table follows. A meter
 * is static (`role="img"`). Keys are local: ←/→ (↑/↓ for bars), Home/End, Enter = `spec.activate`
 * (the same as Enter on the matching table row). Hover has one effect per kind: band highlight
 * (column), row wash (bar), crosshair (line), segment lift (share).
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ChartDataTable, ChartLegend, ChartTooltip, describeCategory, fullFormatter, labelFormatter, tickFormatter, useElementSize } from './chartParts.tsx';
import type { ChartProps, TooltipRow } from './chartParts.tsx';
import { STRIP_PLOT_HEIGHT, areaPath, bandLayout, barPath, colorClass, fitText, graphKeyStep, hbarLayout, hbarPath, labelIndexes, linePath, linearScale, nearestIndex, niceTicks, plotHeight, polarityTicks, seriesColor, shareSegments, textWidth } from './lib/chart.ts';
import type { Point } from './lib/chart.ts';
import { MAX_LINE_POINTS, decimate, measuredSeries } from './lib/chartSpec.ts';
import type { ChartSpec } from './lib/chartSpec.ts';
import { cx } from './lib/cx.ts';

export type { ChartProps } from './chartParts.tsx';

/** Bottom band for category names (px) and the room above the tallest mark for its label. */
const AXIS_BAND = 24;
const TOP = 16;
const BAR_MAX = 24;
const GAP = 2;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function Chart(p: ChartProps): ReactNode {
  return p.spec.kind === 'meter' ? <Meter {...p} /> : <Plot {...p} />;
}

/** A ratio against a limit: figure + "A of B" + an 8 px track (static, role=img). */
function Meter({ spec, describedBy, className }: ChartProps): ReactNode {
  const own = useId();
  const value = measuredSeries(spec)?.values[0] ?? 0;
  const max = spec.max ?? 0;
  const f = spec.valueFormat ?? 'inr';
  const label = labelFormatter(f);
  const full = fullFormatter(f);
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const over = value > max;
  const of = `${label(value)} of ${label(max)}${over ? ` — over by ${label(value - max)}` : ''}`;
  return (
    <>
      <div className={cx('bx-chart', 'bx-chart__meter', className)} role="img" aria-label={`${spec.title}: ${full(value)} of ${full(max)}${over ? ', over the limit' : ''}`} aria-describedby={describedBy ?? own}>
        <p className="bx-statline">
          <span className="bx-kpi__value">{`${pct} %`}</span>
          <span className="bx-kpi__label">{of}</span>
        </p>
        <div className="bx-chart__meter-track">
          <div className={cx('bx-chart__meter-fill', colorClass(over ? 2 : 1))} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      </div>
      {describedBy ? null : (
        <p id={own} className="bx-sr-only">
          {spec.takeaway}
        </p>
      )}
      <ChartDataTable caption={spec.title} categories={spec.categories.length ? spec.categories : [spec.title]} series={[{ name: measuredSeries(spec)?.name ?? spec.title, values: [value] }, { name: 'Limit', values: [max] }]} format={full} />
    </>
  );
}

interface Geometry {
  w: number;
  h: number;
  /** Category index under a pointer at (x, y) in plot coordinates, or -1. */
  pick: (x: number, y: number) => number;
  /** Where the tooltip of category i is anchored. */
  anchor: (i: number) => { x: number; y: number };
  draw: (highlight: number) => ReactNode;
}

function Plot({ spec, height, active, describedBy, className }: ChartProps): ReactNode {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const kind = spec.kind;
  const n = spec.categories.length;
  const box = useElementSize(wrapRef, 640, height ?? plotHeight(kind, n));
  const shareLegend = kind === 'share' ? shareNeedsLegend(spec, box.w) : false;
  // A share bar without room for its names under the segments drops that row (the legend names them).
  const fixedHeight = kind === 'bar' || kind === 'share' ? (height ?? (shareLegend ? SHARE_Y * 2 + SHARE_H + 4 : plotHeight(kind, n))) : height;
  const uid = useId();
  const [hover, setHover] = useState(-1);
  const [focusIdx, setFocusIdx] = useState(-1);
  const f = spec.valueFormat ?? 'inr';
  const full = fullFormatter(f);
  const valid = (i: number | undefined): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < n;
  const highlight = hover >= 0 ? hover : focusIdx >= 0 ? focusIdx : valid(active) ? active : -1;
  const tipIdx = hover >= 0 ? hover : focusIdx;
  const interactive = n > 0;

  const geo = useMemo(() => geometry(spec, box.w, fixedHeight ?? box.h), [spec, box.w, box.h, fixedHeight]);

  const partialIdx = spec.partialLast && kind === 'column' ? n - 1 : -1;
  const optionLabel = (i: number) => describeCategory(spec.categories[i], spec.series, i, full, i === partialIdx ? ' so far' : '');

  // Keys are local (§4.4): with a modifier they keep their global meaning (Ctrl+J, Alt+←, …).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive || e.ctrlKey || e.altKey || e.metaKey) return;
    const to = graphKeyStep(e.key, focusIdx, n, kind === 'bar');
    if (to !== null) setFocusIdx(to);
    else if (e.key === 'Enter' && focusIdx >= 0 && spec.activate) spec.activate(focusIdx);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = geo.pick(e.clientX - r.left, e.clientY - r.top);
    setHover(valid(i) ? i : -1);
  };

  const tooltip = (() => {
    if (!valid(tipIdx)) return null;
    const at = geo.anchor(tipIdx);
    const rows: TooltipRow[] = spec.series.map((s, si) => {
      const v = s.values[tipIdx];
      return { name: s.name, color: seriesColor(spec, tipIdx, si), value: finite(v) ? `${full(v)}${tipIdx === partialIdx ? ' so far' : ''}` : '—' };
    });
    return <ChartTooltip title={spec.categories[tipIdx]} rows={rows} x={at.x} y={at.y} alignRight={at.x > geo.w * 0.6} />;
  })();

  const legend =
    spec.series.length >= 2
      ? spec.series.map((s, si) => ({ name: s.name, color: seriesColor(spec, 0, si), mark: kind === 'line' ? ('line' as const) : ('bar' as const) }))
      : shareLegend
        ? spec.categories.map((c, ci) => ({ name: c, color: seriesColor(spec, ci), mark: 'bar' as const }))
        : null;

  const descId = describedBy ?? `${uid}-d`;
  // Column and line take the strip's plot height (`--graph-h` − its 20 px header, per density) unless
  // given one; the strip's plot box sizes to its content, so the graph always carries its own height.
  const plotStyle = { height: fixedHeight ?? STRIP_PLOT_HEIGHT };

  return (
    <div className={cx('bx-chart', `bx-chart--${kind}`, className)}>
      {legend && kind !== 'share' ? <ChartLegend items={legend} /> : null}
      <div
        ref={wrapRef}
        className="bx-chart__plot"
        style={plotStyle}
        role="listbox"
        aria-roledescription="graph"
        aria-orientation={kind === 'bar' ? 'vertical' : 'horizontal'}
        aria-label={spec.title}
        aria-describedby={descId}
        aria-activedescendant={focusIdx >= 0 ? `${uid}-o${focusIdx}` : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setFocusIdx((i) => (i < 0 && valid(active) ? active : i))}
        onBlur={() => setFocusIdx(-1)}
      >
        <svg
          className="bx-chart__svg"
          width={geo.w}
          height={geo.h}
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          aria-hidden="true"
          focusable="false"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(-1)}
          onClick={() => {
            if (hover >= 0 && spec.activate) spec.activate(hover);
          }}
          style={spec.activate ? { cursor: 'pointer' } : undefined}
        >
          {geo.draw(highlight)}
        </svg>
        {tooltip}
        <div className="bx-sr-only">
          {spec.categories.map((_, i) => (
            <div key={i} id={`${uid}-o${i}`} role="option" aria-selected={i === focusIdx} aria-label={optionLabel(i)} />
          ))}
        </div>
      </div>
      {legend && kind === 'share' ? <ChartLegend items={legend} /> : null}
      {describedBy ? null : (
        <p id={descId} className="bx-sr-only">
          {spec.takeaway}
        </p>
      )}
      <ChartDataTable caption={spec.title} categories={spec.categories} series={spec.series} format={full} />
    </div>
  );
}

function geometry(spec: ChartSpec, w: number, h: number): Geometry {
  if (spec.kind === 'bar') return barGeometry(spec, w);
  if (spec.kind === 'share') return shareGeometry(spec, w, h);
  if (spec.kind === 'line') return lineGeometry(spec, w, h);
  return columnGeometry(spec, w, h);
}

/**
 * Value axis: hairline grid + muted ticks (absolute labels + captions for polarity columns).
 * `bottomRoom` keeps px free under the lowest tick for a direct label hanging below a negative mark,
 * clear of the category names in the axis band.
 */
function yAxis(spec: ChartSpec, h: number, bottomRoom = 0) {
  const f = spec.valueFormat ?? 'inr';
  const tick = tickFormatter(f);
  const all = spec.series.flatMap((s) => s.values.filter(finite));
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const polar = (spec.color ?? 'series') === 'polarity' && spec.kind === 'column';
  const ticks = polar ? polarityTicks(lo, hi, tick, 4) : niceTicks(lo, hi, 4).map((value) => ({ value, label: tick(value) }));
  const caps = polar && spec.axisCaptions ? spec.axisCaptions : null;
  const gutter = Math.ceil(Math.max(20, ...ticks.map((t) => textWidth(t.label)), caps ? textWidth(caps.up, 12) : 0, caps ? textWidth(caps.down, 12) : 0) + 8);
  const plotBottom = h - AXIS_BAND;
  const y = linearScale([ticks[0].value, ticks[ticks.length - 1].value], [plotBottom - bottomRoom, TOP]);
  const zeroY = y(0);
  return { ticks, y, zeroY, gutter, plotBottom, caps, lo, hi, polar };
}

function gridNodes(ax: ReturnType<typeof yAxis>, left: number, right: number): ReactNode {
  return (
    <g>
      {ax.ticks.map((t, i) => {
        const ty = ax.y(t.value);
        // Polarity: the zero label gives way to the captions beside the baseline.
        const showLabel = !ax.polar || (t.value !== 0 && Math.abs(ty - ax.zeroY) >= 18);
        return (
          <g key={i}>
            <line x1={left} x2={right} y1={ty} y2={ty} className={t.value === 0 ? 'bx-chart__baseline' : 'bx-chart__gridline'} />
            {showLabel ? (
              <text x={left - 8} y={ty} dy="0.32em" textAnchor="end" className="bx-chart__tick">
                {t.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {ax.caps && ax.hi > 0 ? (
        <text x={left - 8} y={ax.zeroY - 5} textAnchor="end" className="bx-chart__caption">
          {ax.caps.up}
        </text>
      ) : null}
      {ax.caps && ax.lo < 0 ? (
        <text x={left - 8} y={ax.zeroY + 14} textAnchor="end" className="bx-chart__caption">
          {ax.caps.down}
        </text>
      ) : null}
    </g>
  );
}

function columnGeometry(spec: ChartSpec, w: number, h: number): Geometry {
  const n = spec.categories.length;
  const labels = labelIndexes(spec, 'max');
  const s0 = spec.series[0];
  // A label under a negative column needs ≈ 14 px below the mark's end.
  const ax = yAxis(spec, h, labels.some((i) => (s0?.values[i] ?? 0) < 0) ? 14 : 0);
  const left = ax.gutter;
  const right = Math.max(left + 40, w - 8);
  const band = bandLayout(n, left, right, 0.3, 0.15);
  const ns = Math.max(1, spec.series.length);
  const barW = Math.max(2, Math.min(BAR_MAX, (band.bandwidth - (ns - 1) * GAP) / ns));
  const groupW = ns * barW + (ns - 1) * GAP;
  const every = Math.max(1, Math.ceil((Math.max(0, ...spec.categories.map((c) => textWidth(c))) + 8) / Math.max(1, band.step)));
  const label = labelFormatter(spec.valueFormat ?? 'inr');
  const lastIdx = n - 1;
  // Every `every`-th name, plus the last one (the running period) when it clears the previous name.
  const lastShown = Math.floor(lastIdx / every) * every;
  const showCategory = (ci: number) => ci % every === 0 || (ci === lastIdx && (lastIdx - lastShown) * band.step >= textWidth(spec.categories[ci]) + 8);
  return {
    w,
    h,
    pick: (x) => Math.floor((x - band.start(0) + (band.step - band.bandwidth) / 2) / band.step),
    anchor: (i) => ({ x: band.center(i), y: TOP }),
    draw: (hl) => (
      <>
        {gridNodes(ax, left, right)}
        {hl >= 0 ? <rect className="bx-chart__band-highlight" x={band.start(hl) - (band.step - band.bandwidth) / 2} y={TOP} width={band.step} height={ax.plotBottom - TOP} /> : null}
        {spec.categories.map((c, ci) => {
          const x0 = band.center(ci) - groupW / 2;
          return (
            <g key={ci}>
              {spec.series.map((s, si) => {
                const v = s.values[ci];
                if (!finite(v) || v === 0) return null;
                return <path key={si} d={barPath(x0 + si * (barW + GAP), barW, ax.zeroY, ax.y(v))} className={cx('bx-chart__bar', colorClass(seriesColor(spec, ci, si)))} />;
              })}
              {showCategory(ci) ? (
                <text x={band.center(ci)} y={ax.plotBottom + 16} textAnchor="middle" className="bx-chart__category">
                  {c}
                </text>
              ) : null}
            </g>
          );
        })}
        {s0
          ? labels.map((i) => {
              const v = s0.values[i] as number;
              const text = `${ax.polar ? label(Math.abs(v)) : label(v)}${spec.partialLast && i === lastIdx ? ' so far' : ''}`;
              const x = band.center(i) - groupW / 2 + barW / 2;
              const anchor = x + textWidth(text) / 2 > w ? 'end' : x - textWidth(text) / 2 < 0 ? 'start' : 'middle';
              return (
                <text key={i} x={x} y={v >= 0 ? ax.y(v) - 6 : ax.y(v) + 14} textAnchor={anchor} className="bx-chart__direct-label">
                  {text}
                </text>
              );
            })
          : null}
      </>
    ),
  };
}

function lineGeometry(spec: ChartSpec, w: number, h: number): Geometry {
  const n = spec.categories.length;
  const label = labelFormatter(spec.valueFormat ?? 'inr');
  const labels = labelIndexes(spec, 'last');
  // Room on the right for the end labels (the measured series' and, when shown, the context one's).
  const endWidth = Math.max(0, ...spec.series.map((s) => {
    const v = [...s.values].reverse().find(finite);
    return v === undefined ? 0 : textWidth(label(v));
  }));
  const ax = yAxis(spec, h);
  const left = ax.gutter;
  const right = Math.max(left + 40, w - Math.max(12, Math.ceil(endWidth) + 14));
  const x = (i: number) => (n <= 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1));
  const centers = spec.categories.map((_, i) => x(i));
  const stepPx = n > 1 ? (right - left) / (n - 1) : right - left;
  const every = Math.max(1, Math.ceil((Math.max(0, ...spec.categories.map((c) => textWidth(c))) + 8) / Math.max(1, stepPx)));
  const lines = spec.series.map((s) => {
    const pts: Array<Point | null> = s.values.map((v, i) => (finite(v) ? { x: x(i), y: ax.y(v) } : null));
    const solid = pts.filter((p): p is Point => p !== null);
    const drawnPts = solid.length > MAX_LINE_POINTS && pts.every((p) => p !== null) ? decimate(solid, MAX_LINE_POINTS) : null;
    let lastIndex = -1;
    s.values.forEach((v, i) => {
      if (finite(v)) lastIndex = i;
    });
    return { pts, line: linePath(drawnPts ?? pts), area: areaPath(drawnPts ?? solid, ax.zeroY), last: lastIndex >= 0 ? pts[lastIndex] : null, lastIndex };
  });
  const endY = lines.map((l) => l.last?.y ?? NaN);
  return {
    w,
    h,
    pick: (px) => nearestIndex(px, centers),
    anchor: (i) => ({ x: x(i), y: TOP }),
    draw: (hl) => (
      <>
        {gridNodes(ax, left, right)}
        {spec.categories.map((c, i) =>
          i % every === 0 ? (
            <text key={i} x={x(i)} y={ax.plotBottom + 16} textAnchor="middle" className="bx-chart__category">
              {c}
            </text>
          ) : null,
        )}
        {spec.series.map((s, si) => {
          const l = lines[si];
          const context = si > 0;
          // The measured series carries its direct label(s); a context series an end label only when
          // it clears the measured one by ≥ 14 px (else the legend names it).
          const marks = context ? (Math.abs(endY[si] - endY[0]) >= 14 && l.lastIndex >= 0 ? [l.lastIndex] : []) : labels;
          return (
            <g key={si} className={colorClass(seriesColor(spec, Math.max(0, l.lastIndex), si))}>
              {!context && l.area ? <path d={l.area} className="bx-chart__area" /> : null}
              <path d={l.line} className="bx-chart__line" fill="none" />
              {l.last ? <circle cx={l.last.x} cy={l.last.y} r={4} className="bx-chart__dot" /> : null}
              {marks.map((i) => {
                const pt = l.pts[i];
                const v = s.values[i];
                return pt && finite(v) ? (
                  <text key={i} x={pt.x + 8} y={pt.y} dy="0.32em" className="bx-chart__direct-label">
                    {label(v)}
                  </text>
                ) : null;
              })}
            </g>
          );
        })}
        {hl >= 0 ? (
          <g>
            <line x1={x(hl)} x2={x(hl)} y1={TOP} y2={ax.plotBottom} className="bx-chart__crosshair" />
            {spec.series.map((s, si) => {
              const v = s.values[hl];
              return finite(v) ? <circle key={si} cx={x(hl)} cy={ax.y(v)} r={4} className={cx('bx-chart__dot', colorClass(seriesColor(spec, hl, si)))} /> : null;
            })}
          </g>
        ) : null}
      </>
    ),
  };
}

function barGeometry(spec: ChartSpec, w: number): Geometry {
  const s0 = spec.series[0];
  const n = spec.categories.length;
  const values = spec.categories.map((_, i) => s0?.values[i] ?? null);
  const label = labelFormatter(spec.valueFormat ?? 'inr');
  const tips = (spec.label ?? (n <= 7 ? 'tips' : 'none')) === 'tips';
  const tipText = values.map((v) => (finite(v) && v !== 0 ? label(v) : ''));
  const labelWidth = tips ? Math.ceil(Math.max(0, ...tipText.map((t) => textWidth(t)))) : 0;
  const nameWidth = Math.min(200, Math.max(80, Math.floor(w * 0.35)));
  const g = hbarLayout(values, { width: w, nameWidth, labelWidth, top: 4 });
  const signed = values.some((v) => finite(v) && v < 0);
  return {
    w,
    h: g.height,
    pick: (_x, y) => Math.floor((y - 4) / 20),
    anchor: (i) => ({ x: Math.max(g.rows[i]?.x1 ?? 0, nameWidth), y: (g.rows[i]?.cy ?? 0) + 8 }),
    draw: (hl) => (
      <>
        {hl >= 0 && g.rows[hl] ? <rect className="bx-chart__band-highlight" x={0} y={g.rows[hl].cy - 10} width={w} height={20} /> : null}
        {signed ? <line x1={g.zeroX} x2={g.zeroX} y1={2} y2={g.height - 2} className="bx-chart__baseline" /> : null}
        {spec.categories.map((c, i) => {
          const r = g.rows[i];
          const v = values[i];
          const name = fitText(c, nameWidth - 8, 11);
          return (
            <g key={i}>
              <text x={0} y={r.cy} dy="0.32em" className="bx-chart__category">
                {name !== c ? <title>{c}</title> : null}
                {name}
              </text>
              {finite(v) && v !== 0 ? <path d={hbarPath(r.y, r.height, g.zeroX, v < 0 ? r.x0 : r.x1)} className={cx('bx-chart__bar', colorClass(seriesColor(spec, i)))} /> : null}
              {tips && tipText[i] ? (
                <text x={r.labelX} y={r.cy} dy="0.32em" textAnchor={r.labelAnchor} className="bx-chart__direct-label">
                  {tipText[i]}
                </text>
              ) : null}
            </g>
          );
        })}
      </>
    ),
  };
}

const SHARE_Y = 4;
const SHARE_H = 16;

function shareTotal(spec: ChartSpec): number {
  return (spec.series[0]?.values ?? []).reduce<number>((a, v) => a + (finite(v) && v > 0 ? v : 0), 0);
}

function shareLabel(spec: ChartSpec, i: number): string {
  const v = spec.series[0]?.values[i];
  const total = shareTotal(spec);
  return `${spec.categories[i]} ${total > 0 && finite(v) ? Math.round((v / total) * 100) : 0} %`;
}

/** A share bar names its segments underneath only when every name fits; otherwise a legend does. */
function shareNeedsLegend(spec: ChartSpec, w: number): boolean {
  return shareSegments(spec.series[0]?.values ?? [], w).some((seg) => textWidth(shareLabel(spec, seg.index), 12) > seg.width - 4);
}

function shareGeometry(spec: ChartSpec, w: number, h: number): Geometry {
  const segs = shareSegments(spec.series[0]?.values ?? [], w);
  const fits = !shareNeedsLegend(spec, w);
  return {
    w,
    h,
    pick: (x) => segs.find((s) => x >= s.x - 1 && x < s.x + s.width + 1)?.index ?? -1,
    anchor: (i) => {
      const s = segs.find((x) => x.index === i);
      return { x: s ? s.x + s.width / 2 : 0, y: SHARE_Y + SHARE_H + 4 };
    },
    draw: (hl) => (
      <>
        {segs.map((s) => (
          <rect key={s.index} x={s.x} y={s.index === hl ? SHARE_Y - 2 : SHARE_Y} width={s.width} height={s.index === hl ? SHARE_H + 4 : SHARE_H} rx={2} className={cx('bx-chart__seg', colorClass(seriesColor(spec, s.index)))} />
        ))}
        {fits
          ? segs.map((s) => (
              <text key={s.index} x={s.x} y={SHARE_Y + SHARE_H + 18} className="bx-chart__label">
                {shareLabel(spec, s.index)}
              </text>
            ))
          : null}
      </>
    ),
  };
}
