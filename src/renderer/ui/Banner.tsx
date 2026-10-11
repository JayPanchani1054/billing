import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { IconName } from './Icon.tsx';
import { IconButton } from './IconButton.tsx';
import { cx } from './lib/cx.ts';
import type { StatusTone } from './types.ts';

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: StatusTone;
  /** Rendered verbatim, in 600, before the body on the same line (tests and users read these titles). */
  title?: ReactNode;
  children?: ReactNode;
  /** Action(s) at the end of the line (Buttons render as links). */
  action?: ReactNode;
  onDismiss?: () => void;
  /** Accepted for compatibility; 2.1 banners draw no icon (the tone fill and the words carry it). */
  icon?: IconName | false;
  /** Accepted for compatibility; every 2.1 banner is the compact one-line kind. */
  inline?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Persistent message: info/success/warning/danger. Danger and warning are announced (role=alert /
 * status). Copy: say what happened, then what to do. 2.1 (§2.3): one line by default — tone fill, no
 * border, no icon; the title inline before the body; a trailing action as a link. A body that is a
 * list wraps to more lines.
 */
export function Banner({ tone = 'info', title, children, action, onDismiss, icon: _icon, inline: _inline, className, ...rest }: BannerProps) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('bx-banner', `bx-banner--${tone}`, className)} {...rest}>
      <div className="bx-banner__content">
        {title ? <strong className="bx-banner__title">{title}</strong> : null}
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
