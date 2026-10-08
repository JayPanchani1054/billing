/**
 * 'stock.godowns' { godownId? } — Godown Summary as on the end of the period: godowns (tree) with
 * the items held in each, quantity, rate and value. Enter on an item opens its vouchers in that
 * godown; Enter on a godown opens the Stock Summary of that godown. Alt+Z shows empty godowns.
 */
import { useMemo, useState } from 'react';
import type { GodownSummaryRow } from '../../../shared/types/stock.ts';
import { ReportScreen, useApiQuery, usePeriod } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, Field } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { GodownPicker } from '../inventory/pickers.tsx';
import { NothingHere, qtyColumn, rateColumn, useDrill, useExpansion } from './components.tsx';
import { godownDrill, godownExport, paramId, visibleRows } from './lib/model.ts';

export interface GodownsParams {
  godownId?: number;
}

export function GodownsScreen({ params }: ScreenProps<GodownsParams>) {
  const period = usePeriod();
  const drill = useDrill();
  const [godownId, setGodownId] = useState<number | undefined>(paramId(params?.godownId));
  const [showZero, setShowZero] = useState(false);
  const q = useApiQuery('stock.godownSummary', { asOf: period.to, godownId, showZero }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const expansion = useExpansion(rows, 99);

  const columns = useMemo<Column<GodownSummaryRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Particulars',
        tree: true,
        minWidth: 240,
        render: (r) =>
          r.kind === 'godown' && r.isThirdParty ? (
            <>
              {r.name}{' '}
              <Badge tone="info" size="sm">
                Third party
              </Badge>
            </>
          ) : (
            r.name
          ),
      },
      qtyColumn<GodownSummaryRow>('qty', 'Quantity', (r) => r.qty, (r) => r.unit),
      rateColumn<GodownSummaryRow>('rate', 'Rate', (r) => r.rate),
      { key: 'value', header: 'Value', kind: 'amount', width: 160 },
    ],
    [],
  );
  const footer = useMemo<FooterRow[]>(() => (q.data && rows.length > 0 ? [{ key: 'total', tone: 'total', cells: { name: 'Grand Total', value: q.data.totalValue } }] : []), [q.data, rows.length]);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+Z', label: showZero ? 'Hide empty godowns' : 'Show empty godowns', icon: 'eye', onClick: () => setShowZero(!showZero), group: 'view' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.toggleAll, group: 'view' },
  ];

  return (
    <ReportScreen
      title="Godown Summary"
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open · →/← Expand/collapse · Alt+Z Empty godowns · Alt+F2 Date · Alt+E Export · Alt+P Print"
      filters={
        <Field label="Godown" layout="inline" labelWidth={64}>
          <GodownPicker size="sm" value={godownId ?? null} onChange={(id) => setGodownId(id ?? undefined)} allowCreate={false} placeholder="All godowns" aria-label="Godown" />
        </Field>
      }
      exportDef={() => godownExport(visibleRows(rows, expansion.expandedKeys), q.data?.totalValue ?? 0)}
    >
      <DataTable<GodownSummaryRow>
        aria-label="Godown Summary"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.kind === 'godown'}
        expandable
        expandedKeys={expansion.expandedKeys}
        onExpandedChange={expansion.onExpandedChange}
        onRowActivate={(r) => drill(godownDrill(r, { from: period.from, to: period.to }))}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={<NothingHere icon="warehouse" title="No stock in any godown on this date" body="Change the date with Alt+F2, or press Alt+Z to list empty godowns." />}
      />
    </ReportScreen>
  );
}
