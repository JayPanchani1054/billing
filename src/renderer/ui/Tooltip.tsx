import { cloneElement, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './lib/cx.ts';

/** Tooltip text for an action with a key (2.1, D4): "Print · Alt+P"; the label alone without one. */
export { keyTip } from './lib/keyText.ts';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link, input…). */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Link the tooltip as the child's description (aria-describedby). Default true; set false when the
   * tooltip only repeats the accessible name (icon buttons).
   */
  describeChild?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * CSS-positioned tooltip shown on hover and keyboard focus (after 400 ms, --dur-tooltip-delay), dismissible with
 * Esc (WCAG 1.4.13) without swallowing the key. Plain text content only — no interactive content.
 */
export function Tooltip({ content, children, placement = 'top', describeChild = true, disabled = false, className }: TooltipProps) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  if (disabled || content === null || content === undefined || content === '' || content === false) return children;
  const existing = children.props['aria-describedby'];
  const child = describeChild ? cloneElement(children, { 'aria-describedby': existing ? `${existing} ${id}` : id }) : children;
  return (
    <span
      className={cx('bx-tooltip-anchor', dismissed && 'is-dismissed', className)}
      data-placement={placement}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDismissed(true);
      }}
      onMouseLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {child}
      <span role="tooltip" id={id} className="bx-tooltip">
        {content}
      </span>
    </span>
  );
}
