/**
 * DTOs of the POS module (src/core/modules/pos): counter billing on a Sales voucher type of the POS
 * class (voucher_types.config.posInvoice), split tender, change, held bills, returns / exchanges by
 * credit note and the day-end summary. Money is integer paise; amounts are positive magnitudes unless
 * a field says "signed". Quantities are in the item's base unit; rates are rupees per base unit.
 *
 * Posting stays in the vouchers module: a POS bill is an ordinary Sales voucher (POS return: Credit
 * Note) whose `VoucherInput.posBill` block is turned into ledger entries by the pos voucher hook
 * (src/core/modules/pos/hook.ts) — see src/core/modules/pos/README.md.
 */
import type { Paise } from '../money.ts';

// ───────────────────────────── Tender modes ─────────────────────────────

/**
 * How a customer pays. `exchange` is the system mode of exchange credit (goods returned now, taken in
 * goods on a later bill): its ledger is the system ledger "POS Exchange Credit" (Current Liabilities).
 */
export type PosTenderKind = 'cash' | 'card' | 'upi' | 'wallet' | 'other' | 'exchange';
export const POS_TENDER_KINDS: readonly PosTenderKind[] = ['cash', 'card', 'upi', 'wallet', 'other', 'exchange'];
/** Kinds the user can create (exchange is the system mode). */
export const POS_USER_TENDER_KINDS: readonly PosTenderKind[] = ['cash', 'card', 'upi', 'wallet', 'other'];

export const POS_TENDER_KIND_LABELS: Readonly<Record<PosTenderKind, string>> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  wallet: 'Wallet',
  other: 'Other',
  exchange: 'Exchange credit',
};

export interface PosTenderMode {
  id: number;
  name: string;
  kind: PosTenderKind;
  /** Ledger debited with what the customer pays this way (credited with a refund). */
  ledgerId: number;
  ledgerName: string;
  sortOrder: number;
  isActive: boolean;
  /** The exchange-credit mode (created by the system; its kind and ledger cannot change). */
  isSystem: boolean;
  /** Bills / returns that used the mode (a used mode can be deactivated, not deleted). */
  usedCount: number;
}

export interface PosTenderModeSaveInput {
  id?: number;
  name: string;
  /** Not 'exchange'. */
  kind: PosTenderKind;
  ledgerId: number;
  sortOrder?: number;
  isActive?: boolean;
}

// ───────────────────────────── Settings ─────────────────────────────

export interface PosSettings {
  /** POS Sales voucher type the counter opens with (a Sales type with config.posInvoice). */
  saleVoucherTypeId: number | null;
  /** Credit Note type used for returns / exchanges from a POS bill. */
  returnVoucherTypeId: number | null;
  /** Party of a bill without a customer (walk-in): a Cash-in-Hand ledger. null → the reserved Cash ledger. */
  walkInLedgerId: number | null;
  /** Price level the counter prices at (Price levels feature); null → the item's selling price. */
  priceLevelId: number | null;
  /** Godown the counter sells from (Multiple godowns); null → Main Location. */
  godownId: number | null;
  /** Send the receipt to the printer after each bill (direct to the counter's receipt printer when chosen). */
  printAfterSave: boolean;
  /** Ask for the customer's mobile number before the first item (else the bill starts at the scan field). */
  askCustomerFirst: boolean;
}

export const DEFAULT_POS_SETTINGS: PosSettings = {
  saleVoucherTypeId: null,
  returnVoucherTypeId: null,
  walkInLedgerId: null,
  priceLevelId: null,
  godownId: null,
  printAfterSave: true,
  askCustomerFirst: false,
};

export type PosSettingsInput = Partial<PosSettings>;

export interface PosNamedRef {
  id: number;
  name: string;
}

/** Everything the counter needs, in one call. */
export interface PosContext {
  /** F11 › POS invoicing. */
  enabled: boolean;
  settings: PosSettings;
  /** Active POS Sales voucher types (config.posInvoice). */
  saleTypes: Array<PosNamedRef & { abbreviation: string | null }>;
  /** Active Credit Note types (returns). */
  returnTypes: PosNamedRef[];
  /** The resolved defaults (settings, else the first type / the reserved Cash ledger). */
  saleVoucherTypeId: number | null;
  returnVoucherTypeId: number | null;
  walkIn: PosNamedRef | null;
  /** Active tender modes in order (the exchange mode only once its ledger exists). */
  tenderModes: PosTenderMode[];
  priceLevel: PosNamedRef | null;
  godown: PosNamedRef | null;
  /** Company state (default place of supply of an over-the-counter sale). */
  companyStateCode: string | null;
  gstEnabled: boolean;
  /** Permissions of the user at the counter. */
  can: { bill: boolean; alter: boolean; createCustomer: boolean; manage: boolean; backdate: boolean };
}

// ───────────────────────────── Voucher input / preview ─────────────────────────────

export interface PosTenderInput {
  modeId: number;
  /** Amount applied to the bill (sale) or refunded / credited (return), > 0. */
  amount: Paise;
  /** Card slip / UPI transaction reference (printed and kept with the ledger entry). */
  reference?: string;
  /** Sale with the exchange mode: the POS return (credit note) whose exchange credit is used. */
  exchangeVoucherId?: number;
}

/**
 * `VoucherInput.posBill` — a POS bill (Sales voucher of a POS type) or a POS return (Credit Note).
 *  - Sale: each tender debits its ledger; the party keeps only what is not paid (credit, needs a
 *    customer — never the walk-in cash party), with a bill-wise reference named after the bill.
 *  - Return: each tender credits its ledger (refund); the exchange mode issues exchange credit; the
 *    rest is credited to the party.
 */
export interface VoucherPosInput {
  tenders: PosTenderInput[];
  /** Cash handed over by the customer (≥ the cash tenders); the difference is the change due. */
  cashTendered?: Paise;
  /** Return: the POS bill the goods come back from. */
  returnOfId?: number;
  /** Counter / till name (free text, printed and summarised). */
  counter?: string;
}

export interface PosTenderView {
  modeId: number;
  name: string;
  kind: PosTenderKind;
  ledgerId: number;
  ledgerName: string;
  /** Magnitude. */
  amount: Paise;
  reference: string | null;
  exchangeVoucherId: number | null;
}

/** `VoucherPreview.posBill` and the saved bill's tender detail. */
export interface PosBillView {
  kind: 'sale' | 'return';
  /** Invoice value (credit note value for a return). */
  billValue: Paise;
  /** Σ tenders. */
  paid: Paise;
  /** billValue − paid: left on the customer's account (sale) / credited to the customer (return). */
  credit: Paise;
  cashTendered: Paise | null;
  change: Paise;
  tenders: PosTenderView[];
  returnOfId: number | null;
  counter: string | null;
}

// ───────────────────────────── Item lookup (scan) ─────────────────────────────

export interface PosItemLookupInput {
  /** Barcode, part number, alias or exact name as scanned / typed. */
  code: string;
  date: string;
  priceLevelId?: number;
  godownId?: number;
}

export interface PosPriceSlab {
  qtyFrom: number;
  /** null = no upper limit. */
  qtyTo: number | null;
  /** Rupees per base unit. */
  rate: number;
  discountPct: number;
}

export interface PosItem {
  itemId: number;
  name: string;
  /** How the code matched. */
  matchedBy: 'barcode' | 'part_no' | 'alias' | 'name';
  barcode: string | null;
  partNo: string | null;
  unit: string;
  unitDecimals: number;
  /** Paise per base unit, inclusive of all taxes (Legal Metrology). */
  mrp: Paise | null;
  /** Selling price (rupees per base unit) — the default rate. */
  sellingRate: number;
  /** Price-level slabs on the date (empty without a price level / list). */
  slabs: PosPriceSlab[];
  rateInclusiveOfTax: boolean;
  gstRate: number | null;
  isService: boolean;
  maintainBatches: boolean;
  /** Quantity on hand in the counter's godown (null for services). */
  stock: number | null;
}

export interface PosItemLookupResult {
  /** The item when exactly one matched. */
  item: PosItem | null;
  /** Several items share the code (e.g. alias = another item's part no.): choose one. */
  candidates: Array<{ itemId: number; name: string; matchedBy: PosItem['matchedBy'] }>;
}

// ───────────────────────────── Customers ─────────────────────────────

export interface PosCustomer {
  ledgerId: number;
  name: string;
  mobile: string | null;
  stateCode: string | null;
  gstin: string | null;
  groupName: string;
}

export interface PosCustomerCreateInput {
  name: string;
  /** Indian mobile number (10 digits, optional +91 / 0). */
  mobile: string;
  /** GST state code of the customer (default: the company's state). */
  stateCode?: string;
}

// ───────────────────────────── Held bills ─────────────────────────────

export interface PosDraftLine {
  itemId: number;
  qty: number;
  /** Rupees per base unit as on the counter. */
  rate: number;
  discountPct?: number;
  batchName?: string;
}

/** A bill parked at the counter (no voucher yet). */
export interface PosDraft {
  voucherTypeId: number;
  partyLedgerId?: number;
  customerName?: string;
  customerMobile?: string;
  placeOfSupply?: string;
  lines: PosDraftLine[];
  narration?: string;
}

export interface PosHeldBillSaveInput {
  /** Re-hold over an existing held bill. */
  id?: number;
  label?: string;
  /** Total shown in the list (as last previewed). */
  total: Paise;
  draft: PosDraft;
}

export interface PosHeldBill {
  id: number;
  label: string;
  customerName: string | null;
  lineCount: number;
  total: Paise;
  createdAt: string;
  createdByName: string | null;
  draft: PosDraft;
}

// ───────────────────────────── Returns / exchange ─────────────────────────────

export interface PosReturnContextInput {
  /** The POS bill (Sales voucher) the goods come back from: its id, or its number with `voucherTypeId`. */
  voucherId?: number;
  number?: string;
  voucherTypeId?: number;
  date: string;
}

export interface PosReturnLine {
  /** Index of the line on the bill (input.items). */
  index: number;
  itemId: number;
  name: string;
  unit: string;
  unitDecimals: number;
  sold: number;
  /** Already taken back by other POS returns in the books. */
  returned: number;
  returnable: number;
  rate: number;
  rateInclusiveOfTax: boolean;
  discountPct: number;
  ledgerId: number | null;
  godownId: number | null;
  batchName: string | null;
  mrp: Paise | null;
}

export interface PosReturnContext {
  billId: number;
  billNumber: string | null;
  billDate: string;
  voucherTypeName: string;
  partyLedgerId: number | null;
  partyName: string | null;
  placeOfSupply: string | null;
  billValue: Paise;
  tenders: PosTenderView[];
  lines: PosReturnLine[];
  /** Credit Note type for the return (POS settings › return type, else the predefined Credit Note). */
  returnVoucherTypeId: number;
  /** The walk-in party: a return to it must be refunded in full (or given as exchange credit). */
  walkIn: boolean;
}

export interface PosExchangeCredit {
  /** The POS return (credit note) that issued the credit. */
  voucherId: number;
  number: string | null;
  date: string;
  partyName: string | null;
  issued: Paise;
  used: Paise;
  available: Paise;
}

// ───────────────────────────── Day-end summary / register ─────────────────────────────

export interface PosSummaryInput {
  from: string;
  to: string;
  /** Limit to these POS Sales types (and returns of their bills); default all. */
  voucherTypeIds?: number[];
  /** Bills entered by this user only (null: bills entered without a login, e.g. the owner of a company without security). */
  userId?: number | null;
  counter?: string;
  /** Bills / returns with a tender of this mode only (drill-down from the by-tender view). */
  modeId?: number;
}

export interface PosSummaryTenderRow {
  modeId: number;
  name: string;
  kind: PosTenderKind;
  ledgerName: string;
  /** Received on bills. */
  received: Paise;
  /** Refunded on returns. */
  refunded: Paise;
  net: Paise;
  count: number;
}

export interface PosSummaryUserRow {
  userId: number | null;
  userName: string;
  bills: number;
  sales: Paise;
  returns: number;
  returnValue: Paise;
  net: Paise;
}

export interface PosSummaryCounterRow {
  counter: string;
  bills: number;
  sales: Paise;
  returnValue: Paise;
  net: Paise;
}

export interface PosSummary {
  from: string;
  to: string;
  bills: number;
  /** Σ invoice value of bills. */
  sales: Paise;
  taxable: Paise;
  tax: Paise;
  returns: number;
  /** Σ credit note value of returns. */
  returnValue: Paise;
  returnTax: Paise;
  net: Paise;
  /** Left on customers' accounts by bills (sold on credit). */
  creditSales: Paise;
  /** Credited to customers' accounts by returns. */
  creditReturns: Paise;
  /** Cash received − cash refunded (what the drawer should hold over its opening float). */
  netCash: Paise;
  changeGiven: Paise;
  exchangeIssued: Paise;
  exchangeUsed: Paise;
  /** Saving against MRP given to customers (Σ MRP × qty − value charged incl. GST, items with an MRP). */
  mrpSavings: Paise;
  byTender: PosSummaryTenderRow[];
  byUser: PosSummaryUserRow[];
  byCounter: PosSummaryCounterRow[];
}

export interface PosRegisterInput {
  from: string;
  to: string;
  voucherTypeIds?: number[];
  /** See PosSummaryInput.userId (null: entered without a login). */
  userId?: number | null;
  counter?: string;
  /** Only bills / returns with a tender of this mode. */
  modeId?: number;
  kind?: 'sale' | 'return';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PosRegisterRow {
  voucherId: number;
  kind: 'sale' | 'return';
  voucherTypeName: string;
  number: string | null;
  date: string;
  partyName: string | null;
  billValue: Paise;
  paid: Paise;
  credit: Paise;
  change: Paise;
  /** 'Cash 500.00 · UPI 680.00' */
  tenders: string;
  counter: string | null;
  userName: string | null;
  /** Return: the bill it came from. */
  returnOf: { id: number; number: string | null } | null;
  isOptional: boolean;
}

export interface PosRegister {
  rows: PosRegisterRow[];
  total: number;
  sums: { billValue: Paise; paid: Paise; credit: Paise };
}

// ───────────────────────────── Print (PrintVoucherData.pos) ─────────────────────────────

export interface PrintPos {
  kind: 'sale' | 'return';
  /** 'Cash', 'UPI (Ref 4521…)' … with the amount (magnitude). */
  tenders: Array<{ label: string; amount: Paise }>;
  paid: Paise;
  /** Left on account (sale) / credited (return). */
  credit: Paise;
  cashTendered: Paise | null;
  change: Paise;
  counter: string | null;
  cashier: string | null;
}
