/** 2.0 API, kept for the full Dashboard and the ageing view: a thin adapter that renders the 2.1 kit lazily. */
import type { ReactNode, Ref } from 'react';
import type { ChartSeries, ValueFormat } from './chartParts.tsx';
import { LazyChart, useLegacySpec } from './lazyChart.tsx';

export type { ChartSeries, ChartSlot, ValueFormat } from './chartParts.tsx';

export interface BarChartProps {
  title: string;
  /** The takeaway (announced with the graph; a strip shows it as text). */
  description?: string;
  categories: readonly string[];
  series: readonly ChartSeries[];
  valueFormat?: ValueFormat;
  height?: number;
  /** Direct label on the largest column (default: none). */
  labelMax?: boolean;
  onCategoryActivate?: (categoryIndex: number) => void;
  empty?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Columns (one series, or one plus context); a legend for two series is automatic and cannot be switched off. */
export function BarChart({ title, description, categories, series, valueFormat = 'inr', height = 240, labelMax = false, onCategoryActivate, empty, className, ref }: BarChartProps): ReactNode {
  const spec = useLegacySpec('column', { title, description, categories, series, valueFormat, label: labelMax ? 'max' : 'none', onCategoryActivate });
  return <div ref={ref} className={className}>{spec ? <LazyChart spec={spec} height={height} /> : <div className="bx-chart__empty">{empty ?? 'No data for this period'}</div>}</div>;
}
