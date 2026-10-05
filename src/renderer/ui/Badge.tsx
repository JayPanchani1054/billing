import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './lib/cx.ts';
import type { Tone } from './types.ts';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** 'subtle' (default) tinted fill · 'solid' strong fill · 'outline' border only. */
  variant?: 'subtle' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  icon?: IconName;
  /** Leading status dot (pair with text — colour is never the only signal). */
  dot?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}

/** Small status label: "Cancelled", "Optional", "Post-dated", "GST", counts. */
export function Badge({ tone = 'neutral', variant = 'subtle', size = 'md', icon, dot, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('bx-badge', `bx-badge--${tone}`, `bx-badge--${variant}`, `bx-badge--${size}`, className)} {...rest}>
      {dot ? <span className="bx-badge__dot" aria-hidden="true" /> : null}
      {icon ? <Icon name={icon} size="xs" /> : null}
      {children}
    </span>
  );
}

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  icon?: IconName;
  /** Shows a remove button. */
  onRemove?: () => void;
  /** Accessible name for the remove button (default "Remove <text>"). */
  removeLabel?: string;
  disabled?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}

/** Removable chip (applied filters, selected cost centres…). Backspace/Delete on the remove button removes. */
export function Tag({ tone = 'neutral', icon, onRemove, removeLabel, disabled, className, children, ...rest }: TagProps) {
  const text = typeof children === 'string' ? children : '';
  return (
    <span className={cx('bx-tag', `bx-tag--${tone}`, disabled && 'is-disabled', className)} {...rest}>
      {icon ? <Icon name={icon} size="xs" /> : null}
      <span className="bx-tag__label">{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="bx-tag__remove"
          aria-label={removeLabel ?? (text ? `Remove ${text}` : 'Remove')}
          disabled={disabled}
          onClick={onRemove}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              onRemove();
            }
          }}
        >
          <Icon name="close" size="xs" />
        </button>
      ) : null}
    </span>
  );
}
