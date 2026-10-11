/**
 * 'reports.profitLoss' — Profit & Loss A/c in the conventional two-column layout (Expenses | Income) on
 * one flat sheet: the Trading account down to Gross Profit, then the P&L account down to Net Profit.
 * Groups expand to sub-groups and ledgers (→/←, Alt+F1 opens or closes everything), Alt+C adds a
 * comparison column (previous period → same period last year → none), Alt+V (More › "Schedule III
 * format", checkable) switches to the Schedule III vertical statement. Enter drills into the group (Group
 * Summary on the P&L basis, so its total is this line) / ledger / stock summary.
 *
 * 2.1: the title row says "Net profit ₹x" / "Net loss ₹x" (the one coloured word for a loss), and the
 * graph strip answers "am I making money, month by month?" (reports.profitTrend, lib/charts.ts) — Enter
 * on a month opens the P&L of that month.
 */
import { useMemo, useState } from 'react';
import type { CompareWith, StatementLine, VerticalLine } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { profitLossWord, profitTrendChart, profitTrendGate } from './lib/charts.ts';
import { drillForRow, statementAmountText, statementExport, verticalExport } from './lib/model.ts';
import { StatementSheet, useBlockExpansion, visibleBlock } from './statement.tsx';
import { withScenario } from './lib/overlay.ts';
import { useReportOverlay } from './overlay.tsx';

export interface ProfitLossParams {
  from?: string;
  to?: string;
  /** (2.1) Opened from a report under a scenario (a month of the graph, the Balance Sheet's P&L A/c line): the same scenario. */
  scenarioId?: number;
}

type View = 'horizontal' | 'vertical';
const COMPARE_CYCLE: ReadonlyArray<CompareWith | null> = [null, 'previous_period', 'previous_year'];
const COMPARE_TEXT: Record<CompareWith, string> = { previous_period: 'Previous period', previous_year: 'Same period last year' };

export function ProfitLossScreen({ params }: ScreenProps<ProfitLossParams>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const [detailed, setDetailed] = useState(false);
  const [compareWith, setCompareWith] = useState<CompareWith | null>(null);
  const [view, setView] = useState<View>('horizontal');
  // Scenario (Alt+S) and budget column (Alt+B) — documents module masters.
  const overlay = useReportOverlay(p.period, typeof params?.scenarioId === 'number' ? params.scenarioId : undefined);
  const budget = overlay.budget ? { ...overlay.budget, leftDrNatural: true } : null;
  const q = useApiQuery(
    'reports.profitLoss',
    {
      from: p.from,
      to: p.to,
      mode: detailed ? 'detailed' : 'condensed',
      compareWith: compareWith ?? undefined,
      ...(overlay.scenarioId !== undefined ? { scenarioId: overlay.scenarioId } : {}),
    },
    { keepPrevious: true },
  );
  const d = q.data;
  const trading = useBlockExpansion('pl:trading', d?.trading, detailed);
  const pl = useBlockExpansion('pl:account', d?.profitLoss, detailed);
  const compareLabel = d?.compare ? `${formatDate(d.compare.from, 'D-MMM-YY')} to ${formatDate(d.compare.to, 'D-MMM-YY')}` : null;

  const toggleDetailed = (): void => {
    const next = !detailed;
    setDetailed(next);
    for (const e of [trading.left, trading.right, pl.left, pl.right]) (next ? e.expandAll : e.collapseAll)();
  };
  const cycleCompare = (): void => {
    const i = COMPARE_CYCLE.indexOf(compareWith);
    setCompareWith(COMPARE_CYCLE[(i + 1) % COMPARE_CYCLE.length]);
  };
  // Groups open on the P&L basis (income/expenses of this period only), so the summary agrees with the line.
  const activate = (line: StatementLine): void => drill(withScenario(drillForRow(line, p.period, { basis: 'profitLoss' }), overlay.scenarioId ?? null));

  // The monthly graph: its own read-only query, after the statement has loaded (never delays it).
  const trend = useApiQuery(
    'reports.profitTrend',
    { from: p.from, to: p.to, ...(overlay.scenarioId !== undefined ? { scenarioId: overlay.scenarioId } : {}) },
    { keepPrevious: true, enabled: d !== undefined && compareWith === null },
  );
  const spec = useMemo(
    () =>
      profitTrendChart(trend.data, {
        compare: compareWith !== null,
        activate: (r) => drill(withScenario({ screen: 'reports.profitLoss', params: { from: r.from, to: r.to } }, overlay.scenarioId ?? null)),
      }),
    [trend.data, compareWith, drill, overlay.scenarioId],
  );
  const stockGate = profitTrendGate(trend.data, compareWith !== null) === 'stock';
  const net = d ? profitLossWord(d.figures.netProfit) : null;

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'layers', onClick: toggleDetailed, group: 'view' },
    {
      key: 'Alt+C',
      label: compareWith === null ? 'Compare' : compareWith === 'previous_period' ? 'Compare: last year' : 'No comparison',
      icon: 'columns',
      onClick: cycleCompare,
      hint: compareWith ? COMPARE_TEXT[compareWith] : 'Add a column for the previous period',
      group: 'view',
      prominent: true,
    },
    // The Horizontal / Schedule III tabs became one checkable More item (same key).
    { key: 'Alt+V', label: 'Schedule III format', icon: 'list', onClick: () => setView(view === 'horizontal' ? 'vertical' : 'horizontal'), group: 'view', checked: view === 'vertical' },
    ...overlay.actions,
  ];

  const verticalColumns = useMemo<Column<VerticalLine>[]>(
    () => [
      { key: 'label', header: 'Particulars', tree: true, minWidth: 280 },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 170, render: (r) => statementAmountText(r.amount) },
      { key: 'compare', header: compareLabel ?? 'Compare', kind: 'amount', width: 170, hidden: compareLabel === null, render: (r) => statementAmountText(r.compare) },
    ],
    [compareLabel],
  );

  return (
    <ReportScreen
      title="Profit & Loss A/c"
      subtitle={overlay.text ?? undefined}
      meta={net ? <span className={net.loss ? 'bx-rep-danger' : undefined}>{net.text}</span> : undefined}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      graph={reportGraph(spec)}
      about={
        <>
          <p>Expenses on the left, income on the right: the Trading Account down to the gross profit, then the Profit &amp; Loss Account down to the net profit. Enter on a line opens its details.</p>
          <p>
            {d?.inventoryIntegrated
              ? 'Opening and closing stock are valued by each item’s costing method.'
              : 'Stock is not integrated with accounts (F11), so opening and closing stock are not counted.'}
          </p>
          <p>
            The graph shows the net profit of each month (Enter on a month opens the P&amp;L of that month). It is drawn from the first month with a result and not while a comparison
            column is shown.
            {stockGate ? ' Monthly profit needs stock valued each month — switch on inventory (F11): until then a month with purchases would look like a loss.' : ''}
          </p>
        </>
      }
      hint="Enter Drill down · →/← Expand/collapse · Tab Other side · Alt+F1 Detailed · Alt+C Compare · Alt+V Schedule III · Alt+S Scenario · Alt+B Budget"
      exportDef={() => {
        if (!d) return { columns: [{ header: 'Particulars' }], rows: [] };
        if (view === 'vertical') return { subtitle: ['Schedule III format', overlay.text].filter(Boolean).join(' · '), ...verticalExport(d.vertical, compareLabel) };
        return {
          ...(overlay.text ? { subtitle: overlay.text } : {}),
          ...statementExport(
            { left: 'Expenses', right: 'Income' },
            [
              { caption: 'Trading Account', ...visibleBlock(d.trading, trading) },
              { caption: 'Profit & Loss Account', ...visibleBlock(d.profitLoss, pl) },
            ],
            compareLabel,
            budget,
          ),
        };
      }}
    >
      {d && view === 'vertical' ? (
        <DataTable<VerticalLine>
          aria-label="Profit and loss, Schedule III format"
          columns={verticalColumns}
          rows={d.vertical}
          getRowKey={(r) => r.key}
          getRowLevel={(r) => r.level}
          isGroupRow={(r) => r.emphasis}
          onRowActivate={(r) => r.groupId !== null && drill(drillForRow({ key: r.key, kind: 'group', id: r.groupId }, p.period, { basis: 'profitLoss' }))}
          autoFocus
        />
      ) : d ? (
        <>
          <StatementSheet
            leftTitle="Expenses"
            rightTitle="Income"
            blocks={[
              { caption: 'Trading Account', block: d.trading, expansion: trading },
              { caption: 'Profit & Loss Account', block: d.profitLoss, expansion: pl },
            ]}
            compareLabel={compareLabel}
            budget={budget}
            onActivate={activate}
            rowTitle={(r) => (r.kind === 'stock' && d.inventoryIntegrated ? `${r.name} — valued by each item’s costing method` : undefined)}
          />
          {d.inventoryIntegrated ? null : <p className="bx-rep-note">Stock is not integrated with accounts (F11)</p>}
        </>
      ) : (
        <EmptyState icon="book" title="No profit and loss figures yet" body="Change the period with Alt+F2." />
      )}
      {overlay.dialogs}
    </ReportScreen>
  );
}
