import { useCallback, useLayoutEffect, useRef } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { isEditableTarget, isVisible } from '../lib/dom.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface RovingFocusOptions {
  /** Which arrow keys move focus (default 'horizontal'). */
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** Wrap at the ends (default true). */
  loop?: boolean;
  /** Items inside the container (default '[data-roving-item]'). Nested roving containers are excluded. */
  itemSelector?: string;
  /** Jump to the next item starting with typed letters (menus). */
  typeahead?: boolean;
  /**
   * Manage tabindex in the DOM (exactly one item tabbable: the focused one, else
   * `[data-roving-active]`, `[aria-selected=true]`, `[aria-checked=true]`, else the first). Set false
   * when the component renders tabIndex itself.
   */
  manageTabIndex?: boolean;
  /** Called after focus moves to an item via keyboard (e.g. tabs with automatic activation). */
  onNavigate?: (item: HTMLElement, index: number) => void;
}

export interface RovingFocusResult {
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onFocus: (e: ReactFocusEvent<HTMLElement>) => void;
  /** Items currently managed (DOM order). */
  getItems: () => HTMLElement[];
  focusItem: (index: number) => void;
}

/**
 * Roving tabindex for composite widgets (toolbars, menus, tab lists, segmented controls): the
 * group is one Tab stop; arrow keys move between items; Home/End jump to the ends.
 */
export function useRovingFocus(containerRef: RefObject<HTMLElement | null>, options: RovingFocusOptions = {}): RovingFocusResult {
  const opts = useLatestRef(options);
  const typed = useRef({ buffer: '', at: 0 });

  const getItems = useCallback((): HTMLElement[] => {
    const container = containerRef.current;
    if (!container) return [];
    const selector = opts.current.itemSelector ?? '[data-roving-item]';
    return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => el.closest('[data-roving-container]') === container && !(el as HTMLButtonElement).disabled && isVisible(el),
    );
  }, [containerRef, opts]);

  const setTabStop = useCallback(
    (active: HTMLElement | null) => {
      if (opts.current.manageTabIndex === false) return;
      for (const el of getItems()) el.tabIndex = el === active ? 0 : -1;
    },
    [getItems, opts],
  );

  // Mark the container and keep exactly one tab stop after every render.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.setAttribute('data-roving-container', '');
    if (opts.current.manageTabIndex === false) return;
    const items = getItems();
    if (items.length === 0) return;
    const focused = items.find((el) => el === document.activeElement);
    const preferred =
      focused ??
      items.find((el) => el.hasAttribute('data-roving-active')) ??
      items.find((el) => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true') ??
      items.find((el) => el.tabIndex === 0) ??
      items[0];
    for (const el of items) el.tabIndex = el === preferred ? 0 : -1;
  });

  const focusItem = useCallback(
    (index: number) => {
      const items = getItems();
      const el = items[index];
      if (!el) return;
      setTabStop(el);
      el.focus();
      opts.current.onNavigate?.(el, index);
    },
    [getItems, setTabStop, opts],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditableTarget(e.target)) return;
      const items = getItems();
      if (items.length === 0) return;
      const current = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
      if (current < 0) return;
      const { orientation = 'horizontal', loop = true, typeahead = false } = opts.current;
      const prevKeys = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'horizontal' ? ['ArrowLeft'] : ['ArrowUp', 'ArrowLeft'];
      const nextKeys = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'horizontal' ? ['ArrowRight'] : ['ArrowDown', 'ArrowRight'];
      let next = -1;
      if (nextKeys.includes(e.key)) next = current + 1 < items.length ? current + 1 : loop ? 0 : current;
      else if (prevKeys.includes(e.key)) next = current > 0 ? current - 1 : loop ? items.length - 1 : current;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (typeahead && e.key.length === 1 && e.key !== ' ') {
        const now = Date.now();
        const t = typed.current;
        t.buffer = now - t.at > 600 ? e.key.toLowerCase() : t.buffer + e.key.toLowerCase();
        t.at = now;
        const allSame = t.buffer.split('').every((c) => c === t.buffer[0]);
        const needle = allSame ? t.buffer[0] : t.buffer;
        const start = needle.length > 1 ? current : current + 1;
        for (let k = 0; k < items.length; k++) {
          const i = (start + k) % items.length;
          const text = (items[i].getAttribute('data-text-value') ?? items[i].textContent ?? '').trim().toLowerCase();
          if (text.startsWith(needle)) {
            next = i;
            break;
          }
        }
        if (next < 0) return;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (next !== current) focusItem(next);
    },
    [getItems, focusItem, opts],
  );

  const onFocus = useCallback(
    (e: ReactFocusEvent<HTMLElement>) => {
      const items = getItems();
      const hit = items.find((el) => el === e.target || el.contains(e.target as Node));
      if (hit) setTabStop(hit);
    },
    [getItems, setTabStop],
  );

  return { onKeyDown, onFocus, getItems, focusItem };
}
