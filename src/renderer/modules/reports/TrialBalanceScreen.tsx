/**
 * 'reports.trialBalance' — Tally Trial Balance. Groups / Detailed (Alt+F1) / Ledger-wise (Alt+L),
 * opening column (Alt+O), transactions columns (Alt+T), zero balances (Alt+Z). Enter drills a group
 * into its Group Summary, a ledger into Ledger Vouchers, the opening stock into the Stock Summary.
 */
import { useMemo, useState } from 'react';
import type { TbRow, TrialBalanceMode } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, formatDrCr, useApiQuery, useBooks } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, SegmentedControl, Stack } from '../../ui/index.ts';
import { TbTable, useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { drillForRow, tbExport } from './lib/model.ts';
import { visibleRows } from './lib/tree.ts';

export interface TrialBalanceParams {
  from?: string;
  to?: string;
  mode?: TrialBalanceMode;
}

const MODES: ReadonlyArray<{ value: TrialBalanceMode; label: string }> = [
  { value: 'groups', label: 'Groups' },
  { value: 'detailed', label: 'Detailed' },
  { value: 'ledgers', label: 'Ledger-wise' },
];

export function TrialBalanceScreen({ params }: ScreenProps<TrialBalanceParams>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const books = useBooks();
  const [mode, setMode] = useState<TrialBalanceMode>(params?.mode ?? 'groups');
  const [showOpening, setShowOpening] = useState(false);
  const [showTransactions, setShowTransactions] = useState(false);
  const [showZero, setShowZero] = useState(false);
  const q = useApiQuery('reports.trialBalance', { from: p.from, to: p.to, mode, showZero }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const expansion = useTreeExpansion(`tb:${mode}`, rows, mode === 'detailed' ? 99 : 0);

  const activate = (r: TbRow): void => drill(drillForRow(r, p.period));
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: mode === 'detailed' ? 'Condensed' : 'Detailed', icon: 'layers', onClick: () => setMode(mode === 'detailed' ? 'groups' : 'detailed'), group: 'view' },
    { key: 'Alt+L', label: mode === 'ledgers' ? 'Group-wise' : 'Ledger-wise', icon: 'list', onClick: () => setMode(mode === 'ledgers' ? 'groups' : 'ledgers'), group: 'view' },
    { key: 'Alt+O', label: showOpening ? 'Hide opening' : 'Show opening', icon: 'columns', onClick: () => setShowOpening(!showOpening), group: 'view' },
    { key: 'Alt+T', label: showTransactions ? 'Hide transactions' : 'Show transactions', icon: 'columns', onClick: () => setShowTransactions(!showTransactions), group: 'view' },
    { key: 'Alt+Z', label: showZero ? 'Hide zero balances' : 'Show zero balances', icon: 'eye', onClick: () => setShowZero(!showZero), group: 'view' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.allOpen ? expansion.collapseAll : expansion.expandAll, disabled: mode === 'ledgers', group: 'view' },
  ];
  const d = q.data;
  return (
    <ReportScreen
      title="Trial Balance"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Drill down · →/← Expand/collapse · Alt+F1 Detailed · Alt+O Opening · Alt+T Transactions"
      filters={<SegmentedControl aria-label="Trial Balance view" size="sm" options={MODES} value={mode} onChange={setMode} />}
      exportDef={() => ({
        subtitle: MODES.find((m) => m.value === mode)?.label,
        ...tbExport(visibleRows(rows, expansion.expandedKeys), { opening: showOpening, transactions: showTransactions }),
        notes: d && d.openingDifference !== 0 ? `Difference in opening balances: ${formatDrCr(d.openingDifference)}` : undefined,
      })}
    >
      <Stack gap={3} grow>
        {d && d.openingDifference !== 0 ? (
          <Banner tone="warning" title="Opening balances do not agree">
            Ledger opening balances{d.inventoryIntegrated ? ' and opening stock' : ''} differ by {formatDrCr(-d.openingDifference)}. The difference is shown as its own line so the totals agree — correct the opening balances in the ledgers to clear it.
          </Banner>
        ) : null}
        {d && !d.balanced ? (
          <Banner tone="danger" title="The Trial Balance does not agree">
            Debit and credit totals differ by {formatDrCr(d.unbalancedBy)}. Some stored entries may be damaged — restore a backup or contact support.
          </Banner>
        ) : null}
        <TbTable
          aria-label="Trial Balance"
          rows={rows}
          expansion={expansion}
          showOpening={showOpening}
          showTransactions={showTransactions}
          onActivate={activate}
          loading={q.loading}
        />
        {d && d.yearStart > books.booksFrom ? (
          <p className="bx-rep-note">
            Income and expense ledgers start from {formatDate(d.yearStart)}; the profit of earlier years is in the Profit &amp; Loss A/c.
          </p>
        ) : null}
      </Stack>
    </ReportScreen>
  );
}
