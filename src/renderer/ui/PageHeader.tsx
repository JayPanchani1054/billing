import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Slot above the title (usually <Breadcrumbs>). */
  breadcrumbs?: ReactNode;
  /** Right-aligned actions (Buttons, DropdownMenu). */
  actions?: ReactNode;
  /** Inline metadata after the title (badges like "Cancelled", "Optional"). */
  meta?: ReactNode;
  icon?: IconName;
  ref?: Ref<HTMLElement>;
}

/** Screen header: breadcrumbs, h1 title + meta, subtitle, actions. One per screen. */
export function PageHeader({ title, subtitle, breadcrumbs, actions, meta, icon, className, ref, ...rest }: PageHeaderProps) {
  return (
    <header ref={ref} className={cx('bx-page-header', className)} {...rest}>
      {breadcrumbs ? <div className="bx-page-header__crumbs">{breadcrumbs}</div> : null}
      <div className="bx-page-header__row">
        <div className="bx-page-header__titles">
          <div className="bx-page-header__title-row">
            {icon ? (
              <span className="bx-page-header__icon" aria-hidden="true">
                <Icon name={icon} size="lg" />
              </span>
            ) : null}
            <h1 className="bx-page-header__title">{title}</h1>
            {meta ? <div className="bx-page-header__meta">{meta}</div> : null}
          </div>
          {subtitle ? <p className="bx-page-header__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="bx-page-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
