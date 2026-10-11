/**
 * 'reports.cashBank' — Cash/Bank Book(s): Cash-in-Hand, Bank Accounts and Bank OD A/c with their
 * ledgers (opening, receipts, payments, closing). Enter opens a ledger's vouchers.
 *
 * 2.1: one "Closing" column; a ledger in credit says "overdrawn" in its cell (no banner, no stat). The
 * graph "Closing balance by account" (lib/charts.ts) is drawn as 4 px bars inside the table when there
 * are 3–7 accounts, as a Top 6 + Other strip with more, and not at all with fewer than 3.
 */
import { useMemo } from 'react';
import type { TbRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { EmptyState } from '../../ui/index.ts';
import { TbTable, useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { cashBankBarRows, cashBankChart } from './lib/charts.ts';
import { drillForRow, tbExport } from './lib/model.ts';
import { visibleRows } from './lib/tree.ts';

/** The inline bar's value: each ledger's closing (groups carry none). */
const ledgerClosing = (r: TbRow): number | null => (r.kind === 'ledger' ? r.closing : null);

export function CashBankScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.cashBank', { from: p.from, to: p.to }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const expansion = useTreeExpansion('cashBank', rows, 1);
  const spec = useMemo(() => cashBankChart(q.data), [q.data]);
  const inline = inlineBars(spec, cashBankBarRows(q.data));
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
      graph={reportGraph(spec, { inline })}
      hint="Enter Ledger vouchers · →/← Expand/collapse · Alt+F Cash flow"
      exportDef={() => tbExport(visibleRows(rows, expansion.expandedKeys), { opening: true, transactions: true })}
    >
      <TbTable
        aria-label="Cash and bank books"
        rows={rows}
        expansion={expansion}
        showOpening
        showTransactions
        closing={{ bar: inline ? { value: ledgerClosing, slot: 'polarity' } : null, overdrawn: true }}
        onActivate={(r: TbRow) => drill(drillForRow(r, p.period))}
        loading={q.loading}
        totalLabel="Total"
        empty={<EmptyState icon="bank" title="No cash or bank accounts yet" body="Create a ledger under Bank Accounts (Gateway › Ledgers) to see its book here." />}
      />
    </ReportScreen>
  );
}
