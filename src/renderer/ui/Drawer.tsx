import { useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { HotkeyScope, Hotkeys } from './HotkeyScope.tsx';
import { IconButton } from './IconButton.tsx';
import { Portal } from './Portal.tsx';
import { useFocusTrap } from './hooks/useFocusTrap.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** 'sm' 360 · 'md' 480 (default) · 'lg' 720. */
  size?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
  /** Modal drawers trap focus and dim the page (default true). Non-modal drawers leave the page usable. */
  modal?: boolean;
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/** Right-side panel for details, filters and secondary forms. Esc closes. */
export function Drawer(props: DrawerProps) {
  if (!props.open) return null;
  return <DrawerImpl {...props} />;
}

function DrawerImpl({ onClose, title, description, size = 'md', footer, modal = true, dismissible = true, initialFocusRef, className, children, ref }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(panelRef, ref);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, { active: modal, initialFocus: initialFocusRef ?? 'first' });
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
  return (
    <Portal>
      <HotkeyScope blocking={modal}>
        {modal ? <Hotkeys map={{ Escape: () => requestClose() }} /> : null}
        <div className={cx('bx-drawer-layer', !modal && 'bx-drawer-layer--modeless')} data-bx-overlay="">
          {modal ? <div className="bx-modal-backdrop" aria-hidden="true" onMouseDown={requestClose} /> : null}
          <div
            ref={merged}
            role="dialog"
            aria-modal={modal ? 'true' : undefined}
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            className={cx('bx-drawer', `bx-drawer--${size}`, className)}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <header className="bx-drawer__header">
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
              {dismissible ? <IconButton icon="close" aria-label="Close" tooltip={false} onClick={requestClose} data-enter-skip="" /> : null}
            </header>
            <div className="bx-drawer__body">{children}</div>
            {footer ? <footer className="bx-drawer__footer">{footer}</footer> : null}
          </div>
        </div>
      </HotkeyScope>
    </Portal>
  );
}
