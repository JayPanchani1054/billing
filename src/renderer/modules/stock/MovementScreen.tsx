/**
 * 'stock.movement' { itemId?, groupId?, from?, to? } — Movement Analysis: how much came in from
 * each supplier (and back from customers) and went out to each customer, with quantity, value and
 * average rate; each party opens to the items. Alt+I / Alt+O switch Inward / Outward. Enter on a
 * party opens its ledger, on an item its stock vouchers.
 */
import { useMemo, useState } from 'react';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, DataTable, Field, Inline, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { ItemPicker, StockGroupPicker } from '../inventory/pickers.tsx';
import { NothingHere, qtyColumn, rateColumn, useDrill, useExpansion, useStockPeriod } from './components.tsx';
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
  { value: 'inward', label: 'Inward (from parties)' },
  { value: 'outward', label: 'Outward (to parties)' },
];

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

  const columns = useMemo<Column<MovementTreeRow>[]>(
    () => [
      { key: 'name', header: side === 'inward' ? 'Received from' : 'Sent to', tree: true, minWidth: 240 },
      { key: 'vouchers', header: 'Vouchers', kind: 'number', width: 90 },
      qtyColumn<MovementTreeRow>('qty', 'Quantity', (r) => r.qty, (r) => r.unit),
      rateColumn<MovementTreeRow>('avgRate', 'Avg. rate', (r) => r.avgRate),
      { key: 'value', header: 'Value', kind: 'amount', width: 160 },
    ],
    [side],
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
  const sideLabel = SIDES.find((s) => s.value === side)?.label;
  const internal = d?.internal;

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
      filters={
        <Inline gap={2}>
          <SegmentedControl<Side> aria-label="Direction" size="sm" options={SIDES} value={side} onChange={setSide} />
          <Field label="Item" layout="inline" labelWidth={40}>
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
          </Field>
          <Field label="Group" layout="inline" labelWidth={48}>
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
          </Field>
        </Inline>
      }
      exportDef={() => ({ subtitle: sideLabel, ...movementExport(visibleRows(rows, expansion.expandedKeys), data ?? { qty: null, value: 0 }, side === 'inward' ? 'Received from' : 'Sent to') })}
    >
      <Stack gap={3} grow>
        {internal && internal.vouchers > 0 ? (
          <Banner tone="info" inline>
            Stock journals and physical stock moved {qtyText(internal.inwardQty, d?.unit ?? null) || 'some quantity'} in and {qtyText(internal.outwardQty, d?.unit ?? null) || 'some quantity'} out ({internal.vouchers} voucher{internal.vouchers === 1 ? '' : 's'}) without a party — not shown above.
          </Banner>
        ) : null}
        <DataTable<MovementTreeRow>
          aria-label={`Movement Analysis — ${sideLabel ?? ''}`}
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
      </Stack>
    </ReportScreen>
  );
}
