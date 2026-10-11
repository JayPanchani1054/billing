import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header-right content (buttons, menus, badges). */
  actions?: ReactNode;
  footer?: ReactNode;
  /** 'md' (default), 'sm' or 'none' body padding. */
  padding?: 'none' | 'sm' | 'md';
  /** Accepted for compatibility; 2.1 cards are always flat (D6). */
  elevated?: boolean;
  /** Heading level for the title (default 3). */
  headingLevel?: 2 | 3 | 4;
  as?: 'section' | 'article' | 'div';
  ref?: Ref<HTMLElement>;
}

/**
 * A titled section with optional header actions and footer. 2.1 (D6): flat — no border, radius, fill
 * or horizontal padding; the 14/600 title and the space around it do the separating.
 */
export function Card({ title, subtitle, actions, footer, padding = 'md', elevated: _elevated, headingLevel = 3, as = 'section', className, children, ref, ...rest }: CardProps) {
  const Tag = as as 'section';
  const H = `h${headingLevel}` as 'h3';
  return (
    <Tag ref={ref} className={cx('bx-card', className)} {...rest}>
      {title || actions ? (
        <header className="bx-card__header">
          <div className="bx-card__titles">
            {title ? <H className="bx-card__title">{title}</H> : null}
            {subtitle ? <p className="bx-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="bx-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('bx-card__body', `bx-card__body--${padding}`)}>{children}</div>
      {footer ? <footer className="bx-card__footer">{footer}</footer> : null}
    </Tag>
  );
}
