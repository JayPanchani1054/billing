/**
 * Internal building blocks shared by BarChart and LineChart: width measurement, value formatting,
 * legend, tooltip and the screen-reader table view. Not part of the public barrel except types.
 */
import { useLayoutEffect, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { cx } from './lib/cx.ts';
import { formatCompactINR, formatIndianNumber, formatMoney, formatPercent } from '../../shared/format.ts';

/** Categorical slot (fixed order, never cycled) or the folded "Other" bucket. */
export type ChartSlot = 1 | 2 | 3 | 4 | 5 | 'other';

export interface ChartSeries {
  name: string;
  /** One value per category; null = gap. */
  values: readonly (number | null)[];
  /**
   * Colour slot. Defaults to the series position (1…5). Keep a series' slot stable across filters
   * — colour follows the entity, never its rank.
   */
  slot?: ChartSlot;
}

/** 'inr' = values in paise (ticks ₹1.2 L, tooltips ₹ 1,23,456.00) · 'number' · 'percent' · custom. */
export type ValueFormat = 'inr' | 'number' | 'percent' | { tick: (v: number) => string; full: (v: number) => string };

export function tickFormatter(f: ValueFormat): (v: number) => string {
  if (typeof f === 'object') return f.tick;
  if (f === 'inr') return (v) => (v === 0 ? '0' : formatCompactINR(v));
  if (f === 'percent') return (v) => formatPercent(v);
  return (v) => {
    const a = Math.abs(v);
    if (a >= 1e7) return `${formatIndianNumber(v / 1e7, 1)} Cr`;
    if (a >= 1e5) return `${formatIndianNumber(v / 1e5, 1)} L`;
    return formatIndianNumber(v, Number.isInteger(v) ? 0 : 2);
  };
}

export function fullFormatter(f: ValueFormat): (v: number) => string {
  if (typeof f === 'object') return f.full;
  if (f === 'inr') return (v) => formatMoney(v, { symbol: true });
  if (f === 'percent') return (v) => formatPercent(v);
  return (v) => formatIndianNumber(v, Number.isInteger(v) ? 0 : 2);
}

export function slotOf(s: ChartSeries, i: number): ChartSlot {
  if (s.slot) return s.slot;
  return i < 5 ? ((i + 1) as ChartSlot) : 'other';
}

/** Width of an element (px), tracking resizes. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const next = Math.floor(el.clientWidth);
      if (next > 0) setW((prev) => (prev === next ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Rough text width for layout decisions (Segoe UI ≈ 0.58em per char at small sizes). */
export function textWidth(s: string, fontPx = 11): number {
  return s.length * fontPx * 0.6;
}

export function ChartLegend({ series, mark }: { series: readonly ChartSeries[]; mark: 'bar' | 'line' }) {
  return (
    <ul className="bx-chart__legend" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.name} className="bx-chart__legend-item">
          <span className={cx('bx-chart__key', `bx-chart__key--${mark}`, `bx-chart--s-${slotOf(s, i)}`)} aria-hidden="true" />
          <span>{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  name: string;
  slot: ChartSlot;
  value: string;
}

export function ChartTooltip({ title, rows, x, y, alignRight, mark }: { title: string; rows: readonly TooltipRow[]; x: number; y: number; alignRight: boolean; mark: 'bar' | 'line' }) {
  const style: CSSProperties = alignRight ? { right: `calc(100% - ${x}px + 12px)`, top: y } : { left: x + 12, top: y };
  return (
    <div className="bx-chart__tooltip" style={style} aria-hidden="true">
      <p className="bx-chart__tooltip-title">{title}</p>
      {rows.map((r) => (
        <p key={r.name} className="bx-chart__tooltip-row">
          <span className={cx('bx-chart__key', `bx-chart__key--line`, `bx-chart--s-${r.slot}`)} />
          <strong className="bx-chart__tooltip-value bx-num">{r.value}</strong>
          <span className="bx-chart__tooltip-name">{r.name}</span>
        </p>
      ))}
    </div>
  );
}

/** Visually hidden data table — the WCAG-equivalent view of every chart. */
export function ChartDataTable({ caption, categories, series, format }: { caption: string; categories: readonly string[]; series: readonly ChartSeries[]; format: (v: number) => string }) {
  return (
    <table className="bx-sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          {series.map((s) => (
            <th key={s.name} scope="col">
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {categories.map((c, ci) => (
          <tr key={`${c}-${ci}`}>
            <th scope="row">{c}</th>
            {series.map((s) => {
              const v = s.values[ci];
              return <td key={s.name}>{v === null || v === undefined ? '—' : format(v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Spoken summary for the focused category (keyboard exploration). */
export function describeCategory(category: string, series: readonly ChartSeries[], index: number, format: (v: number) => string): string {
  const parts = series.map((s) => {
    const v = s.values[index];
    return `${s.name} ${v === null || v === undefined ? 'no data' : format(v)}`;
  });
  return `${category}: ${parts.join(', ')}`;
}

export function ChartEmpty({ children }: { children?: ReactNode }) {
  return <div className="bx-chart__empty">{children ?? 'No data for this period'}</div>;
}
