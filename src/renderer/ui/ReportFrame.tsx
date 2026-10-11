import type { ReactNode, Ref } from 'react';
import { PageHeader } from './PageHeader.tsx';
import { cx } from './lib/cx.ts';
import { formatDate } from '../../shared/dates.ts';

export interface ReportPeriod {
  from: string;
  to: string;
}

export interface ReportFrameProps {
  title: ReactNode;
  /** e.g. "Ledger: HDFC Bank" or "Detailed" — words of the title row's context run, after the period. */
  subtitle?: ReactNode;
  /** Accepted but not shown on screen (2.1: the top bar names the company; print/export take it from TableExportDef). */
  companyName?: ReactNode;
  /** ISO range (rendered "1-Apr-26 – 10-Oct-26") or custom node: the period token of the context run. */
  period?: ReportPeriod | ReactNode;
  /** Opens the period dialog (also bind Alt+F2 as a screen action): the token becomes a quiet button. */
  onPeriodClick?: () => void;
  /** Replaces the period token (e.g. the Day Book's dates). */
  context?: ReactNode;
  /** The one state word of the context run ("Net loss ₹3,43,160.32", "Cancelled") — PageHeader's `meta`. */
  meta?: ReactNode;
  breadcrumbs?: ReactNode;
  /** Toolbar row, left: view tabs, one search, one filter. */
  filters?: ReactNode;
  /** Toolbar row, right, before the stat (rare extra controls). */
  actions?: ReactNode;
  /** Toolbar row, right: the report's answer in words (a StatLine) — never the table's total. */
  stat?: ReactNode;
  /** The graph strip (app/graphStrip.tsx), drawn above the table inside the body. */
  graph?: ReactNode;
  /** `data-graphs` on the body: 'off' hides the table's inline bars with the folded strip. */
  graphs?: 'on' | 'off';
  /** Body — usually a DataTable, sized to its content (it scrolls inside itself when taller than the window). */
  children: ReactNode;
  /** Below the body (one-line notes). */
  footer?: ReactNode;
  /** Right-hand ActionRail. */
  rail?: ReactNode;
  /** Refetching: the body dims to 0.6 and keeps the previous data — no spinner, no layout jump. */
  refreshing?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function isPeriod(p: unknown): p is ReportPeriod {
  return typeof p === 'object' && p !== null && 'from' in p && 'to' in p && typeof (p as ReportPeriod).from === 'string';
}

/** "1-Apr-26 – 10-Oct-26". */
export function formatReportPeriod(p: ReportPeriod): string {
  return `${formatDate(p.from, 'D-MMM-YY')} – ${formatDate(p.to, 'D-MMM-YY')}`;
}

/**
 * The 2.1 report template (SPEC-21 D24): the title row (PageHeader: h1 · context run = period token,
 * subtitle · one state word; the shell puts the command bar in its actions slot), an optional toolbar
 * row (filters left, stat right), then the body: the graph strip and the table. No company name, no
 * in-page Export / Print (they are title-row actions), no spinner. Prints the title and the table only.
 */
export function ReportFrame({
  title,
  subtitle,
  period,
  onPeriodClick,
  context,
  meta,
  breadcrumbs,
  filters,
  actions,
  stat,
  graph,
  graphs,
  children,
  footer,
  rail,
  refreshing = false,
  className,
  ref,
}: ReportFrameProps) {
  const text = isPeriod(period) ? formatReportPeriod(period) : period;
  const token =
    context ??
    (period ? (
      onPeriodClick ? (
        <button type="button" className="bx-report__token" onClick={onPeriodClick} title="Change period · Alt+F2" aria-keyshortcuts="Alt+F2">
          {text}
        </button>
      ) : (
        <span className="bx-report__token">{text}</span>
      )
    ) : null);
  const run =
    token && subtitle ? (
      <>
        {token}
        <span aria-hidden="true"> · </span>
        {subtitle}
      </>
    ) : (
      (token ?? subtitle)
    );
  return (
    <div ref={ref} className={cx('bx-report', rail ? 'bx-report--with-rail' : undefined, className)}>
      <div className="bx-report__main">
        {breadcrumbs ? <div className="bx-report__crumbs">{breadcrumbs}</div> : null}
        <PageHeader title={title} subtitle={run ?? undefined} meta={meta} />
        {filters || actions || stat ? (
          <div className="bx-report__toolbar" role="group" aria-label="Report options">
            <div className="bx-report__filters">{filters}</div>
            {actions || stat ? (
              <div className="bx-report__stat">
                {actions}
                {stat}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={cx('bx-report__body', refreshing && 'is-refreshing')} data-graphs={graphs} aria-busy={refreshing || undefined}>
          {graph}
          {children}
        </div>
        {footer ? <footer className="bx-report__footer">{footer}</footer> : null}
      </div>
      {rail ? <div className="bx-report__rail">{rail}</div> : null}
    </div>
  );
}
