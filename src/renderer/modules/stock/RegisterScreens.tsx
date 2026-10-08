/**
 * Order processing and period registers:
 *   'stock.pendingOrders'    { kind?: 'sales' | 'purchase' }  Pending sales / purchase orders as on a date (Alt+S / Alt+U switch)
 *   'stock.profitability'    { groupId?, from?, to? }         Item-wise gross profit
 *   'stock.physicalVariance' { from?, to? }                   Physical stock count differences
 * Enter opens the order / physical stock voucher, or the item's stock vouchers.
 */
import { useMemo, useState } from 'react';
import type { OrderKind, PendingOrderLine, PhysicalVarianceRow, ProfitabilityRow } from '../../../shared/types/stock.ts';
import { formatPercent, ReportScreen, useApiQuery, useCan, useNav, usePeriod, useShell } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, Field, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { StockGroupPicker } from '../inventory/pickers.tsx';
import { amountColumn, NothingHere, qtyColumn, rateColumn, useDrill, useStockPeriod } from './components.tsx';
import { ORDER_KIND_LABEL, overdueText, paramId, pendingOrdersExport, profitabilityExport, varianceExport } from './lib/model.ts';

// ───────────────────────────── Pending orders ─────────────────────────────

const KINDS: ReadonlyArray<{ value: OrderKind; label: string }> = [
  { value: 'sales', label: 'Sales orders' },
  { value: 'purchase', label: 'Purchase orders' },
];

export function PendingOrdersScreen({ params }: ScreenProps<{ kind?: OrderKind }>) {
  const period = usePeriod();
  const nav = useNav();
  const shell = useShell();
  const canView = useCan('vouchers.view');
  const [kind, setKind] = useState<OrderKind>(params?.kind === 'purchase' ? 'purchase' : 'sales');
  const q = useApiQuery('stock.pendingOrders', { kind, asOf: period.to }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const L = ORDER_KIND_LABEL[kind];
  const base = kind === 'sales' ? 'sales_order' : 'purchase_order';
  const avail = shell.voucherAvailability(base);

  const columns = useMemo<Column<PendingOrderLine>[]>(() => {
    const u = (r: PendingOrderLine) => r.unit;
    return [
      { key: 'orderNo', header: 'Order no.', width: 90 },
      { key: 'orderDate', header: 'Date', kind: 'date', width: 105 },
      { key: 'dueDate', header: 'Due on', kind: 'date', width: 105 },
      { key: 'partyName', header: L.party, minWidth: 160 },
      { key: 'itemName', header: 'Item', minWidth: 160 },
      qtyColumn<PendingOrderLine>('orderedQty', 'Ordered', (r) => r.orderedQty, u, { width: 110 }),
      qtyColumn<PendingOrderLine>('fulfilledQty', L.fulfilled, (r) => r.fulfilledQty, u, { width: 110, blankZero: true }),
      qtyColumn<PendingOrderLine>('pendingQty', 'Pending', (r) => r.pendingQty, u, { width: 110 }),
      rateColumn<PendingOrderLine>('rate', 'Rate', (r) => r.rate),
      { ...amountColumn<PendingOrderLine>('pendingValue', 'Pending value', (r) => r.pendingValue), blankZero: false },
      {
        key: 'overdueDays',
        header: 'Status',
        width: 140,
        value: (r) => r.overdueDays ?? 0,
        render: (r) =>
          r.overdueDays !== null ? (
            <Badge tone="danger" size="sm">
              {overdueText(r.overdueDays)}
            </Badge>
          ) : (
            <span className="bx-muted">{r.dueDate ? 'On time' : 'No due date'}</span>
          ),
      },
    ];
  }, [L]);
  const totals = q.data?.totals;
  const footer = useMemo<FooterRow[]>(
    () => (totals && rows.length > 0 ? [{ key: 'total', tone: 'total', cells: { partyName: `${totals.orders} order${totals.orders === 1 ? '' : 's'} pending`, pendingValue: totals.pendingValue } }] : []),
    [totals, rows.length],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Alt+S', label: 'Sales orders', icon: 'invoice', onClick: () => setKind('sales'), disabled: kind === 'sales', group: 'view' },
    { key: 'Alt+U', label: 'Purchase orders', icon: 'cart', onClick: () => setKind('purchase'), disabled: kind === 'purchase', group: 'view' },
    { key: 'Alt+C', label: kind === 'sales' ? 'New sales order' : 'New purchase order', icon: 'plus', onClick: () => shell.openVoucher(base), disabled: !avail.ok, hint: avail.reason, group: 'go' },
  ];

  return (
    <ReportScreen
      title={`Pending ${L.title}`}
      subtitle={totals && totals.overdueLines > 0 ? `${totals.overdueLines} line${totals.overdueLines === 1 ? '' : 's'} overdue` : undefined}
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open order · Alt+S Sales · Alt+U Purchase · Alt+C New order · Alt+F2 Date · Alt+E Export · Alt+P Print"
      filters={<SegmentedControl<OrderKind> aria-label="Order type" size="sm" options={KINDS} value={kind} onChange={setKind} />}
      exportDef={() => pendingOrdersExport(rows, kind, totals?.pendingValue ?? 0)}
    >
      <DataTable<PendingOrderLine>
        aria-label={`Pending ${L.title}`}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        onRowActivate={(r) => {
          if (canView) nav.push('vouchers.view', { id: r.orderId });
        }}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={
          <NothingHere
            icon="check-circle"
            title={`No pending ${L.title.toLowerCase()}`}
            body={kind === 'sales' ? 'Every customer order up to this date has been delivered or invoiced.' : 'Every order placed with suppliers up to this date has been received or billed.'}
          />
        }
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Profitability ─────────────────────────────

export function ProfitabilityScreen({ params }: ScreenProps<{ groupId?: number; from?: string; to?: string }>) {
  const p = useStockPeriod(params);
  const drill = useDrill();
  const [groupId, setGroupId] = useState<number | undefined>(paramId(params?.groupId));
  const q = useApiQuery('stock.profitability', { from: p.from, to: p.to, groupId }, { keepPrevious: true });
  const d = q.data;
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const columns = useMemo<Column<ProfitabilityRow>[]>(
    () => [
      { key: 'name', header: 'Item', minWidth: 200 },
      { key: 'groupName', header: 'Group', width: 140 },
      qtyColumn<ProfitabilityRow>('netQty', 'Net qty sold', (r) => r.netQty, (r) => r.unit),
      amountColumn<ProfitabilityRow>('salesValue', 'Sales', (r) => r.salesValue),
      amountColumn<ProfitabilityRow>('returnsValue', 'Returns', (r) => r.returnsValue),
      { ...amountColumn<ProfitabilityRow>('netSales', 'Net sales', (r) => r.netSales), blankZero: false },
      { ...amountColumn<ProfitabilityRow>('cost', 'Cost of goods sold', (r) => r.cost, { width: 160 }), blankZero: false },
      { key: 'grossProfit', header: 'Gross profit', kind: 'amount', width: 150, cellClassName: (r) => (r.grossProfit < 0 ? 'bx-stock-loss' : undefined) },
      {
        key: 'gpPercent',
        header: 'GP %',
        kind: 'number',
        width: 90,
        value: (r) => r.gpPercent,
        render: (r) => (r.gpPercent === null ? '' : formatPercent(r.gpPercent)),
      },
    ],
    [],
  );
  const footer = useMemo<FooterRow[]>(
    () =>
      d && rows.length > 0
        ? [{ key: 'total', tone: 'total', cells: { name: 'Total', netSales: d.totals.netSales, cost: d.totals.cost, grossProfit: d.totals.grossProfit, gpPercent: d.totals.gpPercent === null ? '' : formatPercent(d.totals.gpPercent) } }]
        : [],
    [d, rows.length],
  );
  return (
    <ReportScreen
      title="Item Profitability"
      subtitle="Sales less the cost of the goods sold, item by item (before GST)"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Item vouchers · Alt+F2 Period · Alt+E Export · Alt+P Print"
      filters={
        <Field label="Group" layout="inline" labelWidth={48}>
          <StockGroupPicker size="sm" value={groupId ?? null} onChange={(id) => setGroupId(id ?? undefined)} allowCreate={false} placeholder="All groups" aria-label="Stock group" />
        </Field>
      }
      exportDef={d ? () => profitabilityExport(d) : undefined}
    >
      <Stack gap={3} grow>
        <p className="bx-stock-note">Cost is each item’s cost at its costing method; goods on a delivery note are costed when they are invoiced. Returns reduce both sales and cost.</p>
        <DataTable<ProfitabilityRow>
          aria-label="Item Profitability"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.itemId)}
          onRowActivate={(r) => drill({ screen: 'stock.item', params: { itemId: r.itemId, from: p.from, to: p.to } })}
          footerRows={footer.length > 0 ? footer : undefined}
          loading={q.loading}
          empty={<NothingHere icon="chart" title="No item sales in this period" body="Sales invoices with stock items appear here. Change the period with Alt+F2." />}
        />
      </Stack>
    </ReportScreen>
  );
}

// ───────────────────────────── Physical stock variance ─────────────────────────────

export function PhysicalVarianceScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useStockPeriod(params);
  const nav = useNav();
  const shell = useShell();
  const canView = useCan('vouchers.view');
  const q = useApiQuery('stock.physicalVariance', { from: p.from, to: p.to }, { keepPrevious: true });
  const d = q.data;
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const avail = shell.voucherAvailability('physical_stock');
  const columns = useMemo<Column<PhysicalVarianceRow>[]>(() => {
    const u = (r: PhysicalVarianceRow) => r.unit;
    return [
      { key: 'date', header: 'Date', kind: 'date', width: 105 },
      { key: 'number', header: 'Vch no.', width: 80 },
      { key: 'itemName', header: 'Item', minWidth: 180 },
      { key: 'godownName', header: 'Godown', width: 130 },
      { key: 'batchName', header: 'Batch', width: 100 },
      qtyColumn<PhysicalVarianceRow>('countedQty', 'Counted', (r) => r.countedQty, u, { width: 110 }),
      qtyColumn<PhysicalVarianceRow>('bookQty', 'As per books', (r) => r.bookQty, u, { width: 120 }),
      {
        ...qtyColumn<PhysicalVarianceRow>('differenceQty', 'Difference', (r) => r.differenceQty, u, { width: 120 }),
        cellClassName: (r) => (r.differenceQty < 0 ? 'bx-stock-loss' : undefined),
      },
      { key: 'value', header: 'Gain / (loss)', kind: 'amount', width: 150, blankZero: true, cellClassName: (r) => (r.value < 0 ? 'bx-stock-loss' : undefined) },
    ];
  }, []);
  const footer = useMemo<FooterRow[]>(
    () =>
      d && rows.length > 0
        ? [
            { key: 'gain', tone: 'subtle', cells: { itemName: 'Excess found (gain)', value: d.totals.gainValue } },
            { key: 'loss', tone: 'subtle', cells: { itemName: 'Shortage (loss)', value: -d.totals.lossValue } },
            { key: 'net', tone: 'total', cells: { itemName: 'Net gain / (loss)', value: d.totals.netValue } },
          ]
        : [],
    [d, rows.length],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Alt+C', label: 'New count', icon: 'plus', onClick: () => shell.openVoucher('physical_stock'), disabled: !avail.ok, hint: avail.reason ?? 'Enter a physical stock count', group: 'go' },
  ];
  return (
    <ReportScreen
      title="Physical Stock Register"
      subtitle="Counted stock against the books, with the value of each difference at cost"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open voucher · Alt+C New count · Alt+F2 Period · Alt+E Export · Alt+P Print"
      exportDef={() => varianceExport(rows, d?.totals.netValue ?? 0)}
    >
      <DataTable<PhysicalVarianceRow>
        aria-label="Physical Stock Register"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        onRowActivate={(r) => {
          if (canView) nav.push('vouchers.view', { id: r.voucherId });
        }}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={<NothingHere icon="check-circle" title="No physical stock counts in this period" body="Record a count with Physical Stock (Ctrl+F7); differences from the books show here." />}
      />
    </ReportScreen>
  );
}
