import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent, ReactNode, Ref, RefObject } from 'react';
import { HotkeyScope } from './HotkeyScope.tsx';
import { Portal } from './Portal.tsx';
import { useAnchoredPosition } from './hooks/useAnchoredPosition.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { useOnClickOutside } from './hooks/useOnClickOutside.ts';
import { cx } from './lib/cx.ts';
import { focusElement, getTabbables, isInNewerOverlay } from './lib/dom.ts';
import type { Placement } from './lib/position.ts';

export type { Placement } from './lib/position.ts';

export interface PopoverProps {
  open: boolean;
  /** Called when the popover asks to close (Esc, outside click, Tab out). */
  onClose: () => void;
  /** Element the popover is anchored to (usually its trigger). Focus returns here on Esc. */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  offset?: number;
  /** Make the panel at least as wide as the anchor. */
  matchWidth?: boolean;
  /** 'dialog' (default) for rich content; 'none' when children bring their own role (menu, listbox). */
  role?: 'dialog' | 'none';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  /** Focus on open: 'first' tabbable (default for dialog), 'none' (keep focus on the anchor), or a ref. */
  initialFocus?: 'first' | 'none' | RefObject<HTMLElement | null>;
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  /** Fence app hotkeys while open (default true). */
  blockHotkeys?: boolean;
  /** Fixed width / max height of the panel. */
  width?: number | string;
  maxHeight?: number | string;
  /** Remove the default padding (lists, calendars manage their own). */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/** Find the tabbable element after `anchor` in document order (Tab out of a portalled popover). */
function focusAfter(anchor: HTMLElement): void {
  const all = getTabbables(document.body).filter((el) => !el.closest('[data-bx-overlay]'));
  const idx = all.findIndex((el) => el === anchor || anchor.contains(el));
  if (idx >= 0 && all[idx + 1]) focusElement(all[idx + 1]);
  else focusElement(anchor);
}

/**
 * Anchored, non-modal floating panel rendered in a portal: closes on Esc (focus returns to the
 * anchor), outside click and tabbing out. Fences app hotkeys while open.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = 'bottom-start',
  offset = 4,
  matchWidth = false,
  role = 'dialog',
  id,
  initialFocus = role === 'dialog' ? 'first' : 'none',
  closeOnOutsideClick = true,
  closeOnEscape = true,
  blockHotkeys = true,
  width,
  maxHeight,
  flush = false,
  className,
  style,
  children,
  ref,
  ...aria
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const mergedRef = useMergedRefs(panelRef, ref);
  const pos = useAnchoredPosition(anchorRef, panelRef, { open, placement, offset, matchWidth });

  useOnClickOutside([panelRef, anchorRef], () => onClose(), open && closeOnOutsideClick);

  useLayoutEffect(() => {
    if (!open || initialFocus === 'none') return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = typeof initialFocus === 'object' ? initialFocus.current : panel.querySelector<HTMLElement>('[data-autofocus]') ?? getTabbables(panel)[0] ?? panel;
    focusElement(target);
    // Only on open — not when initialFocus identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = useCallback(
    (restore: boolean) => {
      const panel = panelRef.current;
      const hadFocus = !!panel && panel.contains(document.activeElement);
      onClose();
      if (restore && hadFocus && anchorRef.current) focusElement(anchorRef.current);
    },
    [onClose, anchorRef],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && closeOnEscape && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab' && !e.defaultPrevented) {
      const panel = panelRef.current;
      if (!panel) return;
      const items = getTabbables(panel);
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (items.length === 0 || (e.shiftKey && (at === first || at === panel)) || (!e.shiftKey && at === last)) {
        e.preventDefault();
        const anchor = anchorRef.current;
        onClose();
        if (anchor) {
          if (e.shiftKey) focusElement(anchor);
          else focusAfter(anchor);
        }
      }
    }
  };

  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    const panel = panelRef.current;
    if (!next || !panel || !(next instanceof Node)) return;
    if (panel.contains(next) || anchorRef.current?.contains(next) || isInNewerOverlay(next, panel)) return;
    onClose();
  };

  if (!open) return null;
  const panelStyle: CSSProperties = { ...pos.style, width, maxHeight: maxHeight ?? (pos.available ? pos.available : undefined), ...style };
  return (
    <Portal>
      <HotkeyScope blocking={blockHotkeys}>
        <div
          ref={mergedRef}
          id={id}
          role={role === 'none' ? undefined : role}
          aria-label={aria['aria-label']}
          aria-labelledby={aria['aria-labelledby']}
          className={cx('bx-popover', flush && 'bx-popover--flush', className)}
          data-bx-overlay=""
          data-placement={pos.placement}
          tabIndex={-1}
          style={panelStyle}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          {children}
        </div>
      </HotkeyScope>
    </Portal>
  );
}
