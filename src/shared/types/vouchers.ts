/**
 * DTOs for the vouchers module (src/core/modules/vouchers) — the voucher posting engine.
 * Full posting rules, sign conventions and the route table live in src/core/modules/vouchers/README.md.
 *
 * Conventions: money is integer paise; ledger amounts are signed (Debit +, Credit −) unless a field
 * says "magnitude"; quantities are in the item's base unit; dates are 'YYYY-MM-DD'.
 */
import type { GstDutyHead, VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { CompanyConfig, CompanyFeatures } from '../settings.ts';
import type { GstNature, InvoiceComputation, RegistrationType, SupplyKind, Taxability } from './gst.ts';

// ───────────────────────────── Enumerations ─────────────────────────────

/**
 * How the voucher is entered:
 *  - item_invoice:       stock-item lines (+ additional ledgers); GST computed by the engine.
 *  - accounting_invoice: ledger lines are the invoice lines (services, expenses); GST computed.
 *  - ledger:             plain Dr/Cr ledger lines (payment, receipt, contra, journal, notes without GST).
 *  - inventory:          stock lines only (delivery/receipt notes, rejections, orders, stock journal, physical stock).
 */
export type VoucherMode = 'item_invoice' | 'accounting_invoice' | 'ledger' | 'inventory';
export const VOUCHER_MODES: readonly VoucherMode[] = ['item_invoice', 'accounting_invoice', 'ledger', 'inventory'];

export type BillRefType = 'new' | 'against' | 'advance' | 'on_account';
export const BILL_REF_TYPES: readonly BillRefType[] = ['new', 'against', 'advance', 'on_account'];

export type InstrumentType = 'cheque' | 'dd' | 'neft' | 'rtgs' | 'imps' | 'upi' | 'card' | 'cash' | 'other';
export const INSTRUMENT_TYPES: readonly InstrumentType[] = ['cheque', 'dd', 'neft', 'rtgs', 'imps', 'upi', 'card', 'cash', 'other'];

/** ledger_entries.role */
export type LedgerEntryRole = 'party' | 'sales' | 'purchase' | 'tax' | 'round_off' | 'charge' | 'cash_bank' | 'other';

export type NumberingMethod = 'automatic' | 'automatic_override' | 'manual' | 'none';
export type NumberingRestart = 'yearly' | 'monthly' | 'never';

/** Guard policy outcome codes and GST/posting checks. `blocking` ones can never be confirmed away. */
export type VoucherWarningCode =
  | 'negative_stock'
  | 'negative_cash'
  | 'credit_limit'
  | 'duplicate_reference'
  | 'gst_missing_gstin'
  | 'gst_missing_hsn'
  | 'gst_missing_rate'
  | 'gst'
  | 'gst_ledger_lines'
  | 'supplier_invoice_required'
  | 'unbalanced'
  | 'cash_bank_required'
  | 'contra_ledger'
  | 'journal_cash_bank'
  | 'zero_value'
  | 'bill_mismatch'
  | 'bill_name_required'
  | 'bill_not_found'
  | 'bill_over_settled'
  | 'duplicate_bill_ref'
  | 'cost_mismatch'
  | 'tracking_ref'
  | 'period_locked';

export interface VoucherWarning {
  code: VoucherWarningCode;
  /** Written for an accountant. */
  message: string;
  /** true → the voucher cannot be saved (rule violation or a guard set to 'block'). */
  blocking: boolean;
  /** Input path of the offending line, e.g. 'items[2]' or 'ledgers[0]' (when known). */
  path?: string;
}

// ───────────────────────────── Input ─────────────────────────────

export interface BillAllocationInput {
  refType: BillRefType;
  /** Required for new / against / advance; ignored for on_account. */
  billName?: string;
  /** Positive magnitude; the stored sign follows the ledger entry it belongs to. */
  amount: Paise;
  creditDays?: number;
  /** Defaults to voucher date + creditDays (new refs). */
  dueDate?: string;
}

export interface CostAllocationInput {
  costCentreId: number;
  /** Positive magnitude; the stored sign follows the ledger entry. */
  amount: Paise;
}

export interface InstrumentInput {
  type: InstrumentType;
  number?: string;
  date?: string;
  bankName?: string;
  favouring?: string;
}

export interface LedgerLineGstInput {
  rate?: number;
  cessRate?: number;
  hsnSac?: string;
  taxability?: Taxability;
  supplyKind?: SupplyKind;
}

export interface LedgerLineInput {
  ledgerId: number;
  /**
   * 'ledger' mode: SIGNED (Dr +, Cr −).
   * Invoice modes: + adds to the invoice value (freight, charges, the income/expense line itself),
   * − reduces it (discount). The engine turns it into the right Dr/Cr for the voucher's base type.
   */
  amount: Paise;
  narration?: string;
  /** For bill-wise ledgers ('ledger' mode). In invoice modes the party uses VoucherInput.partyBillAllocations. */
  billAllocations?: BillAllocationInput[];
  costAllocations?: CostAllocationInput[];
  instrument?: InstrumentInput;
  /** Invoice modes: override the ledger's GST profile for this line. */
  gst?: LedgerLineGstInput;
}

export interface ItemLineInput {
  itemId: number;
  /** Default: Main Location. */
  godownId?: number;
  /** Required when the item maintains batches (and the Batches feature is on). */
  batchName?: string;
  mfgDate?: string;
  expiryDate?: string;
  /**
   * Positive magnitude in the item's base unit; direction comes from the base type
   * (stock journal: isConsumption → out, else in). Physical stock: the COUNTED quantity.
   */
  qty: number;
  altQty?: number;
  /** Quantity billed (Actual & Billed Qty feature); the line value uses it, stock moves by `qty`. */
  billedQty?: number;
  /** Rupees per unit (exclusive of tax unless rateInclusiveOfTax). Default 0. */
  rate: number;
  /** Default: the stock item's rate_inclusive_of_tax flag. */
  rateInclusiveOfTax?: boolean;
  discountPct?: number;
  /** Line value override in paise (instead of qty × rate). */
  amount?: Paise;
  /** Sales/purchase ledger. Default: voucher type config.defaultLedgerId → reserved SALES/PURCHASE. */
  ledgerId?: number;
  description?: string;
  gstRateOverride?: number;
  /** Delivery/receipt note number this line is billed against: the line then does not move stock again. */
  trackingRef?: string;
  /** Sales/purchase order number this line fulfils. */
  orderRef?: string;
  /** Stock journal: consumption (source) side. */
  isConsumption?: boolean;
}

/** Buyer/supplier snapshot overrides (otherwise taken from the party ledger). */
export interface PartySnapshotInput {
  name?: string;
  address?: string;
  stateCode?: string;
  gstin?: string;
  registrationType?: RegistrationType;
  pincode?: string;
}

export interface ConsigneeInput {
  name?: string;
  address?: string;
  stateCode?: string;
  gstin?: string;
  pincode?: string;
}

export interface DispatchDetailsInput {
  docNo?: string;
  through?: string;
  destination?: string;
  vehicleNo?: string;
  transporterId?: string;
  transporterName?: string;
  mode?: string;
  distanceKm?: number;
  lrNo?: string;
  lrDate?: string;
}

export interface OrderDetailsInput {
  orderNo?: string;
  orderDate?: string;
  terms?: string;
  otherRefs?: string;
  buyersOrderNo?: string;
  deliveryNoteNo?: string;
}

export interface ExportDetailsInput {
  shippingBillNo?: string;
  shippingBillDate?: string;
  portCode?: string;
  /** Export / SEZ supply with payment of IGST (default false = under LUT/bond). */
  withPayment?: boolean;
  currency?: string;
  exchangeRate?: number;
}

export interface VoucherInput {
  /** Present → alter. */
  id?: number;
  voucherTypeId: number;
  date: string;
  effectiveDate?: string;
  /** Manual numbering (required) or automatic_override (optional); ignored for automatic. */
  number?: string;
  /** Supplier invoice number for purchases. */
  referenceNo?: string;
  referenceDate?: string;
  narration?: string;
  /** Default: voucher type optional_by_default. */
  isOptional?: boolean;
  isPostDated?: boolean;
  mode: VoucherMode;
  /** Required in invoice modes and for orders/notes/rejections. */
  partyLedgerId?: number;
  party?: PartySnapshotInput;
  consignee?: ConsigneeInput;
  dispatch?: DispatchDetailsInput;
  orderDetails?: OrderDetailsInput;
  exportDetails?: ExportDetailsInput;
  /** Explicit place of supply (state code, '96' for exports). */
  placeOfSupply?: string;
  reverseCharge?: boolean;
  priceLevelId?: number;
  originalInvoiceNo?: string;
  originalInvoiceDate?: string;
  noteReason?: string;
  /** Invoice modes: bill-wise split of the party amount (magnitudes). */
  partyBillAllocations?: BillAllocationInput[];
  items?: ItemLineInput[];
  ledgers?: LedgerLineInput[];
  /** Save even though non-blocking warnings exist (the user confirmed them). */
  acknowledgeWarnings?: boolean;
  /** Alter only: reject with CONFLICT when the voucher's updatedAt differs (optimistic concurrency). */
  expectedUpdatedAt?: string;
}

// ───────────────────────────── Output: preview / save ─────────────────────────────

export interface VoucherTotals {
  /** Σ debit entries (paise). */
  debit: Paise;
  /** Σ |credit entries| (paise). */
  credit: Paise;
  taxable: Paise;
  /** All GST computed on the document (incl. reverse charge). */
  tax: Paise;
  roundOff: Paise;
  /** Invoice value (amount payable by/to the party); ledger mode: Σ debits; inventory: Σ line values. */
  grandTotal: Paise;
}

export interface BillAllocationView {
  refType: BillRefType;
  billName: string | null;
  /** Signed like its ledger entry. */
  amount: Paise;
  creditDays: number | null;
  dueDate: string | null;
}

export interface CostAllocationView {
  costCentreId: number;
  costCentreName?: string;
  /** Signed like its ledger entry. */
  amount: Paise;
}

export interface PreviewEntry {
  ledgerId: number;
  ledgerName: string;
  /** Signed: Dr +, Cr −. */
  amount: Paise;
  role: LedgerEntryRole;
  gstDutyHead: GstDutyHead | null;
  narration: string | null;
  billAllocations: BillAllocationView[];
  costAllocations: CostAllocationView[];
}

export interface PreviewInventoryLine {
  lineNo: number;
  itemId: number;
  itemName: string;
  unit: string;
  godownId: number;
  godownName: string;
  batchName: string | null;
  /** Signed: inward +, outward −. Physical stock: counted − book quantity. */
  qty: number;
  billedQty: number | null;
  rate: number;
  discountPct: number;
  /** Unsigned value (taxable value for invoices, + non-claimable tax capitalised into cost). */
  amount: Paise;
  ledgerId: number | null;
  affectsStock: boolean;
  trackingRef: string | null;
  orderRef: string | null;
  isConsumption: boolean;
  hsnSac: string | null;
  gstRate: number | null;
}

export interface GstLineView {
  lineNo: number;
  source: 'item' | 'ledger';
  itemId: number | null;
  ledgerId: number | null;
  description: string | null;
  hsnSac: string | null;
  uqc: string | null;
  qty: number | null;
  supplyType: SupplyKind;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  /** As on the document (negative for a discount line); never Dr/Cr signed. */
  taxableValue: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  isReverseCharge: boolean;
  itcEligibility: string | null;
}

export interface VoucherPreview {
  /** Number the voucher has (alter) or would get now (create); null for 'none' / blank manual. */
  number: string | null;
  baseType: VoucherBaseType;
  mode: VoucherMode;
  placeOfSupply: string | null;
  gstNature: GstNature | null;
  /**
   * GST engine output (invoice modes), with totals adjusted to the voucher: invoiceValueBeforeRound,
   * roundOff, grandTotal and payableToParty include non-GST charges outside the computation.
   */
  computation: InvoiceComputation | null;
  entries: PreviewEntry[];
  inventory: PreviewInventoryLine[];
  gstLines: GstLineView[];
  totals: VoucherTotals;
  affectsBooks: boolean;
  affectsStock: boolean;
  /** Warnings and (blocking) rule violations. Preview never throws for these; save does. */
  warnings: VoucherWarning[];
}

export interface VoucherSaveResult {
  id: number;
  number: string | null;
  warnings: VoucherWarning[];
  totals: VoucherTotals;
  updatedAt: string;
}

/** details of AppError('BUSINESS_RULE') thrown by save when warnings need confirmation / rules fail. */
export interface VoucherRuleErrorDetails {
  /** true → resubmit with acknowledgeWarnings: true after the user confirms. */
  needsConfirmation?: boolean;
  warnings: VoucherWarning[];
}

// ───────────────────────────── Output: view / list ─────────────────────────────

export interface UserRef {
  id: number | null;
  name: string | null;
}

export interface VoucherDetailEntry {
  id: number;
  lineNo: number;
  ledgerId: number;
  ledgerName: string;
  amount: Paise;
  role: LedgerEntryRole;
  gstDutyHead: GstDutyHead | null;
  narration: string | null;
  instrument: InstrumentInput | null;
  /** Bank reconciliation date (set by the banking module). */
  bankDate: string | null;
  billAllocations: BillAllocationView[];
  costAllocations: CostAllocationView[];
}

export interface VoucherDetail {
  id: number;
  guid: string;
  voucherType: { id: number; name: string; baseType: VoucherBaseType };
  mode: VoucherMode;
  number: string | null;
  numberSeq: number | null;
  date: string;
  effectiveDate: string | null;
  referenceNo: string | null;
  referenceDate: string | null;
  partyLedgerId: number | null;
  partyLedgerName: string | null;
  party: {
    name: string | null;
    address: string | null;
    stateCode: string | null;
    gstin: string | null;
    registrationType: string | null;
    pincode: string | null;
  };
  placeOfSupply: string | null;
  priceLevelId: number | null;
  isOptional: boolean;
  isPostDated: boolean;
  isCancelled: boolean;
  affectsBooks: boolean;
  affectsStock: boolean;
  isReverseCharge: boolean;
  narration: string | null;
  totals: { amount: Paise; taxable: Paise; tax: Paise; roundOff: Paise };
  gstNature: GstNature | null;
  originalInvoiceNo: string | null;
  originalInvoiceDate: string | null;
  noteReason: string | null;
  irn: { irn: string | null; ackNo: string | null; ackDate: string | null; signedQr: string | null; status: string | null };
  ewayBill: { number: string | null; date: string | null; validUpto: string | null };
  consignee: ConsigneeInput | null;
  dispatch: DispatchDetailsInput | null;
  orderDetails: OrderDetailsInput | null;
  exportDetails: ExportDetailsInput | null;
  /** The voucher as entered — send back (with edits) to 'vouchers.save' to alter it. */
  input: VoucherInput;
  entries: VoucherDetailEntry[];
  inventory: PreviewInventoryLine[];
  gstLines: GstLineView[];
  cancellation: { reason: string; at: string; by: string | null } | null;
  createdBy: UserRef;
  createdAt: string;
  updatedBy: UserRef;
  updatedAt: string;
}

export interface VoucherListInput {
  from: string;
  to: string;
  voucherTypeIds?: number[];
  baseTypes?: VoucherBaseType[];
  partyLedgerId?: number;
  /** Vouchers having any ledger entry for this ledger. */
  ledgerId?: number;
  /** Number, reference, narration, party name, or an exact amount ('1,180.00'). */
  search?: string;
  /** Default true (Day Book shows them flagged). */
  includeOptional?: boolean;
  /** Default true. */
  includeCancelled?: boolean;
  onlyPostDated?: boolean;
  sort?: 'date_asc' | 'date_desc';
  /** ≤ 1000, default 200. */
  limit?: number;
  offset?: number;
}

export interface VoucherListRow {
  id: number;
  date: string;
  number: string | null;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  partyLedgerId: number | null;
  /** Party snapshot name, else the first ledger's name. */
  partyName: string | null;
  narration: string | null;
  /** vouchers.total_amount (invoice value / Σ debits / stock value). */
  amount: Paise;
  taxable: Paise;
  tax: Paise;
  referenceNo: string | null;
  gstNature: GstNature | null;
  isOptional: boolean;
  isCancelled: boolean;
  isPostDated: boolean;
  irnStatus: string | null;
}

export interface VoucherListResult {
  rows: VoucherListRow[];
  total: number;
  sums: { amount: Paise };
}

// ───────────────────────────── Bills / party / entry context ─────────────────────────────

export interface PendingBill {
  billName: string;
  /** Date of the originating reference (new/advance/opening). */
  billDate: string;
  dueDate: string | null;
  /** Net pending, signed: Dr + (receivable from the party), Cr − (payable to the party). */
  amount: Paise;
  /** Signed amount of the originating reference(s). */
  originalAmount: Paise;
  source: 'opening' | 'voucher';
  /** Voucher that created the bill (null for opening bills). */
  voucherId: number | null;
}

export interface PartyContext {
  ledgerId: number;
  name: string;
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  gstin: string | null;
  registrationType: RegistrationType | null;
  pan: string | null;
  email: string | null;
  mobile: string | null;
  /** 'debtor' | 'creditor' | 'cash' | 'bank' | 'other' — from the group chain. */
  kind: 'debtor' | 'creditor' | 'cash' | 'bank' | 'other';
  billWise: boolean;
  creditDays: number | null;
  creditLimit: Paise | null;
  /** Closing balance as of the date (books filter), signed Dr +. */
  balance: Paise;
  pendingBills: PendingBill[];
}

export interface VoucherTypeView {
  id: number;
  name: string;
  abbreviation: string | null;
  baseType: VoucherBaseType;
  isActive: boolean;
  numberingMethod: NumberingMethod;
  numberingPrefix: string | null;
  numberingSuffix: string | null;
  numberingStart: number;
  numberingWidth: number;
  numberingRestart: NumberingRestart;
  preventDuplicates: boolean;
  useEffectiveDate: boolean;
  allowZeroValue: boolean;
  optionalByDefault: boolean;
  narrationPerEntry: boolean;
  printAfterSave: boolean;
  config: Record<string, unknown>;
}

export interface VoucherEntryContext {
  voucherType: VoucherTypeView;
  /** Preview of the next automatic number ('' for manual / none). */
  nextNumber: string;
  allowedModes: VoucherMode[];
  defaultMode: VoucherMode;
  today: string;
  company: {
    name: string;
    stateCode: string | null;
    gstin: string | null;
    gstRegistrationType: 'regular' | 'composition' | 'unregistered';
    gstEnabled: boolean;
    booksFrom: string;
    fyStartMonth: number;
    financialYear: { start: string; end: string; label: string };
  };
  features: CompanyFeatures;
  config: Pick<CompanyConfig, 'roundOff' | 'guards' | 'lockedUpTo' | 'gst'> & { printAfterSave: boolean };
  /** Reserved ledger ids (null when absent, e.g. GST ledgers in a non-GST company). */
  ledgers: {
    cash: number | null;
    sales: number | null;
    purchase: number | null;
    roundOff: number | null;
    output: Record<GstDutyHead, number | null>;
    input: Record<GstDutyHead, number | null>;
    rcm: Record<GstDutyHead, number | null>;
  };
  /** Default sales/purchase ledger for item lines (type config → reserved ledger). */
  defaultLedgerId: number | null;
  mainGodownId: number;
  permissions: { canAlter: boolean; canBackdate: boolean; canDelete: boolean };
}

export type TrackingKind = 'delivery' | 'receipt' | 'sales_order' | 'purchase_order';

export interface TrackingDocLine {
  itemId: number;
  itemName: string;
  unit: string;
  godownId: number | null;
  batchName: string | null;
  qty: number;
  pendingQty: number;
  rate: number;
  discountPct: number;
  ledgerId: number | null;
}

export interface TrackingDoc {
  voucherId: number;
  voucherTypeName: string;
  number: string | null;
  date: string;
  /** Value to put into ItemLineInput.trackingRef (notes) or .orderRef (orders). */
  ref: string;
  lines: TrackingDocLine[];
}
