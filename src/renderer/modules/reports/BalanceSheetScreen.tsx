/**
 * 'reports.balanceSheet' — Balance Sheet as on the period's end date, Tally layout (Liabilities |
 * Assets). Profit & Loss A/c shows its opening balance and current period; closing stock sits under
 * Stock-in-Hand. Alt+F1 opens every group, Alt+C adds the same date last year as a comparison column.
 * Enter drills a group into its Group Summary (year to date), a ledger into Ledger Vouchers, the P&L
 * A/c into the Profit & Loss statement and closing stock into the Stock Summary.
 */
import { useState } from 'react';
import type { StatementLine } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, formatDrCr, useApiQuery, useBooks } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, EmptyState, Stack } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { balanceSheetCompareDate, drillForRow, statementAmountText, statementExport, yearStartFor } from './lib/model.ts';
import { StatementBlockView, useBlockExpansion, visibleBlock } from './statement.tsx';
import { withScenario } from './lib/overlay.ts';
import { useReportOverlay } from './overlay.tsx';

export interface BalanceSheetParams {
  /** Period whose end date is the "as on" date (drill-downs pass both). */
  from?: string;
  to?: string;
}

export function BalanceSheetScreen({ params }: ScreenProps<BalanceSheetParams>) {
  const p = useReportPeriod(params);
  const books = useBooks();
  const drill = useDrill();
  const [detailed, setDetailed] = useState(false);
  const [compare, setCompare] = useState(false);
  const asOf = p.to;
  const compareAsOf = compare ? balanceSheetCompareDate(asOf) : undefined;
  // Scenario (Alt+S) and budget column (Alt+B) — documents module masters; budgets for the year to date.
  const overlay = useReportOverlay({ from: yearStartFor(asOf, books.fyStartMonth, books.booksFrom), to: asOf });
  const q = useApiQuery(
    'reports.balanceSheet',
    { asOf, mode: detailed ? 'detailed' : 'condensed', compareAsOf, ...(overlay.scenarioId !== undefined ? { scenarioId: overlay.scenarioId } : {}) },
    { keepPrevious: true },
  );
  const d = q.data;
  const block = d ? { left: d.liabilities, right: d.assets, total: d.liabilitiesTotal, compareTotal: d.compareLiabilitiesTotal } : undefined;
  const expansion = useBlockExpansion('bs', block, detailed);
  const compareLabel = d?.compareAsOf ? `As on ${formatDate(d.compareAsOf)}` : null;
  const yearStart = d?.yearStart ?? yearStartFor(asOf, books.fyStartMonth, books.booksFrom);

  const toggleDetailed = (): void => {
    const next = !detailed;
    setDetailed(next);
    for (const e of [expansion.left, expansion.right]) (next ? e.expandAll : e.collapseAll)();
  };
  const activate = (line: StatementLine): void => drill(withScenario(drillForRow(line, { from: yearStart, to: asOf }, { yearStart }), overlay.scenarioId ?? null));
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'layers', onClick: toggleDetailed, group: 'view' },
    { key: 'Alt+C', label: compare ? 'No comparison' : 'Compare last year', icon: 'columns', onClick: () => setCompare(!compare), group: 'view' },
    ...overlay.actions,
  ];

  return (
    <ReportScreen
      title="Balance Sheet"
      subtitle={overlay.text ?? undefined}
      periodMode="asOn"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Drill down · →/← Expand/collapse · Tab Other side · Alt+F1 Detailed · Alt+C Compare · Alt+S Scenario · Alt+B Budget · Alt+F2 Date"
      exportDef={() =>
        d && block
          ? {
              subtitle: [`As on ${formatDate(asOf)}`, overlay.text].filter(Boolean).join(' · '),
              ...statementExport({ left: 'Liabilities', right: 'Assets' }, [visibleBlock(block, expansion)], compareLabel, overlay.budget ? { ...overlay.budget, leftDrNatural: false } : null),
            }
          : { columns: [{ header: 'Particulars' }], rows: [] }
      }
    >
      {d && block ? (
        <Stack gap={3}>
          {!d.balanced ? (
            <Banner tone="danger" title="The Balance Sheet does not agree">
              Assets and liabilities differ by {statementAmountText(Math.abs(d.difference))}. Some stored entries may be damaged — restore a backup or contact support.
            </Banner>
          ) : null}
          {d.openingDifference !== 0 ? (
            <Banner tone="warning" title="Opening balances do not agree">
              Ledger opening balances{d.inventoryIntegrated ? ' and opening stock' : ''} differ by {formatDrCr(-d.openingDifference)}, so a
              difference of {statementAmountText(Math.abs(d.openingDifference))} is shown on the {d.openingDifference > 0 ? 'assets' : 'liabilities'} side to
              balance it. Correct the ledger opening balances to clear it.
            </Banner>
          ) : null}
          <StatementBlockView
            leftTitle="Liabilities"
            rightTitle="Assets"
            block={block}
            expansion={expansion}
            compareLabel={compareLabel}
            budget={overlay.budget ? { ...overlay.budget, leftDrNatural: false } : null}
            onActivate={activate}
            autoFocus
          />
          <p className="bx-rep-note">
            Profit &amp; Loss A/c: opening {statementAmountText(d.profitLoss.openingBalance)} + current period {statementAmountText(d.profitLoss.currentPeriod)} (from{' '}
            {formatDate(d.yearStart)}).
            {d.inventoryIntegrated ? ` Closing stock ${statementAmountText(d.closingStock)} from the stock valuation.` : ''}
          </p>
        </Stack>
      ) : (
        <EmptyState icon="book" title="No balance sheet yet" body="Change the date with Alt+F2." />
      )}
      {overlay.dialogs}
    </ReportScreen>
  );
}
