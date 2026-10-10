/**
 * DTOs for the outstanding module (src/core/modules/outstanding) — "Statements of Accounts ›
 * Outstandings": bills receivable/payable, group (party) outstandings, ageing, interest, statement of
 * account, payment reminders and the dashboard "due soon" list. Semantics and worked examples:
 * src/core/modules/outstanding/README.md.
 *
 * Route table (scope 'company', access 'reports.view', transactional: false):
 *
 *   'outstanding.bills'         OutstandingBillsInput  → OutstandingBillsResult
 *   'outstanding.partySummary'  PartySummaryInput      → PartySummaryResult
 *   'outstanding.ledgerBills'   LedgerBillsInput       → LedgerBillsResult
 *   'outstanding.ageing'        AgeingInput            → AgeingResult
 *   'outstanding.interest'      InterestInput          → InterestResult
 *   'outstanding.statement'     StatementInput         → StatementResult
 *   'outstanding.reminders'     RemindersInput         → RemindersResult
 *   'outstanding.dueSoon'       DueSoonInput           → DueSoonResult
 *
 * Sign conventions:
 *  - Side reports (bills, partySummary, ageing, dueSoon, reminders, interest) use SIDE-SIGNED amounts:
 *    positive = receivable from the party (receivable side) / payable to the party (payable side);
 *    negative = in the party's favour on that side (advance received from a customer, debit note
 *    against a supplier, …).
 *  - Single-ledger documents (ledgerBills, statement) use ledger signs: Dr +, Cr −.
 * Money is integer paise; dates are 'YYYY-MM-DD'.
 */
import type { Paise } from '../money.ts';
import type { VoucherBaseType } from '../constants.ts';

/** Bills receivable (Dr) or bills payable (Cr). */
export type OutstandingSide = 'receivable' | 'payable';
export const OUTSTANDING_SIDES: readonly OutstandingSide[] = ['receivable', 'payable'];

/**
 * How a ledger that is NOT maintained bill-wise is reported:
 *  - on_account: its whole balance is one "On Account" line (not aged, never overdue).
 *  - fifo:       its balance is aged against the most recent debits (Dr balance) / credits (Cr balance),
 *                newest first, each voucher becoming one pseudo-bill (refType 'fifo').
 */
export type NonBillWiseMode = 'on_account' | 'fifo';
export const NON_BILL_WISE_MODES: readonly NonBillWiseMode[] = ['on_account', 'fifo'];

/** Ageing / interest start: from the due date or from the bill date. */
export type AgeingBasis = 'due_date' | 'bill_date';
export const AGEING_BASES: readonly AgeingBasis[] = ['due_date', 'bill_date'];

/**
 * Origin of an outstanding line:
 *  - new:        bill created by a voucher ('new' reference)
 *  - opening:    opening bill (ledger master, before books beginning)
 *  - advance:    advance reference (amount received/paid before the bill) — shown separately
 *  - against:    a reference with only 'against' allocations (its 'new' reference is missing)
 *  - on_account: amount not allocated to any bill (or the balance of a non-bill-wise ledger)
 *  - fifo:       slice of a non-bill-wise ledger's balance, aged first-in-first-out
 */
export type OutstandingRefType = 'new' | 'opening' | 'advance' | 'against' | 'on_account' | 'fifo';

export type OutstandingBillSort = 'bill_date' | 'due_date' | 'party' | 'amount' | 'overdue';
export const OUTSTANDING_BILL_SORTS: readonly OutstandingBillSort[] = ['bill_date', 'due_date', 'party', 'amount', 'overdue'];

/** Default ageing bucket limits (days): not due, 1–30, 31–60, 61–90, 91–180, > 180. */
export const DEFAULT_AGEING_BUCKETS: readonly number[] = [30, 60, 90, 180];

// ───────────────────────────── outstanding.bills ─────────────────────────────

export interface OutstandingBillsInput {
  side: OutstandingSide;
  asOf: string;
  /**
   * Restrict to ledgers in this group (and its sub-groups). Default: Sundry Debtors (receivable) /
   * Sundry Creditors (payable), plus bill-wise ledgers outside both groups whose net balance is on
   * that side (Dr for receivable, Cr for payable).
   */
  groupId?: number;
  ledgerId?: number;
  /** Only bills with overdueDays > 0. */
  overdueOnly?: boolean;
  /** Only bills overdue by at least this many days. */
  minOverdueDays?: number;
  /** Party name/alias or bill name contains (case-insensitive). */
  search?: string;
  /** Default 'bill_date' (oldest first; On Account lines last). */
  sort?: OutstandingBillSort;
  /** Default 1000, max 10000. */
  limit?: number;
  offset?: number;
  /** Default 'on_account'. */
  nonBillWise?: NonBillWiseMode;
  /** Include one "On Account" line per party for unallocated amounts (default true). */
  includeOnAccount?: boolean;
}

export interface OutstandingBillRow {
  ledgerId: number;
  ledgerName: string;
  groupId: number;
  groupName: string;
  billWise: boolean;
  /** Bill reference; 'On Account' for unallocated lines; voucher number (or 'Opening Balance') for fifo slices. */
  billName: string;
  /** Null for On Account lines. */
  billDate: string | null;
  /** Null for advances and On Account lines. */
  dueDate: string | null;
  creditDays: number | null;
  /** Side-signed amount of the originating reference(s). */
  originalAmount: Paise;
  /** Side-signed pending amount (positive = receivable / payable). */
  pendingAmount: Paise;
  /** asOf − dueDate when positive, else 0 (always 0 for advances and On Account lines). */
  overdueDays: number;
  refType: OutstandingRefType;
  /** Voucher that created the bill (null for opening bills and On Account lines). */
  voucherId: number | null;
}

export interface OutstandingTotals {
  /** Σ pendingAmount = overdue + notDue + advance + onAccount. */
  pending: Paise;
  /** Σ pending of bills with overdueDays > 0. */
  overdue: Paise;
  /** Σ pending of the other bills (excluding advances and On Account). */
  notDue: Paise;
  advance: Paise;
  onAccount: Paise;
  /** Bills (excluding advances and On Account lines). */
  billCount: number;
  overdueCount: number;
}

export interface OutstandingBillsResult {
  side: OutstandingSide;
  asOf: string;
  rows: OutstandingBillRow[];
  /** Matching rows before limit/offset. */
  total: number;
  /** Over all matching rows (not just this page). */
  totals: OutstandingTotals;
}

// ───────────────────────────── outstanding.partySummary ─────────────────────────────

export interface PartySummaryInput {
  side: OutstandingSide;
  asOf: string;
  groupId?: number;
  search?: string;
  nonBillWise?: NonBillWiseMode;
  /** Also list parties with nothing outstanding (default false). */
  includeZero?: boolean;
}

export interface PartyOutstandingRow {
  ledgerId: number;
  ledgerName: string;
  groupId: number;
  groupName: string;
  billWise: boolean;
  /** Net outstanding (side-signed) = billsPending + advance + onAccount = the ledger's closing balance. */
  pending: Paise;
  /** Σ pending bills excluding advances (= overdue + notDue). */
  billsPending: Paise;
  overdue: Paise;
  notDue: Paise;
  advance: Paise;
  onAccount: Paise;
  billCount: number;
  overdueBillCount: number;
  /** Overdue days of the most overdue bill (0 = nothing overdue). */
  oldestDueDays: number;
  creditLimit: Paise | null;
  creditDays: number | null;
  /** pending ÷ creditLimit × 100, 2 decimals; null without a credit limit. */
  utilisationPercent: number | null;
  /** pending > creditLimit. */
  overLimit: boolean;
  mobile: string | null;
  email: string | null;
}

export interface PartySummaryResult {
  side: OutstandingSide;
  asOf: string;
  rows: PartyOutstandingRow[];
  totals: {
    pending: Paise;
    billsPending: Paise;
    overdue: Paise;
    notDue: Paise;
    advance: Paise;
    onAccount: Paise;
    partyCount: number;
    overLimitCount: number;
  };
}

// ───────────────────────────── outstanding.ledgerBills ─────────────────────────────

export interface LedgerBillsInput {
  ledgerId: number;
  asOf: string;
  /** Also return bills fully settled by asOf (default false). */
  includeSettled?: boolean;
  /** Non-bill-wise ledgers: default 'fifo' (the balance broken down by the vouchers that make it up). */
  nonBillWise?: NonBillWiseMode;
}

export type BillHistoryKind = 'opening' | 'new' | 'against' | 'advance' | 'fifo';

export interface BillHistoryLine {
  kind: BillHistoryKind;
  /** Null for opening bills. */
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  baseType: VoucherBaseType | null;
  date: string;
  /** Signed: Dr +, Cr −. */
  amount: Paise;
  /** Pending after this line (signed). */
  runningPending: Paise;
  narration: string | null;
}

export interface LedgerBillDetail {
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  creditDays: number | null;
  refType: OutstandingRefType;
  /** Signed: Dr +, Cr −. */
  originalAmount: Paise;
  /** Signed: Dr +, Cr −. */
  pendingAmount: Paise;
  overdueDays: number;
  voucherId: number | null;
  history: BillHistoryLine[];
}

export type OnAccountKind = 'opening' | 'on_account' | 'unallocated';

export interface OnAccountLine {
  /**
   * opening: opening balance not broken into opening bills · on_account: an 'On Account' allocation ·
   * unallocated: (part of) a ledger entry without bill allocations.
   */
  kind: OnAccountKind;
  date: string;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  baseType: VoucherBaseType | null;
  /** Signed: Dr +, Cr −. */
  amount: Paise;
  narration: string | null;
}

export interface LedgerBillsResult {
  ledger: {
    id: number;
    name: string;
    groupId: number;
    groupName: string;
    billWise: boolean;
    /** Debtors → receivable, creditors → payable, others by the sign of the balance (null when zero). */
    side: OutstandingSide | null;
    creditDays: number | null;
    creditLimit: Paise | null;
    interestRate: number | null;
  };
  asOf: string;
  /** How the balance is broken down. */
  method: 'bill_wise' | 'fifo' | 'on_account';
  /** Closing balance as of asOf (signed). */
  balance: Paise;
  bills: LedgerBillDetail[];
  onAccount: { total: Paise; lines: OnAccountLine[] };
  totals: {
    /** Σ pending of bills (excluding advances), signed. */
    billsPending: Paise;
    advance: Paise;
    onAccount: Paise;
    /** Σ pending of overdue bills, signed. */
    overdue: Paise;
    /** billsPending + advance + onAccount (= balance). */
    balance: Paise;
  };
}

// ───────────────────────────── outstanding.ageing ─────────────────────────────

export interface AgeingInput {
  side: OutstandingSide;
  asOf: string;
  /** Ascending upper limits in days (default [30, 60, 90, 180]); 1–12 entries. */
  buckets?: number[];
  /** Default 'due_date'. */
  basis?: AgeingBasis;
  groupId?: number;
  ledgerId?: number;
  search?: string;
  nonBillWise?: NonBillWiseMode;
}

export interface AgeingBucket {
  /** 0 = not due; 1… = the age ranges. */
  index: number;
  label: string;
  /** Inclusive lower bound in days (null for "not due"). */
  minDays: number | null;
  /** Inclusive upper bound in days (null for the last, open-ended bucket). */
  maxDays: number | null;
}

export interface AgeingPartyRow {
  ledgerId: number;
  ledgerName: string;
  groupId: number;
  groupName: string;
  billWise: boolean;
  /** Side-signed amounts aligned with `buckets` (index 0 = not due). */
  amounts: Paise[];
  advance: Paise;
  onAccount: Paise;
  /** Σ amounts + advance + onAccount (= net outstanding). */
  total: Paise;
}

export interface AgeingResult {
  side: OutstandingSide;
  asOf: string;
  basis: AgeingBasis;
  buckets: AgeingBucket[];
  rows: AgeingPartyRow[];
  totals: { amounts: Paise[]; advance: Paise; onAccount: Paise; total: Paise };
}

// ───────────────────────────── outstanding.interest ─────────────────────────────

export type InterestMethod = 'simple_365';

export interface InterestInput {
  ledgerId?: number;
  /** Default (neither ledgerId nor groupId): Sundry Debtors and Sundry Creditors. */
  groupId?: number;
  from: string;
  to: string;
  /** % per annum; default: each ledger's interest rate (ledgers without one are skipped). */
  ratePercent?: number;
  /** Default 'due_date'. */
  basis?: AgeingBasis;
  /** Interest-free days after the basis date (default 0). */
  graceDays?: number;
  /** Only 'simple_365' (simple interest, 365-day year, also in leap years). */
  method?: InterestMethod;
}

/** A run of days with a constant pending amount: days in (from, to], i.e. `from` excluded, `to` included. */
export interface InterestSegment {
  from: string;
  to: string;
  days: number;
  /** Side-signed pending on those days (> 0 only; days with nothing pending are not listed). */
  balance: Paise;
}

export interface InterestBillRow {
  ledgerId: number;
  ledgerName: string;
  /** receivable: interest to charge the party · payable: interest owed to the party. */
  side: OutstandingSide;
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  refType: OutstandingRefType;
  /** Interest accrues on the days after this date (basis date + grace days). */
  interestFrom: string;
  ratePercent: number;
  /** Pending (side-signed) on the first interest-bearing day in the window. */
  principal: Paise;
  /** Pending (side-signed) at the end of the window. */
  pendingAtEnd: Paise;
  /** Interest-bearing days within the window. */
  days: number;
  /** round(Σ balance × days × rate ÷ 100 ÷ 365) — rounded once per bill. */
  interest: Paise;
  segments: InterestSegment[];
}

export interface InterestResult {
  from: string;
  to: string;
  basis: AgeingBasis;
  graceDays: number;
  method: InterestMethod;
  rows: InterestBillRow[];
  totals: { receivable: Paise; payable: Paise; billCount: number };
  /** Ledgers in scope that were not calculated, with the reason. */
  skipped: Array<{ ledgerId: number; ledgerName: string; reason: string }>;
}

// ───────────────────────────── outstanding.statement ─────────────────────────────

export interface StatementInput {
  ledgerId: number;
  from: string;
  to: string;
  /** Non-bill-wise ledgers' pending list: default 'fifo'. */
  nonBillWise?: NonBillWiseMode;
  /** Ageing buckets for the pending-bills section (default [30, 60, 90, 180], due-date basis). */
  buckets?: number[];
}

export interface StatementCompany {
  name: string;
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  stateName: string | null;
  pincode: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  gstin: string | null;
  pan: string | null;
}

export interface StatementParty {
  ledgerId: number;
  name: string;
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  stateName: string | null;
  pincode: string | null;
  gstin: string | null;
  pan: string | null;
  contactPerson: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  groupName: string;
  billWise: boolean;
  creditDays: number | null;
  creditLimit: Paise | null;
}

export interface StatementLine {
  date: string;
  voucherId: number;
  voucherType: string;
  baseType: VoucherBaseType;
  voucherNumber: string | null;
  referenceNo: string | null;
  /** Counter ledger (the largest opposite-side ledger of the voucher). */
  particulars: string;
  narration: string | null;
  /** Unsigned. */
  debit: Paise;
  /** Unsigned. */
  credit: Paise;
  /** Running balance after this line, signed Dr + / Cr −. */
  balance: Paise;
}

export interface StatementBillRow {
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  refType: OutstandingRefType;
  /** Signed: Dr +, Cr −. */
  pendingAmount: Paise;
  overdueDays: number;
  /** Age used for the bucket (asOf − due date); null for advances / On Account. */
  ageDays: number | null;
  /** Index into pendingBills.buckets; null for advances / On Account. */
  bucketIndex: number | null;
}

export interface StatementResult {
  company: StatementCompany;
  party: StatementParty;
  from: string;
  to: string;
  generatedOn: string;
  /** Signed: Dr +, Cr −. */
  openingBalance: Paise;
  transactions: StatementLine[];
  totals: { debit: Paise; credit: Paise };
  /** openingBalance + debit − credit (signed). */
  closingBalance: Paise;
  pendingBills: {
    asOf: string;
    method: 'bill_wise' | 'fifo' | 'on_account';
    buckets: AgeingBucket[];
    rows: StatementBillRow[];
    /** Signed totals aligned with buckets. */
    bucketTotals: Paise[];
    advance: Paise;
    onAccount: Paise;
    /** = closingBalance. */
    total: Paise;
  };
}

// ───────────────────────────── outstanding.reminders ─────────────────────────────

export interface RemindersInput {
  asOf: string;
  /** Bills overdue by at least this many days (default 1). */
  minOverdueDays?: number;
  /** Only 'receivable'. */
  side?: 'receivable';
  groupId?: number;
  ledgerId?: number;
  nonBillWise?: NonBillWiseMode;
}

export interface ReminderBill {
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  /** Positive amount due. */
  pendingAmount: Paise;
  overdueDays: number;
}

/** gentle: oldest overdue ≤ 30 days · second: 31–60 · firm: > 60 (always polite). */
export type ReminderTone = 'gentle' | 'second' | 'firm';

export interface ReminderLetter {
  /** Letter date (formatted, e.g. '05-Oct-2026'). */
  date: string;
  /** Company name and address lines. */
  from: string[];
  /** 'To,' block: party name and address lines. */
  to: string[];
  subject: string;
  salutation: string;
  /** Paragraphs before the bills table. */
  opening: string[];
  table: { columns: string[]; rows: string[][]; total: string[] };
  /** Paragraphs after the table. */
  closing: string[];
  /** Sign-off lines ('Yours faithfully,', 'For <company>', '', 'Authorised Signatory'). */
  signOff: string[];
  /** The whole letter as plain text (fixed-width table), ready for e-mail or a .txt export. */
  text: string;
}

export interface ReminderParty {
  ledgerId: number;
  ledgerName: string;
  email: string | null;
  mobile: string | null;
  tone: ReminderTone;
  overdueBills: ReminderBill[];
  /** Σ overdueBills. */
  totalOverdue: Paise;
  /** Credits in the party's favour not yet adjusted (advances, credit bills, on account) — ≤ 0. */
  unadjustedCredits: Paise;
  /** max(0, totalOverdue + unadjustedCredits) — what the letter asks for. */
  amountDue: Paise;
  /** Party's net outstanding (side-signed). */
  netOutstanding: Paise;
  oldestOverdueDays: number;
  letter: ReminderLetter;
}

export interface RemindersResult {
  asOf: string;
  minOverdueDays: number;
  parties: ReminderParty[];
  totals: { partyCount: number; amountDue: Paise };
}

// ───────────────────────────── outstanding.dueSoon ─────────────────────────────

export interface DueSoonInput {
  side: OutstandingSide;
  asOf: string;
  /** Bills with asOf ≤ dueDate ≤ asOf + days (0–366). */
  days: number;
  groupId?: number;
  /** Default 50, max 1000. */
  limit?: number;
  nonBillWise?: NonBillWiseMode;
}

export interface DueSoonRow extends OutstandingBillRow {
  /** dueDate − asOf (0 = due today). */
  daysToDue: number;
}

export interface DueSoonResult {
  side: OutstandingSide;
  asOf: string;
  days: number;
  /** asOf + days. */
  until: string;
  /** Ordered by due date, then party. */
  rows: DueSoonRow[];
  /** Matching bills before the limit. */
  total: number;
  /** Σ pending of all matching bills. */
  amount: Paise;
  /** Already overdue on asOf (for the dashboard tile). */
  overdue: { amount: Paise; count: number };
}
