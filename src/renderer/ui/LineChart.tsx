/** 2.0 API, kept for callers outside reports: a thin adapter that renders the 2.1 kit lazily. */
import type { ReactNode, Ref } from 'react';
import type { ChartSeries, ValueFormat } from './chartParts.tsx';
import { LazyChart, useLegacySpec } from './lazyChart.tsx';

export interface LineChartProps {
  title: string;
  /** The takeaway (announced with the graph; a strip shows it as text). */
  description?: string;
  categories: readonly string[];
  series: readonly ChartSeries[];
  valueFormat?: ValueFormat;
  height?: number;
  /** Label the measured series' last value at its end (default true). */
  endLabels?: boolean;
  onCategoryActivate?: (categoryIndex: number) => void;
  empty?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** A trend line (area wash under the measured series; a second series is context, in grey). */
export function LineChart({ title, description, categories, series, valueFormat = 'inr', height = 240, endLabels = true, onCategoryActivate, empty, className, ref }: LineChartProps): ReactNode {
  const spec = useLegacySpec('line', { title, description, categories, series, valueFormat, label: endLabels ? 'last' : 'none', onCategoryActivate });
  return <div ref={ref} className={className}>{spec ? <LazyChart spec={spec} height={height} /> : <div className="bx-chart__empty">{empty ?? 'No data for this period'}</div>}</div>;
}
