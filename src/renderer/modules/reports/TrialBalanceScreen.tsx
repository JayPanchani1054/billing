/**
 * 'reports.trialBalance' — Trial Balance. Groups / Detailed (Alt+F1) / Ledger-wise (Alt+L),
 * opening column (Alt+O), transactions columns (Alt+T), zero balances (Alt+Z). Enter drills a group
 * into its Group Summary, a ledger into Ledger Vouchers, the opening stock into the Stock Summary.
 *
 * 2.1: deliberately no graph — a check, not a story (SPEC-21 §5). The toolbar row says the answer:
 * "Agrees ✓" or "Differs by ₹x" (danger); the year-start footnote moved to About this report.
 */
import { useMemo, useState } from 'react';
import type { TbRow, TrialBalanceMode } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, formatDrCr, useApiQuery, useBooks, useCan, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, Button, SegmentedControl, Stack, StatLine } from '../../ui/index.ts';
import { TbTable, useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { trialBalanceStat } from './lib/charts.ts';
import { drillForRow, tbExport } from './lib/model.ts';
import { withScenario, withTbBudget } from './lib/overlay.ts';
import { useReportOverlay } from './overlay.tsx';
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
  const nav = useNav();
  const canFixOpenings = useCan('masters.view') && nav.isRegistered('accounts.openingBalances');
  const [mode, setMode] = useState<TrialBalanceMode>(params?.mode ?? 'groups');
  const [showOpening, setShowOpening] = useState(false);
  const [showTransactions, setShowTransactions] = useState(false);
  const [showZero, setShowZero] = useState(false);
  // Scenario (Alt+S) and budget column (Alt+B) — documents module masters.
  const overlay = useReportOverlay(p.period);
  const q = useApiQuery(
    'reports.trialBalance',
    { from: p.from, to: p.to, mode, showZero, ...(overlay.scenarioId !== undefined ? { scenarioId: overlay.scenarioId } : {}) },
    { keepPrevious: true },
  );
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const expansion = useTreeExpansion(`tb:${mode}`, rows, mode === 'detailed' ? 99 : 0);

  const activate = (r: TbRow): void => drill(withScenario(drillForRow(r, p.period), overlay.scenarioId ?? null));
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: mode === 'detailed' ? 'Condensed' : 'Detailed', icon: 'layers', onClick: () => setMode(mode === 'detailed' ? 'groups' : 'detailed'), group: 'view' },
    { key: 'Alt+L', label: mode === 'ledgers' ? 'Group-wise' : 'Ledger-wise', icon: 'list', onClick: () => setMode(mode === 'ledgers' ? 'groups' : 'ledgers'), group: 'view' },
    { key: 'Alt+O', label: showOpening ? 'Hide opening' : 'Show opening', icon: 'columns', onClick: () => setShowOpening(!showOpening), group: 'view' },
    { key: 'Alt+T', label: showTransactions ? 'Hide transactions' : 'Show transactions', icon: 'columns', onClick: () => setShowTransactions(!showTransactions), group: 'view' },
    { key: 'Alt+Z', label: showZero ? 'Hide zero balances' : 'Show zero balances', icon: 'eye', onClick: () => setShowZero(!showZero), group: 'view' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.allOpen ? expansion.collapseAll : expansion.expandAll, disabled: mode === 'ledgers', group: 'view' },
    ...overlay.actions,
  ];
  const d = q.data;
  const check = d ? trialBalanceStat(d) : null;
  return (
    <ReportScreen
      title="Trial Balance"
      subtitle={overlay.text ?? undefined}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Drill down · →/← Expand/collapse · Alt+F1 Detailed · Alt+O Opening · Alt+T Transactions · Alt+S Scenario · Alt+B Budget"
      filters={<SegmentedControl aria-label="Trial Balance view" size="sm" options={MODES} value={mode} onChange={setMode} />}
      stat={check ? <StatLine items={[{ label: check.label, value: <span title={check.title}>{check.value}</span>, tone: check.tone }]} /> : undefined}
      about={
        d ? (
          <>
            <p>Closing balances of every group and ledger for the period; the debit and credit totals must agree.</p>
            {d.yearStart > books.booksFrom ? (
              <p>Income and expense ledgers start from {formatDate(d.yearStart)}; the profit of earlier years is in the Profit &amp; Loss A/c.</p>
            ) : null}
          </>
        ) : undefined
      }
      exportDef={() => ({
        subtitle: [MODES.find((m) => m.value === mode)?.label, overlay.text].filter(Boolean).join(' · '),
        ...withTbBudget(
          tbExport(visibleRows(rows, expansion.expandedKeys), { opening: showOpening, transactions: showTransactions }),
          visibleRows(rows, expansion.expandedKeys),
          overlay.budget?.byKey,
          overlay.budget?.name ?? '',
          overlay.budget?.basisByKey,
        ),
        notes: d && d.openingDifference !== 0 ? `Difference in opening balances: ${formatDrCr(d.openingDifference)}` : undefined,
      })}
    >
      <Stack gap={3}>
        {d && d.openingDifference !== 0 ? (
          <Banner
            tone="warning"
            title="Opening balances do not agree"
            action={
              canFixOpenings ? (
                <Button variant="link" onClick={() => nav.push('accounts.openingBalances')}>
                  Correct openings
                </Button>
              ) : undefined
            }
          >
            — differ by {formatDrCr(-d.openingDifference)}, shown as its own line
          </Banner>
        ) : null}
        {d && !d.balanced ? (
          <Banner tone="danger" title="The Trial Balance does not agree">
            — debit and credit totals differ by {formatDrCr(d.unbalancedBy)}; restore a backup or contact support.
          </Banner>
        ) : null}
        <TbTable
          aria-label="Trial Balance"
          rows={rows}
          expansion={expansion}
          showOpening={showOpening}
          showTransactions={showTransactions}
          budget={overlay.budget}
          onActivate={activate}
          loading={q.loading}
        />
        {overlay.dialogs}
      </Stack>
    </ReportScreen>
  );
}
