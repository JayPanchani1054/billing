import type { ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { Kbd } from './Kbd.tsx';
import { Spinner } from './Spinner.tsx';
import { cx } from './lib/cx.ts';
import { formatDate } from '../../shared/dates.ts';

export interface ReportPeriod {
  from: string;
  to: string;
}

export interface ReportFrameProps {
  title: ReactNode;
  /** e.g. "Ledger: HDFC Bank" or "Detailed". */
  subtitle?: ReactNode;
  /** Accepted but not shown on screen (2.1: the top bar names the company; print/export take it from TableExportDef). */
  companyName?: ReactNode;
  /** ISO range (rendered "1-Apr-2026 to 31-Mar-2027") or custom node. */
  period?: ReportPeriod | ReactNode;
  /** Opens the period dialog (also bind Alt+F2 via the ActionRail). */
  onPeriodClick?: () => void;
  breadcrumbs?: ReactNode;
  /** Left toolbar slot (filters, view toggles). */
  filters?: ReactNode;
  /** Right toolbar slot (export, print, column chooser). */
  actions?: ReactNode;
  /** Body — usually a DataTable that fills the remaining height. */
  children: ReactNode;
  /** Below the body (notes, legends, "as of" stamps). */
  footer?: ReactNode;
  /** Right-hand ActionRail. */
  rail?: ReactNode;
  /** Refetching: body dims (previous data stays) and a spinner shows — no layout jump. */
  refreshing?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function isPeriod(p: unknown): p is ReportPeriod {
  return typeof p === 'object' && p !== null && 'from' in p && 'to' in p && typeof (p as ReportPeriod).from === 'string';
}

/**
 * Standard report layout: title + period header, toolbar (filters left, export/print
 * right), a body that fills the height for the DataTable, a footer, and an optional ActionRail.
 * Prints cleanly (toolbar/rail hidden, header kept).
 */
export function ReportFrame({ title, subtitle, period, onPeriodClick, breadcrumbs, filters, actions, children, footer, rail, refreshing = false, className, ref }: ReportFrameProps) {
  const periodNode = isPeriod(period) ? (
    <>
      {formatDate(period.from, 'D-MMM-YY')} <span className="bx-report__period-to">to</span> {formatDate(period.to, 'D-MMM-YY')}
    </>
  ) : (
    period
  );
  return (
    <div ref={ref} className={cx('bx-report', rail ? 'bx-report--with-rail' : undefined, className)}>
      <div className="bx-report__main">
        {breadcrumbs ? <div className="bx-report__crumbs">{breadcrumbs}</div> : null}
        <header className="bx-report__header">
          <div className="bx-report__titles">
            <h1 className="bx-report__title">{title}</h1>
            {subtitle ? <p className="bx-report__subtitle">{subtitle}</p> : null}
          </div>
          {period ? (
            onPeriodClick ? (
              <button type="button" className="bx-report__period" onClick={onPeriodClick} aria-keyshortcuts="Alt+F2">
                <Icon name="calendar" size="sm" />
                <span className="bx-num">{periodNode}</span>
                <Kbd keys="Alt+F2" size="sm" tone="subtle" aria-hidden="true" />
              </button>
            ) : (
              <p className="bx-report__period bx-report__period--static">
                <Icon name="calendar" size="sm" />
                <span className="bx-num">{periodNode}</span>
              </p>
            )
          ) : null}
        </header>
        {filters || actions ? (
          <div className="bx-report__toolbar" role="group" aria-label="Report options">
            <div className="bx-report__filters">{filters}</div>
            <div className="bx-report__actions">
              {refreshing ? <Spinner size="sm" label="Refreshing" /> : null}
              {actions}
            </div>
          </div>
        ) : null}
        <div className={cx('bx-report__body', refreshing && 'is-refreshing')} aria-busy={refreshing || undefined}>
          {children}
        </div>
        {footer ? <footer className="bx-report__footer">{footer}</footer> : null}
      </div>
      {rail ? <div className="bx-report__rail">{rail}</div> : null}
    </div>
  );
}
