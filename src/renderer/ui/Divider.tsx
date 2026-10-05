import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';
import type { Space } from './types.ts';

export interface DividerProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  /** Optional centred caption (horizontal only). */
  label?: ReactNode;
  /** Margin around the rule on the cross axis (space scale step; default 0). */
  spacing?: Space;
  strong?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** Visual separator (role="separator"). */
export function Divider({ orientation = 'horizontal', label, spacing = 0, strong = false, className, style, ...rest }: DividerProps) {
  const margin = `var(--space-${String(spacing).replace('.', '-')})`;
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cx('bx-divider', `bx-divider--${orientation}`, strong && 'bx-divider--strong', label ? 'bx-divider--labelled' : undefined, className)}
      style={{ ...(orientation === 'horizontal' ? { marginTop: margin, marginBottom: margin } : { marginLeft: margin, marginRight: margin }), ...style }}
      {...rest}
    >
      {label && orientation === 'horizontal' ? <span className="bx-divider__label">{label}</span> : null}
    </div>
  );
}
