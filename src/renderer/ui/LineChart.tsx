import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { ChartDataTable, ChartEmpty, ChartLegend, ChartTooltip, describeCategory, fullFormatter, slotOf, textWidth, tickFormatter, useElementWidth } from './chartParts.tsx';
import type { ChartSeries, ValueFormat } from './chartParts.tsx';
import { areaPath, linePath, linearScale, nearestIndex, niceTicks } from './lib/chart.ts';
import type { Point } from './lib/chart.ts';
import { cx } from './lib/cx.ts';

export interface LineChartProps {
  title: string;
  description?: string;
  /** X categories in order (months, days). */
  categories: readonly string[];
  series: readonly ChartSeries[];
  valueFormat?: ValueFormat;
  height?: number;
  legend?: boolean;
  /** Soft area wash under each line (default: only for a single series). */
  area?: boolean;
  /** Label each line's last value at its end (default true for ≤ 2 series). */
  endLabels?: boolean;
  onCategoryActivate?: (categoryIndex: number) => void;
  empty?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

const MARGIN = { top: 14, bottom: 28 };

/**
 * Trend line chart: 2px lines, end dots with a surface ring, hairline grid, crosshair that snaps to
 * the nearest category with a tooltip listing every series (pointer and ←/→ keys), screen-reader
 * table view.
 */
export function LineChart({
  title,
  description,
  categories,
  series,
  valueFormat = 'inr',
  height = 240,
  legend,
  area,
  endLabels,
  onCategoryActivate,
  empty,
  className,
  ref,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef);
  const titleId = useId();
  const descId = useId();
  const [hover, setHover] = useState(-1);
  const [focusIdx, setFocusIdx] = useState(-1);
  const active = hover >= 0 ? hover : focusIdx;
  const tick = tickFormatter(valueFormat);
  const full = fullFormatter(valueFormat);
  const showArea = area ?? series.length === 1;
  const showEndLabels = endLabels ?? series.length <= 2;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const hasData = all.length > 0 && categories.length > 0;

  const geo = useMemo(() => {
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 5);
    const left = Math.max(32, Math.ceil(Math.max(...ticks.map((t) => textWidth(tick(t)))) + 10));
    const lastLabels = showEndLabels
      ? Math.max(0, ...series.map((s) => {
          const last = [...s.values].reverse().find((v) => v !== null && v !== undefined);
          return last === undefined || last === null ? 0 : textWidth(tick(last));
        }))
      : 0;
    const right = Math.max(16, Math.ceil(lastLabels) + 14);
    const plotLeft = left;
    const plotRight = Math.max(left + 40, width - right);
    const plotTop = MARGIN.top;
    const plotBottom = height - MARGIN.bottom;
    const y = linearScale([ticks[0], ticks[ticks.length - 1]], [plotBottom, plotTop]);
    const n = categories.length;
    const x = (i: number) => (n <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + (i * (plotRight - plotLeft)) / (n - 1));
    const centers = categories.map((_, i) => x(i));
    const step = n > 1 ? (plotRight - plotLeft) / (n - 1) : plotRight - plotLeft;
    const every = Math.max(1, Math.ceil((Math.max(...categories.map((c) => textWidth(c))) + 8) / Math.max(1, step)));
    const lines = series.map((s) => {
      const pts: Array<Point | null> = s.values.map((v, i) => (v === null || v === undefined || !Number.isFinite(v) ? null : { x: x(i), y: y(v) }));
      const contiguous = pts.filter((p): p is Point => p !== null);
      const lastIndex = s.values.reduce<number>((acc, v, i) => (v !== null && v !== undefined ? i : acc), -1);
      return { line: linePath(pts), area: areaPath(contiguous, y(Math.max(0, ticks[0]))), last: lastIndex >= 0 ? pts[lastIndex] : null, lastIndex };
    });
    return { ticks, y, x, centers, plotLeft, plotRight, plotTop, plotBottom, every, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, categories, series, valueFormat, showEndLabels]);

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(e.clientX - rect.left, geo.centers));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasData) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, Math.min(categories.length - 1, (i < 0 ? categories.length - 1 : i) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setFocusIdx(e.key === 'Home' ? 0 : categories.length - 1);
    } else if (e.key === 'Enter' && focusIdx >= 0 && onCategoryActivate) {
      e.preventDefault();
      onCategoryActivate(focusIdx);
    }
  };

  const showLegend = legend ?? series.length >= 2;
  const ax = active >= 0 ? geo.centers[active] : 0;

  return (
    <div ref={ref} className={cx('bx-chart', className)}>
      {showLegend ? <ChartLegend series={series} mark="line" /> : null}
      <div
        ref={wrapRef}
        className="bx-chart__plot"
        style={{ height }}
        tabIndex={hasData ? 0 : undefined}
        role="group"
        aria-roledescription="chart"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setFocusIdx(-1)}
      >
        {!hasData ? (
          <ChartEmpty>{empty}</ChartEmpty>
        ) : (
          <svg
            className="bx-chart__svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-labelledby={titleId}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(-1)}
            onClick={() => {
              if (hover >= 0 && onCategoryActivate) onCategoryActivate(hover);
            }}
            style={onCategoryActivate ? { cursor: 'pointer' } : undefined}
          >
            <title id={titleId}>{title}</title>
            {description ? <desc id={descId}>{description}</desc> : null}
            <g className="bx-chart__grid" aria-hidden="true">
              {geo.ticks.map((t) => (
                <g key={t}>
                  <line x1={geo.plotLeft} x2={geo.plotRight} y1={geo.y(t)} y2={geo.y(t)} className={t === 0 ? 'bx-chart__baseline' : 'bx-chart__gridline'} />
                  <text x={geo.plotLeft - 8} y={geo.y(t)} dy="0.32em" textAnchor="end" className="bx-chart__tick">
                    {tick(t)}
                  </text>
                </g>
              ))}
              {categories.map((c, i) =>
                i % geo.every === 0 ? (
                  <text key={`${c}-${i}`} x={geo.centers[i]} y={geo.plotBottom + 18} textAnchor="middle" className="bx-chart__category">
                    {c}
                  </text>
                ) : null,
              )}
            </g>
            <g aria-hidden="true">
              {series.map((s, si) => {
                const l = geo.lines[si];
                const slot = slotOf(s, si);
                return (
                  <g key={s.name} className={`bx-chart--s-${slot}`}>
                    {showArea && l.area ? <path d={l.area} className="bx-chart__area" /> : null}
                    <path d={l.line} className="bx-chart__line" fill="none" />
                    {l.last ? <circle cx={l.last.x} cy={l.last.y} r={4} className="bx-chart__dot" /> : null}
                    {showEndLabels && l.last && l.lastIndex >= 0 ? (
                      <text x={l.last.x + 8} y={l.last.y} dy="0.32em" className="bx-chart__direct-label">
                        {tick(s.values[l.lastIndex] as number)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
            {active >= 0 ? (
              <g aria-hidden="true">
                <line x1={ax} x2={ax} y1={geo.plotTop} y2={geo.plotBottom} className="bx-chart__crosshair" />
                {series.map((s, si) => {
                  const v = s.values[active];
                  if (v === null || v === undefined || !Number.isFinite(v)) return null;
                  return <circle key={s.name} cx={ax} cy={geo.y(v)} r={4} className={cx('bx-chart__dot', `bx-chart--s-${slotOf(s, si)}`)} />;
                })}
              </g>
            ) : null}
          </svg>
        )}
        {hasData && active >= 0 ? (
          <ChartTooltip
            title={categories[active]}
            mark="line"
            x={ax}
            y={geo.plotTop}
            alignRight={ax > width * 0.6}
            rows={series.map((s, si) => ({ name: s.name, slot: slotOf(s, si), value: s.values[active] === null || s.values[active] === undefined ? '—' : full(s.values[active] as number) }))}
          />
        ) : null}
        <span className="bx-sr-only" aria-live="polite">
          {focusIdx >= 0 && hasData ? describeCategory(categories[focusIdx], series, focusIdx, full) : ''}
        </span>
      </div>
      {hasData ? <ChartDataTable caption={title} categories={categories} series={series} format={full} /> : null}
    </div>
  );
}
