/**
 * As-on stock analysis screens (date = end of the period, Alt+F2):
 *   'stock.ageing'   { groupId? }  Stock Ageing — closing stock by age of its inwards (values, Alt+Q quantities)
 *   'stock.reorder'                Reorder Status — items below reorder level, with open orders and what to order
 *   'stock.negative'               Negative Stock — items / godowns below zero and since when
 *   'stock.batches'  { itemId? }   Batch Summary — batch balances with expiry status (Alt+W expiring only)
 * Enter on an item opens its stock vouchers.
 *
 * 2.1: Ageing draws "Stock value by age" (ordinal columns; its age presets are checkable More items);
 * the other three have no graph (SPEC-21 §5) — their answer is a stat on the toolbar row ("Order now:
 * 2 of 12 items", "Below zero 3 items", "Expired 2 batches · Expiring in 30 days 1 batch"), and their
 * explanations live in More › About this report.
 */
import { useMemo, useState } from 'react';
import type { BatchRow, ReorderRow, StockAgeingRow } from '../../../shared/types/stock.ts';
import { addDays, financialYear } from '../../../shared/dates.ts';
import { formatDate, ReportScreen, useApiQuery, useBooks, usePeriod, useShell } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, NO_KEY, SegmentedControl } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { ItemPicker, StockGroupPicker } from '../inventory/pickers.tsx';
import { amountColumn, NothingHere, qtyColumn, StockStat, ToolbarLeft, useDrill, useExpansion } from './components.tsx';
import { batchesStat, negativeStat, reorderStat, stockAgeingChart } from './lib/charts.ts';
import {
  AGEING_PRESETS,
  ageingExport,
  batchesExport,
  batchStatusInfo,
  expiryText,
  negativeExport,
  negativeTree,
  paramId,
  qtyText,
  reorderExport,
  visibleRows,
} from './lib/model.ts';
import type { NegativeTreeRow } from './lib/model.ts';

/** Range for an item drill-down from an as-on report: the financial year up to the as-on date. */
function yearTo(asOf: string, booksFrom: string, fyStartMonth: number): { from: string; to: string } {
  const fy = financialYear(asOf, fyStartMonth).start;
  return { from: fy < booksFrom ? booksFrom : fy, to: asOf };
}

function useItemDrill(): (itemId: number, godownId?: number | null) => void {
  const drill = useDrill();
  const period = usePeriod();
  const books = useBooks();
  return (itemId, godownId) => {
    const r = yearTo(period.to, books.booksFrom, books.fyStartMonth);
    drill({ screen: 'stock.item', params: { itemId, ...r, ...(godownId ? { godownId } : {}) } });
  };
}

// ───────────────────────────── Ageing ─────────────────────────────

export function AgeingScreen({ params }: ScreenProps<{ groupId?: number }>) {
  const period = usePeriod();
  const openItem = useItemDrill();
  const [preset, setPreset] = useState(AGEING_PRESETS[0].id);
  const [show, setShow] = useState<'value' | 'qty'>('value');
  const [groupId, setGroupId] = useState<number | undefined>(paramId(params?.groupId));
  const buckets = (AGEING_PRESETS.find((x) => x.id === preset) ?? AGEING_PRESETS[0]).buckets;
  const q = useApiQuery('stock.ageing', { asOf: period.to, buckets, groupId }, { keepPrevious: true });
  const d = q.data;
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const spec = useMemo(() => (d ? stockAgeingChart(d) : null), [d]);

  const columns = useMemo<Column<StockAgeingRow>[]>(() => {
    const cols: Column<StockAgeingRow>[] = [
      { key: 'name', header: 'Item', minWidth: 200 },
      { key: 'groupName', header: 'Group', width: 150 },
      qtyColumn<StockAgeingRow>('qty', 'In stock', (r) => r.qty, (r) => r.unit),
      amountColumn<StockAgeingRow>('value', 'Value', (r) => r.value, { blankZero: false }),
    ];
    (d?.buckets ?? []).forEach((b, i) => {
      cols.push(
        show === 'value'
          ? amountColumn<StockAgeingRow>(`b${i}`, b.label, (r) => r.buckets[i]?.value ?? 0, { width: 130 })
          : qtyColumn<StockAgeingRow>(`b${i}`, b.label, (r) => r.buckets[i]?.qty ?? 0, (r) => r.unit, { width: 120, blankZero: true }),
      );
    });
    cols.push({ key: 'averageAgeDays', header: 'Avg. age (days)', kind: 'number', width: 110 });
    return cols;
  }, [d?.buckets, show]);
  const footer = useMemo<FooterRow[]>(() => {
    if (!d || rows.length === 0) return [];
    const cells: Record<string, number | string> = { name: 'Total', value: d.totals.value };
    if (show === 'value') d.totals.buckets.forEach((v, i) => (cells[`b${i}`] = v));
    return [{ key: 'total', tone: 'total', cells }];
  }, [d, rows.length, show]);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+Q', label: show === 'value' ? 'Show quantities' : 'Show values', icon: 'columns', onClick: () => setShow(show === 'value' ? 'qty' : 'value'), group: 'view' },
    // The age presets: checkable, keyless More items (2.0: a segmented control on the toolbar).
    ...AGEING_PRESETS.map((x) => ({ key: NO_KEY, label: `Ages ${x.label}`, onClick: () => setPreset(x.id), checked: preset === x.id, group: 'ages', id: `ages-${x.id}` })),
  ];

  return (
    <ReportScreen
      title="Stock Ageing"
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Item vouchers · Alt+Q Values / quantities · Alt+F2 Date · Alt+E Export · Alt+P Print"
      graph={reportGraph(spec)}
      about={
        <p>
          Stock on hand by how long ago it came in (first in, first out): each item's closing stock is matched with its most recent inwards, and each part is aged from the
          day it came in. The graph always shows values; Alt+Q switches the table between values and quantities. Choose the age periods under More.
        </p>
      }
      filters={<StockGroupPicker size="sm" value={groupId ?? null} onChange={(id) => setGroupId(id ?? undefined)} allowCreate={false} placeholder="All groups" aria-label="Stock group" />}
      exportDef={d ? () => ageingExport(d, show) : undefined}
    >
      <DataTable<StockAgeingRow>
        aria-label="Stock Ageing"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.itemId)}
        onRowActivate={(r) => openItem(r.itemId)}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={<NothingHere icon="clock" title="No stock on hand on this date" body="Change the date with Alt+F2." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Reorder ─────────────────────────────

export function ReorderScreen() {
  const period = usePeriod();
  const shell = useShell();
  const openItem = useItemDrill();
  const q = useApiQuery('stock.reorder', { asOf: period.to }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const po = shell.voucherAvailability('purchase_order');
  const columns = useMemo<Column<ReorderRow>[]>(() => {
    const u = (r: ReorderRow) => r.unit;
    return [
      { key: 'name', header: 'Item', minWidth: 200 },
      { key: 'groupName', header: 'Group', width: 140 },
      qtyColumn<ReorderRow>('closingQty', 'In stock', (r) => r.closingQty, u),
      qtyColumn<ReorderRow>('reorderLevel', 'Reorder level', (r) => r.reorderLevel, u),
      qtyColumn<ReorderRow>('po', 'On order', (r) => r.pendingPurchaseQty, u, { blankZero: true }),
      qtyColumn<ReorderRow>('so', 'Promised to customers', (r) => r.pendingSalesQty, u, { blankZero: true, width: 160 }),
      qtyColumn<ReorderRow>('net', 'Net available', (r) => r.netAvailable, u),
      qtyColumn<ReorderRow>('shortfall', 'Shortfall', (r) => r.shortfall, u, { blankZero: true }),
      {
        ...qtyColumn<ReorderRow>('suggestedQty', 'Order now', (r) => r.suggestedQty, u, { blankZero: true }),
        render: (r) =>
          r.suggestedQty > 0 ? (
            <strong>{qtyText(r.suggestedQty, r.unit)}</strong>
          ) : (
            <span className="bx-muted">Covered by orders</span>
          ),
      },
    ];
  }, []);
  const actions: ScreenActionItem[] = [
    { key: 'Alt+O', label: 'Purchase Order', icon: 'cart', onClick: () => shell.openVoucher('purchase_order'), disabled: !po.ok, hint: po.ok ? 'Enter a purchase order for the items you need' : po.reason, group: 'go' },
  ];
  const d = q.data;
  return (
    <ReportScreen
      title="Reorder Status"
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Item vouchers · Alt+O Purchase Order · Alt+F2 Date · Alt+E Export · Alt+P Print"
      stat={d ? <StockStat items={reorderStat(d)} /> : undefined}
      about={
        <p>
          Items below their reorder level. Net available = in stock + on order from suppliers − promised to customers. Order now = reorder level − net available (at least the
          item’s minimum order quantity).
        </p>
      }
      exportDef={() => reorderExport(rows)}
    >
      <DataTable<ReorderRow>
        aria-label="Reorder Status"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.itemId)}
        onRowActivate={(r) => openItem(r.itemId)}
        loading={q.loading}
        empty={
          d && d.itemsWithLevel === 0 ? (
            <NothingHere title="No reorder levels set" body="Set a reorder level (and minimum order quantity) in the stock item master to be warned before you run out." />
          ) : (
            <NothingHere icon="check-circle" title="Every item is above its reorder level" body={`Stock on ${formatDate(period.to)} covers all reorder levels.`} />
          )
        }
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Negative stock ─────────────────────────────

export function NegativeStockScreen() {
  const period = usePeriod();
  const openItem = useItemDrill();
  const q = useApiQuery('stock.negative', { asOf: period.to }, { keepPrevious: true });
  const rows = useMemo(() => negativeTree(q.data?.rows ?? []), [q.data]);
  const expansion = useExpansion(rows, 99);
  const columns = useMemo<Column<NegativeTreeRow>[]>(
    () => [
      { key: 'name', header: 'Item / godown', tree: true, minWidth: 240 },
      qtyColumn<NegativeTreeRow>('qty', 'Quantity', (r) => r.qty, (r) => r.unit),
      amountColumn<NegativeTreeRow>('value', 'Value', (r) => r.value, { width: 160 }),
      { key: 'negativeSince', header: 'Negative since', kind: 'date', width: 130 },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [{ key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.toggleAll, group: 'view' }];
  return (
    <ReportScreen
      title="Negative Stock"
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Item vouchers · →/← Godowns · Alt+F2 Date · Alt+E Export · Alt+P Print"
      stat={<StockStat items={negativeStat(q.data?.rows ?? [])} />}
      about={
        <p>
          Items sold or issued beyond what was in stock. Usually a purchase or receipt was not entered, or was entered after the sale with a later date. Enter the missing inward
          (or correct its date) so stock values are right.
        </p>
      }
      exportDef={() => negativeExport(visibleRows(rows, expansion.expandedKeys))}
    >
      <DataTable<NegativeTreeRow>
        aria-label="Negative Stock"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.kind === 'item'}
        expandable
        expandedKeys={expansion.expandedKeys}
        onExpandedChange={expansion.onExpandedChange}
        onRowActivate={(r) => openItem(r.itemId, r.godownId)}
        loading={q.loading}
        empty={<NothingHere icon="check-circle" title="No negative stock" body={`Every item has stock of zero or more on ${formatDate(period.to)}.`} />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Batches ─────────────────────────────

const WINDOWS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All batches' },
  { value: '30', label: 'Expiring in 30 days' },
  { value: '90', label: 'Expiring in 90 days' },
];

export function BatchesScreen({ params }: ScreenProps<{ itemId?: number }>) {
  const period = usePeriod();
  const openItem = useItemDrill();
  const [itemId, setItemId] = useState<number | undefined>(paramId(params?.itemId));
  const [itemName, setItemName] = useState<string | null>(null);
  const [win, setWin] = useState('all');
  const itemQ = useApiQuery('inventory.item.get', { id: itemId ?? 0 }, { enabled: itemId !== undefined && itemName === null, staleTime: 60_000 });
  const shownItem = itemName ?? itemQ.data?.name ?? null;
  const q = useApiQuery('stock.batches', { asOf: period.to, itemId, expiringWithinDays: win === 'all' ? undefined : Number(win) }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const columns = useMemo<Column<BatchRow>[]>(
    () => [
      { key: 'itemName', header: 'Item', minWidth: 180 },
      { key: 'batchName', header: 'Batch', width: 130 },
      { key: 'mfgDate', header: 'Mfg. date', kind: 'date', width: 110 },
      { key: 'expiryDate', header: 'Expiry date', kind: 'date', width: 110 },
      qtyColumn<BatchRow>('qty', 'Quantity', (r) => r.qty, (r) => r.unit),
      { key: 'daysToExpiry', header: 'Expiry', width: 150, render: (r) => expiryText(r.daysToExpiry) },
      {
        key: 'status',
        header: 'Status',
        width: 130,
        value: (r) => batchStatusInfo(r.status).label,
        render: (r) => {
          const s = batchStatusInfo(r.status);
          // A badge only for the exceptions (expired, expiring); the rest are plain words.
          return r.status === 'expired' || r.status === 'expiring' ? (
            <Badge tone={s.tone} size="sm">
              {s.label}
            </Badge>
          ) : (
            <span className="bx-muted">{s.label}</span>
          );
        },
      },
    ],
    [],
  );
  const cycle = (): void => setWin(WINDOWS[(WINDOWS.findIndex((w) => w.value === win) + 1) % WINDOWS.length].value);
  const actions: ScreenActionItem[] = [{ key: 'Alt+W', label: 'Expiry filter', icon: 'filter', onClick: cycle, hint: 'All → expiring in 30 days → 90 days', group: 'view' }];
  return (
    <ReportScreen
      title="Batch Summary"
      subtitle={shownItem ?? undefined}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Item vouchers · Alt+W Expiry filter · Alt+F2 Date · Alt+E Export · Alt+P Print"
      stat={q.data ? <StockStat items={batchesStat(q.data)} /> : undefined}
      about={<p>Expired stock should not be sold. Record a rejection or a stock journal to write it off. Alt+W shows only the batches expiring within 30, then 90 days.</p>}
      filters={
        <ToolbarLeft>
          <SegmentedControl aria-label="Expiry filter" size="sm" options={WINDOWS} value={win} onChange={setWin} />
          <ItemPicker
            size="sm"
            value={itemId !== undefined ? { id: itemId, name: shownItem ?? '' } : null}
            onChange={(row) => {
              setItemId(row?.id);
              setItemName(row?.name ?? null);
            }}
            allowCreate={false}
            goodsOnly
            placeholder="All items"
            aria-label="Stock item"
          />
        </ToolbarLeft>
      }
      exportDef={() => batchesExport(rows)}
    >
      <DataTable<BatchRow>
        aria-label="Batch Summary"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        onRowActivate={(r) => openItem(r.itemId)}
        loading={q.loading}
        empty={
          win === 'all' ? (
            <NothingHere title="No batches in stock" body="Batch-wise stock appears here for items that keep batches (F11 › Batches, then Maintain in batches on the item)." />
          ) : (
            <NothingHere icon="check-circle" title="Nothing expiring soon" body={`No batch in stock expires by ${formatDate(addDays(period.to, Number(win)))}.`} />
          )
        }
      />
    </ReportScreen>
  );
}
