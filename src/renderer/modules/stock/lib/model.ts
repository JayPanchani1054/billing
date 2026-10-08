/**
 * Pure logic of the stock report screens (no React): period from params, tree helpers, drill-down
 * targets, quantity text, status labels and the export/print tables of every report. Amounts are
 * integer paise throughout; export amount columns carry paise (the exporter formats them).
 */
import { formatIndianNumber } from '../../../../shared/format.ts';
import { formatDate } from '../../../../shared/dates.ts';
import type {
  BatchRow,
  BatchStatus,
  GodownSummaryRow,
  MovementPartyRow,
  NegativeStockRow,
  OrderKind,
  PendingOrderLine,
  PhysicalVarianceRow,
  ProfitabilityResult,
  ReorderRow,
  StockAgeingResult,
  StockItemVouchersResult,
  StockSummaryRow,
} from '../../../../shared/types/stock.ts';

export interface Range {
  from: string;
  to: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `{ from, to }` from screen params when both are ISO dates in order (drill-down), else null. */
export function paramsPeriod(params: { from?: unknown; to?: unknown } | null | undefined): Range | null {
  const from = params?.from;
  const to = params?.to;
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO.test(from) || !ISO.test(to) || from > to) return null;
  return { from, to };
}

/** A positive integer id from params, else undefined. */
export function paramId(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

// ───────────────────────────── Trees ─────────────────────────────

export interface TreeRowLike {
  key: string;
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
}

export function parentKeys(rows: readonly TreeRowLike[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.hasChildren) out.add(r.key);
  return out;
}

/** Parent rows with level < maxLevel (0 → all collapsed, 99 → all open). */
export function keysUpToLevel(rows: readonly TreeRowLike[], maxLevel: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.hasChildren && r.level < maxLevel) out.add(r.key);
  return out;
}

/** Rows whose every ancestor is expanded, in order (what is on screen → what is exported). */
export function visibleRows<T extends TreeRowLike>(rows: readonly T[], expanded: ReadonlySet<string>): T[] {
  const shown = new Map<string, boolean>();
  const known = new Set(rows.map((r) => r.key));
  const out: T[] = [];
  for (const r of rows) {
    let visible = true;
    if (r.parentKey !== null && known.has(r.parentKey)) visible = (shown.get(r.parentKey) ?? false) && expanded.has(r.parentKey);
    shown.set(r.key, visible);
    if (visible) out.push(r);
  }
  return out;
}

// ───────────────────────────── Text ─────────────────────────────

/** Decimals needed to show a quantity exactly (0–4): 12 → 0, 2.5 → 1, 0.125 → 3. */
export function qtyDecimals(q: number): number {
  for (let d = 0; d < 4; d++) {
    if (Math.abs(q * 10 ** d - Math.round(q * 10 ** d)) < 1e-6) return d;
  }
  return 4;
}

/** '1,250 Nos', '12.5 Kg', '-5 Nos'; '' for null. Zero → '' when blankZero. */
export function qtyText(qty: number | null | undefined, unit: string | null | undefined, opts: { blankZero?: boolean } = {}): string {
  if (qty === null || qty === undefined || !Number.isFinite(qty)) return '';
  if (opts.blankZero && Math.abs(qty) < 1e-9) return '';
  const s = formatIndianNumber(qty, qtyDecimals(qty));
  return unit ? `${s} ${unit}` : s;
}

/** Rate text (₹ per unit, 2–4 decimals) or ''. */
export function rateText(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '';
  const four = rate.toFixed(4).replace(/0{1,2}$/, '');
  const decimals = Math.max(2, (four.split('.')[1] ?? '').length);
  return formatIndianNumber(rate, decimals);
}

export function batchStatusInfo(status: BatchStatus): { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' } {
  switch (status) {
    case 'expired':
      return { label: 'Expired', tone: 'danger' };
    case 'expiring':
      return { label: 'Expiring soon', tone: 'warning' };
    case 'ok':
      return { label: 'Good', tone: 'success' };
    default:
      return { label: 'No expiry', tone: 'neutral' };
  }
}

/** '15 days left', 'Expires today', 'Expired 5 days ago', ''. */
export function expiryText(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'Expires today';
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} left`;
  const n = -days;
  return `Expired ${n} day${n === 1 ? '' : 's'} ago`;
}

export function overdueText(days: number | null): string {
  if (days === null || days <= 0) return '';
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

export const ORDER_KIND_LABEL: Record<OrderKind, { title: string; fulfilled: string; party: string }> = {
  sales: { title: 'Sales Orders', fulfilled: 'Delivered', party: 'Customer' },
  purchase: { title: 'Purchase Orders', fulfilled: 'Received', party: 'Supplier' },
};

export interface AgeingPreset {
  id: string;
  label: string;
  buckets: number[];
}

export const AGEING_PRESETS: readonly AgeingPreset[] = [
  { id: 'standard', label: '30 / 60 / 90 / 180 days', buckets: [30, 60, 90, 180] },
  { id: 'short', label: '15 / 30 / 45 / 60 days', buckets: [15, 30, 45, 60] },
  { id: 'long', label: '90 / 180 / 365 days', buckets: [90, 180, 365] },
];

// ───────────────────────────── Drill-down ─────────────────────────────

export interface DrillTarget {
  screen: string;
  params: Record<string, unknown>;
}

/** Stock Summary / Category Summary row → sub-summary of a group / category, or the item's vouchers. */
export function summaryDrill(row: StockSummaryRow, ctx: { from: string; to: string; godownId?: number }): DrillTarget | null {
  const base: Record<string, unknown> = { from: ctx.from, to: ctx.to };
  if (ctx.godownId !== undefined) base.godownId = ctx.godownId;
  if (row.kind === 'item' && row.id !== null) return { screen: 'stock.item', params: { ...base, itemId: row.id } };
  if (row.kind === 'group' && row.id !== null) return { screen: 'stock.summary', params: { ...base, groupId: row.id } };
  if (row.kind === 'category' && row.id !== null) return { screen: 'stock.summary', params: { ...base, categoryId: row.id } };
  return null;
}

/** Godown Summary row → the item's vouchers in that godown, or the Stock Summary of the godown. */
export function godownDrill(row: GodownSummaryRow, range: Range): DrillTarget {
  if (row.kind === 'item' && row.itemId !== null) return { screen: 'stock.item', params: { itemId: row.itemId, godownId: row.godownId, from: range.from, to: range.to } };
  return { screen: 'stock.summary', params: { godownId: row.godownId, from: range.from, to: range.to } };
}

// ───────────────────────────── Movement analysis tree ─────────────────────────────

export interface MovementTreeRow extends TreeRowLike {
  kind: 'party' | 'item';
  partyLedgerId: number | null;
  itemId: number | null;
  name: string;
  unit: string | null;
  qty: number | null;
  value: number;
  avgRate: number | null;
  vouchers: number | null;
}

/** Party rows with their items as children. */
export function movementTree(parties: readonly MovementPartyRow[]): MovementTreeRow[] {
  const out: MovementTreeRow[] = [];
  for (const p of parties) {
    out.push({
      key: p.key,
      level: 0,
      parentKey: null,
      hasChildren: p.items.length > 0,
      kind: 'party',
      partyLedgerId: p.partyLedgerId,
      itemId: null,
      name: p.partyName,
      unit: p.items.length > 0 && p.qty !== null ? p.items[0].unit : null,
      qty: p.qty,
      value: p.value,
      avgRate: p.avgRate,
      vouchers: p.vouchers,
    });
    for (const it of p.items) {
      out.push({
        key: `${p.key}:i:${it.itemId}`,
        level: 1,
        parentKey: p.key,
        hasChildren: false,
        kind: 'item',
        partyLedgerId: p.partyLedgerId,
        itemId: it.itemId,
        name: it.itemName,
        unit: it.unit,
        qty: it.qty,
        value: it.value,
        avgRate: it.avgRate,
        vouchers: null,
      });
    }
  }
  return out;
}

export function movementDrill(row: MovementTreeRow, range: Range): DrillTarget | null {
  if (row.kind === 'item' && row.itemId !== null) return { screen: 'stock.item', params: { itemId: row.itemId, from: range.from, to: range.to } };
  if (row.kind === 'party' && row.partyLedgerId !== null) return { screen: 'reports.ledger', params: { ledgerId: row.partyLedgerId, from: range.from, to: range.to } };
  return null;
}

// ───────────────────────────── Negative stock tree ─────────────────────────────

export interface NegativeTreeRow extends TreeRowLike {
  kind: 'item' | 'godown';
  itemId: number;
  godownId: number | null;
  name: string;
  unit: string;
  qty: number;
  value: number | null;
  negativeSince: string | null;
}

export function negativeTree(rows: readonly NegativeStockRow[]): NegativeTreeRow[] {
  const out: NegativeTreeRow[] = [];
  for (const r of rows) {
    const key = `n:${r.itemId}`;
    out.push({ key, level: 0, parentKey: null, hasChildren: r.godowns.length > 0, kind: 'item', itemId: r.itemId, godownId: null, name: r.name, unit: r.unit, qty: r.qty, value: r.value, negativeSince: r.negativeSince });
    for (const g of r.godowns) {
      out.push({ key: `${key}:g:${g.godownId}`, level: 1, parentKey: key, hasChildren: false, kind: 'godown', itemId: r.itemId, godownId: g.godownId, name: g.godownName, unit: r.unit, qty: g.qty, value: null, negativeSince: g.negativeSince });
    }
  }
  return out;
}

// ───────────────────────────── Export tables ─────────────────────────────

export type Cell = string | number | null;

export interface ExportColumnDef {
  header: string;
  kind?: 'text' | 'amount' | 'drcr' | 'qty' | 'number' | 'date' | 'percent';
  width?: number;
  decimals?: number;
}

export interface ExportTable {
  columns: ExportColumnDef[];
  rows: Cell[][];
  totals?: Cell[];
  levels?: number[];
  notes?: string;
  landscape?: boolean;
}

/** Stock Summary / Category Summary (visible rows). Detailed adds opening / inward / outward. */
export function summaryExport(rows: readonly StockSummaryRow[], opts: { detailed: boolean; valuesShown: boolean; totals: { openingValue: number; inwardValue: number; outwardValue: number; closingValue: number } }): ExportTable {
  const cols: ExportColumnDef[] = [{ header: 'Particulars', width: 34 }, { header: 'Unit', width: 8 }];
  const groups: Array<{ label: string; pick: (r: StockSummaryRow) => { qty: number | null; value: number }; total: number }> = [];
  if (opts.detailed) {
    groups.push({ label: 'Opening', pick: (r) => r.opening, total: opts.totals.openingValue });
    groups.push({ label: 'Inward', pick: (r) => r.inward, total: opts.totals.inwardValue });
    groups.push({ label: 'Outward', pick: (r) => r.outward, total: opts.totals.outwardValue });
  }
  groups.push({ label: 'Closing', pick: (r) => r.closing, total: opts.totals.closingValue });
  for (const g of groups) {
    cols.push({ header: `${g.label} qty`, kind: 'qty', decimals: 3 });
    if (g.label === 'Closing' && opts.valuesShown) cols.push({ header: 'Rate', kind: 'number', decimals: 2 });
    if (opts.valuesShown) cols.push({ header: `${g.label} value`, kind: 'amount' });
  }
  const out: Cell[][] = rows.map((r) => {
    const cells: Cell[] = [r.name, r.unit ?? ''];
    for (const g of groups) {
      const v = g.pick(r);
      cells.push(v.qty);
      if (g.label === 'Closing' && opts.valuesShown) cells.push(r.closing.rate);
      if (opts.valuesShown) cells.push(v.value);
    }
    return cells;
  });
  let totals: Cell[] | undefined;
  if (opts.valuesShown) {
    totals = ['Grand Total', ''];
    for (const g of groups) {
      totals.push(null);
      if (g.label === 'Closing') totals.push(null);
      totals.push(g.total);
    }
  }
  return { columns: cols, rows: out, totals, levels: rows.map((r) => r.level), landscape: opts.detailed };
}

export function itemVouchersExport(d: StockItemVouchersResult): ExportTable {
  const columns: ExportColumnDef[] = [
    { header: 'Date', kind: 'date' },
    { header: 'Particulars', width: 28 },
    { header: 'Voucher type', width: 14 },
    { header: 'Voucher no.', width: 10 },
    { header: 'Inward qty', kind: 'qty', decimals: 3 },
    { header: 'Inward value', kind: 'amount' },
    { header: 'Outward qty', kind: 'qty', decimals: 3 },
    { header: 'Outward value', kind: 'amount' },
    { header: 'Closing qty', kind: 'qty', decimals: 3 },
    { header: 'Closing value', kind: 'amount' },
  ];
  const rows: Cell[][] = [[d.from, 'Opening balance', '', '', null, null, null, null, d.opening.qty, d.opening.value]];
  for (const r of d.rows) {
    rows.push([r.date, r.particulars, r.voucherTypeName, r.number ?? '', r.inward.qty || null, r.inward.value || null, r.outward.qty || null, r.outward.value || null, r.closing.qty, r.closing.value]);
  }
  return {
    columns,
    rows,
    totals: ['', 'Closing balance', '', '', d.totals.inwardQty, d.totals.inwardValue, d.totals.outwardQty, d.totals.outwardValue, d.closing.qty, d.closing.value],
    notes: `Quantities in ${d.item.unit}. Values at cost (${costingLabel(d.item.costingMethod)}).`,
    landscape: true,
  };
}

export function costingLabel(m: string): string {
  switch (m) {
    case 'fifo':
      return 'FIFO';
    case 'lifo':
      return 'LIFO';
    case 'last_purchase':
      return 'Last purchase cost';
    case 'std_cost':
      return 'Standard cost';
    default:
      return 'Average cost';
  }
}

export function godownExport(rows: readonly GodownSummaryRow[], total: number): ExportTable {
  return {
    columns: [{ header: 'Particulars', width: 34 }, { header: 'Quantity', kind: 'qty', decimals: 3 }, { header: 'Unit', width: 8 }, { header: 'Rate', kind: 'number', decimals: 2 }, { header: 'Value', kind: 'amount' }],
    rows: rows.map((r) => [r.name, r.qty, r.unit ?? '', r.rate, r.value]),
    levels: rows.map((r) => r.level),
    totals: ['Grand Total', null, '', null, total],
  };
}

export function movementExport(rows: readonly MovementTreeRow[], side: { value: number; qty: number | null }, label: string): ExportTable {
  return {
    columns: [{ header: label, width: 32 }, { header: 'Vouchers', kind: 'number' }, { header: 'Quantity', kind: 'qty', decimals: 3 }, { header: 'Unit', width: 8 }, { header: 'Avg. rate', kind: 'number', decimals: 2 }, { header: 'Value', kind: 'amount' }],
    rows: rows.map((r) => [r.name, r.vouchers, r.qty, r.unit ?? '', r.avgRate, r.value]),
    levels: rows.map((r) => r.level),
    totals: ['Total', null, side.qty, '', null, side.value],
  };
}

export function ageingExport(d: StockAgeingResult, show: 'value' | 'qty'): ExportTable {
  const columns: ExportColumnDef[] = [{ header: 'Item', width: 30 }, { header: 'Group', width: 18 }, { header: 'Quantity', kind: 'qty', decimals: 3 }, { header: 'Unit', width: 8 }, { header: 'Value', kind: 'amount' }];
  for (const b of d.buckets) columns.push(show === 'value' ? { header: b.label, kind: 'amount' } : { header: b.label, kind: 'qty', decimals: 3 });
  columns.push({ header: 'Average age (days)', kind: 'number' });
  return {
    columns,
    rows: d.rows.map((r) => [r.name, r.groupName ?? '', r.qty, r.unit, r.value, ...r.buckets.map((b) => (show === 'value' ? b.value : b.qty)), r.averageAgeDays]),
    totals: ['Total', '', null, '', d.totals.value, ...d.totals.buckets.map((v) => (show === 'value' ? v : null)), null],
    landscape: d.buckets.length > 4,
  };
}

export function reorderExport(rows: readonly ReorderRow[]): ExportTable {
  return {
    columns: [
      { header: 'Item', width: 28 },
      { header: 'Unit', width: 8 },
      { header: 'In stock', kind: 'qty', decimals: 3 },
      { header: 'Reorder level', kind: 'qty', decimals: 3 },
      { header: 'On order (purchase)', kind: 'qty', decimals: 3 },
      { header: 'Promised (sales orders)', kind: 'qty', decimals: 3 },
      { header: 'Net available', kind: 'qty', decimals: 3 },
      { header: 'Shortfall', kind: 'qty', decimals: 3 },
      { header: 'Order now', kind: 'qty', decimals: 3 },
    ],
    rows: rows.map((r) => [r.name, r.unit, r.closingQty, r.reorderLevel, r.pendingPurchaseQty, r.pendingSalesQty, r.netAvailable, r.shortfall, r.suggestedQty]),
    landscape: true,
  };
}

export function negativeExport(rows: readonly NegativeTreeRow[]): ExportTable {
  return {
    columns: [{ header: 'Item / godown', width: 32 }, { header: 'Quantity', kind: 'qty', decimals: 3 }, { header: 'Unit', width: 8 }, { header: 'Value', kind: 'amount' }, { header: 'Negative since', kind: 'date' }],
    rows: rows.map((r) => [r.name, r.qty, r.unit, r.value, r.negativeSince]),
    levels: rows.map((r) => r.level),
  };
}

export function batchesExport(rows: readonly BatchRow[]): ExportTable {
  return {
    columns: [
      { header: 'Item', width: 26 },
      { header: 'Batch', width: 14 },
      { header: 'Mfg. date', kind: 'date' },
      { header: 'Expiry date', kind: 'date' },
      { header: 'Quantity', kind: 'qty', decimals: 3 },
      { header: 'Unit', width: 8 },
      { header: 'Days to expiry', kind: 'number' },
      { header: 'Status', width: 14 },
    ],
    rows: rows.map((r) => [r.itemName, r.batchName, r.mfgDate, r.expiryDate, r.qty, r.unit, r.daysToExpiry, batchStatusInfo(r.status).label]),
  };
}

export function pendingOrdersExport(rows: readonly PendingOrderLine[], kind: OrderKind, totalValue: number): ExportTable {
  const L = ORDER_KIND_LABEL[kind];
  return {
    columns: [
      { header: 'Order no.', width: 10 },
      { header: 'Order date', kind: 'date' },
      { header: 'Due on', kind: 'date' },
      { header: L.party, width: 24 },
      { header: 'Item', width: 24 },
      { header: 'Ordered', kind: 'qty', decimals: 3 },
      { header: L.fulfilled, kind: 'qty', decimals: 3 },
      { header: 'Pending', kind: 'qty', decimals: 3 },
      { header: 'Unit', width: 8 },
      { header: 'Rate', kind: 'number', decimals: 2 },
      { header: 'Pending value', kind: 'amount' },
      { header: 'Overdue (days)', kind: 'number' },
    ],
    rows: rows.map((r) => [r.orderNo ?? '', r.orderDate, r.dueDate, r.partyName, r.itemName, r.orderedQty, r.fulfilledQty, r.pendingQty, r.unit, r.rate, r.pendingValue, r.overdueDays]),
    totals: ['Total', null, null, '', '', null, null, null, '', null, totalValue, null],
    landscape: true,
  };
}

export function profitabilityExport(d: ProfitabilityResult): ExportTable {
  return {
    columns: [
      { header: 'Item', width: 28 },
      { header: 'Group', width: 18 },
      { header: 'Net qty sold', kind: 'qty', decimals: 3 },
      { header: 'Unit', width: 8 },
      { header: 'Sales', kind: 'amount' },
      { header: 'Returns', kind: 'amount' },
      { header: 'Net sales', kind: 'amount' },
      { header: 'Cost of goods sold', kind: 'amount' },
      { header: 'Gross profit', kind: 'amount' },
      { header: 'GP %', kind: 'percent', decimals: 2 },
    ],
    rows: d.rows.map((r) => [r.name, r.groupName ?? '', r.netQty, r.unit, r.salesValue, r.returnsValue, r.netSales, r.cost, r.grossProfit, r.gpPercent]),
    totals: ['Total', '', null, '', null, null, d.totals.netSales, d.totals.cost, d.totals.grossProfit, d.totals.gpPercent],
    notes: 'Sales and returns are taxable values (before GST). Cost is at each item’s costing method.',
    landscape: true,
  };
}

export function varianceExport(rows: readonly PhysicalVarianceRow[], net: number): ExportTable {
  return {
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher no.', width: 10 },
      { header: 'Item', width: 26 },
      { header: 'Godown', width: 16 },
      { header: 'Batch', width: 12 },
      { header: 'Counted', kind: 'qty', decimals: 3 },
      { header: 'As per books', kind: 'qty', decimals: 3 },
      { header: 'Difference', kind: 'qty', decimals: 3 },
      { header: 'Unit', width: 8 },
      { header: 'Value (gain / loss)', kind: 'amount' },
    ],
    rows: rows.map((r) => [r.date, r.number ?? '', r.itemName, r.godownName ?? '', r.batchName ?? '', r.countedQty, r.bookQty, r.differenceQty, r.unit, r.value]),
    totals: ['', '', 'Net gain / (loss)', '', '', null, null, null, '', net],
    landscape: true,
  };
}

/** "1 Apr 2026 – 30 Apr 2026" style subtitle helper for filters. */
export function filterSubtitle(parts: ReadonlyArray<string | null | undefined>): string | undefined {
  const s = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' · ');
  return s === '' ? undefined : s;
}

export function asOnLabel(date: string): string {
  return `As on ${formatDate(date)}`;
}
