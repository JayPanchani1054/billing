import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { IconButton } from './IconButton.tsx';
import { cx } from './lib/cx.ts';
import type { StatusTone } from './types.ts';

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: StatusTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Action(s) at the end (Buttons, links). */
  action?: ReactNode;
  onDismiss?: () => void;
  /** Override the tone icon (or `false` for none). */
  icon?: IconName | false;
  /** Compact single-line variant for inside panels/forms. */
  inline?: boolean;
  ref?: Ref<HTMLDivElement>;
}

const ICON: Readonly<Record<StatusTone, IconName>> = { info: 'info', success: 'check-circle', warning: 'alert', danger: 'x-circle' };

/**
 * Persistent message: info/success/warning/danger. Danger and warning are announced (role=alert /
 * status). Copy: say what happened, then what to do.
 */
export function Banner({ tone = 'info', title, children, action, onDismiss, icon, inline = false, className, ...rest }: BannerProps) {
  const iconName = icon === false ? null : icon ?? ICON[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('bx-banner', `bx-banner--${tone}`, inline && 'bx-banner--inline', className)}
      {...rest}
    >
      {iconName ? (
        <span className="bx-banner__icon" aria-hidden="true">
          <Icon name={iconName} size="md" />
        </span>
      ) : null}
      <div className="bx-banner__content">
        {title ? <p className="bx-banner__title">{title}</p> : null}
        {children ? <div className="bx-banner__body">{children}</div> : null}
      </div>
      {action ? <div className="bx-banner__action">{action}</div> : null}
      {onDismiss ? <IconButton icon="close" size="sm" aria-label="Dismiss" tooltip={false} className="bx-banner__close" onClick={onDismiss} /> : null}
    </div>
  );
}

/** Alias for documentation parity. */
export const Callout = Banner;
export type CalloutProps = BannerProps;
