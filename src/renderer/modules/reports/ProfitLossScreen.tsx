/**
 * 'reports.profitLoss' — Profit & Loss A/c in Tally's two-column layout (Expenses | Income): the
 * Trading account down to Gross Profit, then the P&L account down to Net Profit. Groups expand to
 * sub-groups and ledgers (→/←, Alt+F1 opens or closes everything), Alt+C adds a comparison column
 * (previous period → same period last year → none), Alt+V switches to the Schedule III vertical
 * statement. Enter drills into the group / ledger / stock summary.
 */
import { useMemo, useState } from 'react';
import type { CompareWith, StatementLine, VerticalLine } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDate, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { drillForRow, statementAmountText, statementExport, verticalExport } from './lib/model.ts';
import { StatementBlockView, useBlockExpansion, visibleBlock } from './statement.tsx';

export interface ProfitLossParams {
  from?: string;
  to?: string;
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
  const q = useApiQuery(
    'reports.profitLoss',
    { from: p.from, to: p.to, mode: detailed ? 'detailed' : 'condensed', compareWith: compareWith ?? undefined },
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
  const activate = (line: StatementLine): void => drill(drillForRow(line, p.period));

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'layers', onClick: toggleDetailed, group: 'view' },
    {
      key: 'Alt+C',
      label: compareWith === null ? 'Compare' : compareWith === 'previous_period' ? 'Compare: last year' : 'No comparison',
      icon: 'columns',
      onClick: cycleCompare,
      hint: compareWith ? COMPARE_TEXT[compareWith] : 'Add a column for the previous period',
      group: 'view',
    },
    { key: 'Alt+V', label: view === 'horizontal' ? 'Vertical (Schedule III)' : 'Horizontal', icon: 'list', onClick: () => setView(view === 'horizontal' ? 'vertical' : 'horizontal'), group: 'view' },
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
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Drill down · →/← Expand/collapse · Tab Other side · Alt+F1 Detailed · Alt+C Compare · Alt+V Vertical"
      filters={
        <SegmentedControl<View>
          aria-label="Layout"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'vertical', label: 'Schedule III' },
          ]}
        />
      }
      exportDef={() => {
        if (!d) return { columns: [{ header: 'Particulars' }], rows: [] };
        if (view === 'vertical') return { subtitle: 'Schedule III format', ...verticalExport(d.vertical, compareLabel) };
        return {
          ...statementExport(
            { left: 'Expenses', right: 'Income' },
            [
              { caption: 'Trading Account', ...visibleBlock(d.trading, trading) },
              { caption: 'Profit & Loss Account', ...visibleBlock(d.profitLoss, pl) },
            ],
            compareLabel,
          ),
        };
      }}
    >
      {d && view === 'vertical' ? (
        <DataTable<VerticalLine>
          aria-label="Profit and loss, Schedule III format"
          className="bx-rep-fill"
          columns={verticalColumns}
          rows={d.vertical}
          getRowKey={(r) => r.key}
          getRowLevel={(r) => r.level}
          isGroupRow={(r) => r.emphasis}
          onRowActivate={(r) => r.groupId !== null && drill({ screen: 'reports.groupSummary', params: { groupId: r.groupId, from: p.from, to: p.to } })}
          autoFocus
        />
      ) : d ? (
        <Stack gap={4}>
          <StatementBlockView
            caption="Trading Account"
            leftTitle="Expenses"
            rightTitle="Income"
            block={d.trading}
            expansion={trading}
            compareLabel={compareLabel}
            onActivate={activate}
            autoFocus
          />
          <StatementBlockView caption="Profit & Loss Account" leftTitle="Expenses" rightTitle="Income" block={d.profitLoss} expansion={pl} compareLabel={compareLabel} onActivate={activate} />
          <p className="bx-rep-note">
            {d.figures.netProfit >= 0 ? 'Net profit' : 'Net loss'} for the period: {statementAmountText(Math.abs(d.figures.netProfit))}
            {d.inventoryIntegrated ? ' · Stock valued by each item’s costing method' : ' · Stock is not integrated with accounts (F11)'}
          </p>
        </Stack>
      ) : (
        <EmptyState icon="book" title="No profit and loss figures yet" body="Change the period with Alt+F2." />
      )}
    </ReportScreen>
  );
}
