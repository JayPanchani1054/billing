import { createElement } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import type { LayoutTag } from './Stack.tsx';
import { cx } from './lib/cx.ts';
import { spaceVar } from './types.ts';
import type { Space } from './types.ts';

export interface InlineProps extends HTMLAttributes<HTMLElement> {
  /** Gap between children (default 2 = 8px). */
  gap?: Space;
  /** Separate row gap when wrapping. */
  rowGap?: Space;
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  /** Wrap onto new lines (default true — "cluster" behaviour). */
  wrap?: boolean;
  as?: LayoutTag;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

const ALIGN: Readonly<Record<NonNullable<InlineProps['align']>, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline', stretch: 'stretch' };
const JUSTIFY: Readonly<Record<NonNullable<InlineProps['justify']>, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };

/** Horizontal flex row (wrapping cluster by default) with token gaps. */
export function Inline({ gap = 2, rowGap, align = 'center', justify, wrap = true, as = 'div', className, style, children, ref, ...rest }: InlineProps) {
  const s: CSSProperties = {
    columnGap: spaceVar(gap),
    rowGap: spaceVar(rowGap ?? gap),
    alignItems: ALIGN[align],
    justifyContent: justify ? JUSTIFY[justify] : undefined,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    ...style,
  };
  return createElement(as, { ref, className: cx('bx-inline', className), style: s, ...rest }, children);
}

/** Alias: a wrapping row of tags/buttons. */
export const Cluster = Inline;
export type ClusterProps = InlineProps;
