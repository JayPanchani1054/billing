/**
 * DTOs and constants for the GST "plus" features of the gst module (src/core/modules/gst):
 * advances (GSTR-1 Table 11), bills of entry (imports of goods), GST stat adjustments (ITC reversal /
 * reclaim, reverse-charge liability), set-off posting and GST challans (electronic cash and credit
 * ledgers), return filing status and GSTR-1 amendments, and composition returns (CMP-08, GSTR-4).
 *
 * Money is integer paise; rates are REAL percent; dates 'YYYY-MM-DD'; return periods are keys
 * ('042026' month, '2026-27-Q1' quarter, '2026-27' financial year for GSTR-4).
 * Rules and legal references: src/core/modules/gst/README.md §11–§16.
 */
import type { Paise } from '../money.ts';
import type { GstJsonFile, ReturnPeriodRef, TaxAmounts, TaxHead, TaxValue } from './gst-returns.ts';

// ───────────────────────────── Voucher input (VoucherInput.gstDetails) ─────────────────────────────

/** Natures of a GST stat adjustment journal (Tally: Journal › Alt+J Stat Adjustment). */
export const GST_ADJUSTMENT_NATURES = [
  'itc_reversal_r42',
  'itc_reversal_r43',
  'itc_reversal_r38',
  'itc_reversal_s17_5',
  'itc_reversal_r37',
  'itc_reversal_r37a',
  'itc_reversal_others',
  'itc_reclaim',
  'rcm_liability',
] as const;
export type GstAdjustmentNature = (typeof GST_ADJUSTMENT_NATURES)[number];

export const GST_ADJUSTMENT_LABELS: Readonly<Record<GstAdjustmentNature, string>> = {
  itc_reversal_r42: 'Reversal of ITC — Rule 42 (common inputs / input services)',
  itc_reversal_r43: 'Reversal of ITC — Rule 43 (common capital goods)',
  itc_reversal_r38: 'Reversal of ITC — Rule 38 (banking company, 50%)',
  itc_reversal_s17_5: 'Reversal of ITC — section 17(5) blocked credit',
  itc_reversal_r37: 'Reversal of ITC — Rule 37 (supplier not paid within 180 days)',
  itc_reversal_r37a: 'Reversal of ITC — Rule 37A (supplier did not file GSTR-3B)',
  itc_reversal_others: 'Reversal of ITC — others',
  itc_reclaim: 'Reclaim of ITC reversed earlier (Rule 37 / 37A paid or filed)',
  rcm_liability: 'Reverse charge liability (and its input credit)',
};

/** GSTR-3B row each nature reaches. */
export const GST_ADJUSTMENT_3B_ROW: Readonly<Record<GstAdjustmentNature, string>> = {
  itc_reversal_r42: '4(B)(1)',
  itc_reversal_r43: '4(B)(1)',
  itc_reversal_r38: '4(B)(1)',
  itc_reversal_s17_5: '4(B)(1)',
  itc_reversal_r37: '4(B)(2)',
  itc_reversal_r37a: '4(B)(2)',
  itc_reversal_others: '4(B)(2)',
  itc_reclaim: '4(A)(5) and 4(D)(1)',
  rcm_liability: '3.1(d) and 4(A)(3)',
};

/** Minor heads of the electronic cash ledger (PMT-06). */
export const CASH_MINOR_HEADS = ['tax', 'interest', 'penalty', 'fee', 'others'] as const;
export type CashMinorHead = (typeof CASH_MINOR_HEADS)[number];

export interface CashHeadAmount {
  head: TaxHead;
  minor: CashMinorHead;
  amount: Paise;
}

export interface AdvanceReceivedInput {
  /** Supply the advance is for: services attract tax on advances; goods do not (N/N 66/2017-CT). */
  supplyType: 'goods' | 'services';
  /** GST rate of the supply (%). */
  rate: number;
  cessRate?: number;
  /** State code; default: the party's state, else the company's. */
  placeOfSupply?: string;
  /** Advance received incl. tax; default: the cash / bank debit of the receipt. */
  amount?: Paise;
}

export interface AdvanceRefInput {
  /** The receipt voucher that recorded the advance. */
  receiptVoucherId: number;
  /** Gross amount (incl. tax) adjusted / refunded. */
  amount: Paise;
}

export interface BillOfEntryInput {
  number: string;
  date: string;
  /** Six-character port code (e.g. INNSA1). */
  portCode?: string;
  /** Assessable value as per the BOE. */
  assessableValue: Paise;
  /** Basic customs duty + SWS (information; not posted). */
  customsDuty?: Paise;
  /** IGST paid at customs (Rule 36(1)(d): BOE is the document for ITC). */
  igst: Paise;
  cess?: Paise;
  /** Ledger credited for the IGST (default: the reserved "IGST Payable on Imports (Customs)"). */
  creditLedgerId?: number;
}

export interface GstStatAdjustmentInput {
  nature: GstAdjustmentNature;
  /** Return period key the adjustment belongs to (default: the voucher date's month / quarter). */
  period?: string;
  /** Reverse charge: taxable value for 3.1(d). */
  taxableValue?: Paise;
}

export interface GstChallanInput {
  cpin: string;
  cin?: string;
  brn?: string;
  challanDate?: string;
  bankName?: string;
  mode?: 'epayment' | 'neft_rtgs' | 'otc';
  period?: string;
  heads: CashHeadAmount[];
}

export interface GstSetoffPostingInput {
  period: string;
  /** Cash utilised per major × minor head (Cr Electronic Cash Ledger). */
  cash: CashHeadAmount[];
  /** Credit utilised: from credit head → to liability head (Cr Input ledger of `from`). */
  credit: Array<{ from: TaxHead; to: TaxHead; amount: Paise }>;
}

/** VoucherInput.gstDetails — validated and posted by the gst voucher hook. */
export interface VoucherGstDetailsInput {
  /** Receipt: advance received against a future supply (GSTR-1 11A). */
  advance?: AdvanceReceivedInput;
  /** Sales / debit note to a customer: advances adjusted (11B); default from bill-wise "against" an advance bill. */
  advanceAdjustments?: AdvanceRefInput[];
  /** Payment: refund voucher for an advance (Rule 51; reported with 11B). */
  advanceRefund?: AdvanceRefInput;
  /** Purchase (import of goods / goods from an SEZ unit): bill of entry. */
  billOfEntry?: BillOfEntryInput;
  /** Journal: stat adjustment. */
  adjustment?: GstStatAdjustmentInput;
  /** Payment: GST challan (cash deposited in the electronic cash ledger). */
  challan?: GstChallanInput;
  /** Journal posted by GST Set-off (offset of liability against credit and cash). */
  setoff?: GstSetoffPostingInput;
}

// ───────────────────────────── Reserved ledgers (created on demand) ─────────────────────────────

export const GST_PLUS_LEDGERS = {
  GST_ADVANCE: { name: 'GST on Advances Received', group: 'DUTIES_TAXES' },
  GST_CASH_LEDGER: { name: 'GST Electronic Cash Ledger', group: 'LOANS_ADVANCES_ASSET' },
  CUSTOMS_IGST: { name: 'IGST Payable on Imports (Customs)', group: 'DUTIES_TAXES' },
  GST_INTEREST: { name: 'Interest on GST', group: 'INDIRECT_EXPENSES' },
  GST_LATE_FEE: { name: 'Late Fee on GST Returns', group: 'INDIRECT_EXPENSES' },
  GST_PENALTY: { name: 'GST Penalty and Other Dues', group: 'INDIRECT_EXPENSES' },
  COMPOSITION_TAX: { name: 'Composition Tax (GST)', group: 'INDIRECT_EXPENSES' },
  ITC_REVERSED: { name: 'ITC Reversed (GST)', group: 'INDIRECT_EXPENSES' },
} as const;
export type GstPlusLedgerCode = keyof typeof GST_PLUS_LEDGERS;

// ───────────────────────────── Advances (GSTR-1 Table 11) ─────────────────────────────

export interface Table11Row extends TaxValue {
  pos: string;
  posName: string;
  /** INTRA / INTER (portal sply_ty). */
  supplyKind: 'INTRA' | 'INTER';
  rate: number;
  /** Gross advance (incl. tax). */
  gross: Paise;
}

export interface AdvanceVoucherRow extends TaxValue {
  voucherId: number;
  receiptVoucherId: number | null;
  kind: 'received' | 'adjusted' | 'refunded';
  number: string | null;
  date: string;
  partyName: string | null;
  pos: string;
  rate: number;
  gross: Paise;
}

export interface Gstr1AdvancesSummary {
  /** 11A(1)/(2): advances received in the period, rate- and POS-wise. */
  received: Table11Row[];
  /** 11B(1)/(2): advances adjusted against invoices (and refunded) in the period. */
  adjusted: Table11Row[];
  vouchers: AdvanceVoucherRow[];
  /** Net tax added to 3.1(a): received − adjusted. */
  net: TaxValue;
}

export interface PendingAdvance {
  receiptVoucherId: number;
  number: string | null;
  date: string;
  partyLedgerId: number | null;
  partyName: string | null;
  pos: string;
  rate: number;
  gross: Paise;
  /** Gross not yet adjusted or refunded. */
  pending: Paise;
}

// ───────────────────────────── Filing status & amendments ─────────────────────────────

export const GST_FILING_FORMS = ['gstr1', 'gstr3b', 'cmp08', 'gstr4'] as const;
export type GstFilingForm = (typeof GST_FILING_FORMS)[number];

export interface GstFiling {
  form: GstFilingForm;
  period: string;
  periodLabel: string;
  filedOn: string;
  arn: string | null;
  createdAt: string;
}

export interface GstAmendmentRate extends TaxValue {
  rate: number;
}

/** A GSTR-1 document as reported (snapshot). */
export interface GstDocSnapshot {
  voucherId: number;
  baseType: string;
  number: string | null;
  date: string;
  /** GSTR-1 section (b2b, b2cl, exp_wp, cdnr, cdnur, b2cs, …) or null when not reported. */
  section: string | null;
  gstin: string | null;
  partyName: string | null;
  pos: string;
  value: Paise;
  reverseCharge: boolean;
  invoiceType: string | null;
  noteType: 'C' | 'D' | null;
  items: GstAmendmentRate[];
}

export interface GstAmendmentRow {
  id: number;
  voucherId: number | null;
  kind: 'amended' | 'added';
  /** 9A (invoices), 9C (notes), 10 (B2C small), or the original table for documents added after filing. */
  table: '9A' | '9C' | '10' | 'late';
  originalPeriod: string;
  amendPeriod: string;
  origNumber: string | null;
  origDate: string;
  original: GstDocSnapshot | null;
  /** null: the document no longer counts (cancelled / made optional) — report it with zero values. */
  amended: GstDocSnapshot | null;
  /** amended − original. */
  delta: TaxValue;
  updatedAt: string;
}

export interface Gstr1AmendmentsSummary {
  /** 9A: amended B2B / B2CL / export invoices. */
  invoices: GstAmendmentRow[];
  /** 9C: amended credit / debit notes (CDNR / CDNUR). */
  notes: GstAmendmentRow[];
  /** 10: amended B2C (small) documents (enter on the portal by POS and rate). */
  b2cs: GstAmendmentRow[];
  /** Documents dated in a filed period that were missing from its GSTR-1 (report them now). */
  late: GstAmendmentRow[];
  /** Σ delta of every row (tax change reported through this return). */
  net: TaxValue;
}

// ───────────────────────────── Book adjustments in GSTR-3B ─────────────────────────────

export interface Gstr3bBookAdjustments {
  /** 11A − 11B (in 3.1(a)). */
  advances: TaxValue;
  /** Reverse-charge journals: 3.1(d) value + tax. */
  rcmLiability: TaxValue;
  /** Their input credit: 4(A)(3). */
  rcmCredit: TaxAmounts;
  /** 4(B)(1) from journals. */
  reversalRules: TaxAmounts;
  /** 4(B)(2) from journals. */
  reversalOthers: TaxAmounts;
  /** 4(A)(5) and 4(D)(1) from journals. */
  reclaimed: TaxAmounts;
  /** 4(A)(1): IGST / cess per bills of entry minus that computed on the purchases. */
  billOfEntry: TaxAmounts;
}

// ───────────────────────────── Set-off & electronic ledgers ─────────────────────────────

export interface SetoffCashRow {
  head: TaxHead;
  label: string;
  /** Cash needed per minor head for this return. */
  tax: Paise;
  interest: Paise;
  penalty: Paise;
  fee: Paise;
  others: Paise;
  total: Paise;
  /** Electronic cash ledger balance available (all minor heads of this major head). */
  available: Paise;
  /** Cash still to deposit (total − available, never below 0). */
  toDeposit: Paise;
}

export interface SetoffCreditRow {
  from: TaxHead;
  to: TaxHead;
  amount: Paise;
}

export interface GstSetoffResult {
  period: ReturnPeriodRef;
  form: 'gstr3b' | 'cmp08';
  composition: boolean;
  /** Liability per head (forward charge, incl. advances; composition: composition tax). */
  liability: TaxAmounts;
  /** Reverse-charge tax (cash only). */
  rcm: TaxAmounts;
  /** Credit available (regular only). */
  creditAvailable: TaxAmounts;
  credit: SetoffCreditRow[];
  /** Credit carried forward after set-off. */
  creditBalance: TaxAmounts;
  cash: SetoffCashRow[];
  cashTotal: Paise;
  toDepositTotal: Paise;
  /** Set-off journal already posted for the period. */
  posted: { voucherId: number; number: string | null; date: string } | null;
  challans: GstChallanRow[];
  notes: string[];
}

export interface GstChallanRow {
  voucherId: number;
  number: string | null;
  date: string;
  cpin: string;
  cin: string | null;
  brn: string | null;
  challanDate: string | null;
  bankName: string | null;
  mode: string | null;
  period: string | null;
  total: Paise;
  heads: CashHeadAmount[];
}

export interface CashLedgerRow {
  head: TaxHead;
  minor: CashMinorHead;
  opening: Paise;
  deposited: Paise;
  utilised: Paise;
  closing: Paise;
}

export interface CashLedgerTxn {
  voucherId: number;
  number: string | null;
  date: string;
  kind: 'deposit' | 'utilised';
  description: string;
  period: string | null;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

export interface ElectronicCashLedger {
  from: string;
  to: string;
  rows: CashLedgerRow[];
  totals: { opening: Paise; deposited: Paise; utilised: Paise; closing: Paise };
  transactions: CashLedgerTxn[];
  /** Balance of the "GST Electronic Cash Ledger" account in the books at `to` (Dr +). */
  booksBalance: Paise;
  notes: string[];
}

export interface CreditLedgerRow {
  head: TaxHead;
  label: string;
  opening: Paise;
  /** ITC booked: purchases, reverse charge, bills of entry, reclaims. */
  accrued: Paise;
  /** Purchase returns / supplier credit notes and reversal journals. */
  reversed: Paise;
  /** Used in set-off journals. */
  utilised: Paise;
  closing: Paise;
}

export interface CreditLedgerTxn {
  voucherId: number;
  number: string | null;
  voucherTypeName: string;
  date: string;
  kind: 'accrued' | 'reversed' | 'utilised';
  description: string;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

export interface ElectronicCreditLedger {
  from: string;
  to: string;
  rows: CreditLedgerRow[];
  transactions: CreditLedgerTxn[];
  notes: string[];
}

// ───────────────────────────── Composition ─────────────────────────────

export const COMPOSITION_CATEGORIES = ['manufacturer', 'trader', 'restaurant', 'services'] as const;
export type CompositionCategory = (typeof COMPOSITION_CATEGORIES)[number];
export const COMPOSITION_CATEGORY_LABELS: Readonly<Record<CompositionCategory, string>> = {
  manufacturer: 'Manufacturer',
  trader: 'Trader (other supplier)',
  restaurant: 'Restaurant service',
  services: 'Services / mixed supplier under s.10(2A)',
};

export interface CompositionRate {
  id: number;
  category: CompositionCategory;
  effectiveFrom: string;
  rate: number;
  basis: 'turnover' | 'taxable_turnover';
  note: string | null;
}

export interface CompositionSettings {
  category: CompositionCategory;
  rates: CompositionRate[];
}

export interface Cmp08Row extends TaxValue {
  key: 'outward' | 'rcm' | 'payable' | 'interest';
  row: string;
  label: string;
}

export interface Cmp08Summary {
  period: ReturnPeriodRef;
  gstin: string | null;
  companyName: string;
  category: CompositionCategory;
  /** Rate applied (latest effective in the quarter) and its basis. */
  rate: number;
  basis: 'turnover' | 'taxable_turnover';
  turnover: { taxable: Paise; exempt: Paise; total: Paise; taxBase: Paise };
  /** Table 3: 1 outward, 2 inward RCM, 3 payable, 4 interest. */
  table3: Cmp08Row[];
  /** Table 4: paid (cash utilised from set-off journals of the quarter). */
  paid: TaxAmounts & { interest: Paise };
  /** Documents of the quarter. */
  outwardDocs: number;
  rcmDocs: number;
  notes: string[];
  filing: GstFiling | null;
}

export interface Gstr4InwardRow extends TaxValue {
  key: '4A' | '4B' | '4C' | '4D';
  label: string;
  gstin: string | null;
  partyName: string | null;
  rate: number | null;
  documents: number;
}

export interface Gstr4QuarterRow extends TaxValue {
  quarter: string;
  label: string;
  outwardValue: Paise;
  outwardTax: TaxAmounts;
  rcmValue: Paise;
  rcmTax: TaxAmounts;
  interest: TaxAmounts;
  paid: Paise;
  filed: boolean;
}

export interface Gstr4RateRow extends TaxValue {
  kind: 'outward' | 'rcm';
  rate: number;
}

export interface Gstr4Summary {
  fy: string;
  gstin: string | null;
  companyName: string;
  caption: string;
  /** 4A by supplier, 4B by supplier, 4C by rate, 4D by rate. */
  table4: Gstr4InwardRow[];
  table4Totals: Record<'4A' | '4B' | '4C' | '4D', TaxValue>;
  /** 5: CMP-08 per quarter. */
  table5: Gstr4QuarterRow[];
  /** 6: rate-wise outward (composition rate) and inward reverse-charge supplies. */
  table6: Gstr4RateRow[];
  /** 8: tax payable and paid for the year. */
  table8: { payable: TaxAmounts; paid: Paise; interest: TaxAmounts };
  notes: string[];
}

export type { GstJsonFile };

// ───────────────────────────── Return files (our own documented formats) ─────────────────────────────

export interface GstCsvFile {
  fileName: string;
  csv: string;
}
