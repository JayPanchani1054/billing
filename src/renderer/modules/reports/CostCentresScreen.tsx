/**
 * 'reports.costCentres' {categoryId?, from?, to?} — Cost Category Summary: categories and their cost
 * centres (sub-centres rolled up). Enter on a centre shows its ledger breakup below; Enter on a
 * ledger of the breakup opens Ledger Vouchers.
 *
 * 2.1: "Net by cost centre" — the centres of the first (or the given) category, as 4 px bars in the Net
 * column when there are ≤ 7 of them, else a Top 6 + Other strip (lib/charts.ts).
 */
import { useMemo, useState } from 'react';
import type { CostCentreLedgerRow, CostCentreRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { DataTable, EmptyState, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod, useTreeExpansion } from './components.tsx';
import { costCentresChart, costCentresOf } from './lib/charts.ts';

export interface CostCentresParams {
  categoryId?: number;
  from?: string;
  to?: string;
}

export function CostCentresScreen({ params }: ScreenProps<CostCentresParams>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const categoryId = typeof params?.categoryId === 'number' ? params.categoryId : undefined;
  const [centreId, setCentreId] = useState<number | undefined>(undefined);
  const q = useApiQuery('reports.costCentres', { from: p.from, to: p.to, categoryId, costCentreId: centreId }, { keepPrevious: true });
  const d = q.data;
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const expansion = useTreeExpansion('costCentres', rows, 1);
  const spec = useMemo(() => costCentresChart(d, categoryId), [d, categoryId]);
  const drawn = useMemo(() => new Set(d ? costCentresOf(d, categoryId).map((r) => r.key) : []), [d, categoryId]);
  const inline = inlineBars(spec, drawn.size);
  const columns = useMemo<Column<CostCentreRow>[]>(
    () => [
      { key: 'name', header: 'Particulars', tree: true, minWidth: 220 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true },
      { key: 'net', header: 'Net', kind: 'drcr', width: 170, bar: inline ? { value: (r) => (drawn.has(r.key) ? r.net : null), slot: 'polarity' } : undefined },
    ],
    [inline, drawn],
  );
  const ledgerColumns = useMemo<Column<CostCentreLedgerRow>[]>(
    () => [
      { key: 'ledgerName', header: 'Ledger', minWidth: 200 },
      { key: 'groupName', header: 'Group', width: 170 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true },
      { key: 'net', header: 'Net', kind: 'drcr', width: 170 },
    ],
    [],
  );
  const centre = d?.centre ?? null;
  const ledgerFooter: FooterRow[] = centre ? [{ key: 'total', tone: 'total', cells: { ledgerName: 'Total', debit: centre.totals.debit, credit: centre.totals.credit, net: centre.totals.net } }] : [];
  const actions: ScreenActionItem[] = [
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.allOpen ? expansion.collapseAll : expansion.expandAll, group: 'view' },
    { key: 'Alt+B', label: 'Hide breakup', icon: 'close', onClick: () => setCentreId(undefined), hidden: centreId === undefined, group: 'view' },
  ];
  return (
    <ReportScreen
      title="Cost Centres"
      period={p.period}
      graph={reportGraph(spec, { inline })}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter on a centre: ledger breakup · Tab: breakup · Enter on a ledger: its vouchers"
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }, { header: 'Net', kind: 'drcr' }],
        rows: [
          ...rows.map((r) => [r.name, r.debit || null, r.credit || null, r.net]),
          ...(centre ? [[`Ledger breakup — ${centre.name}`, null, null, null], ...centre.ledgers.map((l) => [l.ledgerName, l.debit || null, l.credit || null, l.net])] : []),
        ],
        levels: [...rows.map((r) => r.level), ...(centre ? [0, ...centre.ledgers.map(() => 1)] : [])],
      })}
    >
      <Stack gap={3}>
        <DataTable<CostCentreRow>
          aria-label="Cost categories and centres"
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          getRowLevel={(r) => r.level}
          isGroupRow={(r) => r.kind === 'category'}
          expandable
          expandedKeys={expansion.expandedKeys}
          onExpandedChange={expansion.onExpandedChange}
          onRowActivate={(r) => r.kind === 'centre' && setCentreId(r.id)}
          loading={q.loading}
          empty={<EmptyState icon="tag" title="No cost categories" body="Turn on cost centres in Features (F11) and create cost centres under Masters." />}
          autoFocus
        />
        {centre ? (
          <section className="bx-rep-side" aria-label={`Ledger breakup of ${centre.name}`}>
            <h2 className="bx-rep-side__title">Ledger breakup — {centre.name}</h2>
            <DataTable<CostCentreLedgerRow>
              aria-label={`Ledger breakup of ${centre.name}`}
              columns={ledgerColumns}
              rows={centre.ledgers}
              getRowKey={(r) => String(r.ledgerId)}
              onRowActivate={(r) => drill({ screen: 'reports.ledger', params: { ledgerId: r.ledgerId, from: p.from, to: p.to } })}
              footerRows={ledgerFooter}
              virtualize={false}
              empty={<EmptyState size="sm" icon="ledger" title="Nothing allocated to this centre in the period" />}
            />
          </section>
        ) : null}
      </Stack>
    </ReportScreen>
  );
}
