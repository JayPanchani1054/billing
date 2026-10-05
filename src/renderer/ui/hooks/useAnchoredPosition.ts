import { useCallback, useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { computePosition } from '../lib/position.ts';
import type { Placement } from '../lib/position.ts';

export interface AnchoredPositionOptions {
  open: boolean;
  placement?: Placement;
  /** Gap between anchor and floating element (px, default 4). */
  offset?: number;
  /** Keep this far from the viewport edge (px, default 8). */
  padding?: number;
  /** Make the floating element at least as wide as the anchor. */
  matchWidth?: boolean;
}

export interface AnchoredPosition {
  /** Apply to the floating element (position: fixed). Transparent until measured. */
  style: CSSProperties;
  placement: Placement;
  /** Space available on the chosen side — clamp max-height with it. */
  available: number;
  update: () => void;
}

interface State {
  top: number;
  left: number;
  placement: Placement;
  available: number;
  minWidth: number;
}

/** Position a floating element (rendered in a portal) next to an anchor, flipping/shifting to stay on screen. */
export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  { open, placement = 'bottom-start', offset = 4, padding = 8, matchWidth = false }: AnchoredPositionOptions,
): AnchoredPosition {
  const [state, setState] = useState<State | null>(null);

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;
    const a = anchor.getBoundingClientRect();
    const minWidth = matchWidth ? a.width : 0;
    const size = { width: Math.max(floating.offsetWidth, minWidth), height: floating.offsetHeight };
    const vp = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const p = computePosition({ top: a.top, left: a.left, width: a.width, height: a.height }, size, vp, placement, offset, padding);
    setState((prev) =>
      prev && prev.top === p.top && prev.left === p.left && prev.placement === p.placement && prev.available === p.available && prev.minWidth === minWidth
        ? prev
        : { ...p, minWidth },
    );
  }, [anchorRef, floatingRef, placement, offset, padding, matchWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setState(null);
      return undefined;
    }
    update();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro) {
      if (anchorRef.current) ro.observe(anchorRef.current);
      if (floatingRef.current) ro.observe(floatingRef.current);
    }
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, update, anchorRef, floatingRef]);

  const style: CSSProperties = state
    ? { position: 'fixed', top: state.top, left: state.left, minWidth: state.minWidth || undefined }
    : // Unmeasured: invisible but still focusable (children may autofocus before we measure).
      { position: 'fixed', top: 0, left: 0, opacity: 0, pointerEvents: 'none' };
  return { style, placement: state?.placement ?? placement, available: state?.available ?? 0, update };
}
