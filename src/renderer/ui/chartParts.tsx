/**
 * Internal building blocks of the graph kit (ui/Chart.tsx and Home's MiniColumns): width/height
 * measurement, value formatting, colour classes, legend, tooltip and the screen-reader table twin.
 * The graph contract types live in ui/lib/chartSpec.ts (pure); this file re-exports them for the
 * barrel. Not part of the public barrel except types.
 */
import { useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { cx } from './lib/cx.ts';
import { colorClass, compactTick } from './lib/chart.ts';
import { compactValue } from './lib/chartSpec.ts';
import type { ChartSeries, ChartSpec, MarkColor, ValueFormat } from './lib/chartSpec.ts';
import { formatIndianNumber, formatMoney, formatPercent } from '../../shared/format.ts';

export type { ChartColor, ChartKind, ChartSeries, ChartSlot, ChartSpec, ValueFormat } from './lib/chartSpec.ts';

/** What `Chart` (and `LazyChart`) take. */
export interface ChartProps {
  spec: ChartSpec;
  /** Plot height in px. Default: column and line the strip's (`--graph-h` − 20: 148, 132 compact); bar, share and meter their own. */
  height?: number;
  /** The table's active row index when rows map to categories: that mark is highlighted. */
  active?: number;
  /** Id of the visible takeaway (the strip header); without it the chart carries a hidden one. */
  describedBy?: string;
  className?: string;
}

/** Axis ticks: Indian compact without the sign of the currency ("0 · 50 K · 1 L · 1 Cr", "12.5%"). */
export function tickFormatter(f: ValueFormat): (v: number) => string {
  if (typeof f === 'object') return f.tick;
  if (f === 'percent') return (v) => formatPercent(v);
  return (v) => compactTick(f === 'inr' ? v / 100 : v);
}

/** Direct labels on marks: Indian compact money as in the takeaway ("₹87.4 K"). */
export function labelFormatter(f: ValueFormat): (v: number) => string {
  if (typeof f === 'object') return f.tick;
  return (v) => compactValue(v, f);
}

/** Tooltips, option names and the table twin: exact ("₹ 1,23,456.00"). */
export function fullFormatter(f: ValueFormat): (v: number) => string {
  if (typeof f === 'object') return f.full;
  if (f === 'inr') return (v) => formatMoney(v, { symbol: true });
  if (f === 'percent') return (v) => formatPercent(v);
  return (v) => formatIndianNumber(v, Number.isInteger(v) ? 0 : 2);
}

/** Size of an element (px), tracking resizes — one ResizeObserver per graph. */
export function useElementSize(ref: RefObject<HTMLElement | null>, fallbackWidth = 640, fallbackHeight = 148): { w: number; h: number } {
  const [box, setBox] = useState({ w: fallbackWidth, h: fallbackHeight });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      if (w > 0 && h > 0) setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/** Legend: only for two or more series (a single series is named by the title). */
export function ChartLegend({ items }: { items: readonly { name: string; color: MarkColor; mark: 'bar' | 'line' }[] }) {
  return (
    <ul className="bx-chart__legend" aria-hidden="true">
      {items.map((it, i) => (
        <li key={i}>
          <span className={cx('bx-chart__key', `bx-chart__key--${it.mark}`, colorClass(it.color))} />
          <span>{it.name}</span>
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  name: string;
  color: MarkColor;
  value: string;
}

/** Value first (strong), then the name (secondary), keyed by a short line; flips left past 60 %. */
export function ChartTooltip({ title, rows, x, y, alignRight }: { title: string; rows: readonly TooltipRow[]; x: number; y: number; alignRight: boolean }) {
  const style: CSSProperties = alignRight ? { right: `calc(100% - ${x}px + 12px)`, top: y } : { left: x + 12, top: y };
  return (
    <div className="bx-chart__tooltip" style={style} aria-hidden="true">
      <p className="bx-chart__tooltip-title">{title}</p>
      {rows.map((r, i) => (
        <p key={i}>
          <span className={cx('bx-chart__key', 'bx-chart__key--line', colorClass(r.color))} />
          <strong className="bx-chart__tooltip-value bx-num">{r.value}</strong>
          <span>{` ${r.name}`}</span>
        </p>
      ))}
    </div>
  );
}

/** Visually hidden data table — the WCAG-equivalent view of every graph (values exact). */
export function ChartDataTable({ caption, categories, series, format }: { caption: string; categories: readonly string[]; series: readonly ChartSeries[]; format: (v: number) => string }) {
  return (
    <table className="bx-sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          {series.map((s, i) => (
            <th key={i} scope="col">
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {categories.map((c, ci) => (
          <tr key={ci}>
            <th scope="row">{c}</th>
            {series.map((s, si) => {
              const v = s.values[ci];
              return <td key={si}>{v === null || v === undefined ? '—' : format(v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Spoken name of one category ("Sep: ₹ 87,414.00", or "Sep: Sales ₹ …, Purchases ₹ …"). */
export function describeCategory(category: string, series: readonly ChartSeries[], index: number, format: (v: number) => string, suffix = ''): string {
  const value = (s: ChartSeries) => {
    const v = s.values[index];
    return v === null || v === undefined ? 'no data' : `${format(v)}${suffix}`;
  };
  if (series.length === 1) return `${category}: ${value(series[0])}`;
  return `${category}: ${series.map((s) => `${s.name} ${value(s)}`).join(', ')}`;
}
