import { useMemo } from 'react';
import type { Ref } from 'react';
import { sparkline } from './lib/chart.ts';
import { cx } from './lib/cx.ts';

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** Accessible summary ("Sales, last 12 months, rising"). Omit when the parent already says it (then decorative). */
  label?: string;
  /** 'muted' (default): de-emphasised line with the current period dot in the brand colour. 'brand': whole line in brand. */
  emphasis?: 'muted' | 'brand';
  /** Soft area wash under the line. */
  area?: boolean;
  className?: string;
  ref?: Ref<SVGSVGElement>;
}

/** Tiny trend line for figures and table cells: 2 px line, r 4 end dot with a 2 px surface ring. */
export function Sparkline({ values, width = 96, height = 28, label, emphasis = 'muted', area = false, className, ref }: SparklineProps) {
  const g = useMemo(() => sparkline(values, width, height, 5), [values, width, height]);
  return (
    <svg
      ref={ref}
      className={cx('bx-sparkline', `bx-sparkline--${emphasis}`, className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {area && g.area ? <path className="bx-sparkline__area" d={g.area} /> : null}
      {g.line ? <path className="bx-sparkline__line" d={g.line} fill="none" /> : null}
      {g.last ? <circle className="bx-sparkline__dot" cx={g.last.x} cy={g.last.y} r={4} /> : null}
    </svg>
  );
}
