import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { IconName } from './Icon.tsx';
import { Skeleton } from './Skeleton.tsx';
import { Sparkline } from './Sparkline.tsx';
import { cx } from './lib/cx.ts';
import { formatCompactINR, formatMoney } from '../../shared/format.ts';

export interface KpiDelta {
  /** Percentage change (12.5 = +12.5%). */
  value: number;
  /** Comparison period, named: "vs last month". */
  label?: string;
  /**
   * Which direction is good (default 'up'; 'down' for expenses, overdue). Accepted for compatibility:
   * 2.1 draws a delta in muted text — ▲/▼ and the sign say the direction, the label names the period.
   */
  goodWhen?: 'up' | 'down';
}

export interface KpiCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
  /** Sentence case, no trailing colon ("Receivables"). */
  label: ReactNode;
  /** Pre-formatted value, or paise when `amount` is true. */
  value: ReactNode;
  /** Treat `value` as paise: shows compact ₹ (e.g. ₹12.35 L) with the exact amount as a tooltip. */
  amount?: boolean;
  delta?: KpiDelta;
  /** One short caption under the value ("34 bills overdue"). */
  caption?: ReactNode;
  /** Accepted for compatibility and ignored: a figure has no icon tile (2.1). */
  icon?: IconName;
  /** Trend values (≈ 12 points); or pass any node via `trend`. */
  sparkline?: readonly number[];
  trend?: ReactNode;
  loading?: boolean;
  /** Makes the whole figure a button (drill-down). */
  onClick?: () => void;
  ref?: Ref<HTMLElement>;
}

/**
 * A figure (2.1): label 12 muted · value 24/600 in proportional figures · at most one caption ·
 * optional delta (▲/▼ + sign — never colour alone) · optional sparkline. No icon tile, chevron,
 * border or hover lift; a clickable figure is one button (the drill).
 */
export function KpiCard({ label, value, amount = false, delta, caption, icon, sparkline, trend, loading = false, onClick, className, ref, ...rest }: KpiCardProps) {
  void icon;
  const display = amount && typeof value === 'number' ? formatCompactINR(value) : value;
  const exact = amount && typeof value === 'number' ? formatMoney(value, { symbol: true }) : undefined;
  const spark = trend ?? (sparkline && sparkline.length > 1 ? <Sparkline values={sparkline} className="bx-kpi__spark" /> : null);
  const body = (
    <>
      <span className="bx-kpi__label">{label}</span>
      {loading ? (
        <Skeleton variant="text" width="60%" height={28} />
      ) : (
        <span className="bx-kpi__value" title={exact}>
          {display}
          {exact ? <span className="bx-sr-only"> ({exact})</span> : null}
        </span>
      )}
      {(delta && !loading) || caption || spark ? (
        <span className="bx-kpi__foot">
          {delta && !loading ? (
            <span className="bx-kpi__delta">
              <span aria-hidden="true">{delta.value > 0 ? '▲ ' : delta.value < 0 ? '▼ ' : '■ '}</span>
              <span className="bx-sr-only">{delta.value > 0 ? 'Up ' : delta.value < 0 ? 'Down ' : 'No change '}</span>
              {`${delta.value > 0 ? '+' : delta.value < 0 ? '−' : ''}${Math.abs(delta.value).toFixed(1)}%${delta.label ? ` ${delta.label}` : ''}`}
            </span>
          ) : null}
          {caption ? <span className="bx-kpi__caption">{caption}</span> : null}
          {spark}
        </span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button ref={ref as Ref<HTMLButtonElement>} type="button" className={cx('bx-kpi', 'bx-kpi--interactive', className)} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <section ref={ref} className={cx('bx-kpi', className)} {...rest}>
      {body}
    </section>
  );
}

/** Alias. */
export const Stat = KpiCard;
export type StatProps = KpiCardProps;
