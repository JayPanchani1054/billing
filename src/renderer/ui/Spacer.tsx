import type { CSSProperties } from 'react';
import { spaceVar } from './types.ts';
import type { Space } from './types.ts';

export interface SpacerProps {
  /** Fixed size (space step). Omit to grow and push siblings apart (flex: 1). */
  size?: Space;
  axis?: 'horizontal' | 'vertical';
}

/** Flexible (default) or fixed empty space inside Inline/Stack/Toolbar. */
export function Spacer({ size, axis = 'horizontal' }: SpacerProps) {
  const style: CSSProperties =
    size === undefined ? { flex: 1 } : axis === 'horizontal' ? { width: spaceVar(size), flexShrink: 0 } : { height: spaceVar(size), flexShrink: 0 };
  return <span className="bx-spacer" aria-hidden="true" style={style} />;
}
