import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  /** What is empty, plainly: "No vouchers in this period". */
  title: ReactNode;
  /** Why / what to do next: "Change the period with Alt+F2 or create a voucher with F8." */
  body?: ReactNode;
  /** Primary next step (a Button). */
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  ref?: Ref<HTMLDivElement>;
}

/** Calm placeholder for empty lists, reports and first-run screens. */
export function EmptyState({ icon = 'folder', title, body, action, size = 'md', className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx('bx-empty', `bx-empty--${size}`, className)} {...rest}>
      <span className="bx-empty__icon" aria-hidden="true">
        <Icon name={icon} size={size === 'sm' ? 'lg' : 'xl'} />
      </span>
      <p className="bx-empty__title">{title}</p>
      {body ? <p className="bx-empty__body">{body}</p> : null}
      {action ? <div className="bx-empty__action">{action}</div> : null}
    </div>
  );
}
