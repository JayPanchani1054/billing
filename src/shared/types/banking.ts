/**
 * DTOs for the banking module (src/core/modules/banking): Bank Reconciliation Statement (BRS), bank statement
 * import (CSV / XLSX) with bank presets, auto-matching, vouchers from statement lines, cheque register,
 * post-dated cheques, deposit slip and the per-bank summary. Semantics, worked example, parser presets and the
 * scoring formula: src/core/modules/banking/README.md.
 *
 * Route table (scope 'company'):
 *
 *   'banking.brs'                     reports.view       BrsInput               → BrsResult
 *   'banking.setBankDates'            banking.reconcile  SetBankDatesInput      → SetBankDatesResult
 *   'banking.statement.presets'       reports.view       {}                     → BankPresetInfo[]
 *   'banking.statement.preview'       banking.reconcile  StatementPreviewInput  → StatementPreview
 *   'banking.statement.import'        banking.reconcile  StatementImportInput   → StatementImportResult
 *   'banking.statement.lines'         reports.view       StatementLinesInput    → StatementLinesResult
 *   'banking.statement.batches'       reports.view       { ledgerId? }          → StatementBatch[]
 *   'banking.statement.deleteBatch'   banking.reconcile  { batchId, unmatch? }  → DeleteBatchResult
 *   'banking.autoMatch'               banking.reconcile  AutoMatchInput         → AutoMatchResult
 *   'banking.suggestions'             banking.reconcile  { lineId, dateWindowDays? } → MatchCandidate[]
 *   'banking.match'                   banking.reconcile  { lineId, ledgerEntryId }   → StatementLineView
 *   'banking.unmatch'                 banking.reconcile  { lineId }                  → StatementLineView
 *   'banking.ignoreLine'              banking.reconcile  { lineId, ignore }          → StatementLineView
 *   'banking.createVoucher'           banking.reconcile + vouchers.create  CreateFromLineInput  → CreateFromLineResult
 *   'banking.createVouchers'          banking.reconcile + vouchers.create  { items, acknowledgeWarnings? } → CreateFromLineResult[]
 *   'banking.chequeRegister'          reports.view       ChequeRegisterInput    → ChequeRegisterResult
 *   'banking.pdc'                     reports.view       PdcInput               → PdcResult
 *   'banking.depositSlip'             reports.view       { ledgerId, date }     → DepositSlip
 *   'banking.summary'                 reports.view       { asOf }               → BankSummaryRow[]
 *
 * Sign conventions:
 *  - Book amounts (ledger entries, balances) are signed like the ledger: Dr + / Cr −. For a bank account a Dr
 *    balance is money in the bank; a Bank OD balance is normally Cr (negative).
 *  - Statement amounts are from the BANK's view: deposit (credit in the bank's books) +, withdrawal −.
 *    A deposit therefore matches a DEBIT to the bank ledger in our books with the same signed value.
 *  - Statement balances: positive = funds in the account (the bank shows "Cr"), negative = overdrawn ("Dr"),
 *    i.e. the same sign as the bank ledger's balance in our books.
 * Money is integer paise; dates are 'YYYY-MM-DD'.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { InstrumentType, VoucherWarning } from './vouchers.ts';

// ───────────────────────────── Common ─────────────────────────────

export interface BankLedgerRef {
  id: number;
  name: string;
  /** Under Bank OD A/c (overdraft / cash credit). */
  isOd: boolean;
  accountNo: string | null;
  bankName: string | null;
  ifsc: string | null;
  branch: string | null;
}

/** The voucher a ledger entry belongs to, as shown in banking lists. */
export interface EntryVoucherRef {
  ledgerEntryId: number;
  voucherId: number;
  /** Voucher date. */
  date: string;
  /** Voucher type name ('Receipt', 'Bank Payment', …). */
  voucherType: string;
  baseType: VoucherBaseType;
  number: string | null;
  /** The other side of the voucher: the largest opposite ledger (party, expense, cash …). */
  particulars: string;
}

// ───────────────────────────── BRS ─────────────────────────────

export type BrsShow = 'unreconciled' | 'reconciled' | 'all';
export const BRS_SHOW: readonly BrsShow[] = ['unreconciled', 'reconciled', 'all'];

export interface BrsInput {
  /** A ledger under Bank Accounts or Bank OD A/c. */
  ledgerId: number;
  /** Reconciliation date (period end). */
  asOf: string;
  /** Default 'unreconciled'. */
  show?: BrsShow;
  /**
   * First voucher date for the RECONCILED rows (show 'reconciled' / 'all'); default: first day of asOf's month.
   * Unreconciled rows are always listed in full (an old uncleared cheque still matters).
   */
  from?: string;
}

/**
 * - issued_not_presented:   credit to the bank in the books (cheque issued / payment), no bank date as of asOf.
 * - deposited_not_cleared:  debit to the bank in the books (cheque deposited / receipt), no bank date as of asOf.
 * - cleared_before_voucher: voucher dated AFTER asOf but the bank cleared it on/before asOf (cheque dated earlier
 *                           than the voucher, or a statement match within the 2-day tolerance).
 * - reconciled:             bank date on or before asOf.
 */
export type BrsCategory = 'issued_not_presented' | 'deposited_not_cleared' | 'cleared_before_voucher' | 'reconciled';

export interface BrsEntry extends EntryVoucherRef {
  narration: string | null;
  instrumentType: InstrumentType | null;
  instrumentNo: string | null;
  instrumentDate: string | null;
  /** Drawee bank of a received cheque. */
  drawnOn: string | null;
  /** Unsigned: debit to the bank ledger (deposit/receipt). */
  debit: Paise;
  /** Unsigned: credit to the bank ledger (payment/cheque issued). */
  credit: Paise;
  bankDate: string | null;
  category: BrsCategory;
  /** Statement line linked to this entry (matched or created from it). */
  statementLineId: number | null;
  isPostDated: boolean;
}

export interface BrsResult {
  ledger: BankLedgerRef;
  asOf: string;
  from: string;
  show: BrsShow;
  /** Opening + entries dated ≤ asOf (books filter). Signed Dr +. */
  balanceAsPerBooks: Paise;
  /** Σ credits to the bank (dated ≤ asOf) without a bank date as of asOf — unsigned; ADD to the book balance. */
  chequesIssuedNotPresented: Paise;
  /** Σ debits to the bank (dated ≤ asOf) without a bank date as of asOf — unsigned; SUBTRACT from the book balance. */
  chequesDepositedNotCleared: Paise;
  /** Signed net of entries dated after asOf already cleared by the bank on/before asOf (usually 0). */
  clearedBeforeVoucherDate: Paise;
  /**
   * What the bank should show, from the books:
   *   balanceAsPerBooks + chequesIssuedNotPresented − chequesDepositedNotCleared + clearedBeforeVoucherDate
   * = opening balance + Σ entries with bank date ≤ asOf. Signed like the books (Dr + = funds in the account).
   */
  balanceAsPerBank: Paise;
  /** Running balance of the latest imported statement line dated ≤ asOf (null when none was imported). */
  statementBalance: Paise | null;
  statementDate: string | null;
  /** statementBalance − balanceAsPerBank (null without a statement). */
  difference: Paise | null;
  /**
   * Statement lines dated ≤ asOf that are not linked to any voucher (unmatched or ignored): bank charges,
   * interest, direct credits … — "amounts not reflected in the company's books".
   */
  amountsNotInBooks: { count: number; deposits: Paise; withdrawals: Paise };
  /** difference − (amountsNotInBooks.deposits − amountsNotInBooks.withdrawals); 0 when everything is explained. */
  unexplainedDifference: Paise | null;
  counts: { issuedNotPresented: number; depositedNotCleared: number; clearedBeforeVoucher: number; reconciledListed: number };
  entries: BrsEntry[];
  /** More than BRS_MAX_ROWS rows qualified; the list was cut (totals are always complete). */
  truncated: boolean;
}

export const BRS_MAX_ROWS = 10_000;

export interface SetBankDatesInput {
  entries: Array<{ ledgerEntryId: number; bankDate: string | null }>;
}

export interface SetBankDatesResult {
  updated: number;
  unchanged: number;
  /** Statement lines un-linked because their entry's bank date was cleared. */
  unmatchedLines: number;
}

// ───────────────────────────── Statement import ─────────────────────────────

export type BankPresetId = 'sbi' | 'hdfc' | 'icici' | 'axis' | 'kotak' | 'yes' | 'pnb' | 'bob' | 'canara' | 'generic';
export const BANK_PRESET_IDS: readonly BankPresetId[] = ['sbi', 'hdfc', 'icici', 'axis', 'kotak', 'yes', 'pnb', 'bob', 'canara', 'generic'];

export interface BankPresetInfo {
  id: BankPresetId;
  name: string;
  /** Typical header captions of this bank's download (for help text). */
  headers: string[];
  /** Short note on the bank's file (download menu, quirks). */
  note: string;
}

/** Column roles a statement column can play. */
export type StatementColumnRole =
  | 'date'
  | 'valueDate'
  | 'description'
  | 'reference'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'drCr'
  | 'balance'
  | 'balanceDrCr';
export const STATEMENT_COLUMN_ROLES: readonly StatementColumnRole[] = [
  'date',
  'valueDate',
  'description',
  'reference',
  'debit',
  'credit',
  'amount',
  'drCr',
  'balance',
  'balanceDrCr',
];

/** 0-based column indexes in the header row. `date` and either debit/credit or amount are required. */
export interface StatementColumnMap {
  date: number;
  valueDate?: number | null;
  description?: number | null;
  reference?: number | null;
  /** Withdrawal column (two-column layout). */
  debit?: number | null;
  /** Deposit column (two-column layout). */
  credit?: number | null;
  /** Single amount column (signed, or with a Dr/Cr suffix / indicator column). */
  amount?: number | null;
  /** Dr/Cr indicator for `amount`. */
  drCr?: number | null;
  balance?: number | null;
  /** Dr/Cr indicator for `balance` (Kotak). */
  balanceDrCr?: number | null;
}

export type StatementDateOrder = 'auto' | 'dmy' | 'mdy' | 'ymd';
export const STATEMENT_DATE_ORDERS: readonly StatementDateOrder[] = ['auto', 'dmy', 'mdy', 'ymd'];

/** Single signed amount column without a Dr/Cr indicator: which sign is a deposit. Default deposit_positive. */
export type StatementAmountSign = 'deposit_positive' | 'withdrawal_positive';
export const STATEMENT_AMOUNT_SIGNS: readonly StatementAmountSign[] = ['deposit_positive', 'withdrawal_positive'];

export type StatementDelimiter = ',' | ';' | '\t' | '|';
export const STATEMENT_DELIMITERS: readonly StatementDelimiter[] = [',', ';', '\t', '|'];

/** How to read one statement file. Returned by preview (detected), sent back (possibly edited) to import. */
export interface StatementMapping {
  preset: BankPresetId;
  /** XLSX: worksheet name. */
  sheet?: string | null;
  /** CSV / text: field separator. */
  delimiter?: StatementDelimiter | null;
  /** 0-based index of the header row in the sheet / text rows. */
  headerRow: number;
  columns: StatementColumnMap;
  dateOrder: StatementDateOrder;
  amountSign?: StatementAmountSign;
}

export interface StatementPreviewInput {
  ledgerId: number;
  fileName: string;
  bytes: Uint8Array;
  /** Omit to auto-detect (the ledger's saved mapping first, then bank presets, then fuzzy header matching). */
  mapping?: StatementMapping;
}

export interface StatementImportInput {
  ledgerId: number;
  fileName: string;
  bytes: Uint8Array;
  mapping: StatementMapping;
}

export type StatementIssueLevel = 'info' | 'warning';

/** A row that was not imported as a transaction (or a check that failed), with the reason. */
export interface StatementIssue {
  /** 1-based row in the sheet / text file. */
  row: number;
  level: StatementIssueLevel;
  reason: string;
  /** The row's cells joined with ' | ' (≤ 200 characters). */
  text: string;
}

export interface ParsedStatementLine {
  /** 1-based row in the file. */
  row: number;
  /** Chronological position in the file (0-based). */
  seq: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string;
  /** Bank view: deposit +, withdrawal −. */
  amount: Paise;
  /** Running balance after this line (+ funds / − overdrawn); null when the file has no balance column. */
  balance: Paise | null;
  /** Already imported for this ledger (would be skipped by import). */
  duplicate: boolean;
}

export interface StatementSummary {
  lineCount: number;
  depositCount: number;
  withdrawalCount: number;
  totalDeposits: Paise;
  totalWithdrawals: Paise;
  from: string | null;
  to: string | null;
  /** From an "Opening Balance" row, the lines above the header, or first balance − first amount. */
  openingBalance: Paise | null;
  /** From a "Closing Balance" row or the last running balance. */
  closingBalance: Paise | null;
  /** File order: statements listing the newest transaction first are read bottom-up. */
  order: 'ascending' | 'descending';
  /** Running-balance check: previous balance + amount = balance, in chronological order. */
  balanceCheck: {
    checked: number;
    mismatches: number;
    firstMismatchRow: number | null;
    /** Most mismatches disappear with withdrawals and deposits swapped: the debit/credit columns are probably reversed. */
    swappedLikely: boolean;
  };
  duplicates: number;
  skippedRows: number;
}

export interface StatementPreview {
  format: 'csv' | 'xlsx';
  /** Text files: the detected encoding. */
  encoding: string | null;
  /** XLSX: all worksheet names. */
  sheets: string[];
  preset: BankPresetInfo;
  /** given = the mapping in the request; saved = the ledger's last mapping; preset = a bank layout; auto = fuzzy headers. */
  detectedBy: 'given' | 'saved' | 'preset' | 'auto';
  mapping: StatementMapping;
  /** Header row cells (column captions) of the mapping. */
  headers: string[];
  /** First rows of the sheet as text (≤ 40 rows × 30 columns), to let the user pick another header row. */
  rawPreview: string[][];
  lines: ParsedStatementLine[];
  /** More than STATEMENT_PREVIEW_MAX_LINES lines: the list was cut (summary counts are complete). */
  truncated: boolean;
  issues: StatementIssue[];
  summary: StatementSummary;
}

export const STATEMENT_PREVIEW_MAX_LINES = 5_000;

export interface StatementImportResult {
  /** null when every line was already imported (nothing new → no batch). */
  batchId: number | null;
  imported: number;
  duplicates: number;
  skippedRows: number;
  from: string | null;
  to: string | null;
  totalDeposits: Paise;
  totalWithdrawals: Paise;
  closingBalance: Paise | null;
}

export type StatementLineStatus = 'unmatched' | 'matched' | 'created' | 'ignored';
export const STATEMENT_LINE_STATUSES: readonly StatementLineStatus[] = ['unmatched', 'matched', 'created', 'ignored'];

/** How a line got linked: auto-match, a manual match, or a voucher created from it. */
export type MatchMethod = 'auto' | 'manual' | 'created';

export interface StatementLineView {
  id: number;
  batchId: number;
  ledgerId: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string;
  /** Bank view: deposit +, withdrawal −. */
  amount: Paise;
  deposit: Paise;
  withdrawal: Paise;
  balance: Paise | null;
  status: StatementLineStatus;
  matchScore: number | null;
  matchMethod: MatchMethod | null;
  /** The voucher entry this line is linked to (status matched / created). */
  matched: (EntryVoucherRef & { bankDate: string | null; amount: Paise }) | null;
  sourceRow: number | null;
}

export interface StatementLinesInput {
  ledgerId: number;
  from: string;
  to: string;
  /** Default all. */
  status?: StatementLineStatus | 'all';
  batchId?: number;
  /** Matches description or reference (case-insensitive) or an exact amount ('1,180.00'). */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface StatementLinesResult {
  rows: StatementLineView[];
  total: number;
  /** Counts over the date range (all statuses, ignoring status/search filters). */
  counts: Record<StatementLineStatus, number>;
  /** Over the filtered rows. */
  totals: { deposits: Paise; withdrawals: Paise };
}

export interface StatementBatch {
  id: number;
  ledgerId: number;
  ledgerName: string;
  fileName: string | null;
  importedAt: string;
  importedBy: string | null;
  preset: BankPresetId;
  presetName: string;
  format: 'csv' | 'xlsx';
  from: string | null;
  to: string | null;
  lineCount: number;
  counts: Record<StatementLineStatus, number>;
  totalDeposits: Paise;
  totalWithdrawals: Paise;
  openingBalance: Paise | null;
  closingBalance: Paise | null;
  duplicatesSkipped: number;
}

export interface DeleteBatchResult {
  batchId: number;
  deletedLines: number;
  /** Linked lines that were un-reconciled first (their entries' bank dates cleared). */
  unmatched: number;
}

// ───────────────────────────── Matching ─────────────────────────────

export interface AutoMatchInput {
  ledgerId: number;
  /** Only lines of this import batch. */
  batchId?: number;
  /** Days after the voucher date a statement line may fall (default 7). Lines may also be up to 2 days earlier. */
  dateWindowDays?: number;
  /** Minimum score to apply a match automatically (default 70). */
  threshold?: number;
  /** false = dry run: report what would be matched without changing anything (default true). */
  apply?: boolean;
}

export type MatchReasonCode = 'amount' | 'date' | 'reference' | 'party' | 'instrument' | 'bank_date';

export interface MatchReason {
  code: MatchReasonCode;
  points: number;
  text: string;
}

export interface MatchCandidate extends EntryVoucherRef {
  /** Signed book amount on the bank ledger (equals the statement amount). */
  amount: Paise;
  instrumentType: InstrumentType | null;
  instrumentNo: string | null;
  bankDate: string | null;
  /** 0–100. */
  score: number;
  /** Statement date − voucher date, in days. */
  dayGap: number;
  reasons: MatchReason[];
}

export interface AutoMatchApplied {
  lineId: number;
  ledgerEntryId: number;
  voucherId: number;
  score: number;
}

export interface AutoMatchSuggestion {
  line: StatementLineView;
  /** Best first (≤ 3). */
  candidates: MatchCandidate[];
  /** Why it was not applied. */
  reason: 'ambiguous' | 'low_score';
}

export interface AutoMatchResult {
  applied: AutoMatchApplied[];
  suggestions: AutoMatchSuggestion[];
  /** Lines considered (unmatched, not ignored). */
  considered: number;
  /** Lines with no candidate at all (create a voucher or ignore them). */
  withoutCandidates: number;
  dryRun: boolean;
}

// ───────────────────────────── Vouchers from statement lines ─────────────────────────────

export type FromLineKind = 'receipt' | 'payment' | 'contra';
export const FROM_LINE_KINDS: readonly FromLineKind[] = ['receipt', 'payment', 'contra'];

export interface CreateFromLineInput {
  lineId: number;
  /** receipt / contra for deposits; payment / contra for withdrawals. */
  kind: FromLineKind;
  /** The other ledger: party / income / expense (receipt, payment) or cash / another bank (contra). */
  contraLedgerId: number;
  /** Default: the statement narration. */
  narration?: string;
  /** Default: the predefined voucher type of `kind`. */
  voucherTypeId?: number;
  /** Save even though the voucher engine raised non-blocking warnings (negative cash, credit limit …). */
  acknowledgeWarnings?: boolean;
}

export interface CreateFromLineResult {
  lineId: number;
  voucherId: number;
  number: string | null;
  ledgerEntryId: number;
  warnings: VoucherWarning[];
}

// ───────────────────────────── Registers ─────────────────────────────

export type ChequeStatus = 'cleared' | 'uncleared' | 'post_dated';
export type ChequeStatusFilter = 'cleared' | 'uncleared' | 'all';
export const CHEQUE_STATUS_FILTERS: readonly ChequeStatusFilter[] = ['cleared', 'uncleared', 'all'];
/** issued = credit to the bank (our cheque); received = debit to the bank (customer's cheque deposited). */
export type ChequeDirection = 'issued' | 'received';

export interface ChequeRegisterInput {
  /** Omit for every bank ledger. */
  ledgerId?: number;
  from: string;
  to: string;
  status?: ChequeStatusFilter;
  direction?: ChequeDirection | 'all';
}

export interface ChequeRegisterRow extends EntryVoucherRef {
  bankLedgerId: number;
  bankLedgerName: string;
  direction: ChequeDirection;
  instrumentType: 'cheque' | 'dd';
  instrumentNo: string | null;
  instrumentDate: string | null;
  drawnOn: string | null;
  favouring: string | null;
  /** Unsigned. */
  amount: Paise;
  bankDate: string | null;
  status: ChequeStatus;
  /** Uncleared and more than 3 months past the cheque date (CTS validity) as of today. */
  stale: boolean;
}

export interface ChequeRegisterResult {
  rows: ChequeRegisterRow[];
  totals: {
    issued: { count: number; amount: Paise; uncleared: number; unclearedAmount: Paise };
    received: { count: number; amount: Paise; uncleared: number; unclearedAmount: Paise };
    stale: number;
  };
}

export interface PdcInput {
  asOf: string;
  ledgerId?: number;
  /** Also list post-dated vouchers whose date has arrived (date ≤ asOf). Default false. */
  includeMatured?: boolean;
}

/** receivable = PDC received from a customer (Dr bank); payable = PDC issued to a supplier (Cr bank). */
export type PdcKind = 'receivable' | 'payable';

export interface PdcRow extends EntryVoucherRef {
  bankLedgerId: number;
  bankLedgerName: string;
  kind: PdcKind;
  instrumentType: InstrumentType | null;
  instrumentNo: string | null;
  instrumentDate: string | null;
  drawnOn: string | null;
  /** Unsigned. */
  amount: Paise;
  /** Voucher (maturity) date − asOf; negative once matured. */
  daysToMaturity: number;
  matured: boolean;
  bankDate: string | null;
}

export interface PdcResult {
  asOf: string;
  rows: PdcRow[];
  totals: { receivable: { count: number; amount: Paise }; payable: { count: number; amount: Paise } };
}

export interface DepositSlipCheque {
  ledgerEntryId: number;
  voucherId: number;
  voucherType: string;
  number: string | null;
  /** Party the cheque came from. */
  particulars: string;
  instrumentType: 'cheque' | 'dd';
  instrumentNo: string | null;
  instrumentDate: string | null;
  drawnOn: string | null;
  amount: Paise;
}

export interface DepositSlip {
  company: { name: string; gstin: string | null };
  bank: BankLedgerRef & { holder: string | null };
  date: string;
  cheques: DepositSlipCheque[];
  /** Cash deposited the same day (contra from a cash ledger / instrument 'cash'). */
  cash: { amount: Paise; vouchers: number };
  totals: { chequeCount: number; cheques: Paise; cash: Paise; total: Paise };
  /** e.g. 'Rupees Twelve Thousand Only'. */
  amountInWords: string;
}

export interface BankSummaryRow extends BankLedgerRef {
  balanceAsPerBooks: Paise;
  balanceAsPerBank: Paise;
  unreconciled: {
    count: number;
    /** Deposits/receipts not yet cleared (unsigned). */
    depositsCount: number;
    deposits: Paise;
    /** Cheques issued/payments not yet presented (unsigned). */
    issuedCount: number;
    issued: Paise;
  };
  /** Latest bank date set on this ledger (≤ asOf). */
  lastReconciledDate: string | null;
  lastStatement: { date: string; balance: Paise | null; importedAt: string } | null;
  statementLines: Record<StatementLineStatus, number>;
}
