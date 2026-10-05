/**
 * GST reconciliation DTOs (module 'gstrecon'): GSTR-2B / GSTR-2A against purchase books and GSTR-1
 * against sales books. Routes and semantics: src/core/modules/gstrecon/README.md.
 *
 * Money is integer paise. Portal amounts are stored "as on the document" (unsigned); summaries sign
 * them: invoices and debit notes +, credit notes − (books: purchases +, purchase returns −).
 * Differences are always `portal − books`.
 */
import type { Paise } from '../money.ts';

// ───────────────────────────── Enumerations ─────────────────────────────

export type ReconSource = 'gstr2b' | 'gstr2a' | 'gstr1';
export const RECON_SOURCES: readonly ReconSource[] = ['gstr2b', 'gstr2a', 'gstr1'];
export const RECON_SOURCE_LABELS: Readonly<Record<ReconSource, string>> = {
  gstr2b: 'GSTR-2B',
  gstr2a: 'GSTR-2A',
  gstr1: 'GSTR-1',
};

/** Document type, normalised from the portal codes (R/SEWP/… → invoice, C → credit_note, D → debit_note). */
export type PortalDocType = 'invoice' | 'credit_note' | 'debit_note';
export const PORTAL_DOC_TYPE_LABELS: Readonly<Record<PortalDocType, string>> = {
  invoice: 'Invoice',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
};

/** Portal section the document came from (amendment sections end in 'a'). */
export type PortalSection = 'b2b' | 'b2ba' | 'cdnr' | 'cdnra' | 'b2cl' | 'b2cla' | 'exp' | 'expa' | 'cdnur' | 'cdnura';

export type PortalFileFormat = 'json' | 'xlsx' | 'zip';

/**
 * Status of a reconciliation row.
 *  - pending            imported, not reconciled yet
 *  - matched            paired; every head within tolerance and no other difference
 *  - partial            paired, but taxable/tax/date/POS/rate/RCM/ITC differ (see `diffs`)
 *  - missing_in_books   on the portal only
 *  - missing_in_portal  in the books only (supplier has not filed it, or filed it in another period)
 *  - duplicate          one portal document matches two or more vouchers (or appears twice on the portal)
 *  - accepted           the user accepted the differences (`baseStatus` keeps the computed status)
 *  - ignored            the user excluded the row from follow-up
 */
export type ReconStatus =
  | 'pending'
  | 'matched'
  | 'partial'
  | 'missing_in_books'
  | 'missing_in_portal'
  | 'duplicate'
  | 'accepted'
  | 'ignored';
export const RECON_STATUSES: readonly ReconStatus[] = [
  'matched',
  'partial',
  'missing_in_books',
  'missing_in_portal',
  'duplicate',
  'accepted',
  'ignored',
  'pending',
];
export type ReconBaseStatus = Exclude<ReconStatus, 'accepted' | 'ignored'>;
export const RECON_STATUS_LABELS: Readonly<Record<ReconStatus, string>> = {
  pending: 'Not reconciled',
  matched: 'Matched',
  partial: 'Partially matched',
  missing_in_books: 'Missing in books',
  missing_in_portal: 'Missing in portal',
  duplicate: 'Duplicate',
  accepted: 'Accepted',
  ignored: 'Ignored',
};
/**
 * Results filter: a status, 'open' (needs action: partial, missing_in_books, missing_in_portal, duplicate),
 * 'other_period' (missing in portal but found in another imported period) or 'all'.
 */
export type ReconStatusFilter = ReconStatus | 'open' | 'other_period' | 'all';
export const RECON_STATUS_FILTERS: readonly ReconStatusFilter[] = ['all', 'open', 'other_period', ...RECON_STATUSES];

/** How a pair was made. */
export type MatchMethod = 'exact' | 'fy_stripped' | 'other_period' | 'manual';
export const MATCH_METHOD_LABELS: Readonly<Record<MatchMethod, string>> = {
  exact: 'Document number',
  fy_stripped: 'Document number (year part ignored)',
  other_period: 'Booked in another period',
  manual: 'Linked manually',
};

export type DiffField =
  | 'taxable'
  | 'igst'
  | 'cgst'
  | 'sgst'
  | 'cess'
  | 'date'
  | 'pos'
  | 'rate'
  | 'reverse_charge'
  | 'itc'
  | 'doc_type'
  | 'doc_no'
  | 'invoice_value'
  | 'gstin'
  | 'books_period';

/**
 * One field-level difference. `severity: 'mismatch'` makes the pair 'partial'; 'info' differences are
 * shown but do not change the status (e.g. a 50-paise rounding difference within tolerance).
 * Amount fields: portal/books/difference in paise. date: ISO strings, difference in days (portal − books).
 */
export interface FieldDiff {
  field: DiffField;
  label: string;
  portal: string | number | boolean | null;
  books: string | number | boolean | null;
  difference: number | null;
  severity: 'mismatch' | 'info';
}

export interface TaxHeads {
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

export interface TaxTotals extends TaxHeads {
  count: number;
  taxable: Paise;
  /** igst + cgst + sgst + cess */
  tax: Paise;
}

/**
 * Matching tolerance.
 *  - amountPaise: per head (taxable, IGST, CGST, SGST, cess); |portal − books| ≤ amountPaise is a match (default 100 = ₹1.00).
 *  - dateDays: allowed |date difference|; beyond it the pair stays matched to the document but becomes 'partial' (default 0).
 *  - fuzzyDocNo: normalise document numbers (case, separators, leading zeros, financial-year parts) (default true).
 */
export interface ReconTolerance {
  amountPaise: Paise;
  dateDays: number;
  fuzzyDocNo: boolean;
}
export const DEFAULT_RECON_TOLERANCE: Readonly<ReconTolerance> = { amountPaise: 100, dateDays: 0, fuzzyDocNo: true };

// ───────────────────────────── Documents ─────────────────────────────

/** A document as on the portal file. */
export interface PortalDocView {
  id: number;
  section: PortalSection | null;
  /** Supplier GSTIN (2A/2B) or customer GSTIN (GSTR-1); '' for B2CL / exports / unregistered notes. */
  gstin: string;
  name: string | null;
  docType: PortalDocType;
  docNo: string;
  docDate: string;
  /** State code. */
  pos: string | null;
  reverseCharge: boolean;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  tax: Paise;
  invoiceValue: Paise;
  rates: number[];
  /** GSTR-2B ITC availability (null when the file does not say, e.g. GSTR-2A / GSTR-1). */
  itcAvailable: boolean | null;
  /** 2B reason code and its meaning when ITC is not available. */
  itcReason: string | null;
  /** Supplier's GSTR-1/IFF period (MMYYYY) and filing date (ISO), when known. */
  supplierPeriod: string | null;
  filingDate: string | null;
  /** 2A 'cfs' (counterparty filed: 'Y'/'N') or similar. */
  filingStatus: string | null;
  invoiceType: string | null;
  /** Amendment: the original document number/date. */
  original: { docNo: string; docDate: string | null } | null;
  /** Applicable % of tax rate (e.g. 65) when the portal says so. */
  applicablePct: number | null;
}

/** A voucher as seen by the reconciliation (values from gst_lines, never recomputed). */
export interface BooksDocView {
  voucherId: number;
  voucherNumber: string | null;
  voucherType: string;
  baseType: string;
  /** Supplier invoice no. (reference no.) for purchases, voucher number for sales. */
  docNo: string;
  docNoBasis: 'reference_no' | 'voucher_number';
  docDate: string;
  /** 'voucher_date' when the supplier invoice date was not entered. */
  dateBasis: 'reference_date' | 'voucher_date';
  voucherDate: string;
  partyLedgerId: number | null;
  partyName: string | null;
  gstin: string;
  /** True when the voucher has no GSTIN snapshot and the party ledger's current GSTIN was used. */
  gstinFromLedger: boolean;
  pos: string | null;
  reverseCharge: boolean;
  /** Portal-equivalent type (a purchase return is the supplier's credit note). */
  docType: PortalDocType;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  tax: Paise;
  /** Tax on lines whose ITC is not ineligible (inward only; equals `tax` for sales). */
  eligibleTax: Paise;
  /** `eligibleTax` per head. */
  itc: TaxHeads;
  invoiceValue: Paise;
  rates: number[];
  /** The voucher's reconciliation period (MMYYYY of docDate). */
  period: string;
  /** False when the voucher falls outside the reconciled period (matched across periods). */
  inPeriod: boolean;
}

export interface ReconDifference {
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  tax: Paise;
}

export interface ReconRow {
  /** 'portal' rows come from the imported file; 'books' rows are vouchers missing on the portal. */
  kind: 'portal' | 'books';
  /** Stable row key for UI lists: 'p<portalDocId>' or 'b<voucherId>'. */
  key: string;
  portalDocId: number | null;
  voucherId: number | null;
  status: ReconStatus;
  baseStatus: ReconBaseStatus;
  gstin: string;
  name: string | null;
  docType: PortalDocType;
  portal: PortalDocView | null;
  books: BooksDocView | null;
  diffs: FieldDiff[];
  /** portal − books (null unless both sides exist). */
  difference: ReconDifference | null;
  method: MatchMethod | null;
  manual: boolean;
  /** Missing in portal: another imported period (MMYYYY) where the supplier reported this document. */
  otherPeriod: string | null;
  /** Other vouchers with the same supplier + document number (duplicate entry in the books). */
  duplicateVoucherIds: number[];
  /** Portal duplicate: the portal document this one repeats. */
  duplicateOfDocId: number | null;
  suggestionCount: number;
  notes: string[];
  remarks: string | null;
}

// ───────────────────────────── Imports ─────────────────────────────

export interface ReconImportInput {
  source: ReconSource;
  /** MMYYYY; optional when the file says which period it is for. */
  period?: string;
  fileName: string;
  bytes: Uint8Array;
  /** Replace an earlier import of the same source + period (otherwise CONFLICT). */
  replace?: boolean;
}

export interface ReconImportResult {
  batchId: number;
  source: ReconSource;
  period: string;
  periodLabel: string;
  format: PortalFileFormat;
  docCount: number;
  /** Documents per portal section. */
  sections: Record<string, number>;
  /** Sections present in the file but not reconciled (ISD, IMPG, B2CS summary …) with their document counts. */
  skipped: Record<string, number>;
  totals: TaxTotals;
  warnings: string[];
  replacedBatchId: number | null;
}

/** CONFLICT details when the period was already imported. */
export interface ReconImportConflict {
  existingBatchId: number;
  existingDocCount: number;
  existingFileName: string | null;
  existingImportedAt: string;
  newDocCount: number;
  source: ReconSource;
  period: string;
}

export interface ImportBatchView {
  id: number;
  source: ReconSource;
  period: string;
  periodLabel: string;
  fileName: string | null;
  format: PortalFileFormat;
  importedAt: string;
  importedBy: string | null;
  docCount: number;
  totals: TaxTotals;
  warnings: string[];
  skipped: Record<string, number>;
  lastRunAt: string | null;
  /** Rows needing action at the last run (null when never run). */
  openCount: number | null;
}

// ───────────────────────────── Runs & summaries ─────────────────────────────

export interface ReconRunInput {
  /** MMYYYY (GSTR-1 also accepts a quarter key 'YYYY-YY-Qn'). */
  period: string;
  source: ReconSource;
  tolerance?: Partial<ReconTolerance>;
}

export interface ReconRunView {
  id: number;
  source: ReconSource;
  period: string;
  runAt: string;
  by: string | null;
  tolerance: ReconTolerance;
  /** Books date range that was reconciled. */
  from: string;
  to: string;
  counts: Partial<Record<ReconStatus, number>>;
}

export interface ReconStatusTotals extends TaxTotals {
  status: ReconStatus;
  label: string;
}

export interface ReconSummary {
  source: ReconSource;
  sourceLabel: string;
  period: string;
  periodLabel: string;
  from: string;
  to: string;
  batch: { id: number; fileName: string | null; importedAt: string; docCount: number } | null;
  run: ReconRunView | null;
  /** True when vouchers or the import changed after the last run (run again). */
  stale: boolean;
  staleReason: string | null;
  /** Per status: counts and values (portal values for portal rows, books values for books rows, signed). */
  statuses: ReconStatusTotals[];
  /** All portal documents (signed). */
  portal: TaxTotals;
  /** Portal documents with ITC available (2B); equals `portal` for 2A / GSTR-1. */
  portalItc: TaxTotals;
  /** Vouchers of the period (signed). Null before the first run. */
  books: TaxTotals | null;
  /** Books tax on lines with eligible ITC (null before the first run). */
  booksItc: TaxTotals | null;
  /** portalItc − booksItc per head (null before the first run). */
  difference: ReconDifference | null;
  /** Tax claimed in the books that the portal does not support. */
  itcAtRisk: {
    missingInPortal: TaxHeads;
    excessInBooks: TaxHeads;
    itcNotAvailable: TaxHeads;
    total: Paise;
  };
  /** ITC on the portal that the books have not taken. */
  itcNotBooked: { missingInBooks: TaxHeads; shortInBooks: TaxHeads; total: Paise };
  /** Missing-in-portal rows found in another imported period. */
  otherPeriodCount: number;
  /** Rows needing action. */
  openCount: number;
  /** Share of portal documents that are matched or accepted (0–100, one decimal). */
  reconciledPct: number;
  warnings: string[];
}

export interface ReconResultsInput {
  period: string;
  source: ReconSource;
  status?: ReconStatusFilter;
  supplierGstin?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ReconResultsPage {
  rows: ReconRow[];
  total: number;
  /** Counts per status over the whole period (ignores status/search filters, honours supplierGstin). */
  counts: Partial<Record<ReconStatus, number>>;
}

export interface SupplierReconRow {
  gstin: string;
  name: string | null;
  portalCount: number;
  booksCount: number;
  counts: Partial<Record<ReconStatus, number>>;
  openCount: number;
  portalTaxable: Paise;
  portalTax: Paise;
  booksTaxable: Paise;
  booksTax: Paise;
  /** portal − books */
  taxDifference: Paise;
  taxableDifference: Paise;
}

export interface ReconSuggestion {
  /** Candidate voucher (for a portal row) or portal document (for a books row). */
  voucherId: number | null;
  portalDocId: number | null;
  docNo: string;
  docDate: string;
  voucherNumber: string | null;
  gstin: string;
  name: string | null;
  taxable: Paise;
  tax: Paise;
  /** 1–100, higher is more likely. */
  score: number;
  reasons: string[];
}

export interface ReconSuggestionsInput {
  portalDocId?: number;
  voucherId?: number;
  /** Required with voucherId: the reconciliation the books row belongs to. */
  period?: string;
  source?: ReconSource;
}

export interface ReconLinkInput {
  portalDocId: number;
  voucherId: number;
}

export interface ReconDecisionInput {
  portalDocIds?: number[];
  /** Books-only rows (missing in portal) of this period/source. */
  voucherIds?: number[];
  period?: string;
  source?: ReconSource;
  remarks?: string;
}

export interface ReconDecisionResult {
  updated: number;
  summary: ReconSummary;
}

export interface ReconExportInput {
  period: string;
  source: ReconSource;
  format: 'xlsx' | 'csv';
}

export interface ReconExportResult {
  fileName: string;
  bytes: Uint8Array;
}

export interface SupplierFollowUpInput {
  period: string;
  supplierGstin: string;
  source?: ReconSource;
}

export interface SupplierFollowUp {
  gstin: string;
  name: string | null;
  subject: string;
  /** Plain text, ready to paste into an e-mail. */
  body: string;
  counts: { missingInPortal: number; mismatched: number; missingInBooks: number };
}
