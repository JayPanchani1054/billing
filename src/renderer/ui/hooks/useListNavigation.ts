import { useCallback } from 'react';
import { isListNavKey, nextListIndex } from '../lib/listNav.ts';
import { useControllableState } from './useControllableState.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface ListNavigationOptions {
  count: number;
  /** Controlled active index (-1 = none). */
  activeIndex?: number;
  defaultActiveIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  /** Rows per PageUp/PageDown (default 10). */
  pageSize?: number;
  /** Arrow keys wrap around (default false). */
  loop?: boolean;
  /** Handle Home/End (default true; false for text inputs where they move the caret). */
  homeEnd?: boolean;
  isDisabled?: (index: number) => boolean;
}

export interface ListKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

export interface ListNavigation {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Handle a navigation key; returns true (and preventDefaults) when it moved the active index. */
  onKeyDown: (e: ListKeyEvent) => boolean;
}

/**
 * "Virtual focus" navigation for listboxes and grids that keep DOM focus elsewhere and expose the
 * active item through aria-activedescendant (Combobox, DataTable).
 */
export function useListNavigation(options: ListNavigationOptions): ListNavigation {
  const [activeIndex, setActiveIndex] = useControllableState<number>({
    value: options.activeIndex,
    defaultValue: options.defaultActiveIndex ?? -1,
    onChange: options.onActiveIndexChange,
  });
  const opts = useLatestRef(options);

  const onKeyDown = useCallback(
    (e: ListKeyEvent): boolean => {
      if (e.altKey || e.ctrlKey || e.metaKey) return false;
      if (!isListNavKey(e.key)) return false;
      const { count, pageSize, loop, isDisabled, homeEnd = true } = opts.current;
      if (!homeEnd && (e.key === 'Home' || e.key === 'End')) return false;
      e.preventDefault();
      setActiveIndex((cur) => nextListIndex(cur, e.key as Parameters<typeof nextListIndex>[1], { count, pageSize, loop, isDisabled }));
      return true;
    },
    [opts, setActiveIndex],
  );

  return { activeIndex, setActiveIndex, onKeyDown };
}
