import { useRef } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** Required accessible name ("Report options"). */
  'aria-label': string;
  /**
   * Roving focus among the toolbar's buttons (one Tab stop, ←/→ move). Inputs/selects stay in the
   * normal Tab order. Default true.
   */
  roving?: boolean;
  /** Visual style: 'plain' (default) or 'bar' (filled strip with bottom border). */
  variant?: 'plain' | 'bar';
  /** Smaller height. */
  dense?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/** Horizontal group of controls (role="toolbar"). Use <Spacer/> to push items to the end. */
export function Toolbar({ roving = true, variant = 'plain', dense = false, className, children, onKeyDown, onFocus, ref, ...rest }: ToolbarProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(innerRef, ref);
  const nav = useRovingFocus(innerRef, {
    orientation: 'horizontal',
    loop: false,
    itemSelector: 'button:not([data-roving-skip]), [role="button"], a[href]',
    manageTabIndex: roving,
  });
  return (
    <div
      ref={merged}
      role="toolbar"
      aria-orientation="horizontal"
      className={cx('bx-toolbar', `bx-toolbar--${variant}`, dense && 'bx-toolbar--dense', className)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (roving) nav.onKeyDown(e);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        if (roving) nav.onFocus(e);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
