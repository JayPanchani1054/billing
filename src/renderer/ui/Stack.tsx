import { createElement } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';
import { spaceVar } from './types.ts';
import type { Space } from './types.ts';

export type LayoutTag = 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav' | 'form' | 'ul' | 'ol' | 'li' | 'fieldset';

export interface StackProps extends HTMLAttributes<HTMLElement> {
  /** Gap between children (space scale step, default 3 = 12px). */
  gap?: Space;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between';
  /** Fill the parent's height (flex: 1, min-height: 0) — for screens whose body scrolls. */
  grow?: boolean;
  as?: LayoutTag;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

const ALIGN: Readonly<Record<NonNullable<StackProps['align']>, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY: Readonly<Record<NonNullable<StackProps['justify']>, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };

/** Vertical flex layout with token gaps. */
export function Stack({ gap = 3, align = 'stretch', justify, grow = false, as = 'div', className, style, children, ref, ...rest }: StackProps) {
  const s: CSSProperties = { gap: spaceVar(gap), alignItems: ALIGN[align], justifyContent: justify ? JUSTIFY[justify] : undefined, ...style };
  return createElement(as, { ref, className: cx('bx-stack', grow && 'bx-stack--grow', className), style: s, ...rest }, children);
}
