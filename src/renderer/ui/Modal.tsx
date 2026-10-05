import { useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { HotkeyScope, Hotkeys } from './HotkeyScope.tsx';
import { IconButton } from './IconButton.tsx';
import { Portal } from './Portal.tsx';
import { useFocusTrap } from './hooks/useFocusTrap.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  open: boolean;
  /** Requested close (Esc, close button, backdrop). Not called when `dismissible` is false. */
  onClose: () => void;
  title: ReactNode;
  /** Short supporting text under the title (wired to aria-describedby). */
  description?: ReactNode;
  size?: ModalSize;
  /** Footer actions (right-aligned). Put the primary action last. */
  footer?: ReactNode;
  /** Content left of the footer actions (e.g. a hint or a Kbd legend). */
  footerStart?: ReactNode;
  /** Esc / close button / backdrop click close the dialog (default true). */
  dismissible?: boolean;
  /** Backdrop click closes (default false — accidental clicks shouldn't lose data entry). */
  closeOnBackdrop?: boolean;
  /** Element to focus on open (default: first `[data-autofocus]`, else first field/button). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 'dialog' (default) or 'alertdialog' for urgent confirmations. */
  role?: 'dialog' | 'alertdialog';
  /** Body without padding (tables, editors). */
  flush?: boolean;
  /** Hide the × button (Esc still works when dismissible). */
  hideClose?: boolean;
  className?: string;
  bodyClassName?: string;
  /** Extra id for aria-describedby (e.g. an error summary). */
  'aria-describedby'?: string;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Modal dialog: portal + backdrop, focus trap with initial focus and focus restore, aria-modal,
 * Esc to close (unless `dismissible={false}`), and a blocking hotkey scope so only the dialog's
 * shortcuts fire. Unmounts when closed.
 */
export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalImpl {...props} />;
}

/** Alias — same component. */
export const Dialog = Modal;

function ModalImpl({
  onClose,
  title,
  description,
  size = 'md',
  footer,
  footerStart,
  dismissible = true,
  closeOnBackdrop = false,
  initialFocusRef,
  role = 'dialog',
  flush = false,
  hideClose = false,
  className,
  bodyClassName,
  children,
  ref,
  ...rest
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(dialogRef, ref);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(dialogRef, { active: true, initialFocus: initialFocusRef ?? 'first' });

  const requestClose = () => {
    if (dismissible) onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
  };

  const describedBy = [description ? descId : null, rest['aria-describedby'] ?? null].filter(Boolean).join(' ') || undefined;

  return (
    <Portal>
      <HotkeyScope blocking>
        {/* Fallback when focus is lost (e.g. on body): Esc still reaches the topmost dialog. */}
        <Hotkeys map={{ Escape: () => requestClose() }} />
        <div className="bx-modal-layer" data-bx-overlay="">
          <div className="bx-modal-backdrop" aria-hidden="true" onMouseDown={closeOnBackdrop ? requestClose : undefined} />
          <div
            ref={merged}
            role={role}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            className={cx('bx-modal', `bx-modal--${size}`, className)}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <header className="bx-modal__header">
              <div className="bx-modal__titles">
                <h2 id={titleId} className="bx-modal__title">
                  {title}
                </h2>
                {description ? (
                  <p id={descId} className="bx-modal__description">
                    {description}
                  </p>
                ) : null}
              </div>
              {dismissible && !hideClose ? (
                <IconButton icon="close" aria-label="Close" tooltip={false} className="bx-modal__close" onClick={requestClose} data-enter-skip="" data-initial-focus-skip="" />
              ) : null}
            </header>
            <div className={cx('bx-modal__body', flush && 'bx-modal__body--flush', bodyClassName)}>{children}</div>
            {footer || footerStart ? (
              <footer className="bx-modal__footer">
                <div className="bx-modal__footer-start">{footerStart}</div>
                <div className="bx-modal__footer-actions">{footer}</div>
              </footer>
            ) : null}
          </div>
        </div>
      </HotkeyScope>
    </Portal>
  );
}
