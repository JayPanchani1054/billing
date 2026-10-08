/**
 * 'reports.monthlySummary' {ledgerId? | groupId?, from?, to?} — month-wise debit, credit and closing
 * balance of a ledger or group. Enter on a month opens that month's ledger vouchers (or the group's
 * summary for the month).
 */
import { useMemo } from 'react';
import type { MonthRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { monthLabel } from './lib/model.ts';

export interface MonthlySummaryParams {
  ledgerId?: number;
  groupId?: number;
  from?: string;
  to?: string;
}

export function MonthlySummaryScreen({ params }: ScreenProps<MonthlySummaryParams>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const ledgerId = typeof params?.ledgerId === 'number' ? params.ledgerId : undefined;
  const groupId = ledgerId === undefined && typeof params?.groupId === 'number' ? params.groupId : undefined;
  const has = ledgerId !== undefined || groupId !== undefined;
  const q = useApiQuery('reports.monthlySummary', { ledgerId, groupId, from: p.from, to: p.to }, { keepPrevious: true, enabled: has });
  const d = q.data;
  const columns = useMemo<Column<MonthRow>[]>(
    () => [
      { key: 'month', header: 'Month', minWidth: 160, render: (r) => monthLabel(r.month), value: (r) => monthLabel(r.month) },
      { key: 'count', header: 'Vouchers', kind: 'number', width: 110 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 160, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 160, blankZero: true },
      { key: 'closing', header: 'Closing Balance', kind: 'drcr', width: 180 },
    ],
    [],
  );
  const footer: FooterRow[] = d
    ? [
        { key: 'opening', tone: 'subtle', cells: { month: 'Opening Balance', closing: d.opening } },
        { key: 'total', tone: 'total', cells: { month: 'Grand Total', debit: d.totals.debit, credit: d.totals.credit, closing: d.closing } },
      ]
    : [];
  const open = (r: MonthRow): void => {
    if (ledgerId !== undefined) drill({ screen: 'reports.ledger', params: { ledgerId, from: r.from, to: r.to } });
    else if (groupId !== undefined) drill({ screen: 'reports.groupSummary', params: { groupId, from: r.from, to: r.to } });
  };
  return (
    <ReportScreen
      title={d ? `${d.subject.name} — Monthly Summary` : 'Monthly Summary'}
      period={p.period}
      loading={has && q.loading}
      refreshing={q.refreshing}
      error={has ? q.error : null}
      onRetry={q.refetch}
      hint="Enter Vouchers of the month"
      exportDef={() => ({
        columns: [{ header: 'Month' }, { header: 'Vouchers', kind: 'number' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }, { header: 'Closing Balance', kind: 'drcr' }],
        rows: d ? [['Opening Balance', null, null, null, d.opening], ...d.rows.map((r) => [monthLabel(r.month), r.count, r.debit || null, r.credit || null, r.closing])] : [],
        totals: d ? ['Grand Total', null, d.totals.debit, d.totals.credit, d.closing] : undefined,
      })}
    >
      {has ? (
        <DataTable<MonthRow>
          aria-label="Monthly summary"
          className="bx-rep-fill"
          columns={columns}
          rows={d?.rows ?? []}
          getRowKey={(r) => r.month}
          onRowActivate={open}
          footerRows={footer}
          loading={q.loading}
          autoFocus
        />
      ) : (
        <EmptyState icon="calendar" title="Choose a ledger or group" body="Open the monthly summary from a ledger (Alt+M) or a group summary (Alt+M)." />
      )}
    </ReportScreen>
  );
}
