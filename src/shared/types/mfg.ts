/**
 * DTOs of the mfg module (Bill of Materials, Manufacturing Journal, job work, ITC-04).
 * Money is integer paise; quantities REAL in the item's base unit; rates rupees per base unit.
 */
import type { Paise } from '../money.ts';
import type { AdditionalCostBasis } from '../mfg/costing.ts';
import type { Itc04Frequency, JobWorkGoodsType, ReturnStatus } from '../mfg/jobwork.ts';

// ───────────────────────────── Godowns (job work ownership) ─────────────────────────────

/** Whose stock a godown holds. */
export const THIRD_PARTY_KINDS = ['none', 'ours_with_party', 'party_with_us'] as const;
export type ThirdPartyKind = (typeof THIRD_PARTY_KINDS)[number];

export const THIRD_PARTY_KIND_LABELS: Readonly<Record<ThirdPartyKind, string>> = {
  none: 'Own premises',
  ours_with_party: 'Our stock with third party',
  party_with_us: 'Third-party stock with us',
};

// ───────────────────────────── Bill of Materials ─────────────────────────────

export const BOM_LINE_KINDS = ['component', 'by_product', 'scrap'] as const;
export type BomLineKind = (typeof BOM_LINE_KINDS)[number];
export const BOM_VALUE_BASES = ['nil', 'rate', 'percent'] as const;
/** Value of a by-product / scrap: none, a rate per unit (₹), or a percentage of the production cost. */
export type BomValueBasis = (typeof BOM_VALUE_BASES)[number];

export interface BomLineInput {
  kind: BomLineKind;
  itemId: number;
  /** Per `outputQty` of the finished item. */
  qty: number;
  godownId?: number | null;
  valueBasis?: BomValueBasis | null;
  /** Rupees per base unit (valueBasis 'rate'). */
  valueRate?: number | null;
  /** Percent of the production cost (valueBasis 'percent'). */
  valuePct?: number | null;
  notes?: string | null;
}

export interface BomSaveInput {
  id?: number;
  itemId: number;
  name: string;
  /** Quantity of the finished item the lines are for (e.g. 100 Nos). */
  outputQty: number;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string | null;
  lines: BomLineInput[];
  /** Alter only: CONFLICT when the BOM changed since it was opened. */
  expectedUpdatedAt?: string;
}

export interface BomLineView {
  lineNo: number;
  kind: BomLineKind;
  itemId: number;
  itemName: string;
  unit: string;
  unitDecimals: number;
  qty: number;
  godownId: number | null;
  godownName: string | null;
  valueBasis: BomValueBasis | null;
  valueRate: number | null;
  valuePct: number | null;
  notes: string | null;
}

export interface BomDetail {
  id: number;
  guid: string;
  itemId: number;
  itemName: string;
  unit: string;
  unitDecimals: number;
  name: string;
  outputQty: number;
  isDefault: boolean;
  isActive: boolean;
  revision: number;
  notes: string | null;
  lines: BomLineView[];
  /** Manufacturing / job work vouchers that used this BOM. */
  usedInVouchers: number;
  createdAt: string;
  updatedAt: string;
}

export interface BomListInput {
  itemId?: number;
  search?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export interface BomListRow {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  name: string;
  outputQty: number;
  isDefault: boolean;
  isActive: boolean;
  revision: number;
  components: number;
  byProducts: number;
  updatedAt: string;
}

export interface BomRevisionRow {
  revision: number;
  changedAt: string;
  changedByName: string | null;
  snapshot: BomDetail;
}

export interface BomCostLine {
  lineNo: number;
  kind: BomLineKind;
  itemId: number;
  itemName: string;
  unit: string;
  /** Scaled to the requested quantity. */
  qty: number;
  /** Current cost (components) or by-product rate, rupees per base unit. */
  rate: number;
  value: Paise;
}

/** Estimated cost of making `qty` of the item with a BOM at current costs (as on `asOf`). */
export interface BomCostResult {
  bomId: number;
  itemId: number;
  qty: number;
  asOf: string;
  lines: BomCostLine[];
  componentCost: Paise;
  byProductValue: Paise;
  estimatedCost: Paise;
  /** Rupees per base unit of the finished item. */
  unitCost: number;
  /** Item master's standard cost (rupees per unit) for comparison, null when not set. */
  standardCost: number | null;
}

// ───────────────────────────── Manufacturing / job work journals ─────────────────────────────

/** Stock journal voucher types with a class (voucher_types.config.stockJournalClass). */
export const STOCK_JOURNAL_CLASSES = ['manufacturing', 'material_out', 'material_in'] as const;
export type StockJournalClass = (typeof STOCK_JOURNAL_CLASSES)[number];

export const STOCK_JOURNAL_CLASS_LABELS: Readonly<Record<StockJournalClass, string>> = {
  manufacturing: 'Manufacturing Journal',
  material_out: 'Material Out',
  material_in: 'Material In',
};

/**
 * Line roles of a classed stock journal:
 *   component    consumed (godown default: Material In → the job worker's godown, else Main Location)
 *   product      the finished goods (one per voucher)
 *   by_product, scrap   produced alongside, valued by `valueBasis`
 *   transfer     goods moved between our godown (`godownId`) and the third-party godown, keeping their
 *                cost: Material Out sends them, Material In brings them back
 *   receipt      a principal's goods received into our 'third-party stock with us' godown (job worker)
 *   issue        a principal's goods sent back from that godown (job worker)
 */
export const STOCK_JOURNAL_ROLES = ['component', 'product', 'by_product', 'scrap', 'transfer', 'receipt', 'issue'] as const;
export type StockJournalRole = (typeof STOCK_JOURNAL_ROLES)[number];

export interface StockJournalLineInput {
  role: StockJournalRole;
  itemId: number;
  qty: number;
  /** Our godown for the line (see the roles). */
  godownId?: number;
  batchName?: string;
  mfgDate?: string;
  expiryDate?: string;
  /** By-products / scrap. */
  valueBasis?: BomValueBasis;
  valueRate?: number;
  valuePct?: number;
  /** Job work: what the goods are for s.143 (default inputs). */
  goodsType?: JobWorkGoodsType;
  /** Job work challan rate (₹ per unit, the taxable value shown on the challan and in ITC-04). Default: current cost. */
  rate?: number;
  /** s.143 time limit extended by the Commissioner up to this date. */
  extendedTo?: string;
  description?: string;
}

export interface AdditionalCostInput {
  /** Expense ledger the cost is booked in (for reference — the journal itself posts no accounting entry). */
  ledgerId?: number;
  label?: string;
  basis: AdditionalCostBasis;
  /** Paise ('amount') or percent of the consumed cost ('percent'). */
  value: number;
}

/** `VoucherInput.stockJournal`: the classed journal as entered; the item lines are derived from it. */
export interface StockJournalExtInput {
  bomId?: number;
  /** Job worker's / principal's godown (Material Out: destination; Material In: source). */
  thirdPartyGodownId?: number;
  jobWorkOrderId?: number;
  /** Nature of job work (process), printed on the challan and in ITC-04. */
  process?: string;
  lines: StockJournalLineInput[];
  additionalCosts?: AdditionalCostInput[];
}

/** Costing estimate of a classed journal at entry time (VoucherPreview.stockJournal). */
export interface StockJournalCostPreview {
  class: StockJournalClass;
  /** Consumed cost of the components (excl. transfers). */
  consumed: Paise;
  transferred: Paise;
  additional: Paise;
  additionalValues: Paise[];
  byProducts: Paise;
  /** Value of the finished goods (residual lines). */
  productValue: Paise;
  productQty: number;
  /** Rupees per base unit of the finished goods. */
  productRate: number;
  /** By-products and scrap exceed the cost: the finished goods get 0. */
  shortfall: Paise;
  /** Estimated value per line of the input block (paise; null = none). */
  lineValues: Array<Paise | null>;
  /** Job work direction derived from the godowns: 'out' = we are the principal, 'in' = we are the job worker. */
  jobWorkDirection: 'out' | 'in' | null;
}

export interface MfgJournalContextInput {
  voucherTypeId: number;
  date: string;
}

export interface StockJournalTypeRow {
  id: number;
  name: string;
  class: StockJournalClass;
  isActive: boolean;
}

export interface GodownKindRow {
  id: number;
  name: string;
  kind: ThirdPartyKind;
  partyLedgerId: number | null;
  partyName: string | null;
}

/** Everything the entry screen needs besides vouchers.entryContext. */
export interface MfgJournalContext {
  voucherType: StockJournalTypeRow;
  types: StockJournalTypeRow[];
  godowns: GodownKindRow[];
  nextNumber: string | null;
  mainGodownId: number;
}

/** A classed journal for alteration / duplication (the stored block, or one rebuilt from its lines). */
export interface MfgJournalDetail {
  id: number | null;
  voucherTypeId: number;
  class: StockJournalClass;
  date: string;
  number: string | null;
  partyLedgerId: number | null;
  narration: string | null;
  isOptional: boolean;
  block: StockJournalExtInput;
  updatedAt: string | null;
}

export interface ProductionRegisterInput {
  from: string;
  to: string;
  itemId?: number;
  bomId?: number;
  class?: StockJournalClass;
}

export interface ProductionRegisterRow {
  voucherId: number;
  date: string;
  number: string | null;
  typeName: string;
  class: StockJournalClass;
  itemId: number | null;
  itemName: string | null;
  unit: string | null;
  qty: number;
  bomName: string | null;
  partyName: string | null;
  /** Engine values (the figures of the stock reports). */
  consumed: Paise;
  additional: Paise;
  byProducts: Paise;
  productValue: Paise;
  /** Rupees per unit. */
  productRate: number;
  /** BOM estimate at today's cost of the same quantity (standard vs actual), null without a BOM. */
  bomEstimate: Paise | null;
}

export interface ProductionRegisterResult {
  from: string;
  to: string;
  rows: ProductionRegisterRow[];
  totals: { consumed: Paise; additional: Paise; byProducts: Paise; productValue: Paise };
}

// ───────────────────────────── Job work orders ─────────────────────────────

export type JobWorkDirection = 'out' | 'in';

export interface JobWorkOrderLineInput {
  itemId: number;
  qty: number;
  goodsType?: JobWorkGoodsType;
}

export interface JobWorkOrderSaveInput {
  id?: number;
  direction: JobWorkDirection;
  /** Blank → next number. */
  number?: string;
  date: string;
  partyLedgerId: number;
  godownId?: number | null;
  itemId?: number | null;
  qty?: number | null;
  bomId?: number | null;
  dueDate?: string | null;
  process?: string | null;
  /** Job charges, rupees per unit of the product. */
  rate?: number | null;
  status?: 'open' | 'closed';
  narration?: string | null;
  lines: JobWorkOrderLineInput[];
  expectedUpdatedAt?: string;
}

export interface JobWorkOrderLineView {
  lineNo: number;
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  goodsType: JobWorkGoodsType;
  /** Sent to the job worker against this order (Material Out) / received from the principal (Material In). */
  sentQty: number;
  /** Consumed or returned at the job worker against this order. */
  returnedQty: number;
}

export interface JobWorkOrderDetail {
  id: number;
  guid: string;
  direction: JobWorkDirection;
  number: string;
  date: string;
  partyLedgerId: number;
  partyName: string;
  godownId: number | null;
  godownName: string | null;
  itemId: number | null;
  itemName: string | null;
  unit: string | null;
  qty: number | null;
  bomId: number | null;
  bomName: string | null;
  dueDate: string | null;
  process: string | null;
  rate: number | null;
  status: 'open' | 'closed';
  narration: string | null;
  lines: JobWorkOrderLineView[];
  /** Product received against the order (Material In) — or, for an In order, sent back to the principal. */
  productDoneQty: number;
  vouchers: Array<{ id: number; date: string; number: string | null; typeName: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface JobWorkOrderListInput {
  direction?: JobWorkDirection;
  partyLedgerId?: number;
  status?: 'open' | 'closed' | 'all';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface JobWorkOrderListRow {
  id: number;
  direction: JobWorkDirection;
  number: string;
  date: string;
  partyName: string;
  itemName: string | null;
  unit: string | null;
  qty: number | null;
  productDoneQty: number;
  pendingQty: number | null;
  dueDate: string | null;
  status: 'open' | 'closed';
  overdue: boolean;
}

// ───────────────────────────── Pending job work / s.143 ─────────────────────────────

export interface PendingJobWorkInput {
  asOf: string;
  /** 'out': our goods with job workers (principal); 'in': principals' goods with us (job worker). */
  direction?: JobWorkDirection;
  partyLedgerId?: number;
  /** Days before the due date that count as "due soon" (default 30). */
  warnDays?: number;
  onlyAlerts?: boolean;
}

/** One challan line still (partly) with the job worker, FIFO against what came back. */
export interface PendingJobWorkRow {
  key: string;
  direction: JobWorkDirection;
  voucherId: number;
  lineNo: number;
  challanNo: string | null;
  sentOn: string;
  partyLedgerId: number | null;
  partyName: string | null;
  godownId: number;
  godownName: string;
  itemId: number;
  itemName: string;
  unit: string;
  goodsType: JobWorkGoodsType;
  sentQty: number;
  returnedQty: number;
  pendingQty: number;
  /** Challan value of the pending quantity (paise). */
  pendingValue: Paise;
  dueDate: string | null;
  daysLeft: number | null;
  status: ReturnStatus;
  ageDays: number;
  orderNo: string | null;
}

export interface PendingJobWorkResult {
  asOf: string;
  rows: PendingJobWorkRow[];
  /** Quantities in third-party godowns that no challan explains (e.g. opening stock there). */
  unexplained: Array<{ godownId: number; godownName: string; itemId: number; itemName: string; unit: string; qty: number }>;
  counts: { overdue: number; dueSoon: number; total: number };
  overdueValue: Paise;
}

/** s.143 alerts for the Gateway banner / dashboard. */
export interface JobWorkAlerts {
  asOf: string;
  overdue: number;
  dueSoon: number;
  overdueValue: Paise;
  nextDue: string | null;
}

// ───────────────────────────── ITC-04 ─────────────────────────────

export interface Itc04Input {
  from: string;
  to: string;
}

/** Table 4: inputs / capital goods sent to a job worker (one row per challan line). */
export interface Itc04SentRow {
  jobWorkerGstin: string | null;
  jobWorkerState: string | null;
  jobWorkerName: string | null;
  challanNo: string | null;
  challanDate: string;
  goodsType: JobWorkGoodsType;
  description: string;
  hsn: string | null;
  uqc: string;
  qty: number;
  taxableValue: Paise;
  igstRate: number;
  cgstRate: number;
  sgstRate: number;
  cessRate: number;
  voucherId: number;
}

/** Tables 5A / 5B / 5C: goods received back, sent to another job worker, supplied from the job worker's premises. */
export interface Itc04ReturnRow {
  table: '5A' | '5B' | '5C';
  jobWorkerGstin: string | null;
  jobWorkerState: string | null;
  jobWorkerName: string | null;
  /** Challan / invoice of the movement (Material In number, sales invoice number …). */
  docNo: string | null;
  docDate: string;
  originalChallanNo: string | null;
  originalChallanDate: string | null;
  description: string;
  uqc: string;
  qty: number;
  /** Goods received back after processing (5A), when different from the goods sent. */
  receivedDescription: string | null;
  receivedUqc: string | null;
  receivedQty: number | null;
  lossesQty: number;
  natureOfJobWork: string | null;
  voucherId: number;
}

export interface Itc04Result {
  from: string;
  to: string;
  frequency: Itc04Frequency | null;
  dueDate: string | null;
  sent: Itc04SentRow[];
  returned: Itc04ReturnRow[];
  warnings: string[];
}
