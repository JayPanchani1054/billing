import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * A ref that always holds the latest committed `value` — lets stable callbacks/listeners read fresh
 * props without re-subscribing.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef<T>(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
