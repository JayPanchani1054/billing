/**
 * 'reports.balanceSheet' — Balance Sheet as on the period's end date, horizontal layout (Liabilities |
 * Assets). Profit & Loss A/c shows its opening balance and current period; closing stock sits under
 * Stock-in-Hand. Alt+F1 opens every group, Alt+C adds the same date last year as a comparison column.
 * Enter drills a group into its Group Summary (year to date), a ledger into Ledger Vouchers, the P&L
 * A/c into the Profit & Loss statement and closing stock into the Stock Summary.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { StatementLine } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, formatDrCr, useApiQuery, useBooks, useCan, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, Button, EmptyState, Stack } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { balanceSheetChart } from './lib/charts.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { balanceSheetCompareDate, drillForRow, statementAmountText, statementExport, yearStartFor } from './lib/model.ts';
import { StatementSheet, useBlockExpansion, visibleBlock } from './statement.tsx';
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
  const nav = useNav();
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
  const canFixOpenings = useCan('masters.view') && nav.isRegistered('accounts.openingBalances');

  const toggleDetailed = (): void => {
    const next = !detailed;
    setDetailed(next);
    for (const e of [expansion.left, expansion.right]) (next ? e.expandAll : e.collapseAll)();
  };
  const activate = (line: StatementLine): void => drill(withScenario(drillForRow(line, { from: yearStart, to: asOf }, { yearStart }), overlay.scenarioId ?? null));
  // Enter on a segment = Enter on that head's line (through a ref: the spec is memoised on the data).
  const activateRef = useRef(activate);
  activateRef.current = activate;
  const onHead = useCallback((line: StatementLine) => activateRef.current(line), []);
  const spec = useMemo(() => balanceSheetChart(d, onHead), [d, onHead]);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'layers', onClick: toggleDetailed, group: 'view' },
    {
      key: 'Alt+C',
      label: compare ? 'No comparison' : 'Compare last year',
      icon: 'columns',
      onClick: () => setCompare(!compare),
      group: 'view',
      // The comparison column keeps a title-row button (the Balance Sheet has room; SPEC-21 §1.9).
      prominent: true,
    },
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
      graph={reportGraph(spec)}
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
              — assets and liabilities differ by {statementAmountText(Math.abs(d.difference))}; restore a backup or contact support.
            </Banner>
          ) : null}
          {d.openingDifference !== 0 ? (
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
              — differ by {formatDrCr(-d.openingDifference)}, shown as “Difference in opening balances”
            </Banner>
          ) : null}
          <StatementSheet
            leftTitle="Liabilities"
            rightTitle="Assets"
            blocks={[{ block, expansion }]}
            compareLabel={compareLabel}
            budget={overlay.budget ? { ...overlay.budget, leftDrNatural: false } : null}
            onActivate={activate}
            rowTitle={(r) =>
              r.kind === 'profit_loss'
                ? `Opening ${statementAmountText(d.profitLoss.openingBalance)} + current period ${statementAmountText(d.profitLoss.currentPeriod)} (from ${formatDate(d.yearStart)})`
                : r.kind === 'stock' && d.inventoryIntegrated
                  ? `Closing stock ${statementAmountText(d.closingStock)} from the stock valuation`
                  : undefined
            }
          />
        </Stack>
      ) : (
        <EmptyState icon="book" title="No balance sheet yet" body="Change the date with Alt+F2." />
      )}
      {overlay.dialogs}
    </ReportScreen>
  );
}
