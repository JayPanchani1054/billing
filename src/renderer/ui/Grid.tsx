import { createElement } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import type { LayoutTag } from './Stack.tsx';
import { cx } from './lib/cx.ts';
import { spaceVar } from './types.ts';
import type { Space } from './types.ts';

export interface GridProps extends HTMLAttributes<HTMLElement> {
  /** Column count, or a grid-template-columns string ('2fr 1fr'). Ignored when minItemWidth is set. */
  columns?: number | string;
  /** Responsive auto-fill: as many columns as fit at this minimum width (px). */
  minItemWidth?: number;
  gap?: Space;
  rowGap?: Space;
  align?: 'start' | 'center' | 'end' | 'stretch';
  as?: LayoutTag;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

/** CSS grid with token gaps (dashboards, multi-column forms). */
export function Grid({ columns = 2, minItemWidth, gap = 4, rowGap, align = 'stretch', as = 'div', className, style, children, ref, ...rest }: GridProps) {
  const template = minItemWidth
    ? `repeat(auto-fill, minmax(min(${minItemWidth}px, 100%), 1fr))`
    : typeof columns === 'number'
      ? `repeat(${columns}, minmax(0, 1fr))`
      : columns;
  const s: CSSProperties = { gridTemplateColumns: template, columnGap: spaceVar(gap), rowGap: spaceVar(rowGap ?? gap), alignItems: align, ...style };
  return createElement(as, { ref, className: cx('bx-grid', className), style: s, ...rest }, children);
}
