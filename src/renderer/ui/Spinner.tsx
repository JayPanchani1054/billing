import type { HTMLAttributes, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Announced text (default 'Loading'). */
  label?: string;
  /** Hide from assistive tech (when the parent already conveys busy state, e.g. aria-busy). */
  decorative?: boolean;
  ref?: Ref<HTMLSpanElement>;
}

/** Indeterminate activity indicator. Respects reduced motion (slows to a gentle pulse). */
export function Spinner({ size = 'md', label = 'Loading', decorative = false, className, ...rest }: SpinnerProps) {
  return (
    <span
      className={cx('bx-spinner', `bx-spinner--${size}`, className)}
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative ? true : undefined}
      {...rest}
    >
      <svg viewBox="0 0 24 24" className="bx-spinner__svg" focusable="false" aria-hidden="true">
        <circle className="bx-spinner__track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" />
        <circle className="bx-spinner__arc" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {decorative ? null : <span className="bx-sr-only">{label}</span>}
    </span>
  );
}
