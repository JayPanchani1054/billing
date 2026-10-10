/**
 * DTOs for the print module (src/core/modules/print, src/renderer/modules/print).
 *
 *   'print.voucherData'  PrintDataInput    → PrintVoucherData       access 'vouchers.view'
 *   'print.batchData'    PrintBatchInput   → PrintBatchResult       access 'vouchers.view'
 *   'print.sample'       PrintSampleInput  → PrintVoucherData       access 'company.view'
 *   'print.bankLedgers'  none              → PrintBankOption[]      access 'company.view'
 *
 * Everything a template needs to render a document is in PrintVoucherData — templates never call
 * the API. Money is integer paise; quantities are in the item's unit; dates are 'YYYY-MM-DD'.
 * Semantics (titles, copies, totals tie-out, fallbacks): src/core/modules/print/README.md.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { CompanyConfig, InvoiceTemplate } from '../settings.ts';
import type { GstNature, Taxability, TaxMode } from './gst.ts';
import type { PrintForex } from './forex.ts';
import type { PrintPos } from './pos.ts';

/** Which family of template renders the document. */
export type PrintLayout = 'invoice' | 'voucher' | 'inventory';
export const PRINT_LAYOUTS: readonly PrintLayout[] = ['invoice', 'voucher', 'inventory'];

/** What the document is (drives the title and the statutory endorsements). */
export type PrintDocKind =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'invoice_cum_bill_of_supply'
  | 'invoice'
  | 'export_invoice'
  | 'sez_invoice'
  | 'self_invoice'
  | 'sales_voucher'
  | 'purchase_voucher'
  | 'credit_note'
  | 'debit_note'
  | 'delivery_challan'
  | 'receipt_note'
  | 'rejection_in'
  | 'rejection_out'
  | 'sales_order'
  | 'purchase_order'
  | 'payment_voucher'
  | 'receipt_voucher'
  | 'journal_voucher'
  | 'contra_voucher'
  | 'memorandum'
  | 'reversing_journal'
  | 'stock_journal'
  | 'physical_stock'
  // Documents module: pre-sale documents (no books, not a tax invoice).
  | 'quotation'
  | 'proforma_invoice';

export type PrintCopy = 'original' | 'duplicate' | 'triplicate';
export const PRINT_COPIES: readonly PrintCopy[] = ['original', 'duplicate', 'triplicate'];

/**
 * Paper of a printed document: sheets (A5 also landscape) and thermal receipt rolls (continuous: the page
 * is as long as the receipt). Sheets take the Modern / Classic templates, rolls the Compact receipt.
 */
export type PrintPageSize = 'A4' | 'A5' | 'A5-landscape' | 'Letter' | 'Legal' | '80mm' | '58mm';
export const PRINT_PAGE_SIZES: readonly PrintPageSize[] = ['A4', 'A5', 'A5-landscape', 'Letter', 'Legal', '80mm', '58mm'];
export const PRINT_SHEET_SIZES: readonly PrintPageSize[] = ['A4', 'A5', 'A5-landscape', 'Letter', 'Legal'];
export const PRINT_ROLL_SIZES: readonly PrintPageSize[] = ['80mm', '58mm'];

export const PRINT_TEMPLATES: readonly InvoiceTemplate[] = ['modern', 'classic', 'compact'];

/** Invoice print options (Invoice Printing (print settings)) — the subset of CompanyConfig['invoice'] the documents use. */
export type InvoicePrintOptions = CompanyConfig['invoice'];

/** Name + address block (company, buyer, consignee). Empty strings are normalised to null. */
export interface PrintAddress {
  name: string | null;
  address: string | null;
  pincode: string | null;
  /** GST state code, e.g. '27'; '96' for other countries. */
  stateCode: string | null;
  /** 'Maharashtra' ('' never — null when unknown). */
  stateName: string | null;
  country: string | null;
  gstin: string | null;
  pan: string | null;
  /** Party GST registration type ('regular', 'unregistered', 'overseas', …); null for the company block. */
  registrationType: string | null;
  phone: string | null;
  email: string | null;
}

export interface PrintCompany extends PrintAddress {
  /** Name to print (mailing name when set, else the company name). */
  displayName: string;
  website: string | null;
  cin: string | null;
  /** 'regular' | 'composition' | 'unregistered' (or GST feature off → 'unregistered'). */
  gstRegistrationType: 'regular' | 'composition' | 'unregistered';
  /** data:image/(png|jpeg|webp|gif);base64,… or null. */
  logo: string | null;
}

/** One printed line (item or invoice-ledger line), in document order. */
export interface PrintLine {
  /** 1-based serial number. */
  sl: number;
  kind: 'item' | 'ledger';
  /** Item name / ledger name. */
  name: string;
  /** Extra line description typed on the voucher (printed under the name). */
  description: string | null;
  hsnSac: string | null;
  batch: string | null;
  /** null on ledger lines without a quantity. */
  qty: number | null;
  unit: string | null;
  /** Decimal places of the unit (0 for Nos). */
  qtyDecimals: number;
  /** Rupees per unit, exclusive of tax; null when not applicable. */
  rate: number | null;
  discountPct: number;
  discount: Paise;
  /**
   * Value in the Amount column: the line's own value after discount (before additional charges absorbed
   * into it). Σ amount over all lines = Σ taxableValue = totals.taxable.
   */
  amount: Paise;
  /** Taxable value (including any absorbed charges); 0 for an absorbed charge line. */
  taxableValue: Paise;
  taxability: Taxability;
  /** GST rate % (0 for exempt / nil / non-GST). */
  gstRate: number;
  cessRate: number;
  cgst: Paise;
  /** SGST or UTGST (see PrintGst.sgstLabel). */
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  /** cgst + sgst + igst + cess. */
  tax: Paise;
  /** Tax is part of the invoice value (false: reverse charge, import of goods). */
  taxPayable: boolean;
  /** Charge whose value is included in the goods lines' taxable value (freight apportioned by value/qty). */
  absorbed: boolean;
  reverseCharge: boolean;
  /** Stock journal side; null elsewhere. */
  section: 'consumption' | 'production' | null;
  /**
   * (print group) Item's MRP per unit in paise (maximum retail price, inclusive of all taxes), when the
   * item master has one; absent / null otherwise.
   */
  mrp?: Paise | null;
}

/**
 * (print group) MRP summary of an outward document whose items carry an MRP: Σ MRP × qty and what the
 * buyer saved against it (Σ per line of MRP value − value charged incl. tax, never negative).
 */
export interface PrintMrpSummary {
  /** The MRP column / 'You saved' line is printed (Invoice Printing (print settings) › Show MRP, voucher type). */
  show: boolean;
  mrpValue: Paise;
  savings: Paise;
}

/** Non-GST charge or deduction added after tax (TCS, non-GST discount). Negative = deduction. */
export interface PrintCharge {
  name: string;
  amount: Paise;
}

export interface PrintTaxRateRow {
  taxability: Taxability;
  rate: number;
  cessRate: number;
  reverseCharge: boolean;
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  tax: Paise;
}

export interface PrintHsnRow {
  hsnSac: string;
  description: string | null;
  /** Total quantity (goods), null for services / ledger lines. */
  qty: number | null;
  unit: string | null;
  rate: number;
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  tax: Paise;
}

export interface PrintTotals {
  /** Σ qty when every quantity line uses the same unit, else null. */
  qty: number | null;
  unit: string | null;
  qtyDecimals: number;
  discount: Paise;
  /** Σ line amount = Σ taxable value. */
  taxable: Paise;
  /** Tax heads payable with the invoice (reverse-charge / import tax excluded). */
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  /** cgst + sgst + igst + cess (payable with the invoice). */
  tax: Paise;
  /** Tax computed but payable by the recipient (reverse charge) or at customs (import of goods). */
  reverseChargeTax: Paise;
  /** Σ PrintCharge.amount. */
  charges: Paise;
  roundOff: Paise;
  /**
   * Document value. Invoice layout: taxable + tax + charges + roundOff (asserted). Voucher layout: Σ debits.
   * Inventory layout: Σ line amounts.
   */
  grandTotal: Paise;
}

/** Ledger entry for payment / receipt / journal / contra vouchers. */
export interface PrintEntry {
  ledgerName: string;
  /** Signed, Dr +, Cr −. */
  amount: Paise;
  debit: Paise;
  credit: Paise;
  /** Cash-in-hand / bank ledger. */
  isCashBank: boolean;
  narration: string | null;
  /** 'Cheque 004512 dated 05-Apr-2026, HDFC Bank' style text, or null. */
  instrument: string | null;
  /** 'Agst Ref 12/2026-27: 1,180.00' style lines. */
  bills: string[];
  costCentres: string[];
}

export interface PrintBank {
  ledgerId: number;
  ledgerName: string;
  accountHolder: string | null;
  accountNo: string | null;
  ifsc: string | null;
  bankName: string | null;
  branch: string | null;
  upiId: string | null;
}

export type PrintBankOption = PrintBank;

export interface PrintUpi {
  /** VPA, e.g. 'shop@okhdfcbank'. */
  id: string;
  payeeName: string;
  amount: Paise;
  /** Transaction note (invoice number). */
  note: string;
  /** upi://pay?pa=…&pn=…&am=…&cu=INR&tn=… (URL-encoded). */
  uri: string;
}

export interface PrintEInvoice {
  irn: string;
  ackNo: string | null;
  ackDate: string | null;
  /** Signed QR code string from the IRP (render as a QR image). */
  signedQr: string | null;
}

export interface PrintEwayBill {
  number: string;
  date: string | null;
  validUpto: string | null;
}

export interface PrintGst {
  /** The document carries GST columns / tax summary (GST company, invoice layout, not composition/unregistered). */
  showTax: boolean;
  taxMode: TaxMode;
  interState: boolean;
  /** 'SGST' or 'UTGST' (UT without legislature). */
  sgstLabel: 'SGST' | 'UTGST';
  nature: GstNature | null;
}

export interface PrintCopyLabels {
  original: string;
  duplicate: string;
  triplicate: string;
}

/** Labelled pairs printed in the reference grid (Buyer's order no., Dispatched through, Vehicle no., …). */
export interface PrintRef {
  label: string;
  value: string;
}

export interface PrintVoucherData {
  /** Voucher id (0 for the sample document). */
  id: number;
  sample: boolean;
  layout: PrintLayout;
  kind: PrintDocKind;
  baseType: VoucherBaseType;
  voucherTypeId: number;
  voucherTypeName: string;
  /** 'Tax Invoice', 'Bill of Supply', 'Payment Voucher', … */
  title: string;
  /** Statutory endorsement under the title (export / SEZ under LUT …), or null. */
  endorsement: string | null;
  /** Further statutory notes printed on the document (composition dealer, reverse charge …). */
  notes: string[];
  number: string | null;
  date: string;
  /** Supplier invoice no. (purchase) / reference no. */
  referenceNo: string | null;
  referenceDate: string | null;
  status: { cancelled: boolean; cancelReason: string | null; optional: boolean; postDated: boolean };
  company: PrintCompany;
  /** 'Buyer (Bill to)', 'Supplier (Bill from)', 'Party', 'Recipient' … */
  partyLabel: string;
  party: PrintAddress | null;
  consigneeLabel: string;
  /**
   * Ship-to; equals the party block when no separate consignee was entered (see consigneeSameAsParty).
   * null on inward documents (goods come to the company); the company itself on a purchase order.
   */
  consignee: PrintAddress | null;
  consigneeSameAsParty: boolean;
  /** '27-Maharashtra' style; null when not applicable. */
  placeOfSupply: { code: string; name: string; label: string } | null;
  reverseCharge: boolean;
  gst: PrintGst;
  lines: PrintLine[];
  charges: PrintCharge[];
  taxByRate: PrintTaxRateRow[];
  taxByHsn: PrintHsnRow[];
  totals: PrintTotals;
  amountInWords: string;
  /** Tax amount in words (invoices with tax), else null. */
  taxInWords: string | null;
  /** Voucher layout only (empty otherwise). */
  entries: PrintEntry[];
  narration: string | null;
  /** Credit / debit note: the invoice it adjusts. */
  originalInvoice: { number: string; date: string | null; reason: string | null } | null;
  /** Order / dispatch / export references (label + value pairs, empty values dropped). */
  references: PrintRef[];
  einvoice: PrintEInvoice | null;
  ewayBill: PrintEwayBill | null;
  bank: PrintBank | null;
  upi: PrintUpi | null;
  declaration: string | null;
  terms: string | null;
  signatoryLabel: string;
  /** Copy labels for this kind of document (Rule 48 / Rule 55). */
  copyLabels: PrintCopyLabels;
  /** Resolved print options: Invoice Printing (print settings), voucher-type overrides and preview overrides applied. */
  options: InvoicePrintOptions;
  /** Template to start with (voucher type › F12 › layout default). */
  defaultTemplate: InvoiceTemplate;
  /** (print group) MRP of the items sold; null when no line has an MRP or the document is not a sale. */
  mrpSummary?: PrintMrpSummary | null;
  /** (forex group) Foreign-currency amounts, rate and words of an export / import document; absent / null otherwise. */
  forex?: PrintForex | null;
  /** (pos group) Tenders, cash tendered and change of a POS bill / return; absent / null otherwise. */
  pos?: PrintPos | null;
  /** Previous / next voucher of the same type (date, number order) for Next/Prev in the preview. */
  navigation: { prevId: number | null; nextId: number | null };
  /**
   * Things the user should know before printing (figures rebuilt from the books, masters changed since
   * the voucher was saved, missing statutory particulars — see print/compliance.ts …). Written for an
   * accountant; never blocks printing.
   */
  warnings: string[];
}

/** Partial invoice options applied on top of the saved configuration (live preview in print settings). */
export type InvoicePrintOverrides = Partial<InvoicePrintOptions>;

export interface PrintDataInput {
  id: number;
  overrides?: InvoicePrintOverrides;
}

export interface PrintBatchInput {
  ids: number[];
}

export interface PrintBatchResult {
  documents: PrintVoucherData[];
  /** Ids that no longer exist (deleted since the list was made). */
  notFound: number[];
}

export interface PrintSampleInput {
  overrides?: InvoicePrintOverrides;
}

export const PRINT_BATCH_MAX = 500;

// ───────────────────────────── Sharing (print group) ─────────────────────────────

/** What is being shared: a voucher (invoice, note, receipt …) or a party's statement of account. */
export interface ShareSubjectInput {
  voucherId?: number;
  statement?: { ledgerId: number; from: string; to: string };
}

export type ShareChannel = 'email' | 'whatsapp';
export const SHARE_CHANNELS: readonly ShareChannel[] = ['email', 'whatsapp'];

/** 'print.share.context' → recipient and texts, pre-filled from the party ledger and F12 › Sharing. */
export interface ShareContext {
  kind: 'voucher' | 'statement';
  /** 'Tax Invoice INV/12' / 'Statement of Account — Sharma Traders'. */
  label: string;
  partyLedgerId: number | null;
  partyName: string | null;
  /** Party ledger e-mail (null when none or invalid). */
  email: string | null;
  /** Party mobile, 10 digits (Mobile, else a Phone that is a mobile number); null when none. */
  mobile: string | null;
  subject: string;
  body: string;
  whatsappText: string;
  /** Suggested PDF file name without extension. */
  fileName: string;
}

/** 'print.share.log' — the edit-log entry written before main sends the file. */
export interface ShareLogInput extends ShareSubjectInput {
  channel: ShareChannel;
  /** Recipient as typed (e-mail address(es) or mobile). */
  to?: string;
  fileName: string;
}
