import type { CSSProperties, HTMLAttributes, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'text' | 'rect' | 'circle';
  width?: number | string;
  height?: number | string;
  /** Render N text lines (the last one shorter). */
  lines?: number;
  ref?: Ref<HTMLSpanElement>;
}

/** Loading placeholder (aria-hidden; pair with aria-busy on the region being loaded). */
export function Skeleton({ variant = 'text', width, height, lines, className, style, ...rest }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx('bx-skeleton-lines', className)} aria-hidden="true" style={style} {...rest}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="bx-skeleton bx-skeleton--text" style={{ width: i === lines - 1 ? '60%' : width ?? '100%' }} />
        ))}
      </span>
    );
  }
  const s: CSSProperties = { ...style, width, height };
  return <span className={cx('bx-skeleton', `bx-skeleton--${variant}`, className)} aria-hidden="true" style={s} {...rest} />;
}
