import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { IconName } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Accepted for compatibility; 2.1 empty states draw no icon disc. */
  icon?: IconName;
  /** What is empty, plainly: "No vouchers in this period". */
  title: ReactNode;
  /** Why / what to do next: "Change the period with Alt+F2 or create a voucher with F8." */
  body?: ReactNode;
  /** Up to two next steps (Buttons; drawn as links). */
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  ref?: Ref<HTMLDivElement>;
}

/**
 * Calm placeholder for empty lists, reports and first-run screens. 2.1 (D33): one 13/600 line, an
 * optional muted sentence and ≤ 2 link actions, left-aligned — no icon disc, no box.
 */
export function EmptyState({ icon: _icon, title, body, action, size = 'md', className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx('bx-empty', `bx-empty--${size}`, className)} {...rest}>
      <p className="bx-empty__title">{title}</p>
      {body ? <p className="bx-empty__body">{body}</p> : null}
      {action ? <div className="bx-empty__action">{action}</div> : null}
    </div>
  );
}
