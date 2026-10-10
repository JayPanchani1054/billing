/**
 * Layout for the screens shown before a company is open (data folder, company list, login,
 * forced password change): brand header, one focused card, quiet footer.
 */
import type { ReactNode } from 'react';
import { Icon } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';

export interface GateLayoutProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 'narrow' (login), 'medium' (setup), 'wide' (company list, wizard). */
  width?: 'narrow' | 'medium' | 'wide';
  /** Right side of the brand bar (e.g. data folder, version). */
  aside?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  titleId?: string;
}

export function GateLayout({ title, subtitle, width = 'medium', aside, footer, children, titleId = 'gate-title' }: GateLayoutProps) {
  return (
    <div className="bx-gate">
      <header className="bx-gate__bar">
        <span className="bx-gate__brand">
          <span className="bx-gate__mark" aria-hidden="true">
            <Icon name="book" size="md" />
          </span>
          <span className="bx-gate__wordmark">Pevqori</span>
        </span>
        {aside ? <span className="bx-gate__aside">{aside}</span> : null}
      </header>
      <main className={cx('bx-gate__main', `bx-gate__main--${width}`)} aria-labelledby={titleId}>
        <div className="bx-gate__card">
          <div className="bx-gate__heading">
            <h1 id={titleId} className="bx-gate__title">
              {title}
            </h1>
            {subtitle ? <p className="bx-gate__subtitle">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </main>
      {footer ? <footer className="bx-gate__footer">{footer}</footer> : null}
    </div>
  );
}
