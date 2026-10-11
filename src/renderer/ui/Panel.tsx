import { useId, useState } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Header-right actions. */
  actions?: ReactNode;
  /** Header can collapse the body (button with aria-expanded). */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** Body padding (default true). */
  padded?: boolean;
  /** Heading level (default 2). */
  headingLevel?: 2 | 3 | 4;
  ref?: Ref<HTMLElement>;
}

/** Titled section of a screen ("Statutory details", "Bill-wise details"). 2.1: flat (no border or fill), title 14/600. */
export function Panel({ title, description, actions, collapsible = false, defaultCollapsed = false, padded = true, headingLevel = 2, className, children, ref, ...rest }: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();
  const titleId = useId();
  const H = `h${headingLevel}` as 'h2';
  return (
    <section ref={ref} aria-labelledby={titleId} className={cx('bx-panel', collapsed && 'is-collapsed', className)} {...rest}>
      <header className="bx-panel__header">
        <div className="bx-panel__titles">
          <H id={titleId} className="bx-panel__title">
            {collapsible ? (
              <button type="button" className="bx-panel__toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed((c) => !c)}>
                <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
                {title}
              </button>
            ) : (
              title
            )}
          </H>
          {description ? <p className="bx-panel__description">{description}</p> : null}
        </div>
        {actions ? <div className="bx-panel__actions">{actions}</div> : null}
      </header>
      <div id={bodyId} className={cx('bx-panel__body', padded && 'bx-panel__body--padded')} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
