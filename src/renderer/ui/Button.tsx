import { isValidElement } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, MouseEvent as ReactMouseEvent, ReactElement, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Kbd } from './Kbd.tsx';
import { Spinner } from './Spinner.tsx';
import { keyTip } from './lib/keyText.ts';
import { cx } from './lib/cx.ts';
import { toAriaKeyShortcut } from './lib/hotkeys.ts';
import type { ControlSize } from './types.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Shows a spinner, keeps width, sets aria-busy and ignores clicks (focus is kept). */
  loading?: boolean;
  /** Leading icon (name or element). */
  icon?: IconName | ReactElement;
  /** Trailing icon (e.g. 'chevron-down' for menus). */
  iconRight?: IconName | ReactElement;
  /**
   * The button's key, e.g. 'Ctrl+A' (register it with useHotkeys). 2.1 (D4): not printed at rest —
   * it is in `aria-keyshortcuts`, in the default tooltip ("Save · Ctrl+A", when the label is text and no
   * `title` is given), and shown as plain text on :focus-visible and while Ctrl is held (html[data-keys]).
   */
  shortcut?: string;
  fullWidth?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function renderIcon(icon: IconName | ReactElement | undefined, size: 'sm' | 'md' = 'md', className?: string): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return <Icon name={icon as IconName} size={size} className={className} />;
}

function ariaShortcut(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    return toAriaKeyShortcut(s);
  } catch {
    return undefined;
  }
}

/** Button. Default `type="button"` (never submits by accident). */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  shortcut,
  fullWidth = false,
  className,
  children,
  type = 'button',
  onClick,
  title,
  ref,
  ...rest
}: ButtonProps) {
  const hasLabel = children !== undefined && children !== null && children !== false && children !== '';
  const handleClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (loading || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true') {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'bx-btn',
        `bx-btn--${variant}`,
        `bx-btn--${size}`,
        fullWidth && 'bx-btn--block',
        !hasLabel && 'bx-btn--icon-only',
        loading && 'is-loading',
        className,
      )}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      aria-keyshortcuts={ariaShortcut(shortcut)}
      title={title ?? (shortcut && typeof children === 'string' ? keyTip(children, shortcut) : undefined)}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size="xs" decorative className="bx-btn__spinner" /> : null}
      {renderIcon(icon, size === 'sm' ? 'sm' : 'md', 'bx-btn__icon')}
      {hasLabel ? <span className="bx-btn__label">{children}</span> : null}
      {renderIcon(iconRight, size === 'sm' ? 'sm' : 'md', 'bx-btn__icon')}
      {shortcut ? (
        <Kbd keys={shortcut} tone="subtle" className="bx-btn__kbd" aria-hidden="true" />
      ) : null}
    </button>
  );
}

export interface ButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Accepted for compatibility; 2.1 groups are always spaced (no joined, segmented look). */
  attached?: boolean;
  'aria-label'?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Groups related buttons (role="group"). */
export function ButtonGroup({ attached: _attached, className, children, ...rest }: ButtonGroupProps) {
  return (
    <div role="group" className={cx('bx-btn-group', className)} {...rest}>
      {children}
    </div>
  );
}
