import { useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** Max height (px or CSS length); omit to fill the parent (flex: 1). */
  maxHeight?: number | string;
  height?: number | string;
  /** Allow horizontal scrolling too (default false). */
  horizontal?: boolean;
  /** Accessible name — makes the region keyboard-scrollable (focusable) when it overflows. */
  'aria-label'?: string;
  /** Subtle top/bottom shadows when content is cut off. Default true. */
  shadows?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Styled scroll container. When the content overflows it becomes focusable (tabIndex 0, role region)
 * so keyboard users can scroll it (WCAG scrollable-region-focusable).
 */
export function ScrollArea({ maxHeight, height, horizontal = false, shadows = true, className, style, children, ref, ...rest }: ScrollAreaProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(innerRef, ref);
  const [state, setState] = useState({ overflow: false, top: false, bottom: false });

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const update = () => {
      const overflow = el.scrollHeight > el.clientHeight + 1 || (horizontal && el.scrollWidth > el.clientWidth + 1);
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setState((s) => (s.overflow === overflow && s.top === top && s.bottom === bottom ? s : { overflow, top, bottom }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [horizontal]);

  const labelled = !!rest['aria-label'] || !!rest['aria-labelledby'];
  return (
    <div
      ref={merged}
      className={cx(
        'bx-scroll',
        horizontal && 'bx-scroll--x',
        maxHeight === undefined && height === undefined && 'bx-scroll--fill',
        shadows && state.top && 'has-top-shadow',
        shadows && state.bottom && 'has-bottom-shadow',
        className,
      )}
      style={{ maxHeight, height, ...style }}
      tabIndex={state.overflow ? 0 : undefined}
      role={labelled ? 'region' : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}
