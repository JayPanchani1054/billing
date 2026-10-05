import { useId } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Omit (or `indeterminate`) for unknown progress. */
  value?: number;
  max?: number;
  /** Visible label above the bar (also the accessible name). */
  label?: ReactNode;
  /** Accessible name when no visible label. */
  'aria-label'?: string;
  /** Show "42%" (or valueText) at the right of the label row. */
  showValue?: boolean;
  valueText?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  indeterminate?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** Determinate or indeterminate progress (backups, imports, GST JSON generation). */
export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = false,
  valueText,
  tone = 'brand',
  size = 'md',
  indeterminate,
  className,
  ...rest
}: ProgressBarProps) {
  const labelId = useId();
  const isIndeterminate = indeterminate ?? value === undefined;
  const pct = isIndeterminate ? 0 : Math.max(0, Math.min(100, ((value ?? 0) / (max || 1)) * 100));
  const text = valueText ?? `${Math.round(pct)}%`;
  return (
    <div className={cx('bx-progress', `bx-progress--${tone}`, `bx-progress--${size}`, isIndeterminate && 'is-indeterminate', className)} {...rest}>
      {label || showValue ? (
        <div className="bx-progress__meta">
          {label ? (
            <span id={labelId} className="bx-progress__label">
              {label}
            </span>
          ) : (
            <span />
          )}
          {showValue && !isIndeterminate ? <span className="bx-progress__value bx-num">{text}</span> : null}
        </div>
      ) : null}
      <div
        className="bx-progress__track"
        role="progressbar"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : rest['aria-label']}
        aria-valuemin={isIndeterminate ? undefined : 0}
        aria-valuemax={isIndeterminate ? undefined : max}
        aria-valuenow={isIndeterminate ? undefined : value}
        aria-valuetext={isIndeterminate ? undefined : text}
      >
        <div className="bx-progress__bar" style={isIndeterminate ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}
