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
  /** Raised (shadow) vs flat (border only, default). */
  elevated?: boolean;
  /** Heading level for the title (default 3). */
  headingLevel?: 2 | 3 | 4;
  as?: 'section' | 'article' | 'div';
  ref?: Ref<HTMLElement>;
}

/** Surface container with optional header and footer. */
export function Card({ title, subtitle, actions, footer, padding = 'md', elevated = false, headingLevel = 3, as = 'section', className, children, ref, ...rest }: CardProps) {
  const Tag = as as 'section';
  const H = `h${headingLevel}` as 'h3';
  return (
    <Tag ref={ref} className={cx('bx-card', elevated && 'bx-card--elevated', className)} {...rest}>
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
