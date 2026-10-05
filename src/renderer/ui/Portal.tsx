import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export interface PortalProps {
  children?: ReactNode;
  /** Defaults to document.body. Overlays append in open order, which the kit relies on for stacking. */
  container?: Element | null;
}

/** Render children into document.body (overlays: dialogs, popovers, toasts). */
export function Portal({ children, container }: PortalProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, container ?? document.body);
}
