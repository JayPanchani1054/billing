import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { useControllableState } from './hooks/useControllableState.ts';
import { cx } from './lib/cx.ts';

export interface SplitPaneProps {
  /** 'horizontal' = side by side (default), 'vertical' = stacked. */
  orientation?: 'horizontal' | 'vertical';
  /** Size of the first pane in px (controlled). */
  size?: number;
  defaultSize?: number;
  onSizeChange?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  first: ReactNode;
  second: ReactNode;
  /** Accessible name for the divider ("Resize ledger list"). */
  separatorLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Two resizable panes. Divider: drag, or focus it and use arrows (Shift ×4), Home/End. */
export function SplitPane({
  orientation = 'horizontal',
  size,
  defaultSize = 320,
  onSizeChange,
  minSize = 160,
  maxSize = 960,
  first,
  second,
  separatorLabel = 'Resize panes',
  className,
  ref,
}: SplitPaneProps) {
  const [current, setCurrent] = useControllableState<number>({ value: size, defaultValue: defaultSize, onChange: onSizeChange });
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, size: 0 });
  const clamp = (n: number) => Math.round(Math.min(maxSize, Math.max(minSize, n)));
  const horizontal = orientation === 'horizontal';

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: horizontal ? e.clientX : e.clientY, size: current };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const delta = (horizontal ? e.clientX : e.clientY) - start.current.pos;
    setCurrent(clamp(start.current.size + delta));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const dec = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const inc = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) setCurrent(clamp(current - step));
    else if (e.key === inc) setCurrent(clamp(current + step));
    else if (e.key === 'Home') setCurrent(minSize);
    else if (e.key === 'End') setCurrent(maxSize);
    else return;
    e.preventDefault();
  };

  const firstStyle: CSSProperties = horizontal ? { width: current, flexShrink: 0 } : { height: current, flexShrink: 0 };
  return (
    <div ref={ref} className={cx('bx-split', `bx-split--${orientation}`, dragging && 'is-dragging', className)}>
      <div className="bx-split__pane bx-split__pane--first" style={firstStyle}>
        {first}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={separatorLabel}
        aria-valuenow={current}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        className="bx-split__divider"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="bx-split__pane bx-split__pane--second">{second}</div>
    </div>
  );
}
