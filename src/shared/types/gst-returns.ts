/**
 * DTOs for the GST returns module (src/core/modules/gst): GSTR-1, GSTR-3B, GSTR-9 summaries, GST
 * registers, ITC, exceptions, e-invoice (IRP schema 1.1) and e-way bill bulk JSON.
 * Full mapping rules: src/core/modules/gst/README.md.
 *
 * Conventions: money is integer paise (JSON exports convert to rupees); "taxable" etc. are NET values
 * for the period (credit notes / purchase returns already subtracted) unless a field says otherwise.
 * Dates are 'YYYY-MM-DD'. Return periods are keys: '042026' (month, MMYYYY) or '2026-27-Q1' (quarter).
 */
import type { Paise } from '../money.ts';
import type { GstNature, SupplyKind } from './gst.ts';

// ───────────────────────────── Common ─────────────────────────────

export interface TaxAmounts {
  igst: Paise;
  /** CGST. */
  cgst: Paise;
  /** SGST or UTGST. */
  sgst: Paise;
  cess: Paise;
}

export interface TaxValue extends TaxAmounts {
  taxable: Paise;
}

/** Tax heads in statutory order. */
export type TaxHead = 'igst' | 'cgst' | 'sgst' | 'cess';
export const TAX_HEADS: readonly TaxHead[] = ['igst', 'cgst', 'sgst', 'cess'];

/** Period input accepted by every period-based route: a return period key, or an explicit range. */
export interface GstPeriodInput {
  /** '042026' (month) or '2026-27-Q1' (quarter). Wins over from/to. */
  period?: string;
  from?: string;
  to?: string;
}

export interface GstRangeInput {
  from: string;
  to: string;
}

/** The resolved period of a report. */
export interface ReturnPeriodRef {
  /** Period key, or null for an arbitrary from/to range. */
  key: string | null;
  kind: 'month' | 'quarter' | 'range';
  /** 'Apr 2026', 'Q1 (Apr–Jun) 2026-27' or '01-Apr-2026 to 15-Apr-2026'. */
  label: string;
  from: string;
  to: string;
  /** GSTN 'fp' / 'ret_period' (MMYYYY; a quarter uses its last month); null for a range. */
  fp: string | null;
}

// ───────────────────────────── Periods ─────────────────────────────

export interface ReturnPeriod extends ReturnPeriodRef {
  key: string;
  kind: 'month' | 'quarter';
  fp: string;
  /** GST financial year (April–March), e.g. '2026-27'. */
  fy: string;
  /** Outward documents (sales, credit/debit notes to customers) that count in the books. */
  outwardCount: number;
  /** Inward documents (purchases, purchase returns). */
  inwardCount: number;
  hasData: boolean;
  /** The period containing the working date. */
  isCurrent: boolean;
}

export interface GstPeriodsResult {
  filingFrequency: 'monthly' | 'quarterly';
  /** Newest first. Months always; quarters too when the company files quarterly. */
  periods: ReturnPeriod[];
  /** Key of the period that contains the working date (quarter key for quarterly filers). */
  current: string;
  /** Key of the period most likely being filed now (the previous month / quarter). */
  suggested: string;
}

// ───────────────────────────── Issues (uncertain transactions) ─────────────────────────────

export type GstIssueCode =
  | 'gstin_missing'
  | 'gstin_invalid'
  | 'b2c_with_gstin'
  | 'hsn_missing'
  | 'hsn_short'
  | 'hsn_invalid'
  | 'pos_missing'
  | 'note_without_original'
  | 'doc_no_missing'
  | 'doc_no_invalid'
  | 'doc_series_gap'
  | 'optional_in_series'
  | 'rate_not_slab'
  | 'nature_mismatch'
  | 'tax_head_mismatch'
  | 'no_gst_lines'
  | 'negative_value'
  | 'export_shipping_bill_missing'
  | 'supplier_invoice_missing'
  | 'supplier_gstin_invalid'
  | 'itc_without_gstin'
  | 'rcm_without_liability'
  | 'itc_time_limit';

export interface GstIssue {
  code: GstIssueCode;
  /** error: the portal would reject it or the return would be wrong; warning: review it. */
  severity: 'error' | 'warning';
  /** null for period-level issues (e.g. a gap in a number series). */
  voucherId: number | null;
  voucherNumber: string | null;
  voucherTypeName: string | null;
  date: string | null;
  partyName: string | null;
  /** GSTR-1 section the document is reported in (outward documents). */
  section: Gstr1SectionId | null;
  /** What is wrong (written for an accountant). */
  message: string;
  /** How to fix it. */
  fix: string;
  /** Party ledger of the document (fix link: accounts.ledger.form); null on period-level issues. */
  partyLedgerId?: number | null;
  /** Stock item of the first offending line (HSN / rate issues; fix link: inventory.item.form). */
  itemId?: number | null;
  /** Ledger of the first offending accounting-mode line (HSN / rate issues; fix link: accounts.ledger.form). */
  lineLedgerId?: number | null;
}

// ───────────────────────────── GSTR-1 ─────────────────────────────

/**
 * GSTR-1 sections (table numbers as in the return):
 *   b2b 4A · b2b_rcm 4B · sez_wp 6B (with payment) · sez_wop 6B (without payment) · de 6C · b2cl 5 ·
 *   exp_wp / exp_wop 6A · b2cs 7 · nil 8 · cdnr 9B (registered) · cdnur 9B (unregistered) ·
 *   at 11A(1) · atadj 11B(1) · hsn_b2b / hsn_b2c 12 · doc 13
 */
export type Gstr1SectionId =
  | 'b2b'
  | 'b2b_rcm'
  | 'sez_wp'
  | 'sez_wop'
  | 'de'
  | 'b2cl'
  | 'exp_wp'
  | 'exp_wop'
  | 'b2cs'
  | 'nil'
  | 'cdnr'
  | 'cdnur'
  | 'at'
  | 'atadj'
  | 'hsn_b2b'
  | 'hsn_b2c'
  | 'doc';

export const GSTR1_SECTIONS: readonly Gstr1SectionId[] = [
  'b2b',
  'b2b_rcm',
  'b2cl',
  'exp_wp',
  'exp_wop',
  'sez_wp',
  'sez_wop',
  'de',
  'b2cs',
  'nil',
  'cdnr',
  'cdnur',
  'at',
  'atadj',
  'hsn_b2b',
  'hsn_b2c',
  'doc',
];

export interface Gstr1SectionSummary extends TaxValue {
  id: Gstr1SectionId;
  /** Table number in the return, e.g. '4A', '6B', '9B'. */
  table: string;
  title: string;
  /** Documents (invoices / notes), B2CS rows, HSN rows or document series — see `countLabel`. */
  count: number;
  countLabel: 'documents' | 'rows' | 'series';
  /** Σ invoice values of the documents, signed like the amounts (credit notes negative); 0 for aggregate tables. */
  invoiceValue: Paise;
  note?: string;
}

/** Table 7 row: aggregated by place of supply + rate + supply type. */
export interface Gstr1B2csRow extends TaxValue {
  supplyType: 'INTRA' | 'INTER';
  pos: string;
  posName: string;
  rate: number;
  /** 'OE' = other than e-commerce. */
  type: 'OE';
  /** Documents contributing (invoices and netted credit/debit notes). */
  documents: number;
}

/** Table 8 row. */
export interface Gstr1NilRow {
  supplyType: 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C';
  label: string;
  exempt: Paise;
  nil: Paise;
  nonGst: Paise;
}

/** Table 12 row (also used by the HSN summary report and GSTR-9 tables 17/18). */
export interface GstHsnRow extends TaxValue {
  /** HSN/SAC truncated to config.gst.hsnDigits ('' when missing). */
  hsn: string;
  description: string;
  /** GST UQC; 'NA' for services. */
  uqc: string;
  qty: number;
  rate: number;
  /** taxable + all tax. */
  total: Paise;
  supplyType: SupplyKind;
}

/** Table 13 document series. */
export interface Gstr1DocSeries {
  /** GSTN doc_num: 1 outward invoices, 4 debit notes, 5 credit notes. */
  docNum: 1 | 4 | 5;
  docTypeLabel: string;
  voucherTypeId: number;
  voucherTypeName: string;
  from: string;
  to: string;
  /** Numbers in the range (to − from + 1 for numeric series, else documents found). */
  total: number;
  /** Cancelled vouchers + numbers missing from the range (deleted documents). */
  cancelled: number;
  /** Numbers in the range with no voucher (included in `cancelled`). */
  missing: number;
  net: number;
}

export interface Gstr1Summary {
  period: ReturnPeriodRef;
  gstin: string | null;
  companyName: string;
  /** In table order; every section is present (zeros when empty). */
  sections: Gstr1SectionSummary[];
  b2cs: Gstr1B2csRow[];
  nil: Gstr1NilRow[];
  hsnB2b: GstHsnRow[];
  hsnB2c: GstHsnRow[];
  docs: Gstr1DocSeries[];
  /**
   * Net tax on outward supplies as reported in GSTR-1 (all sections except 4B, whose tax the
   * recipient pays, and except 8 which has none) — compare with GSTR-3B 3.1(a)+(b).
   */
  totals: TaxValue;
  issues: GstIssue[];
  notes: string[];
  /** Documents in the period that are NOT in GSTR-1 (optional / cancelled / non-GST). */
  excluded: { optional: number; cancelled: number; notGst: number };
}

export interface Gstr1SectionInput extends GstPeriodInput {
  section: Gstr1SectionId;
}

export interface GstRateSplit extends TaxValue {
  rate: number;
  cessRate: number;
}

/** One voucher in a GSTR-1 section (drill-down). Amounts are this voucher's contribution, signed. */
export interface Gstr1DocRow extends TaxValue {
  voucherId: number;
  voucherTypeName: string;
  baseType: string;
  number: string | null;
  date: string;
  partyName: string | null;
  gstin: string | null;
  pos: string;
  posName: string;
  /** Invoice value as on the document (always positive). */
  invoiceValue: Paise;
  /** +1 adds to the section, −1 reduces it (credit notes netted in B2CS/HSN/nil). */
  sign: 1 | -1;
  reverseCharge: boolean;
  /** 'C' credit note / 'D' debit note; null for invoices. */
  noteType: 'C' | 'D' | null;
  /** GSTN inv_typ for b2b/cdnr: R, SEWP, SEWOP, DE. */
  invoiceType: 'R' | 'SEWP' | 'SEWOP' | 'DE' | null;
  /** exp / cdnur type. */
  exportType: 'WPAY' | 'WOPAY' | null;
  cdnurType: 'B2CL' | 'EXPWP' | 'EXPWOP' | null;
  shippingBill: { number: string | null; date: string | null; portCode: string | null } | null;
  originalInvoiceNo: string | null;
  originalInvoiceDate: string | null;
  nature: GstNature;
  rates: GstRateSplit[];
}

export interface Gstr1SectionResult {
  period: ReturnPeriodRef;
  section: Gstr1SectionId;
  table: string;
  title: string;
  rows: Gstr1DocRow[];
  /** Signed totals of the rows (equal to the section summary for document sections). */
  totals: TaxValue & { invoiceValue: Paise };
  /** Aggregated rows for aggregate sections (b2cs, nil, hsn_*, doc) — same as in the summary. */
  b2cs?: Gstr1B2csRow[];
  nil?: Gstr1NilRow[];
  hsn?: GstHsnRow[];
  docs?: Gstr1DocSeries[];
}

/** A generated return / bulk file. */
export interface GstJsonFile {
  fileName: string;
  /** Pretty-printed? No — compact JSON text exactly as it should be uploaded. */
  json: string;
  /** Non-blocking remarks (e.g. sections that could not be derived). */
  warnings: string[];
}

// ───────────────────────────── GSTR-3B ─────────────────────────────

export type Gstr3bSupplyKey = 'osup_det' | 'osup_zero' | 'osup_nil_exmp' | 'isup_rev' | 'osup_nongst';

export interface Gstr3bSupplyRow extends TaxValue {
  key: Gstr3bSupplyKey | 'eco_sup' | 'eco_reg_sup';
  /** '3.1(a)' … */
  row: string;
  label: string;
}

export interface Gstr3bInterStateRow {
  pos: string;
  posName: string;
  taxable: Paise;
  igst: Paise;
}

export type Gstr3bItcType = 'IMPG' | 'IMPS' | 'ISRC' | 'ISD' | 'OTH' | 'RUL';

export interface Gstr3bItcRow extends TaxAmounts {
  ty: Gstr3bItcType;
  /** '4(A)(1)' … */
  row: string;
  label: string;
  /** Books: from gst_lines; manual: from saved adjustments; both: books + manual. */
  source: 'books' | 'manual' | 'both';
}

export interface Gstr3bInwardRow {
  ty: 'GST' | 'NONGST';
  label: string;
  inter: Paise;
  intra: Paise;
}

/** Statutory ITC set-off result (Rule 88A / s.49). */
export interface SetOffResult {
  /** utilisation[creditHead][liabilityHead] = amount of that credit used against that liability. */
  utilisation: Record<TaxHead, Record<TaxHead, Paise>>;
  /** Liability per head paid through ITC (Σ over credit heads). */
  paidByItc: TaxAmounts;
  /** Liability per head left to pay in cash. */
  cash: TaxAmounts;
  /** Credit per head left after set-off (carried forward). */
  creditBalance: TaxAmounts;
}

export interface Gstr3bPaymentRow {
  head: TaxHead;
  label: string;
  /** Tax payable other than reverse charge (3.1(a) + 3.1(b), never below 0). */
  liability: Paise;
  paidIgst: Paise;
  paidCgst: Paise;
  paidSgst: Paise;
  paidCess: Paise;
  /** Cash for forward-charge tax. */
  cash: Paise;
  /** Reverse-charge tax (3.1(d)) — always paid in cash. */
  rcmLiability: Paise;
  interest: Paise;
  lateFee: Paise;
  /** cash + rcmLiability + interest + lateFee. */
  totalCash: Paise;
}

export type Gstr3bAdjustmentKey =
  | 'itcIsd'
  | 'itcReversalRules'
  | 'itcReversalOthers'
  | 'itcReclaimed'
  | 'itcIneligibleOthers'
  | 'interest'
  | 'lateFee'
  | 'creditLedgerBalance';

export const GSTR3B_ADJUSTMENT_KEYS: readonly Gstr3bAdjustmentKey[] = [
  'itcIsd',
  'itcReversalRules',
  'itcReversalOthers',
  'itcReclaimed',
  'itcIneligibleOthers',
  'interest',
  'lateFee',
  'creditLedgerBalance',
];

/**
 * Manual GSTR-3B entries for a period (all ≥ 0, paise):
 *   itcIsd              4(A)(4) ITC received from an Input Service Distributor
 *   itcReversalRules    4(B)(1) reversals under rules 38, 42, 43 (s.17(5) blocked credit is added from the books)
 *   itcReversalOthers   4(B)(2) other reversals
 *   itcReclaimed        4(D)(1) ITC reclaimed that was reversed under 4(B)(2) earlier
 *   itcIneligibleOthers 4(D)(2) ineligible ITC under s.16(4) / place-of-supply rules
 *   interest, lateFee   5.1 (late fee: CGST and SGST only)
 *   creditLedgerBalance electronic credit ledger credit the books do not hold (e.g. the portal balance
 *                       when the books began); added to 4(C) and to the credit brought forward from the
 *                       previous period (computed from the books) for the 6.1 set-off only, and carried on
 */
export type Gstr3bAdjustments = Record<Gstr3bAdjustmentKey, TaxAmounts>;

export interface Gstr3bAdjustmentsInput {
  period: string;
  values: Partial<Record<Gstr3bAdjustmentKey, Partial<TaxAmounts>>>;
}

export interface Gstr3bSummary {
  period: ReturnPeriodRef;
  gstin: string | null;
  companyName: string;
  /** 3.1 (a)–(e). */
  supplies: Gstr3bSupplyRow[];
  /** 3.1.1 e-commerce rows (always zero: ECO supplies are not recorded). */
  eco: Gstr3bSupplyRow[];
  /** 3.2 inter-state supplies by place of supply. */
  interState: {
    unregistered: Gstr3bInterStateRow[];
    composition: Gstr3bInterStateRow[];
    uin: Gstr3bInterStateRow[];
  };
  itc: {
    /** 4(A)(1)–(5). */
    available: Gstr3bItcRow[];
    /** 4(B)(1)–(2). */
    reversed: Gstr3bItcRow[];
    /** 4(C) = A − B (per head; may be negative in theory, shown as is). */
    net: TaxAmounts;
    /** 4(D)(1)–(2). */
    ineligible: Gstr3bItcRow[];
    /** Credit blocked under s.17(5) per the books (itc_eligibility = 'ineligible'); included in 4(A) and 4(B)(1). */
    blocked: TaxAmounts;
  };
  /** 5: exempt, nil-rated, non-GST inward supplies. */
  inward: Gstr3bInwardRow[];
  /** 5.1. */
  interest: TaxAmounts;
  lateFee: TaxAmounts;
  /** 6.1. */
  payment: {
    rows: Gstr3bPaymentRow[];
    setOff: SetOffResult;
    /**
     * Credit available for set-off: 4(C) (never below 0) + `broughtForward` + the manual
     * `creditLedgerBalance` (credit the books do not hold).
     */
    creditAvailable: TaxAmounts;
    /**
     * Electronic credit ledger balance brought forward from the books: the credit left after the previous
     * return period's set-off (chained from the books beginning; months for a month, quarters for a
     * quarter). Zero for a date range.
     */
    broughtForward: TaxAmounts;
    /** Credit used for set-off per credit head. */
    itcUsed: TaxAmounts;
    /** Σ totalCash. */
    cashTotal: Paise;
  };
  adjustments: Gstr3bAdjustments;
  adjustmentsUpdatedAt: string | null;
  notes: string[];
  /** Same checks as gst.exceptions for the period (errors and warnings). */
  issueCount: { errors: number; warnings: number };
}

// ───────────────────────────── Registers, HSN, ITC, exceptions ─────────────────────────────

export interface GstHsnSummaryInput extends GstRangeInput {
  direction: 'outward' | 'inward';
}

export interface GstHsnSummaryResult {
  from: string;
  to: string;
  direction: 'outward' | 'inward';
  rows: GstHsnRow[];
  totals: TaxValue & { total: Paise };
}

export interface GstRegisterInput extends GstRangeInput {
  kind: 'sales' | 'purchase';
}

export interface GstRegisterRow extends TaxValue {
  voucherId: number;
  date: string;
  number: string | null;
  voucherTypeName: string;
  baseType: string;
  partyName: string | null;
  gstin: string | null;
  /** Place of supply (sales) or supplier state (purchases). */
  stateCode: string;
  stateName: string;
  nature: GstNature;
  natureLabel: string;
  reverseCharge: boolean;
  /** Supplier's invoice number and date (purchases). */
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  /** Invoice value, signed like the other amounts. */
  invoiceValue: Paise;
  /** −1 for credit notes (sales) / purchase returns (purchases): every amount in the row is already signed. */
  sign: 1 | -1;
  rates: GstRateSplit[];
  /** Exempt + nil + non-GST value inside the document (signed). */
  nonTaxable: Paise;
}

export interface GstRegisterResult {
  from: string;
  to: string;
  kind: 'sales' | 'purchase';
  rows: GstRegisterRow[];
  totals: TaxValue & { invoiceValue: Paise; nonTaxable: Paise };
  /** Totals per rate (signed). */
  rateTotals: GstRateSplit[];
}

export type ItcEligibility = 'inputs' | 'capital_goods' | 'input_services' | 'ineligible';

export interface GstItcSupplierRow {
  partyLedgerId: number | null;
  partyName: string;
  gstin: string | null;
  documents: number;
  taxable: Paise;
  /** ITC claimable (eligibility ≠ ineligible), net of purchase returns. */
  eligible: TaxAmounts;
  /** Blocked under s.17(5). */
  ineligible: TaxAmounts;
  /** Part of `eligible` + `ineligible` paid under reverse charge (incl. import of services). */
  reverseCharge: TaxAmounts;
  /** Part of `eligible` + `ineligible` on imports of goods (incl. goods from an SEZ unit: IGST paid at customs). */
  imports: TaxAmounts;
}

export interface GstItcResult {
  from: string;
  to: string;
  rows: GstItcSupplierRow[];
  totals: { taxable: Paise; eligible: TaxAmounts; ineligible: TaxAmounts; reverseCharge: TaxAmounts; imports: TaxAmounts };
  byEligibility: Array<{ eligibility: ItcEligibility; label: string; taxable: Paise; tax: TaxAmounts }>;
}

export interface GstExceptionsResult {
  from: string;
  to: string;
  issues: GstIssue[];
  counts: { errors: number; warnings: number; byCode: Partial<Record<GstIssueCode, number>> };
}

// ───────────────────────────── e-Invoice ─────────────────────────────

export type EinvoiceSupplyType = 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' | 'DEXP';
export type EinvoiceDocType = 'INV' | 'CRN' | 'DBN';

export interface EinvoicePendingRow {
  voucherId: number;
  number: string | null;
  date: string;
  voucherTypeName: string;
  partyName: string | null;
  gstin: string | null;
  supplyType: EinvoiceSupplyType;
  docType: EinvoiceDocType;
  invoiceValue: Paise;
  irnStatus: string | null;
  /** No blocking errors: can be exported now. */
  ready: boolean;
  errors: string[];
  warnings: string[];
}

/** A voucher cancelled in the books whose IRN / e-way bill is still active on the portal. */
export interface GstCancelRequiredRow {
  voucherId: number;
  number: string | null;
  date: string;
  voucherTypeName: string;
  partyName: string | null;
  /** IRN (e-invoice) or e-way bill number. */
  refNo: string;
  /** IRN ack date / e-way bill date as recorded. */
  refDate: string | null;
}

export interface EinvoicePendingResult {
  /** F11 e-Invoice feature is on. */
  enabled: boolean;
  rows: EinvoicePendingRow[];
  /** Cancelled in the books but the IRN is still active: cancel it on the IRP, then mark it cancelled. */
  cancelRequired: GstCancelRequiredRow[];
}

/** A document whose IRN is active ('gst.einvoice.generated'). */
export interface EinvoiceGeneratedRow {
  voucherId: number;
  number: string | null;
  date: string;
  voucherTypeName: string;
  partyName: string | null;
  gstin: string | null;
  docType: EinvoiceDocType;
  invoiceValue: Paise;
  irn: string;
  ackNo: string | null;
  /** As recorded from the IRP ('YYYY-MM-DD HH:mm:ss', Indian time). */
  ackDate: string | null;
  /** The voucher is cancelled in the books (its IRN must be cancelled on the IRP too). */
  cancelledInBooks: boolean;
  /** ISO UTC instant 24 hours after the acknowledgement (IRP cancellation limit); null without an ack date. */
  cancellableUntil: string | null;
  /** The 24-hour cancellation window is still open. */
  cancelWindowOpen: boolean;
}

export interface EinvoiceGeneratedResult {
  rows: EinvoiceGeneratedRow[];
}

export interface GstBulkJsonFile extends GstJsonFile {
  /** Documents written into the file. */
  documents: number;
  /** Vouchers left out because of errors (fix them and export again). */
  rejected: Array<{ voucherId: number; number: string | null; errors: string[] }>;
}

export interface EinvoiceImportInput {
  fileName: string;
  bytes: Uint8Array;
}

export interface EinvoiceImportResult {
  /** Response records read from the file. */
  records: number;
  updated: Array<{ voucherId: number; number: string | null; irn: string; ackNo: string | null; ewayBillNo: string | null }>;
  /** Already carried the same IRN. */
  unchanged: Array<{ voucherId: number; number: string | null }>;
  /** Records that could not be applied. */
  skipped: Array<{ docNo: string | null; docDate: string | null; voucherId: number | null; reason: string }>;
  /** Records the IRP rejected (error rows in the response file). */
  failed: Array<{ docNo: string | null; docDate: string | null; message: string }>;
  /** Things to act on (e.g. an IRN generated for a voucher that is cancelled in the books). */
  warnings: string[];
}

export interface EinvoiceCancelInput {
  voucherId: number;
  reason: string;
}

// ───────────────────────────── e-Way bill ─────────────────────────────

export interface EwayPendingRow {
  voucherId: number;
  number: string | null;
  date: string;
  voucherTypeName: string;
  partyName: string | null;
  toGstin: string;
  /** Taxable value + tax of the taxable goods lines (Rule 138 consignment value). */
  consignmentValue: Paise;
  invoiceValue: Paise;
  distanceKm: number | null;
  vehicleNo: string | null;
  transporterId: string | null;
  ready: boolean;
  errors: string[];
  warnings: string[];
}

export interface EwayPendingResult {
  /** F11 e-Way Bill feature is on. */
  enabled: boolean;
  thresholdPaise: Paise;
  rows: EwayPendingRow[];
  /** Cancelled in the books but an e-way bill is recorded: cancel it on the EWB portal. */
  cancelRequired: GstCancelRequiredRow[];
}

export interface EwayUpdateInput {
  voucherId: number;
  /** 12-digit e-way bill number. */
  ewayBillNo: string;
  date: string;
  validUpto?: string | null;
}

export interface GstDocStatusResult {
  voucherId: number;
  number: string | null;
  irnStatus: string | null;
  irn: string | null;
  ewayBillNo: string | null;
  ewayBillDate: string | null;
  ewayValidUpto: string | null;
}

/** One entry of a voucher's e-invoice / e-way bill trail ('gst.docEvents'). */
export interface GstDocEvent {
  id: number;
  kind: 'einvoice' | 'ewaybill';
  /** exported | generated | cancelled | updated */
  action: string;
  /** IRN or e-way bill number. */
  refNo: string | null;
  /** File name, ack no., cancellation reason … */
  detail: Record<string, unknown> | null;
  at: string;
  by: string | null;
}

// ───────────────────────────── GSTR-9 ─────────────────────────────

export interface Gstr9Row extends TaxValue {
  /** '4A', '5D', '6B' … */
  key: string;
  label: string;
}

export interface Gstr9PaidRow {
  head: TaxHead;
  label: string;
  payable: Paise;
  paidCash: Paise;
  paidItc: { igst: Paise; cgst: Paise; sgst: Paise; cess: Paise };
}

export interface Gstr9MonthRow {
  period: string;
  label: string;
  outwardTaxable: Paise;
  outwardTax: TaxAmounts;
  itc: TaxAmounts;
  cash: TaxAmounts;
}

export interface Gstr9Summary {
  fy: string;
  from: string;
  to: string;
  gstin: string | null;
  companyName: string;
  /** Always 'Prepared from books — verify before filing'. */
  caption: string;
  /** Pt II table 4: outward and RCM inward supplies on which tax is payable. */
  table4: Gstr9Row[];
  /** Pt II table 5: outward supplies on which tax is not payable. */
  table5: Gstr9Row[];
  /** Pt III table 6: ITC availed. */
  table6: Gstr9Row[];
  /** Pt IV table 9: tax payable and paid (from the monthly GSTR-3B computations). */
  table9: Gstr9PaidRow[];
  /** Table 17: HSN summary of outward supplies. */
  hsnOutward: GstHsnRow[];
  /** Table 18: HSN summary of inward supplies. */
  hsnInward: GstHsnRow[];
  months: Gstr9MonthRow[];
  notes: string[];
}

export interface Gstr9Input {
  /** GST financial year, e.g. '2026-27'. */
  fy: string;
}
