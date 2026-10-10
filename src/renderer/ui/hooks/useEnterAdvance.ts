import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import { focusElement, getEnterTargets, isActivatable } from '../lib/dom.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface EnterAdvanceOptions {
  /** Default true. */
  enabled?: boolean;
  /** Enter on the last field (e.g. ask "Accept?" / save). Without it Enter on the last field does nothing. */
  onComplete?: () => void;
  /** Select the text of the field that receives focus (overwrite-on-entry behaviour). Default true. */
  selectOnFocus?: boolean;
}

/**
 * Keyboard-first form navigation. Returns a ref for the form container (it gets `data-enter-scope`):
 * - Enter moves to the next field, Shift+Enter to the previous one.
 * - In a textarea plain Enter is a newline; Ctrl+Enter / Ctrl+Shift+Enter move instead.
 * - Buttons and links keep their native Enter activation. Controls that consume Enter themselves
 *   (an open picker selecting an item calls preventDefault) are respected.
 * - Fields are editable inputs/selects/textareas/comboboxes/switches in DOM order, skipping
 *   disabled/read-only/tabindex=-1 and anything inside `[data-enter-skip]`; add
 *   `data-enter-target` to include another element (e.g. the Save button).
 * - Only the innermost scope handles a key (nested dialogs get their own scope).
 *
 * The listener runs at window level in the bubble phase, i.e. after React's own handlers.
 */
export function useEnterAdvance<T extends HTMLElement = HTMLElement>(options: EnterAdvanceOptions = {}): RefCallback<T> {
  const opts = useLatestRef(options);
  const [node, setNode] = useState<T | null>(null);
  const nodeRef = useRef<T | null>(null);

  const ref = useCallback<RefCallback<T>>((el) => {
    nodeRef.current = el;
    if (el) el.setAttribute('data-enter-scope', '');
    setNode(el);
  }, []);

  useEffect(() => {
    if (!node) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.altKey || e.metaKey) return;
      if (opts.current.enabled === false) return;
      const target = e.target;
      if (!(target instanceof HTMLElement) || !node.contains(target)) return;
      if (target.closest('[data-enter-scope]') !== node) return;
      if (target.closest('[data-enter-ignore]')) return;
      const isTextarea = target instanceof HTMLTextAreaElement;
      if (isTextarea !== e.ctrlKey) return; // textarea needs Ctrl+Enter; elsewhere Ctrl+Enter is reserved
      if (isActivatable(target)) return;

      const fields = getEnterTargets(node);
      let index = fields.indexOf(target);
      if (index < 0) index = fields.findIndex((f) => f.contains(target) || target.contains(f));
      if (index < 0) return;
      e.preventDefault();
      const next = fields[e.shiftKey ? index - 1 : index + 1];
      if (next) {
        focusElement(next, opts.current.selectOnFocus !== false);
        next.scrollIntoView({ block: 'nearest' });
      } else if (!e.shiftKey) {
        opts.current.onComplete?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [node, opts]);

  return ref;
}
