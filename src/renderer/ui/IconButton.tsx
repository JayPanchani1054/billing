import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Spinner } from './Spinner.tsx';
import { Tooltip } from './Tooltip.tsx';
import { cx } from './lib/cx.ts';
import { toAriaKeyShortcut } from './lib/hotkeys.ts';
import type { ControlSize } from './types.ts';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: IconName;
  /** Required accessible name (also the default tooltip text). */
  'aria-label': string;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
  size?: ControlSize;
  /** Tooltip: true (default) shows the aria-label; a node shows custom text; false disables. */
  tooltip?: boolean | ReactNode;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  shortcut?: string;
  loading?: boolean;
  /** Toggle buttons: sets aria-pressed. */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Square icon-only button. `aria-label` is mandatory. */
export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  tooltip = true,
  tooltipPlacement = 'top',
  shortcut,
  loading = false,
  pressed,
  className,
  type = 'button',
  onClick,
  ref,
  ...rest
}: IconButtonProps) {
  const label = rest['aria-label'];
  let aria: string | undefined;
  try {
    aria = shortcut ? toAriaKeyShortcut(shortcut) : undefined;
  } catch {
    aria = undefined;
  }
  const button = (
    <button
      ref={ref}
      type={type}
      className={cx('bx-icon-btn', `bx-icon-btn--${variant}`, `bx-icon-btn--${size}`, loading && 'is-loading', className)}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      aria-keyshortcuts={aria}
      onClick={(e) => {
        if (loading) return;
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <Spinner size="xs" decorative /> : <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} />}
    </button>
  );
  if (tooltip === false) return button;
  const content = tooltip === true ? (shortcut ? `${label} (${shortcut})` : label) : tooltip;
  return (
    <Tooltip content={content} placement={tooltipPlacement} describeChild={tooltip !== true}>
      {button}
    </Tooltip>
  );
}
