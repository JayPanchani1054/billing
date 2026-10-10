/**
 * DTOs for the reports module (src/core/modules/reports) — "Display" reports with drill-down.
 * Semantics, formulas and worked examples: src/core/modules/reports/README.md.
 *
 * Route table (scope 'company', transactional: false; access reports.view unless noted):
 *
 *   'reports.trialBalance'    TrialBalanceInput     → TrialBalanceResult
 *   'reports.profitLoss'      ProfitLossInput       → ProfitLossResult          reports.financial
 *   'reports.balanceSheet'    BalanceSheetInput     → BalanceSheetResult        reports.financial
 *   'reports.groupSummary'    GroupSummaryInput     → GroupSummaryResult
 *   'reports.groupVouchers'   GroupVouchersInput    → GroupVouchersResult
 *   'reports.ledger'          LedgerReportInput     → LedgerReportResult
 *   'reports.monthlySummary'  MonthlySummaryInput   → MonthlySummaryResult
 *   'reports.cashBank'        PeriodInput           → CashBankResult
 *   'reports.register'        RegisterInput         → RegisterResult
 *   'reports.cashFlow'        PeriodInput           → CashFlowResult            reports.financial
 *   'reports.fundsFlow'       PeriodInput           → FundsFlowResult           reports.financial
 *   'reports.ratios'          PeriodInput           → RatiosResult              reports.financial
 *   'reports.exceptions'      ExceptionsInput       → ExceptionsResult
 *   'reports.costCentres'     CostCentresInput      → CostCentresResult
 *   'reports.statistics'      PeriodInput           → StatisticsResult
 *
 * Conventions: money is integer paise. Ledger-style figures (opening / closing / running balance)
 * are SIGNED: Dr +, Cr −. `debit` / `credit` are unsigned period totals (closing = opening + debit −
 * credit). Two-sided statements (P&L, Balance Sheet, funds flow) use SIDE-NATURAL amounts: positive
 * = the normal balance for the side the line is on (an expense line's Dr, an income line's Cr, a
 * liability's Cr, an asset's Dr); a negative value means the line has the opposite balance.
 * Dates are 'YYYY-MM-DD'.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';

// ───────────────────────────── Common ─────────────────────────────

export interface PeriodInput {
  from: string;
  to: string;
}

/**
 * Kinds of rows in tree reports:
 *  group / ledger            masters (id = group / ledger id)
 *  stock                     inventory value line (Opening Stock / Closing Stock), id null
 *  difference                "Difference in opening balances", id null
 *  profit_loss               the Balance Sheet "Profit & Loss A/c" line (id = the reserved ledger, if any)
 *  pl_part                   its sub-lines "Opening Balance" / "Current Period"
 *  gross / net               Gross Profit c/o / b/f, Gross Loss, Net Profit / Net Loss lines
 *  total                     section totals (P&L trading / P&L account totals)
 */
export type ReportRowKind = 'group' | 'ledger' | 'stock' | 'difference' | 'profit_loss' | 'pl_part' | 'gross' | 'net' | 'total';

/** Common shape of every tree row (rows are returned in display / pre-order). */
export interface ReportTreeRow {
  /** Stable key: 'g:12', 'l:45', 'stock:opening', 'stock:closing', 'diff', 'pl', 'pl:opening', 'gp:co', … */
  key: string;
  kind: ReportRowKind;
  /** Group or ledger id for master rows, else null. */
  id: number | null;
  name: string;
  /** 0 = top level. */
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
}

// ───────────────────────────── Trial Balance ─────────────────────────────

/**
 * 'groups': group tree (no ledgers) · 'detailed': groups with their ledgers · 'ledgers': flat ledger list.
 * In every mode the reserved Profit & Loss A/c ledger is a level-0 line of its own (key 'l:<id>'), never
 * inside Capital Account — as accountants expect, and so Capital Account agrees with its Balance Sheet line.
 */
export type TrialBalanceMode = 'groups' | 'ledgers' | 'detailed';
export const TRIAL_BALANCE_MODES: readonly TrialBalanceMode[] = ['groups', 'ledgers', 'detailed'];

export interface TrialBalanceInput extends PeriodInput {
  mode?: TrialBalanceMode;
  /** UI hint only (the opening column is always computed). */
  showOpening?: boolean;
  /** Include rows whose opening, debit, credit and closing are all zero (default false). */
  showZero?: boolean;
}

export interface TbRow extends ReportTreeRow {
  /** Signed, Dr + / Cr −. */
  opening: Paise;
  debit: Paise;
  credit: Paise;
  /** Signed, Dr + / Cr −. */
  closing: Paise;
}

export interface DrCrTotals {
  debit: Paise;
  credit: Paise;
}

export interface TrialBalanceResult {
  from: string;
  to: string;
  mode: TrialBalanceMode;
  /** Nominal (income/expense) ledgers start from this date; earlier results sit in the Profit & Loss A/c. */
  yearStart: string;
  inventoryIntegrated: boolean;
  rows: TbRow[];
  /** Totals of the top-level rows (Dr column = Σ positive balances, Cr column = Σ |negative|). */
  totals: { opening: DrCrTotals; transactions: DrCrTotals; closing: DrCrTotals };
  /** Opening stock shown in the Trial Balance (stock value at `yearStart`), 0 without integrated inventory. */
  openingStock: Paise;
  /**
   * Difference in opening balances = −(Σ ledger opening balances + opening stock at the books
   * beginning). Signed (Dr + / Cr −); 0 when the openings agree. Shown as its own row when ≠ 0.
   */
  openingDifference: Paise;
  /** Closing Dr total − Cr total after the difference row: 0 unless the stored data is inconsistent. */
  unbalancedBy: Paise;
  balanced: boolean;
}

// ───────────────────────────── Profit & Loss ─────────────────────────────

export type StatementMode = 'condensed' | 'detailed';
export const STATEMENT_MODES: readonly StatementMode[] = ['condensed', 'detailed'];
export type CompareWith = 'previous_period' | 'previous_year';
export const COMPARE_WITH: readonly CompareWith[] = ['previous_period', 'previous_year'];

export interface ProfitLossInput extends PeriodInput {
  /** UI default expansion only: the full tree is always returned. */
  mode?: StatementMode;
  compareWith?: CompareWith;
}

export interface StatementLine extends ReportTreeRow {
  /** Side-natural amount (see the header). */
  amount: Paise;
  /** Same line for the comparison period (null when no comparison or the line did not exist). */
  compare: Paise | null;
}

/** One two-sided block (conventional horizontal layout). Each side's lines are in display order. */
export interface StatementBlock {
  left: StatementLine[];
  right: StatementLine[];
  /** Left total = right total (by construction). */
  total: Paise;
  compareTotal: Paise | null;
}

export interface VerticalLine {
  key: string;
  label: string;
  /** Schedule III note: amounts are positive for income / expense as labelled; profit negative = loss. */
  amount: Paise;
  compare: Paise | null;
  level: number;
  emphasis: boolean;
  /** Group whose summary explains the figure, when there is one. */
  groupId: number | null;
}

export interface ProfitFigures {
  openingStock: Paise;
  closingStock: Paise;
  sales: Paise;
  purchases: Paise;
  directIncomes: Paise;
  directExpenses: Paise;
  indirectIncomes: Paise;
  indirectExpenses: Paise;
  /** Positive = gross profit, negative = gross loss. */
  grossProfit: Paise;
  /** Positive = net profit, negative = net loss. */
  netProfit: Paise;
}

export interface ProfitLossResult {
  from: string;
  to: string;
  mode: StatementMode;
  compare: { from: string; to: string } | null;
  inventoryIntegrated: boolean;
  /** Expenses (left) | Income (right): Trading account (down to Gross Profit c/o). */
  trading: StatementBlock;
  /** Expenses (left) | Income (right): Profit & Loss account (from Gross Profit b/f). */
  profitLoss: StatementBlock;
  figures: ProfitFigures;
  compareFigures: ProfitFigures | null;
  /** Schedule III-style vertical statement. */
  vertical: VerticalLine[];
}

// ───────────────────────────── Balance Sheet ─────────────────────────────

export interface BalanceSheetInput {
  asOf: string;
  mode?: StatementMode;
  /** Optional comparative date (e.g. the previous year end). */
  compareAsOf?: string;
}

export interface BalanceSheetResult {
  asOf: string;
  mode: StatementMode;
  compareAsOf: string | null;
  /** Financial year start used to split the Profit & Loss A/c into opening and current period. */
  yearStart: string;
  inventoryIntegrated: boolean;
  liabilities: StatementLine[];
  assets: StatementLine[];
  liabilitiesTotal: Paise;
  assetsTotal: Paise;
  compareLiabilitiesTotal: Paise | null;
  compareAssetsTotal: Paise | null;
  /** assetsTotal − liabilitiesTotal: 0 unless the stored data is inconsistent. */
  difference: Paise;
  balanced: boolean;
  closingStock: Paise;
  /** Profit & Loss A/c split (positive = profit / credit balance). */
  profitLoss: { openingBalance: Paise; currentPeriod: Paise; total: Paise };
  /** Signed like the Trial Balance (Dr + / Cr −). */
  openingDifference: Paise;
}

// ───────────────────────────── Group summary / vouchers ─────────────────────────────

/**
 * Figures of a Group Summary: 'trialBalance' (default) = Trial-Balance balances (income/expense ledgers
 * from the start of the financial year); 'profitLoss' = as in the Profit & Loss statement — income and
 * expense ledgers count only from `from` (what a drill-down from a mid-year P&L must show). Asset and
 * liability groups always use Trial-Balance figures.
 */
export type GroupSummaryBasis = 'trialBalance' | 'profitLoss';
export const GROUP_SUMMARY_BASES: readonly GroupSummaryBasis[] = ['trialBalance', 'profitLoss'];

export interface GroupSummaryInput extends PeriodInput {
  groupId: number;
  showZero?: boolean;
  basis?: GroupSummaryBasis;
}

export interface GroupSummaryResult {
  from: string;
  to: string;
  group: { id: number; name: string; path: string[]; nature: string; isNominal: boolean };
  /** Basis actually applied ('profitLoss' only for an income/expense group). */
  basis: GroupSummaryBasis;
  /** Sub-groups and ledgers below the group (direct children at level 0, deeper rows below them). */
  rows: TbRow[];
  /** The group's own totals (= Σ level-0 rows). */
  totals: { opening: Paise; debit: Paise; credit: Paise; closing: Paise };
}

export interface GroupVouchersInput extends PeriodInput {
  groupId: number;
  limit?: number;
}

export interface GroupVoucherRow {
  voucherId: number;
  date: string;
  voucherType: string;
  baseType: VoucherBaseType;
  number: string | null;
  /** Ledgers of the group touched by the voucher (comma-joined), or '(as per details)' when > 3. */
  particulars: string;
  narration: string | null;
  debit: Paise;
  credit: Paise;
  /** Signed running balance of the group. */
  balance: Paise;
}

export interface GroupVouchersResult {
  from: string;
  to: string;
  group: { id: number; name: string };
  opening: Paise;
  rows: GroupVoucherRow[];
  totals: DrCrTotals;
  closing: Paise;
  /** Vouchers in the period (rows may be fewer when truncated). */
  count: number;
  truncated: boolean;
}

// ───────────────────────────── Ledger ─────────────────────────────

export interface LedgerReportInput extends PeriodInput {
  ledgerId: number;
  limit?: number;
}

export interface LedgerReportDetail {
  ledgerId: number;
  ledgerName: string;
  /** Signed like the entry. */
  amount: Paise;
}

export interface LedgerReportRow {
  voucherId: number;
  date: string;
  voucherType: string;
  baseType: VoucherBaseType;
  number: string | null;
  referenceNo: string | null;
  /** The opposite ledger, or '(as per details)' when there are several (see `details`). */
  particulars: string;
  /** All other ledgers of the voucher with their amounts (signed). */
  details: LedgerReportDetail[];
  narration: string | null;
  debit: Paise;
  credit: Paise;
  /** Signed running balance after this voucher. */
  balance: Paise;
  isPostDated: boolean;
}

export interface LedgerReportResult {
  from: string;
  to: string;
  ledger: { id: number; name: string; alias: string | null; groupId: number; groupName: string; isNominal: boolean; isActive: boolean };
  opening: Paise;
  rows: LedgerReportRow[];
  totals: DrCrTotals;
  closing: Paise;
  count: number;
  truncated: boolean;
}

// ───────────────────────────── Monthly summary ─────────────────────────────

export interface MonthlySummaryInput extends PeriodInput {
  ledgerId?: number;
  groupId?: number;
}

export interface MonthRow {
  /** 'YYYY-MM'. */
  month: string;
  /** First / last day of the month inside the period. */
  from: string;
  to: string;
  debit: Paise;
  credit: Paise;
  /** Signed closing balance at the end of the month. */
  closing: Paise;
  /** Vouchers touching the ledger/group that month. */
  count: number;
}

export interface MonthlySummaryResult {
  from: string;
  to: string;
  subject: { kind: 'ledger' | 'group'; id: number; name: string };
  opening: Paise;
  rows: MonthRow[];
  totals: DrCrTotals;
  closing: Paise;
}

// ───────────────────────────── Cash / Bank books ─────────────────────────────

export interface CashBankResult {
  from: string;
  to: string;
  rows: TbRow[];
  totals: { opening: Paise; debit: Paise; credit: Paise; closing: Paise };
}

// ───────────────────────────── Registers ─────────────────────────────

export interface RegisterInput extends PeriodInput {
  baseType?: VoucherBaseType;
  voucherTypeId?: number;
  /** Also return the vouchers of the period (for a month drill-down). */
  includeVouchers?: boolean;
  limit?: number;
}

export interface RegisterMonth {
  month: string;
  from: string;
  to: string;
  /** Vouchers counted (not optional, not cancelled, post-dated only once due). */
  count: number;
  cancelled: number;
  amount: Paise;
  taxable: Paise;
  tax: Paise;
}

export interface RegisterVoucher {
  id: number;
  date: string;
  voucherType: string;
  baseType: VoucherBaseType;
  number: string | null;
  partyName: string | null;
  referenceNo: string | null;
  narration: string | null;
  amount: Paise;
  taxable: Paise;
  tax: Paise;
  isCancelled: boolean;
  isPostDated: boolean;
}

export interface RegisterResult {
  from: string;
  to: string;
  title: string;
  baseType: VoucherBaseType | null;
  voucherTypeIds: number[];
  months: RegisterMonth[];
  totals: { count: number; cancelled: number; amount: Paise; taxable: Paise; tax: Paise };
  vouchers: RegisterVoucher[] | null;
  truncated: boolean;
}

// ───────────────────────────── Cash flow / funds flow ─────────────────────────────

export interface CashFlowMonth {
  month: string;
  from: string;
  to: string;
  inflow: Paise;
  outflow: Paise;
  /** inflow − outflow. */
  net: Paise;
}

export interface CashFlowGroupRow {
  /** Reporting group of the counter ledgers: the primary group, or its first sub-group (Sundry Debtors, Duties & Taxes, …). */
  groupId: number;
  groupName: string;
  inflow: Paise;
  outflow: Paise;
  net: Paise;
}

export interface CashFlowResult {
  from: string;
  to: string;
  /** Σ Cash-in-Hand + Bank Accounts + Bank OD balances (signed). */
  opening: Paise;
  closing: Paise;
  months: CashFlowMonth[];
  groups: CashFlowGroupRow[];
  totals: { inflow: Paise; outflow: Paise; net: Paise };
}

export interface FundsFlowLine {
  key: string;
  label: string;
  groupId: number | null;
  amount: Paise;
}

export interface WorkingCapitalRow {
  key: string;
  label: string;
  groupId: number | null;
  /** Set for a ledger placed directly under Current Assets / Current Liabilities. */
  ledgerId: number | null;
  side: 'asset' | 'liability';
  /** Side-natural balances. */
  opening: Paise;
  closing: Paise;
  /** Effect on working capital: + increase, − decrease. */
  change: Paise;
}

export interface FundsFlowResult {
  from: string;
  to: string;
  sources: FundsFlowLine[];
  applications: FundsFlowLine[];
  totalSources: Paise;
  totalApplications: Paise;
  workingCapital: { opening: Paise; closing: Paise; change: Paise };
  workingCapitalRows: WorkingCapitalRow[];
  /** totalSources − totalApplications − workingCapital.change: 0 unless the data is inconsistent. */
  difference: Paise;
}

// ───────────────────────────── Ratios ─────────────────────────────

export type RatioUnit = 'amount' | 'ratio' | 'percent' | 'days' | 'times';

export interface RatioItem {
  key: string;
  label: string;
  /** amount → paise (side-natural); ratio/times → plain number; percent → %; days → days. null = not computable (zero denominator). */
  value: number | null;
  unit: RatioUnit;
  formula: string;
  /** Group whose summary explains the figure. */
  groupId: number | null;
}

export interface RatiosResult {
  from: string;
  to: string;
  days: number;
  principal: RatioItem[];
  ratios: RatioItem[];
}

// ───────────────────────────── Exceptions ─────────────────────────────

export interface ExceptionsInput extends PeriodInput {
  includeNoNarration?: boolean;
  limit?: number;
}

export interface NegativeLedgerRow {
  ledgerId: number;
  ledgerName: string;
  groupName: string;
  /** Signed closing balance at `to`. */
  closing: Paise;
  reason: string;
}

export interface ExceptionVoucher {
  id: number;
  date: string;
  voucherType: string;
  baseType: VoucherBaseType;
  number: string | null;
  partyName: string | null;
  narration: string | null;
  amount: Paise;
}

export interface ExceptionsResult {
  from: string;
  to: string;
  negativeLedgers: NegativeLedgerRow[];
  optional: ExceptionVoucher[];
  postDated: ExceptionVoucher[];
  cancelled: ExceptionVoucher[];
  memorandum: ExceptionVoucher[];
  /** Only when includeNoNarration (accounting vouchers without narration). */
  noNarration: ExceptionVoucher[] | null;
  truncated: boolean;
}

// ───────────────────────────── Cost centres ─────────────────────────────

export interface CostCentresInput extends PeriodInput {
  categoryId?: number;
  /** Ledger breakup of this centre (and its sub-centres). */
  costCentreId?: number;
}

export interface CostCentreRow {
  /** 'cat:1' for categories, 'cc:5' for centres. */
  key: string;
  kind: 'category' | 'centre';
  id: number;
  name: string;
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
  debit: Paise;
  credit: Paise;
  /** Signed (debit − credit), including sub-centres. */
  net: Paise;
}

export interface CostCentreLedgerRow {
  ledgerId: number;
  ledgerName: string;
  groupName: string;
  debit: Paise;
  credit: Paise;
  net: Paise;
}

export interface CostCentresResult {
  from: string;
  to: string;
  rows: CostCentreRow[];
  centre: { id: number; name: string; ledgers: CostCentreLedgerRow[]; totals: { debit: Paise; credit: Paise; net: Paise } } | null;
}

// ───────────────────────────── Statistics ─────────────────────────────

export interface VoucherStatRow {
  voucherTypeId: number;
  name: string;
  baseType: VoucherBaseType;
  regular: number;
  optional: number;
  cancelled: number;
  postDated: number;
  total: number;
}

export interface StatisticsResult {
  from: string;
  to: string;
  vouchers: VoucherStatRow[];
  voucherTotals: { regular: number; optional: number; cancelled: number; postDated: number; total: number };
  masters: Array<{ key: string; label: string; count: number }>;
}
