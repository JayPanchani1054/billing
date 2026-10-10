/**
 * DTOs of the documents module (src/core/modules/documents): quotations / proforma invoices and
 * their conversion, recurring vouchers, sales / purchase bills pending, order pre-close, scenarios
 * and budgets. Routes and rules: src/core/modules/documents/README.md.
 *
 * Money is integer paise; ledger-style amounts are signed Dr + / Cr −; dates 'YYYY-MM-DD'.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { VoucherInput } from './vouchers.ts';

// ───────────────────────────── Quotations / proforma ─────────────────────────────

export type DocumentBaseType = 'quotation' | 'proforma';
export const DOCUMENT_BASE_TYPES: readonly DocumentBaseType[] = ['quotation', 'proforma'];

/**
 * open: awaiting the customer · accepted / rejected: recorded by the user · expired: open and past its
 * "valid until" date · converted: a live (not cancelled) sales order / invoice was made from it ·
 * cancelled: the document itself was cancelled.
 */
export type DocumentStatus = 'open' | 'accepted' | 'rejected' | 'expired' | 'converted' | 'cancelled';
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['open', 'accepted', 'rejected', 'expired', 'converted', 'cancelled'];
/** Statuses a user can set (expired / converted / cancelled are derived). */
export type DocumentDecision = 'open' | 'accepted' | 'rejected';
export const DOCUMENT_DECISIONS: readonly DocumentDecision[] = ['open', 'accepted', 'rejected'];

/** Which documents a source may be converted into (one-key conversion). */
export const CONVERSION_TARGETS: Readonly<Record<DocumentBaseType, readonly VoucherBaseType[]>> = {
  quotation: ['sales_order', 'sales'],
  proforma: ['sales'],
};

export interface VoucherRef {
  id: number;
  number: string | null;
  date: string;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  isCancelled: boolean;
}

export interface DocumentListInput {
  baseType: DocumentBaseType;
  from: string;
  to: string;
  status?: DocumentStatus;
  partyLedgerId?: number;
  search?: string;
  limit?: number;
}

export interface DocumentRow {
  id: number;
  number: string | null;
  date: string;
  validUntil: string | null;
  /** Days until valid-until (negative once expired); null without a date. */
  daysToExpiry: number | null;
  voucherTypeName: string;
  partyLedgerId: number | null;
  partyName: string | null;
  /** Document value (invoice value incl. tax). */
  amount: Paise;
  status: DocumentStatus;
  statusReason: string | null;
  /** The live voucher it was converted into (latest), if any. */
  convertedTo: VoucherRef | null;
}

export interface DocumentListResult {
  baseType: DocumentBaseType;
  rows: DocumentRow[];
  truncated: boolean;
  summary: {
    count: number;
    value: Paise;
    byStatus: Record<DocumentStatus, { count: number; value: Paise }>;
    /** converted ÷ (all − cancelled) × 100, 2 decimals; null when there is nothing to convert. */
    conversionRatePct: number | null;
  };
}

export interface DocumentStatusInput {
  id: number;
  status: DocumentDecision;
  reason?: string;
}

/** Links of any voucher, for the voucher view (Alt+V convert, Alt+R make recurring, pre-close). */
export interface VoucherLinks {
  voucherId: number;
  baseType: VoucherBaseType;
  /** Quotation / proforma only. */
  document: { status: DocumentStatus; validUntil: string | null; reason: string | null; targets: VoucherBaseType[] } | null;
  /** The quotation / proforma this voucher was converted from. */
  convertedFrom: VoucherRef | null;
  /** Vouchers converted from this one (cancelled ones flagged). */
  convertedTo: VoucherRef[];
  /** Reversing journal only. */
  applicableUpto: string | null;
  /** Posted from a recurring template. */
  recurring: { templateId: number; templateName: string; periodKey: string } | null;
  /** Recurring templates made from this voucher. */
  templates: Array<{ id: number; name: string; isActive: boolean }>;
  /** Sales / purchase orders: pre-closed balances. */
  closures: OrderClosureRow[];
}

/**
 * 'documents.draft' — a VoucherInput pre-filled from a source (no id / number), either
 *  - a document: `sourceId` + `targetBaseType` (conversion of a quotation / proforma, or billing a note), or
 *  - a recurring occurrence: `templateId` + `periodKey` (Edit & post).
 */
export interface DraftInput {
  /** Quotation / proforma (conversion), delivery / receipt note or rejection (billing). */
  sourceId?: number;
  targetBaseType?: VoucherBaseType;
  templateId?: number;
  periodKey?: string;
  /** A company-defined type of the target base; default: the predefined one. */
  voucherTypeId?: number;
  /** Default: today (the entry screen puts its working date in). */
  date?: string;
}

// ───────────────────────────── Recurring vouchers ─────────────────────────────

export type RecurringFrequency = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'every_n_days';
export const RECURRING_FREQUENCIES: readonly RecurringFrequency[] = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'every_n_days'];

export interface RecurringSchedule {
  frequency: RecurringFrequency;
  /** every_n_days only (1–366). */
  intervalDays?: number | null;
  /** Month-based frequencies: 1–31, or 0 = last day of the month. Default: the start date's day. */
  dayOfMonth?: number | null;
  startDate: string;
  /** Inclusive; null/absent = no end. */
  endDate?: string | null;
}

export interface RecurringTemplateRow extends RecurringSchedule {
  id: number;
  name: string;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  partyName: string | null;
  /** The template's value (invoice value / Σ debits) as last previewed, paise; null when not computable. */
  amount: Paise | null;
  /** The single amount an override replaces (see README › Amount override); null = override not possible. */
  overridable: boolean;
  isActive: boolean;
  sourceVoucherId: number | null;
  notes: string | null;
  /** First occurrence not yet posted or skipped (null when the schedule has ended). */
  nextDate: string | null;
  lastPosted: { date: string; voucherId: number; number: string | null } | null;
  postedCount: number;
  skippedCount: number;
}

export interface RecurringTemplateDetail extends RecurringTemplateRow {
  /** The voucher the template posts (no id / number / date). */
  input: VoucherInput;
  /** Latest occurrences dealt with (posted / skipped), newest first. */
  runs: RecurringRunRow[];
}

export interface RecurringRunRow {
  periodKey: string;
  scheduledDate: string;
  status: 'posted' | 'skipped';
  voucher: VoucherRef | null;
  createdAt: string;
}

export interface RecurringSaveInput extends RecurringSchedule {
  id?: number;
  name: string;
  /** Create: the saved voucher to copy (any voucher type, memorandum included). Alter: re-copy it. */
  sourceVoucherId?: number;
  /** Replace the template's single amount (README › Amount override), paise. */
  amount?: Paise;
  isActive?: boolean;
  notes?: string;
}

/** 'documents.recurring.fromVoucher' — suggested template for a saved voucher (nothing saved). */
export interface RecurringSuggestion extends RecurringSchedule {
  name: string;
  sourceVoucherId: number;
  voucherTypeId: number;
  voucherTypeName: string;
  amount: Paise;
  overridable: boolean;
  /** Why some details are not carried over (cheque numbers, bill references, supplier invoice no.). */
  notes: string[];
}

export interface RecurringDueRow {
  /** `${templateId}|${periodKey}` */
  key: string;
  templateId: number;
  templateName: string;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  partyName: string | null;
  periodKey: string;
  date: string;
  /** Days past the scheduled date (0 = due today). */
  overdueDays: number;
  amount: Paise | null;
  overridable: boolean;
}

export interface RecurringDueResult {
  asOf: string;
  rows: RecurringDueRow[];
  /** A template had more than the listed catch-up occurrences (oldest first). */
  truncated: boolean;
}

export interface RecurringPostItem {
  templateId: number;
  periodKey: string;
  /** Default: the scheduled date. */
  date?: string;
  /** Replace the single amount for this occurrence only (paise). */
  amount?: Paise;
}

export interface RecurringPostInput {
  items: RecurringPostItem[];
  acknowledgeWarnings?: boolean;
}

export type RecurringPostOutcome =
  | { templateId: number; periodKey: string; ok: true; voucherId: number; number: string | null; date: string }
  | { templateId: number; periodKey: string; ok: false; code: string; message: string; needsConfirmation: boolean };

export interface RecurringPostResult {
  posted: number;
  failed: number;
  results: RecurringPostOutcome[];
}

// ───────────────────────────── Bills pending ─────────────────────────────

export type BillsPendingKind = 'sales' | 'purchase';
export const BILLS_PENDING_KINDS: readonly BillsPendingKind[] = ['sales', 'purchase'];

export interface BillsPendingInput {
  kind: BillsPendingKind;
  asOf: string;
  partyLedgerId?: number;
  itemId?: number;
}

export interface BillsPendingRow {
  /** `n:<noteId>:<lineNo>` */
  key: string;
  noteId: number;
  noteNo: string | null;
  noteDate: string;
  /** delivery_note / rejection_in (sales) · receipt_note / rejection_out (purchase). */
  noteBaseType: VoucherBaseType;
  noteTypeName: string;
  /** The voucher that bills it: sales / credit_note / purchase / debit_note. */
  invoiceBaseType: VoucherBaseType;
  partyLedgerId: number | null;
  partyName: string;
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  billedQty: number;
  pendingQty: number;
  rate: number;
  discountPct: number;
  pendingValue: Paise;
  ageDays: number;
}

export interface BillsPendingResult {
  kind: BillsPendingKind;
  asOf: string;
  rows: BillsPendingRow[];
  /** olderThan7Days: delivery / receipt notes (not rejections) with a line unbilled for more than 7 days. */
  totals: { notes: number; parties: number; pendingValue: Paise; olderThan7Days: number };
}

// ───────────────────────────── Order pre-close ─────────────────────────────

export interface OrderClosureRow {
  orderId: number;
  itemId: number;
  itemName: string;
  unit: string;
  closedQty: number;
  date: string;
  reason: string;
  createdAt: string;
  createdBy: string | null;
}

export interface OrderPrecloseInput {
  orderId: number;
  /** Default: today. On or after the order date. */
  date?: string;
  reason: string;
  /** Default: every item's whole pending balance. `qty` default: the item's pending balance. */
  items?: Array<{ itemId: number; qty?: number }>;
}

export interface OrderReopenInput {
  orderId: number;
  /** Default: every closed item of the order. */
  itemId?: number;
}

// ───────────────────────────── Scenarios ─────────────────────────────

export interface ScenarioRow {
  id: number;
  name: string;
  includeActuals: boolean;
  includeTypeIds: number[];
  excludeTypeIds: number[];
  /** Names, for lists. */
  includeTypes: string[];
  excludeTypes: string[];
}

export interface ScenarioSaveInput {
  id?: number;
  name: string;
  includeActuals: boolean;
  /** Voucher types whose provisional vouchers (memorandum, reversing journal, optional) are included. */
  includeTypeIds: number[];
  /** Voucher types whose regular vouchers are left out (only with includeActuals). */
  excludeTypeIds: number[];
}

// ───────────────────────────── Budgets ─────────────────────────────

export type BudgetBasis = 'net_transactions' | 'closing_balance';
export const BUDGET_BASES: readonly BudgetBasis[] = ['net_transactions', 'closing_balance'];
export type BudgetLineKind = 'group' | 'ledger' | 'cost_centre';
export const BUDGET_LINE_KINDS: readonly BudgetLineKind[] = ['group', 'ledger', 'cost_centre'];

export interface BudgetLineInput {
  kind: BudgetLineKind;
  refId: number;
  basis: BudgetBasis;
  /** Signed paise, Dr + / Cr − (an expense or asset budget is Dr, income or liability Cr). */
  amount: Paise;
}

export interface BudgetLineView extends BudgetLineInput {
  name: string;
  /** Group path / cost category, for display. */
  under: string | null;
}

export interface BudgetRow {
  id: number;
  name: string;
  from: string;
  to: string;
  notes: string | null;
  lineCount: number;
}

export interface BudgetDetail extends BudgetRow {
  lines: BudgetLineView[];
}

export interface BudgetSaveInput {
  id?: number;
  name: string;
  from: string;
  to: string;
  notes?: string;
  lines: BudgetLineInput[];
}

export interface BudgetVarianceInput {
  budgetId: number;
  /** Default: the budget period. */
  from?: string;
  to?: string;
  scenarioId?: number;
}

export interface BudgetVarianceRow {
  key: string;
  kind: BudgetLineKind;
  refId: number;
  name: string;
  under: string | null;
  basis: BudgetBasis;
  /** Budget for the report period (net-transaction budgets pro-rated by days), Dr + / Cr −. */
  budget: Paise;
  /** Net transactions in the period, or the closing balance at `to` (Trial-Balance rule), Dr + / Cr −. */
  actual: Paise;
  /** actual − budget, Dr + / Cr −. */
  variance: Paise;
  /** variance ÷ |budget| × 100 (2 decimals); null for a zero budget. */
  variancePct: number | null;
  /** Actual beyond the budget on the budget's own side (spent / earned more than budgeted). */
  overBudget: boolean;
  /**
   * (additive) Counted in `totals`: false for a line already inside another line's figure — a ledger or
   * group under a budgeted group, a cost centre under a budgeted centre — and for cost-centre lines when
   * the budget also has group / ledger lines (cost centres split the same ledger amounts).
   */
  inTotal?: boolean;
}

export interface BudgetVarianceResult {
  budget: BudgetRow;
  from: string;
  to: string;
  /** Share of the budget period the report covers (1 = whole period). */
  proRata: number;
  rows: BudgetVarianceRow[];
  /** Σ of the rows with `inTotal` (each amount counted once). */
  totals: { budget: Paise; actual: Paise; variance: Paise };
}

/** 'documents.budget.columns' — budget per report row key ('g:<id>', 'l:<id>') for TB / P&L / BS. */
export interface BudgetColumnsInput {
  budgetId: number;
  from: string;
  to: string;
}

export interface BudgetColumnsResult {
  budgetId: number;
  name: string;
  /** Dr + / Cr − per row key; groups without a line of their own roll up their ledgers and sub-groups. */
  byKey: Record<string, Paise>;
  /**
   * (additive) Basis of each `byKey` entry: what the budget is compared with — the period's nett
   * transactions (Dr − Cr) or the closing balance; 'mixed' for a group rolling up lines of both bases.
   */
  basisByKey?: Record<string, BudgetBasis | 'mixed'>;
  proRata: number;
}

// ───────────────────────────── Summary (dashboard / Gateway) ─────────────────────────────

export interface DocumentsSummary {
  asOf: string;
  recurringDue: number;
  recurringDueValue: Paise;
  quotationsOpen: number;
  /** Open quotations / proforma expiring within 7 days. */
  quotationsExpiringSoon: number;
  /** Delivery notes with an unbilled balance older than 7 days. */
  unbilledDeliveryNotes: number;
  unbilledValue: Paise;
}
