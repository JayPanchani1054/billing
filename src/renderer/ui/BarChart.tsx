import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { ChartDataTable, ChartEmpty, ChartLegend, ChartTooltip, describeCategory, fullFormatter, slotOf, textWidth, tickFormatter, useElementWidth } from './chartParts.tsx';
import type { ChartSeries, ValueFormat } from './chartParts.tsx';
import { bandLayout, barPath, linearScale, niceTicks } from './lib/chart.ts';
import { cx } from './lib/cx.ts';

export type { ChartSeries, ChartSlot, ValueFormat } from './chartParts.tsx';

export interface BarChartProps {
  /** Accessible title (the visible title usually lives in the surrounding Card). */
  title: string;
  /** Accessible description / takeaway ("Sales peaked in March at ₹4.2 L"). */
  description?: string;
  categories: readonly string[];
  series: readonly ChartSeries[];
  /** Default 'inr' (values in paise). */
  valueFormat?: ValueFormat;
  /** Total height including axes (px, default 240). */
  height?: number;
  /** Legend: auto (default) shows it for 2+ series. */
  legend?: boolean;
  /** Direct value label on the largest bar of a single-series chart. */
  labelMax?: boolean;
  /** Click / Enter on a category (drill-down). */
  onCategoryActivate?: (categoryIndex: number) => void;
  /** Rendered instead of the plot when there is no data. */
  empty?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

const MARGIN = { top: 12, right: 12, bottom: 28 };
const BAR_MAX = 24;
const GAP = 2;

/**
 * Grouped column chart (dependency-free SVG): ≤24px bars with rounded data-ends, hairline grid,
 * Indian compact ticks, legend for 2+ series, per-category tooltip on hover and keyboard focus
 * (←/→ move, Enter activates), and a screen-reader table view.
 */
export function BarChart({
  title,
  description,
  categories,
  series,
  valueFormat = 'inr',
  height = 240,
  legend,
  labelMax = false,
  onCategoryActivate,
  empty,
  className,
  ref,
}: BarChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef);
  const titleId = useId();
  const descId = useId();
  const [hover, setHover] = useState<number>(-1);
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const active = hover >= 0 ? hover : focusIdx;
  const tick = tickFormatter(valueFormat);
  const full = fullFormatter(valueFormat);

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const hasData = all.length > 0 && categories.length > 0;

  const geo = useMemo(() => {
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 5);
    const labelW = Math.max(...ticks.map((t) => textWidth(tick(t)))) + 10;
    const left = Math.max(32, Math.ceil(labelW));
    const plotTop = MARGIN.top;
    const plotBottom = height - MARGIN.bottom;
    const plotLeft = left;
    const plotRight = Math.max(left + 40, width - MARGIN.right);
    const y = linearScale([ticks[0], ticks[ticks.length - 1]], [plotBottom, plotTop]);
    const band = bandLayout(categories.length, plotLeft, plotRight, 0.3, 0.15);
    const n = Math.max(1, series.length);
    const barW = Math.max(2, Math.min(BAR_MAX, (band.bandwidth - (n - 1) * GAP) / n));
    const groupW = n * barW + (n - 1) * GAP;
    const maxLabel = Math.max(...categories.map((c) => textWidth(c)));
    const every = Math.max(1, Math.ceil((maxLabel + 8) / Math.max(1, band.step)));
    return { ticks, y, band, barW, groupW, plotTop, plotBottom, plotLeft, plotRight, every };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, categories, series, valueFormat]);

  const base = geo.y(0);
  let maxCi = -1;
  if (labelMax && series.length === 1) {
    const vals = series[0].values;
    for (let ci = 0; ci < vals.length; ci++) {
      const v = vals[ci];
      if (v !== null && Number.isFinite(v) && (maxCi < 0 || v > (vals[maxCi] as number))) maxCi = ci;
    }
  }
  const maxValue = maxCi >= 0 ? (series[0].values[maxCi] as number) : 0;

  const pickFromPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.floor((x - geo.band.start(0) + (geo.band.step - geo.band.bandwidth) / 2) / geo.band.step);
    setHover(i >= 0 && i < categories.length ? i : -1);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasData) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, Math.min(categories.length - 1, (i < 0 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setFocusIdx(e.key === 'Home' ? 0 : categories.length - 1);
    } else if (e.key === 'Enter' && focusIdx >= 0 && onCategoryActivate) {
      e.preventDefault();
      onCategoryActivate(focusIdx);
    }
  };

  const showLegend = legend ?? series.length >= 2;
  const tooltipX = active >= 0 ? geo.band.center(active) : 0;

  return (
    <div ref={ref} className={cx('bx-chart', className)}>
      {showLegend ? <ChartLegend series={series} mark="bar" /> : null}
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
            onPointerMove={pickFromPointer}
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
            </g>
            {active >= 0 ? (
              <rect
                className="bx-chart__band-highlight"
                x={geo.band.start(active) - (geo.band.step - geo.band.bandwidth) / 2}
                y={geo.plotTop}
                width={geo.band.step}
                height={geo.plotBottom - geo.plotTop}
                aria-hidden="true"
              />
            ) : null}
            <g aria-hidden="true">
              {categories.map((c, ci) => {
                const x0 = geo.band.center(ci) - geo.groupW / 2;
                return (
                  <g key={`${c}-${ci}`} className={cx('bx-chart__group', active >= 0 && active !== ci && 'is-dimmed')}>
                    {series.map((s, si) => {
                      const v = s.values[ci];
                      if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return null;
                      const x = x0 + si * (geo.barW + GAP);
                      return <path key={s.name} d={barPath(x, geo.barW, base, geo.y(v))} className={cx('bx-chart__bar', `bx-chart--s-${slotOf(s, si)}`)} />;
                    })}
                    {ci % geo.every === 0 ? (
                      <text x={geo.band.center(ci)} y={geo.plotBottom + 18} textAnchor="middle" className="bx-chart__category">
                        {c}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
            {maxCi >= 0 ? (
              <text x={geo.band.center(maxCi)} y={geo.y(maxValue) - 6} textAnchor="middle" className="bx-chart__direct-label" aria-hidden="true">
                {tick(maxValue)}
              </text>
            ) : null}
          </svg>
        )}
        {hasData && active >= 0 ? (
          <ChartTooltip
            title={categories[active]}
            mark="bar"
            x={tooltipX}
            y={geo.plotTop}
            alignRight={tooltipX > width * 0.6}
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
