/**
 * 'reports.cashFlow' — month-wise inflow / outflow / net flow of cash and bank (contra transfers are
 * not flows) with the group-wise breakup of where money came from and went. Enter on a month shows
 * that month; Enter on a group opens its summary.
 *
 * 'reports.fundsFlow' — sources and applications of funds between the start and end of the period
 * and the resulting change in working capital (with the working-capital breakup).
 */
import { useMemo } from 'react';
import type { CashFlowGroupRow, CashFlowMonth, FundsFlowLine, WorkingCapitalRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Banner, DataTable, EmptyState, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { monthLabel, statementAmountText } from './lib/model.ts';

const signed = (v: number): string => statementAmountText(v);

export function CashFlowScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.cashFlow', { from: p.from, to: p.to }, { keepPrevious: true });
  const d = q.data;
  const monthColumns = useMemo<Column<CashFlowMonth>[]>(
    () => [
      { key: 'month', header: 'Month', minWidth: 150, render: (r) => monthLabel(r.month), value: (r) => monthLabel(r.month) },
      { key: 'inflow', header: 'Inflow', kind: 'amount', width: 170, blankZero: true },
      { key: 'outflow', header: 'Outflow', kind: 'amount', width: 170, blankZero: true },
      { key: 'net', header: 'Net flow', kind: 'amount', width: 170, render: (r) => signed(r.net) },
    ],
    [],
  );
  const groupColumns = useMemo<Column<CashFlowGroupRow>[]>(
    () => [
      { key: 'groupName', header: 'Particulars', minWidth: 200 },
      { key: 'inflow', header: 'Inflow', kind: 'amount', width: 170, blankZero: true },
      { key: 'outflow', header: 'Outflow', kind: 'amount', width: 170, blankZero: true },
      { key: 'net', header: 'Net flow', kind: 'amount', width: 170, render: (r) => signed(r.net) },
    ],
    [],
  );
  const footer: FooterRow[] = d
    ? [
        { key: 'opening', tone: 'subtle', cells: { month: 'Opening cash & bank', net: signed(d.opening) } },
        { key: 'total', tone: 'subtle', cells: { month: 'Total', inflow: d.totals.inflow, outflow: d.totals.outflow, net: signed(d.totals.net) } },
        { key: 'closing', tone: 'total', cells: { month: 'Closing cash & bank', net: signed(d.closing) } },
      ]
    : [];
  return (
    <ReportScreen
      title="Cash Flow"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter on a month: that month's breakup · Tab: group breakup · Enter on a group: its summary"
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Inflow', kind: 'amount' }, { header: 'Outflow', kind: 'amount' }, { header: 'Net flow', kind: 'amount' }],
        rows: d
          ? [
              ...d.months.map((m) => [monthLabel(m.month), m.inflow, m.outflow, m.net]),
              ['Group-wise breakup', null, null, null],
              ...d.groups.map((g) => [g.groupName, g.inflow, g.outflow, g.net]),
            ]
          : [],
        totals: d ? ['Total', d.totals.inflow, d.totals.outflow, d.totals.net] : undefined,
      })}
    >
      <Stack gap={3} grow>
        <DataTable<CashFlowMonth>
          aria-label="Cash flow by month"
          columns={monthColumns}
          rows={d?.months ?? []}
          getRowKey={(r) => r.month}
          onRowActivate={(r) => drill({ screen: 'reports.cashFlow', params: { from: r.from, to: r.to } })}
          footerRows={footer}
          loading={q.loading}
          virtualize={false}
          autoFocus
        />
        <DataTable<CashFlowGroupRow>
          aria-label="Cash flow by group"
          className="bx-rep-fill"
          columns={groupColumns}
          rows={d?.groups ?? []}
          getRowKey={(r) => String(r.groupId)}
          onRowActivate={(r) => drill({ screen: 'reports.groupSummary', params: { groupId: r.groupId, from: p.from, to: p.to } })}
          loading={q.loading}
          empty={<EmptyState icon="wallet" size="sm" title="No cash or bank movement in this period" body="Receipts and payments appear here. Change the period with Alt+F2." />}
        />
      </Stack>
    </ReportScreen>
  );
}

export function FundsFlowScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.fundsFlow', { from: p.from, to: p.to }, { keepPrevious: true });
  const d = q.data;
  const lineColumns = useMemo<Column<FundsFlowLine>[]>(
    () => [
      { key: 'label', header: 'Particulars', minWidth: 180 },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 160 },
    ],
    [],
  );
  const wcColumns = useMemo<Column<WorkingCapitalRow>[]>(
    () => [
      { key: 'label', header: 'Particulars', minWidth: 200 },
      { key: 'side', header: 'Type', width: 140, render: (r) => (r.side === 'asset' ? 'Current asset' : 'Current liability') },
      { key: 'opening', header: 'Opening', kind: 'amount', width: 160, render: (r) => signed(r.opening) },
      { key: 'closing', header: 'Closing', kind: 'amount', width: 160, render: (r) => signed(r.closing) },
      { key: 'increase', header: 'Increase in WC', kind: 'amount', width: 160, blankZero: true, value: (r) => (r.change > 0 ? r.change : 0) },
      { key: 'decrease', header: 'Decrease in WC', kind: 'amount', width: 160, blankZero: true, value: (r) => (r.change < 0 ? -r.change : 0) },
    ],
    [],
  );
  const openLine = (r: { groupId: number | null; ledgerId?: number | null }): void => {
    if (r.groupId !== null) drill({ screen: 'reports.groupSummary', params: { groupId: r.groupId, from: p.from, to: p.to } });
    else if (typeof r.ledgerId === 'number') drill({ screen: 'reports.ledger', params: { ledgerId: r.ledgerId, from: p.from, to: p.to } });
  };
  const side = (title: string, lines: readonly FundsFlowLine[], total: number, autoFocus: boolean) => (
    <section className="bx-rep-side" aria-label={title}>
      <div className="bx-rep-side__title">{title}</div>
      <DataTable<FundsFlowLine>
        aria-label={title}
        columns={lineColumns}
        rows={lines}
        getRowKey={(r) => r.key}
        onRowActivate={openLine}
        footerRows={[{ key: 'total', tone: 'total', cells: { label: 'Total', amount: total } }]}
        loading={q.loading}
        virtualize={false}
        empty={<EmptyState size="sm" icon="book" title="None in this period" />}
        autoFocus={autoFocus}
      />
    </section>
  );
  return (
    <ReportScreen
      title="Funds Flow"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Group summary or ledger · Tab Next table"
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Amount', kind: 'amount' }],
        rows: d
          ? [
              ['Sources of funds', null],
              ...d.sources.map((s) => [s.label, s.amount]),
              ['Total sources', d.totalSources],
              ['Application of funds', null],
              ...d.applications.map((s) => [s.label, s.amount]),
              ['Total applications', d.totalApplications],
              ['Working capital at the start', d.workingCapital.opening],
              ['Working capital at the end', d.workingCapital.closing],
              ['Working capital changes (increase + / decrease −)', null],
              ...d.workingCapitalRows.map((r) => [`${r.label} (${r.side === 'asset' ? 'current asset' : 'current liability'})`, r.change]),
            ]
          : [],
        totals: d ? ['Change in working capital', d.workingCapital.change] : undefined,
      })}
    >
      {d ? (
        <Stack gap={3} grow>
          {d.difference !== 0 ? (
            <Banner tone="danger" title="Funds flow does not agree">
              Sources less applications differ from the change in working capital by {statementAmountText(d.difference)}.
            </Banner>
          ) : null}
          <div className="bx-rep-sides">
            {side('Sources of Funds', d.sources, d.totalSources, true)}
            {side('Application of Funds', d.applications, d.totalApplications, false)}
          </div>
          <p className="bx-rep-note">
            Working capital {d.workingCapital.change >= 0 ? 'increased' : 'decreased'} by {statementAmountText(Math.abs(d.workingCapital.change))} (from{' '}
            {signed(d.workingCapital.opening)} to {signed(d.workingCapital.closing)}).
          </p>
          <DataTable<WorkingCapitalRow>
            aria-label="Working capital changes"
            className="bx-rep-fill"
            columns={wcColumns}
            rows={d.workingCapitalRows}
            getRowKey={(r) => r.key}
            onRowActivate={openLine}
            empty={<EmptyState size="sm" icon="book" title="No current assets or liabilities" />}
          />
        </Stack>
      ) : (
        <EmptyState icon="book" title="No funds flow yet" body="Change the period with Alt+F2." />
      )}
    </ReportScreen>
  );
}
