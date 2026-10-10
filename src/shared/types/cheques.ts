/**
 * DTOs of the cheques module (print group): payee bank details, cheque books, cheque register, cheque
 * layouts and printing, and bulk e-payment files. Core: src/core/modules/cheques (README there).
 *
 *   'cheques.payee.get'        { ledgerId }                 → PayeeBankDetails            masters.view
 *   'cheques.payee.save'       PayeeBankSaveInput           → PayeeBankDetails            masters.alter
 *   'cheques.payee.list'       PayeeListInput               → { rows, total }             masters.view
 *   'cheques.banks'            {}                           → ChequeBank[]                vouchers.view
 *   'cheques.book.list'        { bankLedgerId? }            → ChequeBook[]                masters.view
 *   'cheques.book.save'        ChequeBookSaveInput          → ChequeBook                  masters.view + create / alter
 *   'cheques.book.delete'      { id }                       → { ok: true }                masters.delete
 *   'cheques.book.next'        { bankLedgerId, voucherId? } → { chequeNo, bookId } | null vouchers.view
 *   'cheques.leaf.cancel'      ChequeLeafCancelInput        → { ok: true }                vouchers.alter
 *   'cheques.leaf.restore'     { bankLedgerId, chequeNo }   → { ok: true }                vouchers.alter
 *   'cheques.register'         ChequeRegisterInput          → ChequeRegisterResult        reports.view
 *   'cheques.layout.presets'   {}                           → ChequePreset[]              masters.view
 *   'cheques.layout.list'      {}                           → ChequeLayout[]              masters.view
 *   'cheques.layout.save'      ChequeLayoutSaveInput        → ChequeLayout                masters.alter
 *   'cheques.layout.delete'    { id }                       → { ok: true }                masters.alter
 *   'cheques.bank.get'         { bankLedgerId }             → ChequeBankSettings          masters.view
 *   'cheques.bank.save'        ChequeBankSettingsInput      → ChequeBankSettings          masters.alter
 *   'cheques.print.data'       { voucherIds, layoutId? }    → ChequePrintData             vouchers.view
 *   'cheques.print.record'     ChequePrintRecordInput       → { recorded }                data.export
 *   'cheques.epayment.list'    EPaymentListInput            → EPaymentCandidate[]         vouchers.view
 *   'cheques.epayment.export'  EPaymentExportInput          → EPaymentExportResult        data.export
 *   'cheques.epayment.discard' { batchId }                  → { ok: true }                data.export (save cancelled)
 *
 * Money is integer paise; dates 'YYYY-MM-DD'; positions on a cheque leaf are millimetres from the
 * leaf's top-left corner.
 */
import type { Paise } from '../money.ts';

// ───────────────────────────── Payee bank details ─────────────────────────────

export const PAYEE_ACCOUNT_TYPES = ['savings', 'current', 'cash_credit', 'overdraft', 'nre', 'nro', 'other'] as const;
export type PayeeAccountType = (typeof PAYEE_ACCOUNT_TYPES)[number];

/** Bank transfer modes of a bulk payment file. */
export const EPAYMENT_MODES = ['neft', 'rtgs', 'imps'] as const;
export type EPaymentMode = (typeof EPAYMENT_MODES)[number];
/** A payee's preferred way of being paid. */
export type PayeePaymentMode = EPaymentMode | 'cheque';
export const PAYEE_PAYMENT_MODES: readonly PayeePaymentMode[] = ['neft', 'rtgs', 'imps', 'cheque'];

export interface PayeeBankDetails {
  ledgerId: number;
  ledgerName: string;
  /** Account holder's name as the bank has it (e-payment files). */
  beneficiaryName: string | null;
  accountNo: string | null;
  /** 11 characters: 4 letters, '0', 6 letters / digits. */
  ifsc: string | null;
  bankName: string | null;
  branch: string | null;
  accountType: PayeeAccountType | null;
  /** Written on the payee line of cheques (default: beneficiary name, else the ledger's mailing name). */
  chequeName: string | null;
  paymentMode: PayeePaymentMode | null;
  /** Name printed on cheques after the defaults are applied. */
  effectiveChequeName: string;
  updatedAt: string | null;
}

export interface PayeeBankSaveInput {
  ledgerId: number;
  beneficiaryName?: string | null;
  accountNo?: string | null;
  ifsc?: string | null;
  bankName?: string | null;
  branch?: string | null;
  accountType?: PayeeAccountType | null;
  chequeName?: string | null;
  paymentMode?: PayeePaymentMode | null;
}

export interface PayeeListInput {
  search?: string;
  /** Only ledgers that have bank details (else every party / expense ledger, details or not). */
  withDetails?: boolean;
  limit?: number;
  offset?: number;
}

export interface PayeeListRow {
  ledgerId: number;
  ledgerName: string;
  groupName: string;
  beneficiaryName: string | null;
  accountNo: string | null;
  ifsc: string | null;
  bankName: string | null;
  paymentMode: PayeePaymentMode | null;
  hasDetails: boolean;
}

// ───────────────────────────── Cheque books ─────────────────────────────

/** A bank ledger (Bank Accounts / Bank OD) with its cheque printing set-up. */
export interface ChequeBank {
  ledgerId: number;
  name: string;
  accountNo: string | null;
  books: number;
  unusedLeaves: number;
  layoutId: number | null;
}

export interface ChequeBook {
  id: number;
  bankLedgerId: number;
  bankLedgerName: string;
  name: string;
  fromNo: number;
  toNo: number;
  /** Cheque numbers are printed zero-padded to this many digits (6 on CTS-2010 leaves). */
  digits: number;
  isActive: boolean;
  leaves: number;
  issued: number;
  cancelled: number;
  unused: number;
  /** Lowest unused leaf ('000123'), null when the book is used up. */
  nextNo: string | null;
}

export interface ChequeBookSaveInput {
  id?: number;
  bankLedgerId: number;
  name?: string;
  fromNo: number;
  toNo: number;
  digits?: number;
  isActive?: boolean;
}

// ───────────────────────────── Register ─────────────────────────────

export const CHEQUE_LEAF_STATUSES = ['unused', 'issued', 'cleared', 'stale', 'cancelled'] as const;
export type ChequeLeafStatus = (typeof CHEQUE_LEAF_STATUSES)[number];

export interface ChequeRegisterInput {
  bankLedgerId: number;
  bookId?: number;
  status?: ChequeLeafStatus | 'all';
  /** Staleness is judged as on this date (default today). */
  asOf?: string;
}

export interface ChequeRegisterRow {
  key: string;
  bookId: number | null;
  bookName: string | null;
  chequeNo: string;
  status: ChequeLeafStatus;
  /** Issued, dated after asOf. */
  postDated: boolean;
  voucherId: number | null;
  voucherLabel: string | null;
  voucherDate: string | null;
  chequeDate: string | null;
  payee: string | null;
  amount: Paise | null;
  /** Date the cheque cleared (BRS bank date). */
  bankDate: string | null;
  printedAt: string | null;
  /** Why a leaf is cancelled / stale. */
  reason: string | null;
}

export interface ChequeRegisterResult {
  bankLedgerId: number;
  bankLedgerName: string;
  asOf: string;
  rows: ChequeRegisterRow[];
  totals: {
    leaves: number;
    unused: number;
    issued: number;
    cleared: number;
    stale: number;
    cancelled: number;
    issuedAmount: Paise;
    /**
     * Cheques issued but not presented as on `asOf`, exactly as the BRS counts them: in the books (not
     * optional), dated on or before `asOf`, no bank date on or before it. Post-dated cheques dated after
     * `asOf` and optional vouchers are listed as issued but not in this total.
     */
    unclearedAmount: Paise;
  };
}

export interface ChequeLeafCancelInput {
  bankLedgerId: number;
  chequeNo: string;
  reason: string;
  date?: string;
}

// ───────────────────────────── Layouts ─────────────────────────────

/** A point on the leaf, millimetres from its top-left corner; `w` = width available. */
export interface ChequePoint {
  x: number;
  y: number;
  w?: number;
}

/**
 * Where everything goes on the leaf. CTS-2010 leaves are 202 mm × 92 mm; the date is eight boxes
 * (D D M M Y Y Y Y) `pitch` mm apart starting at `date`.
 */
/**
 * Geometry shared by the core's layout check and the renderer's cheque marks: the signatory text
 * ("Authorised Signatory") prints this many millimetres below the "For <company>" line, and text boxes
 * are one font size tall (line-height 1; 1 pt = 25.4 / 72 mm).
 */
export const CHEQUE_SIGN_LINE_GAP_MM = 10;
export const CHEQUE_PT_MM = 25.4 / 72;

export interface ChequeLayoutSpec {
  widthMm: number;
  heightMm: number;
  fontPt: number;
  date: ChequePoint & { pitch: number };
  payee: ChequePoint;
  /** Amount in words: first line, and the second line it wraps onto. */
  words: ChequePoint;
  words2: ChequePoint;
  figures: ChequePoint;
  acPayee: ChequePoint;
  signatory: ChequePoint;
  /** Calibration: shift everything right / down (negative: left / up), mm. */
  offsetX: number;
  offsetY: number;
  /**
   * How the leaf goes into the printer: 'leaf' = a page the size of the leaf (cheque / envelope feed);
   * 'a4_left' / 'a4_center' = the leaf held at the top-left / top-centre of an A4 sheet.
   */
  placement: 'leaf' | 'a4_left' | 'a4_center';
  /** Print paise in the figures ('**1,180.00/-'); off: '**1,180/-' when there are no paise. */
  figuresPaise: boolean;
}

export interface ChequePreset {
  code: string;
  name: string;
  description: string;
  spec: ChequeLayoutSpec;
}

export interface ChequeLayout {
  id: number;
  name: string;
  preset: string | null;
  spec: ChequeLayoutSpec;
  /** Bank ledgers using it. */
  usedBy: string[];
}

export interface ChequeLayoutSaveInput {
  id?: number;
  name: string;
  preset?: string | null;
  spec: ChequeLayoutSpec;
}

export interface ChequeBankSettings {
  bankLedgerId: number;
  bankLedgerName: string;
  layoutId: number | null;
  layoutName: string | null;
  /** Cross cheques 'A/c Payee' by default (never on a self / bearer cheque). */
  acPayee: boolean;
  /** Text under the signature space, e.g. 'Authorised Signatory'. */
  signatory: string | null;
}

export interface ChequeBankSettingsInput {
  bankLedgerId: number;
  layoutId?: number | null;
  acPayee?: boolean;
  signatory?: string | null;
}

// ───────────────────────────── Printing ─────────────────────────────

export interface ChequePrintItem {
  /** `${voucherId}:${lineNo}` */
  key: string;
  voucherId: number;
  /** Ledger entry line of the bank credit. */
  lineNo: number;
  voucherLabel: string;
  voucherDate: string;
  bankLedgerId: number;
  bankLedgerName: string;
  chequeNo: string | null;
  /** Date written on the cheque (instrument date, else the voucher date). */
  chequeDate: string;
  /** DDMMYYYY digits for the eight date boxes. */
  dateDigits: string;
  payee: string;
  /** Self cheque (cash withdrawal): never crossed. */
  self: boolean;
  amount: Paise;
  /** 'Rupees One Thousand One Hundred Eighty Only' */
  amountWords: string;
  /** '**1,180.00/-' */
  amountFigures: string;
  acPayee: boolean;
  signatory: string;
  companyName: string;
  layoutId: number | null;
  layoutName: string;
  spec: ChequeLayoutSpec;
  /** Earlier prints of this voucher's cheque. */
  printed: Array<{ at: string; chequeNo: string | null }>;
  /** Post-dated, stale … — shown before printing, never blocking. */
  warnings: string[];
}

export interface ChequePrintData {
  cheques: ChequePrintItem[];
  /** Vouchers that have no cheque to print, with the reason. */
  skipped: Array<{ voucherId: number; label: string; reason: string }>;
}

export interface ChequePrintRecordInput {
  items: Array<{ voucherId: number; lineNo: number }>;
  layoutId?: number | null;
}

// ───────────────────────────── E-payments ─────────────────────────────

export interface EPaymentListInput {
  from: string;
  to: string;
  bankLedgerId?: number;
}

export interface EPaymentCandidate {
  voucherId: number;
  voucherLabel: string;
  date: string;
  bankLedgerId: number;
  bankLedgerName: string;
  payeeLedgerId: number | null;
  payeeName: string | null;
  beneficiaryName: string | null;
  accountNo: string | null;
  ifsc: string | null;
  amount: Paise;
  mode: EPaymentMode;
  /** Problem that keeps it out of the file (no bank details, several payees …), else null. */
  problem: string | null;
  /** When it was last put in a payment file. */
  exportedAt: string | null;
}

export interface EPaymentExportInput {
  voucherIds: number[];
  /** Value date for the bank (default: each voucher's date). */
  valueDate?: string;
}

export interface EPaymentExportResult {
  bytes: Uint8Array;
  fileName: string;
  rows: number;
  total: Paise;
  skipped: Array<{ voucherId: number; label: string; reason: string }>;
  /** The recorded batch: discard it ('cheques.epayment.discard') when the file was not saved. */
  batchId: number;
}
