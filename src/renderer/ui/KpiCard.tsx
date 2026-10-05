import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
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
  /** Which direction is good (default 'up'; use 'down' for expenses, overdue). */
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
  /** Small caption under the value ("34 bills overdue"). */
  caption?: ReactNode;
  icon?: IconName;
  /** Trend values (≈ 12 points); or pass any node via `trend`. */
  sparkline?: readonly number[];
  trend?: ReactNode;
  loading?: boolean;
  /** Makes the whole tile a button (drill-down). */
  onClick?: () => void;
  ref?: Ref<HTMLElement>;
}

function deltaTone(d: KpiDelta): 'positive' | 'negative' | 'neutral' {
  if (d.value === 0) return 'neutral';
  const up = d.value > 0;
  return up === ((d.goodWhen ?? 'up') === 'up') ? 'positive' : 'negative';
}

/**
 * Stat tile: label · value (proportional figures) · delta (▲/▼ + sign + tone — never colour alone) ·
 * optional sparkline. Clickable tiles are buttons.
 */
export function KpiCard({ label, value, amount = false, delta, caption, icon, sparkline, trend, loading = false, onClick, className, ref, ...rest }: KpiCardProps) {
  const display = amount && typeof value === 'number' ? formatCompactINR(value) : value;
  const exact = amount && typeof value === 'number' ? formatMoney(value, { symbol: true }) : undefined;
  const body = (
    <>
      <div className="bx-kpi__head">
        {icon ? (
          <span className="bx-kpi__icon" aria-hidden="true">
            <Icon name={icon} size="sm" />
          </span>
        ) : null}
        <span className="bx-kpi__label">{label}</span>
        {onClick ? <Icon name="chevron-right" size="sm" className="bx-kpi__chevron" /> : null}
      </div>
      {loading ? (
        <Skeleton variant="text" width="60%" height={28} />
      ) : (
        <div className="bx-kpi__value" title={exact}>
          {display}
          {exact ? <span className="bx-sr-only"> ({exact})</span> : null}
        </div>
      )}
      <div className="bx-kpi__foot">
        {delta && !loading ? (
          <span className={cx('bx-kpi__delta', `bx-kpi__delta--${deltaTone(delta)}`)}>
            <span aria-hidden="true">{delta.value > 0 ? '▲' : delta.value < 0 ? '▼' : '■'}</span>
            <span className="bx-sr-only">{delta.value > 0 ? 'Up' : delta.value < 0 ? 'Down' : 'No change'}</span>
            <span className="bx-num">{`${delta.value > 0 ? '+' : delta.value < 0 ? '−' : ''}${Math.abs(delta.value).toFixed(1)}%`}</span>
            {delta.label ? <span className="bx-kpi__delta-label">{delta.label}</span> : null}
          </span>
        ) : null}
        {caption ? <span className="bx-kpi__caption">{caption}</span> : null}
        {trend ?? (sparkline && sparkline.length > 1 ? <Sparkline values={sparkline} className="bx-kpi__spark" /> : null)}
      </div>
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
