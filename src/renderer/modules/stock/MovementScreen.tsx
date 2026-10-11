/**
 * 'stock.movement' { itemId?, groupId?, from?, to? } — Movement Analysis: how much came in from
 * each supplier (and back from customers) and went out to each customer, with quantity, value and
 * average rate; each party opens to the items. Alt+I / Alt+O switch Inward / Outward. Enter on a
 * party opens its ledger, on an item its stock vouchers.
 *
 * 2.1: the toolbar row holds the Inward · Outward tabs and one "Filters ▾" (item, group); the graph
 * "Biggest buyers" / "Biggest suppliers" bars the parties by value (inline for ≤ 7 parties); what moved
 * without a party is a one-line note under the table.
 */
import { useCallback, useMemo, useState } from 'react';
import type { MovementPartyRow } from '../../../shared/types/stock.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, SegmentedControl } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { ItemPicker, StockGroupPicker } from '../inventory/pickers.tsx';
import { NothingHere, qtyColumn, rateColumn, StockFilters, ToolbarLeft, useDrill, useExpansion, useStockPeriod, withBar } from './components.tsx';
import type { StockFilter } from './components.tsx';
import { movementBarValue, movementChart, movementInline } from './lib/charts.ts';
import { movementDrill, movementExport, movementTree, paramId, qtyText, visibleRows } from './lib/model.ts';
import type { MovementTreeRow } from './lib/model.ts';

export interface MovementParams {
  itemId?: number;
  groupId?: number;
  from?: string;
  to?: string;
}

type Side = 'inward' | 'outward';
const SIDES: ReadonlyArray<{ value: Side; label: string }> = [
  { value: 'inward', label: 'Inward' },
  { value: 'outward', label: 'Outward' },
];
/** The export / print subtitle and the table's name. */
const SIDE_TEXT: Record<Side, string> = { inward: 'Inward (from parties)', outward: 'Outward (to parties)' };

export function MovementScreen({ params }: ScreenProps<MovementParams>) {
  const p = useStockPeriod(params);
  const drill = useDrill();
  const [side, setSide] = useState<Side>('outward');
  const [itemId, setItemId] = useState<number | undefined>(paramId(params?.itemId));
  const [itemName, setItemName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | undefined>(itemId === undefined ? paramId(params?.groupId) : undefined);
  const q = useApiQuery('stock.movement', { from: p.from, to: p.to, itemId, groupId }, { keepPrevious: true });
  const itemQ = useApiQuery('inventory.item.get', { id: itemId ?? 0 }, { enabled: itemId !== undefined && itemName === null, staleTime: 60_000 });
  const shownItem = itemName ?? itemQ.data?.name ?? null;
  const d = q.data;
  const data = d ? d[side] : undefined;
  const rows = useMemo(() => (data ? movementTree(data.rows) : []), [data]);
  const expansion = useExpansion(rows, 0);
  // Enter on a bar = Enter on the party's row.
  const openParty = useCallback(
    (party: MovementPartyRow) => {
      const row = rows.find((r) => r.key === party.key);
      if (row) drill(movementDrill(row, { from: p.from, to: p.to }));
    },
    [rows, drill, p.from, p.to],
  );
  const spec = useMemo(() => (d ? movementChart(d, side, openParty) : null), [d, side, openParty]);
  const inline = useMemo(() => (d ? movementInline(d, side, spec) : false), [d, side, spec]);

  const columns = useMemo<Column<MovementTreeRow>[]>(
    () => [
      { key: 'name', header: side === 'inward' ? 'Received from' : 'Sent to', tree: true, minWidth: 240 },
      { key: 'vouchers', header: 'Vouchers', kind: 'number', width: 90 },
      qtyColumn<MovementTreeRow>('qty', 'Quantity', (r) => r.qty, (r) => r.unit),
      rateColumn<MovementTreeRow>('avgRate', 'Avg. rate', (r) => r.avgRate),
      // Slot 1 on both sides; a party below zero (a net return) in slot 2, as the strip draws it (`signColor`).
      withBar<MovementTreeRow>({ key: 'value', header: 'Value', kind: 'amount', width: 160 }, inline, movementBarValue),
    ],
    [side, inline],
  );
  const footer = useMemo<FooterRow[]>(
    () => (data && rows.length > 0 ? [{ key: 'total', tone: 'total', cells: { name: 'Total', qty: qtyText(data.qty, d?.unit ?? null), value: data.value } }] : []),
    [data, rows.length, d?.unit],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Alt+I', label: 'Inward', icon: 'arrow-down', onClick: () => setSide('inward'), disabled: side === 'inward', group: 'view' },
    { key: 'Alt+O', label: 'Outward', icon: 'arrow-up', onClick: () => setSide('outward'), disabled: side === 'outward', group: 'view' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.toggleAll, group: 'view' },
  ];
  const sideLabel = SIDE_TEXT[side];
  const internal = d?.internal;
  const filters: StockFilter[] = [
    {
      key: 'item',
      label: 'Item',
      active: itemId !== undefined,
      clear: () => {
        setItemId(undefined);
        setItemName(null);
      },
      node: (
        <ItemPicker
          size="sm"
          value={itemId !== undefined ? { id: itemId, name: shownItem ?? '' } : null}
          onChange={(row) => {
            setItemId(row?.id);
            setItemName(row?.name ?? null);
            if (row) setGroupId(undefined);
          }}
          allowCreate={false}
          goodsOnly
          placeholder="All items"
          aria-label="Stock item"
        />
      ),
    },
    {
      key: 'group',
      label: 'Group',
      active: groupId !== undefined,
      clear: () => setGroupId(undefined),
      node: (
        <StockGroupPicker
          size="sm"
          value={groupId ?? null}
          onChange={(id) => {
            setGroupId(id ?? undefined);
            if (id !== null) {
              setItemId(undefined);
              setItemName(null);
            }
          }}
          allowCreate={false}
          placeholder="All groups"
          aria-label="Stock group"
        />
      ),
    },
  ];
  const unit = d?.unit ?? null;
  const note =
    internal && internal.vouchers > 0
      ? `Stock journals and physical stock moved ${qtyText(internal.inwardQty, unit) || 'some quantity'} in and ${qtyText(internal.outwardQty, unit) || 'some quantity'} out (${internal.vouchers} voucher${internal.vouchers === 1 ? '' : 's'}) without a party — not shown above.`
      : undefined;

  return (
    <ReportScreen
      title="Movement Analysis"
      subtitle={shownItem ?? undefined}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open · →/← Items of a party · Alt+I Inward · Alt+O Outward · Alt+E Export · Alt+P Print"
      graph={reportGraph(spec, { inline })}
      footer={note}
      filters={
        <ToolbarLeft>
          <SegmentedControl<Side> aria-label="Direction" size="sm" options={SIDES} value={side} onChange={setSide} />
          <StockFilters filters={filters} />
        </ToolbarLeft>
      }
      exportDef={() => ({ subtitle: sideLabel, ...movementExport(visibleRows(rows, expansion.expandedKeys), data ?? { qty: null, value: 0 }, side === 'inward' ? 'Received from' : 'Sent to') })}
    >
      <DataTable<MovementTreeRow>
        aria-label={`Movement Analysis — ${sideLabel}`}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.kind === 'party'}
        expandable
        expandedKeys={expansion.expandedKeys}
        onExpandedChange={expansion.onExpandedChange}
        onRowActivate={(r) => drill(movementDrill(r, { from: p.from, to: p.to }))}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={<NothingHere icon="chart" title={side === 'inward' ? 'Nothing came in from parties in this period' : 'Nothing went out to parties in this period'} body="Change the period with Alt+F2, or choose another item or group." />}
      />
    </ReportScreen>
  );
}
