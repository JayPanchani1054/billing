import { useCallback } from 'react';
import type { Ref, RefCallback } from 'react';

/** Point several refs (callback or object) at one node. Supports React 19 ref-callback cleanups. */
export function mergeRefs<T>(...refs: ReadonlyArray<Ref<T> | undefined>): RefCallback<T> {
  return (node: T | null) => {
    const cleanups: Array<() => void> = [];
    for (const ref of refs) {
      if (typeof ref === 'function') {
        const cleanup = ref(node);
        cleanups.push(typeof cleanup === 'function' ? cleanup : () => void ref(null));
      } else if (ref) {
        ref.current = node;
        cleanups.push(() => {
          ref.current = null;
        });
      }
    }
    return () => {
      for (const c of cleanups) c();
    };
  };
}

/** Memoised mergeRefs — the callback identity only changes when one of the refs does. */
export function useMergedRefs<T>(...refs: ReadonlyArray<Ref<T> | undefined>): RefCallback<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(mergeRefs(...refs), refs);
}
