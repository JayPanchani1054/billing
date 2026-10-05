import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ControllableStateOptions<T> {
  /** Controlled value. `undefined` = uncontrolled (use `null` for an explicit empty controlled value). */
  value?: T;
  /** Initial value when uncontrolled. */
  defaultValue: T;
  /** Called with every change (controlled or not). Not called when the value is unchanged (Object.is). */
  onChange?: (value: T) => void;
}

export type ControllableSetter<T> = (next: T | ((prev: T) => T)) => void;

/**
 * State that can be controlled by a parent (`value` + `onChange`) or managed internally
 * (`defaultValue`). The returned setter is stable. Do not use with function-typed values.
 */
export function useControllableState<T>({ value, defaultValue, onChange }: ControllableStateOptions<T>): [T, ControllableSetter<T>] {
  const [internal, setInternal] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? (value as T) : internal;

  const currentRef = useRef<T>(current);
  const controlledRef = useRef(controlled);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    currentRef.current = current;
    controlledRef.current = controlled;
    onChangeRef.current = onChange;
  });

  const set = useCallback<ControllableSetter<T>>((next) => {
    const prev = currentRef.current;
    const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    if (Object.is(resolved, prev)) return;
    currentRef.current = resolved; // chained sets within one tick see the latest value
    if (!controlledRef.current) setInternal(resolved);
    onChangeRef.current?.(resolved);
  }, []);

  return [current, set];
}
