/**
 * 'reports.ratios' — Ratio Analysis: principal groups (left) and key ratios (right) with the
 * formula of each. Enter on a principal group opens its group summary. "—" means the ratio cannot be
 * worked out because its denominator is zero.
 */
import { useMemo } from 'react';
import type { RatioItem } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { drillForRow, ratioText } from './lib/model.ts';

export function RatiosScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.ratios', { from: p.from, to: p.to }, { keepPrevious: true });
  const d = q.data;
  const columns = useMemo<Column<RatioItem>[]>(
    () => [
      { key: 'label', header: 'Particulars', minWidth: 180, title: (r) => r.formula },
      {
        key: 'value',
        header: 'Value',
        width: 170,
        align: 'right',
        render: (r) => <span className="bx-num">{ratioText(r)}</span>,
        title: (r) => (r.value === null ? 'Not computable: the denominator is zero' : ratioText(r)),
      },
      { key: 'formula', header: 'How it is worked out', minWidth: 220, render: (r) => <span className="bx-rep-formula">{r.formula}</span> },
    ],
    [],
  );
  const open = (r: RatioItem): void => {
    if (r.groupId === null) return;
    // Sales / purchases are period figures (P&L basis); the other principal groups are balances.
    const basis = r.key === 'sales' || r.key === 'purchases' ? ('profitLoss' as const) : undefined;
    drill(drillForRow({ key: r.key, kind: 'group', id: r.groupId }, p.period, { basis }));
  };
  const table = (title: string, rows: readonly RatioItem[], autoFocus: boolean) => (
    <section className="bx-rep-side" aria-label={title}>
      <div className="bx-rep-side__title">{title}</div>
      <DataTable<RatioItem> aria-label={title} columns={columns} rows={rows} getRowKey={(r) => r.key} onRowActivate={open} loading={q.loading} virtualize={false} autoFocus={autoFocus} />
    </section>
  );
  return (
    <ReportScreen
      title="Ratio Analysis"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Group summary · Tab Ratios"
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Value' }, { header: 'Formula' }],
        rows: d ? [['Principal groups', '', ''], ...d.principal.map((r) => [r.label, ratioText(r), r.formula]), ['Principal ratios', '', ''], ...d.ratios.map((r) => [r.label, ratioText(r), r.formula])] : [],
      })}
    >
      {d ? (
        <div className="bx-rep-sides">
          {table('Principal Groups', d.principal, true)}
          {table('Principal Ratios', d.ratios, false)}
        </div>
      ) : (
        <EmptyState icon="calculator" title="No figures yet" body="Change the period with Alt+F2." />
      )}
    </ReportScreen>
  );
}
