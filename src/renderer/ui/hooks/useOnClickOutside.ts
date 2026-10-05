import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isInNewerOverlay } from '../lib/dom.ts';
import { useLatestRef } from './useLatestRef.ts';

/**
 * Call `handler` on a pointer-down outside all `refs`. Pointer-downs inside overlays opened *after*
 * the first ref (e.g. a picker list inside a popover) count as inside.
 */
export function useOnClickOutside(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  handler: (event: PointerEvent) => void,
  enabled = true,
): void {
  const handlerRef = useLatestRef(handler);
  const refsRef = useLatestRef(refs);
  useEffect(() => {
    if (!enabled) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !target.isConnected) return;
      const els = refsRef.current.map((r) => r.current).filter((el): el is HTMLElement => !!el);
      if (els.some((el) => el.contains(target))) return;
      if (isInNewerOverlay(target, els[0] ?? null)) return;
      handlerRef.current(e);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [enabled, handlerRef, refsRef]);
}
