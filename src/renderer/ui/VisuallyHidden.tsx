import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
  /** Become visible when focused (skip links). */
  focusable?: boolean;
  ref?: Ref<HTMLSpanElement>;
}

/** Content for screen readers only (class `bx-sr-only`). */
export function VisuallyHidden({ children, focusable, className, ...rest }: VisuallyHiddenProps) {
  return (
    <span className={cx(focusable ? 'bx-sr-only-focusable' : 'bx-sr-only', className)} {...rest}>
      {children}
    </span>
  );
}
