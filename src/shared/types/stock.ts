/**
 * DTOs for the stock (inventory reports) module — src/core/modules/stock. All routes are company
 * scope, read-only, `transactional: false`, `reports.view` (`stock.profitability`: `reports.financial`).
 *
 *   'stock.summary'           StockSummaryInput        → StockSummaryResult       stock groups → items: opening / inward / outward / closing
 *   'stock.categorySummary'   StockCategorySummaryInput → StockSummaryResult      the same by stock category
 *   'stock.itemVouchers'      StockItemVouchersInput   → StockItemVouchersResult  stock item ledger with running quantity / value
 *   'stock.godownSummary'     GodownSummaryInput       → GodownSummaryResult      godowns → items with closing quantity / value
 *   'stock.movement'          StockMovementInput       → StockMovementResult      inward from / outward to each party
 *   'stock.ageing'            StockAgeingInput         → StockAgeingResult        closing stock by age of its inward (FIFO layers)
 *   'stock.reorder'           ReorderStatusInput       → ReorderStatusResult      items below reorder level with pending orders
 *   'stock.negative'          NegativeStockInput       → NegativeStockResult      items / godowns with negative stock
 *   'stock.batches'           BatchSummaryInput        → BatchSummaryResult       batch balances with expiry status
 *   'stock.pendingOrders'     PendingOrdersInput       → PendingOrdersResult      sales / purchase orders: ordered vs delivered / received
 *   'stock.profitability'     ProfitabilityInput       → ProfitabilityResult      item-wise sales, cost of goods sold, gross profit
 *   'stock.physicalVariance'  PhysicalVarianceInput    → PhysicalVarianceResult   physical stock count differences register
 *
 * Conventions: quantities are in each item's base unit (inward +, outward − in the books; the
 * reports show unsigned inward/outward columns and a signed closing). Every `value` is integer
 * paise. `rate` is rupees per base unit (value ÷ qty, 4 decimals). A quantity that cannot be added
 * up (a group of items in different units) is `null`. Dates are ISO 'YYYY-MM-DD'.
 * Valuation follows each item's costing method (see src/core/modules/inventory/README.md).
 */
import type { CostingMethod } from './inventory.ts';

export type { CostingMethod };

export interface QtyValue {
  /** Base-unit quantity; null when the rows add up items of different units. */
  qty: number | null;
  /** Paise. */
  value: number;
}

export interface ClosingQtyValue extends QtyValue {
  /** Rupees per base unit (value ÷ qty); null when the quantity is null or 0. */
  rate: number | null;
}

// ───────────────────────────── Stock summary ─────────────────────────────

export interface StockSummaryInput {
  from: string;
  to: string;
  /** Only this stock group (its sub-groups and items become the top level). */
  groupId?: number;
  /** Only items of this stock category (or its sub-categories). */
  categoryId?: number;
  /** Quantities of this godown and the godowns under it (values at the item's overall unit cost). */
  godownId?: number;
  /** Default true. false → quantities only (no valuation is run; every value is 0, valuesShown false). */
  showValues?: boolean;
  /** Also list items (and groups) with nothing in the period. Default false. */
  showZero?: boolean;
}

export interface StockCategorySummaryInput {
  from: string;
  to: string;
  godownId?: number;
  showValues?: boolean;
  showZero?: boolean;
}

export type StockSummaryRowKind = 'group' | 'category' | 'item';

export interface StockSummaryRow {
  /** 'g:<id>' group, 'c:<id>' category ('c:none' = items without a category), 'i:<id>' item. */
  key: string;
  kind: StockSummaryRowKind;
  /** Group / category / item id; null for the "No category" bucket. */
  id: number | null;
  name: string;
  /** 0 = top level. Rows are in display (pre-order) order. */
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
  /** Item unit; for a group/category the common unit when its quantities add up, else null. */
  unit: string | null;
  /** Items only. */
  costingMethod: CostingMethod | null;
  opening: QtyValue;
  inward: QtyValue;
  outward: QtyValue;
  closing: ClosingQtyValue;
}

export interface StockSummaryResult {
  from: string;
  to: string;
  groupId: number | null;
  categoryId: number | null;
  godownId: number | null;
  /** false when the report was asked without values (showValues: false). */
  valuesShown: boolean;
  rows: StockSummaryRow[];
  /** Paise, of the rows shown (top-level rows added up). */
  totals: { openingValue: number; inwardValue: number; outwardValue: number; closingValue: number };
}

// ───────────────────────────── Stock item vouchers ─────────────────────────────

export interface StockItemVouchersInput {
  itemId: number;
  from: string;
  to: string;
  /** Movements of this godown and the godowns under it. */
  godownId?: number;
}

export interface StockItemVoucherRow {
  /** 'v:<voucherId>'. One row per voucher (all its lines of the item added up). */
  key: string;
  voucherId: number;
  date: string;
  voucherTypeName: string;
  baseType: string;
  number: string | null;
  /** Party name, or what the voucher did ("Stock Journal", "Physical stock count"). */
  particulars: string;
  /** Godown name(s) of the lines (comma separated when several). */
  godowns: string;
  inward: { qty: number; value: number };
  outward: { qty: number; value: number };
  /** Running balance after this voucher (at the end of its day it equals the Stock Summary's closing). */
  closing: { qty: number; value: number };
}

export interface StockItemVouchersResult {
  item: {
    id: number;
    name: string;
    unit: string;
    unitDecimals: number;
    groupId: number | null;
    groupName: string | null;
    costingMethod: CostingMethod;
    isService: boolean;
  };
  from: string;
  to: string;
  godownId: number | null;
  opening: { qty: number; value: number };
  rows: StockItemVoucherRow[];
  totals: { inwardQty: number; inwardValue: number; outwardQty: number; outwardValue: number };
  closing: { qty: number; value: number; rate: number | null };
}

// ───────────────────────────── Godown summary ─────────────────────────────

export interface GodownSummaryInput {
  /** Only this godown and the godowns under it. */
  godownId?: number;
  asOf: string;
  /** Also list godowns that hold nothing. Default false. */
  showZero?: boolean;
}

export interface GodownSummaryRow {
  /** 'gd:<godownId>' godown, 'gi:<godownId>:<itemId>' item in that godown. */
  key: string;
  kind: 'godown' | 'item';
  godownId: number;
  itemId: number | null;
  name: string;
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
  unit: string | null;
  /** Items: quantity in this godown (exactly). Godowns: null (items have different units). */
  qty: number | null;
  rate: number | null;
  /** Paise. A godown's value includes its sub-godowns. */
  value: number;
  isThirdParty: boolean;
}

export interface GodownSummaryResult {
  asOf: string;
  godownId: number | null;
  rows: GodownSummaryRow[];
  totalValue: number;
}

// ───────────────────────────── Movement analysis ─────────────────────────────

export interface StockMovementInput {
  from: string;
  to: string;
  /** One item, or … */
  itemId?: number;
  /** … the items of a stock group (and its sub-groups). Neither → every item. */
  groupId?: number;
}

export interface MovementItemRow {
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  /** Paise: taxable line value (excluding GST). */
  value: number;
  /** Rupees per unit (value ÷ qty); null when qty is 0. */
  avgRate: number | null;
}

export interface MovementPartyRow {
  /** 'p:<ledgerId>' ('p:0' when the voucher has no party ledger). */
  key: string;
  partyLedgerId: number | null;
  partyName: string;
  /** Null when the items are in different units. */
  qty: number | null;
  value: number;
  avgRate: number | null;
  /** Vouchers with this party in the period. */
  vouchers: number;
  items: MovementItemRow[];
}

export interface MovementSide {
  rows: MovementPartyRow[];
  qty: number | null;
  value: number;
  avgRate: number | null;
}

export interface StockMovementResult {
  from: string;
  to: string;
  itemId: number | null;
  groupId: number | null;
  /** Common unit of the items in scope, else null. */
  unit: string | null;
  /** Purchases, receipt notes, rejections in and sales returns (credit notes), by party. */
  inward: MovementSide;
  /** Sales, delivery notes, rejections out and purchase returns (debit notes), by party. */
  outward: MovementSide;
  /** Quantities moved without a party (stock journals, physical stock), for reference. */
  internal: { inwardQty: number | null; outwardQty: number | null; vouchers: number };
}

// ───────────────────────────── Ageing ─────────────────────────────

export interface StockAgeingInput {
  asOf: string;
  /** Upper bounds of the age buckets in days, ascending (default [30, 60, 90, 180] → 0–30, 31–60, 61–90, 91–180, over 180). */
  buckets?: number[];
  groupId?: number;
}

export interface AgeingBucket {
  label: string;
  fromDays: number;
  /** Null for the last (open-ended) bucket. */
  toDays: number | null;
}

export interface StockAgeingRow {
  itemId: number;
  name: string;
  unit: string;
  groupId: number | null;
  groupName: string | null;
  qty: number;
  value: number;
  /** One entry per bucket, same order as StockAgeingResult.buckets. */
  buckets: Array<{ qty: number; value: number }>;
  /** Date of the oldest inward still in stock. */
  oldestDate: string;
  /** Quantity-weighted average age in days (whole days). */
  averageAgeDays: number;
}

export interface StockAgeingResult {
  asOf: string;
  buckets: AgeingBucket[];
  rows: StockAgeingRow[];
  totals: { value: number; buckets: number[] };
}

// ───────────────────────────── Reorder status ─────────────────────────────

export interface ReorderStatusInput {
  asOf: string;
}

export interface ReorderRow {
  itemId: number;
  name: string;
  unit: string;
  groupName: string | null;
  closingQty: number;
  reorderLevel: number;
  minOrderQty: number | null;
  /** Ordered from suppliers but not yet received. */
  pendingPurchaseQty: number;
  /** Ordered by customers but not yet delivered. */
  pendingSalesQty: number;
  /** closing + pending purchase − pending sales. */
  netAvailable: number;
  /** max(0, reorder level − net available). Rows with stock on hand below the level but covered by open purchase orders show 0. */
  shortfall: number;
  /** Quantity to order: the shortfall, at least the minimum order quantity. */
  suggestedQty: number;
}

export interface ReorderStatusResult {
  asOf: string;
  rows: ReorderRow[];
  /** Items that have a reorder level set (to tell "nothing short" from "no levels set"). */
  itemsWithLevel: number;
}

// ───────────────────────────── Negative stock ─────────────────────────────

export interface NegativeStockInput {
  asOf: string;
}

export interface NegativeGodownRow {
  godownId: number;
  godownName: string;
  qty: number;
  /** First day of the current negative run in this godown. */
  negativeSince: string | null;
}

export interface NegativeStockRow {
  itemId: number;
  name: string;
  unit: string;
  groupName: string | null;
  /** All godowns together. */
  qty: number;
  /** Closing value (paise) — negative when the quantity is. */
  value: number;
  negativeSince: string | null;
  /** Godowns where this item is below zero (the item total may still be positive). */
  godowns: NegativeGodownRow[];
}

export interface NegativeStockResult {
  asOf: string;
  rows: NegativeStockRow[];
}

// ───────────────────────────── Batches ─────────────────────────────

export interface BatchSummaryInput {
  itemId?: number;
  asOf: string;
  /** Only batches that have expired or expire within this many days of asOf. */
  expiringWithinDays?: number;
}

export type BatchStatus = 'expired' | 'expiring' | 'ok' | 'no_expiry';

export interface BatchRow {
  /** 'b:<itemId>:<batch name>' */
  key: string;
  itemId: number;
  itemName: string;
  unit: string;
  batchName: string;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number;
  /** expiry − asOf in days (negative once expired); null without expiry. */
  daysToExpiry: number | null;
  status: BatchStatus;
}

export interface BatchSummaryResult {
  asOf: string;
  /** The window used for 'expiring' (expiringWithinDays, default 30). */
  windowDays: number;
  rows: BatchRow[];
}

// ───────────────────────────── Pending orders ─────────────────────────────

export type OrderKind = 'sales' | 'purchase';
export const ORDER_KINDS: readonly OrderKind[] = ['sales', 'purchase'];

export interface PendingOrdersInput {
  kind: OrderKind;
  asOf: string;
}

export interface PendingOrderLine {
  /** 'o:<voucherId>:<lineNo>' */
  key: string;
  orderId: number;
  orderNo: string | null;
  orderDate: string;
  /** The order's "due on" (effective) date, when entered. */
  dueDate: string | null;
  /** Days past the due date as of asOf (> 0 only). */
  overdueDays: number | null;
  partyLedgerId: number | null;
  partyName: string;
  itemId: number;
  itemName: string;
  unit: string;
  orderedQty: number;
  /** Delivered (sales) or received (purchase) against the order up to asOf. */
  fulfilledQty: number;
  pendingQty: number;
  /** Rupees per unit (before tax). */
  rate: number;
  discountPct: number;
  /** Paise: pendingQty × rate less discount. */
  pendingValue: number;
}

export interface PendingOrdersResult {
  kind: OrderKind;
  asOf: string;
  rows: PendingOrderLine[];
  totals: { orders: number; pendingValue: number; overdueLines: number };
}

// ───────────────────────────── Profitability ─────────────────────────────

export interface ProfitabilityInput {
  from: string;
  to: string;
  groupId?: number;
}

export interface ProfitabilityRow {
  itemId: number;
  name: string;
  unit: string;
  groupId: number | null;
  groupName: string | null;
  /** Invoiced (sales vouchers in the books). */
  salesQty: number;
  salesValue: number;
  /** Sales returns (credit notes with items). */
  returnsQty: number;
  returnsValue: number;
  netQty: number;
  /** salesValue − returnsValue (paise, taxable value excl. GST). */
  netSales: number;
  /** Cost of goods sold: cost of goods sent to customers less cost of goods returned. */
  cost: number;
  grossProfit: number;
  /** grossProfit ÷ netSales × 100, 2 decimals; null when there are no net sales. */
  gpPercent: number | null;
}

export interface ProfitabilityResult {
  from: string;
  to: string;
  groupId: number | null;
  rows: ProfitabilityRow[];
  totals: { netSales: number; cost: number; grossProfit: number; gpPercent: number | null };
}

// ───────────────────────────── Physical stock variance ─────────────────────────────

export interface PhysicalVarianceInput {
  from: string;
  to: string;
}

export interface PhysicalVarianceRow {
  /** 'pv:<voucherId>:<lineNo>' */
  key: string;
  voucherId: number;
  date: string;
  number: string | null;
  itemId: number;
  itemName: string;
  unit: string;
  godownName: string | null;
  batchName: string | null;
  /** Quantity counted (as entered on the voucher). */
  countedQty: number | null;
  /** Book quantity at the time of the count (counted − difference). */
  bookQty: number | null;
  /** counted − book: + excess found, − shortage. */
  differenceQty: number;
  /** Paise at cost: + gain, − loss. */
  value: number;
}

export interface PhysicalVarianceResult {
  from: string;
  to: string;
  rows: PhysicalVarianceRow[];
  totals: { gainValue: number; lossValue: number; netValue: number };
}
