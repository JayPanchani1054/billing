import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { focusElement, getTabbables, isInNewerOverlay } from '../lib/dom.ts';
import { useLatestRef } from './useLatestRef.ts';

export type InitialFocus = RefObject<HTMLElement | null> | 'first' | 'container' | 'none';

export interface FocusTrapOptions {
  active: boolean;
  /**
   * What to focus on activation: a ref, 'first' (default — first `[data-autofocus]`, else first
   * tabbable, else the container), 'container', or 'none'.
   */
  initialFocus?: InitialFocus;
  /** Return focus to the previously focused element on deactivation (default true). */
  restoreFocus?: boolean;
}

/** Stack of active traps — only the topmost one enforces focus. */
const trapStack: HTMLElement[] = [];

/**
 * Keep keyboard focus inside `containerRef` while active (Tab/Shift+Tab cycle; focus escaping to
 * the page is pulled back). Popups rendered later in their own overlay (menus, pickers, nested
 * dialogs) are allowed to take focus.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
  const { active, restoreFocus = true } = options;
  const initialRef = useLatestRef<InitialFocus>(options.initialFocus ?? 'first');

  useLayoutEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trapStack.push(container);

    const init = initialRef.current;
    if (!container.contains(document.activeElement) && init !== 'none') {
      let target: HTMLElement | null = null;
      if (typeof init === 'object') target = init.current;
      else if (init === 'first') target = container.querySelector<HTMLElement>('[data-autofocus]') ?? getTabbables(container)[0] ?? null;
      if (!target) {
        if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
        target = container;
      }
      focusElement(target);
    }

    const isTop = () => trapStack[trapStack.length - 1] === container;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || !isTop()) return;
      const items = getTabbables(container);
      if (items.length === 0) {
        e.preventDefault();
        focusElement(container);
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === container)) {
        e.preventDefault();
        focusElement(last);
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        focusElement(first);
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (!isTop() || !(t instanceof Node) || container.contains(t)) return;
      if (isInNewerOverlay(t, container)) return;
      focusElement(getTabbables(container)[0] ?? container);
    };

    container.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      const idx = trapStack.lastIndexOf(container);
      if (idx >= 0) trapStack.splice(idx, 1);
      if (restoreFocus && previous && previous.isConnected) {
        const fallback = previous;
        // Restore after the overlay leaves the DOM so screen readers announce the right element.
        queueMicrotask(() => {
          if (!document.activeElement || document.activeElement === document.body || container.contains(document.activeElement) || !document.activeElement.isConnected) {
            focusElement(fallback);
          }
        });
      }
    };
  }, [active, containerRef, restoreFocus, initialRef]);
}
