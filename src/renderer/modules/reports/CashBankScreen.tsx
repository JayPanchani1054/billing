/**
 * 'reports.cashBank' — Cash/Bank Book(s): Cash-in-Hand, Bank Accounts and Bank OD A/c with their
 * ledgers (opening, receipts, payments, closing). Enter opens a ledger's vouchers.
 */
import { useMemo } from 'react';
import type { TbRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { EmptyState } from '../../ui/index.ts';
import { TbTable, useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { drillForRow, tbExport } from './lib/model.ts';
import { visibleRows } from './lib/tree.ts';

export function CashBankScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.cashBank', { from: p.from, to: p.to }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const expansion = useTreeExpansion('cashBank', rows, 1);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.allOpen ? expansion.collapseAll : expansion.expandAll, group: 'view' },
    { key: 'Alt+F', label: 'Cash flow', icon: 'line-chart', onClick: () => drill({ screen: 'reports.cashFlow', params: { from: p.from, to: p.to } }), group: 'view' },
  ];
  return (
    <ReportScreen
      title="Cash/Bank Books"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Ledger vouchers · →/← Expand/collapse · Alt+F Cash flow"
      exportDef={() => tbExport(visibleRows(rows, expansion.expandedKeys), { opening: true, transactions: true })}
    >
      <TbTable
        aria-label="Cash and bank books"
        rows={rows}
        expansion={expansion}
        showOpening
        showTransactions
        onActivate={(r: TbRow) => drill(drillForRow(r, p.period))}
        loading={q.loading}
        totalLabel="Total"
        empty={<EmptyState icon="bank" title="No cash or bank accounts yet" body="Create a ledger under Bank Accounts (Gateway › Ledgers) to see its book here." />}
      />
    </ReportScreen>
  );
}
