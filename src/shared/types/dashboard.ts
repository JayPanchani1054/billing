/**
 * Dashboard DTOs ('dashboard.summary'). Money is integer paise. Flows (sales, purchases) are
 * side-natural positives (sales = credits to Sales Accounts less debits, e.g. credit notes);
 * balances (cash, bank) are signed Dr + / Cr −. Dates are ISO 'YYYY-MM-DD'.
 * See src/core/modules/dashboard/README.md for every rule.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';

export interface DashboardSummaryInput {
  /** Working date: today / month-to-date / year-to-date figures and balances are as at this date. */
  asOf: string;
  /** Selected reporting period (Alt+F2): top customers/items, gross profit, period sales. */
  from: string;
  to: string;
}

export interface DateRange {
  from: string;
  to: string;
}

/** The ranges every flow figure is computed for (so the UI can drill down with the same dates). */
export interface DashboardRanges {
  today: DateRange;
  /** First of the month of `asOf` → asOf. */
  mtd: DateRange;
  /** Start of the financial year of `asOf` (never before the books begin) → asOf. */
  ytd: DateRange;
  period: DateRange;
  /** The same ranges a year earlier (a month-end stays a month-end; 29-Feb → 28-Feb). */
  lastYear: { today: DateRange; mtd: DateRange; ytd: DateRange; period: DateRange };
}

export interface FlowSet {
  today: Paise;
  mtd: Paise;
  ytd: Paise;
  period: Paise;
}

/** A flow (sales or purchases, net of returns) for each range and the same range last year. */
export interface DashboardFlow extends FlowSet {
  lastYear: FlowSet;
}

export interface DashboardGrossProfit {
  /**
   * 'stock_valuation' (integrated inventory): sales + direct incomes − (opening stock + purchases +
   * direct expenses − closing stock) — the P&L's gross profit. 'purchases': the same without stock.
   */
  method: 'stock_valuation' | 'purchases';
  sales: Paise;
  purchases: Paise;
  directIncomes: Paise;
  directExpenses: Paise;
  /** null when inventory is not integrated with accounts. */
  openingStock: Paise | null;
  closingStock: Paise | null;
  /** openingStock + purchases + directExpenses − closingStock (stock terms 0 when not integrated). */
  costOfSales: Paise;
  amount: Paise;
  /** amount ÷ sales × 100, 2 decimals; null when sales is 0. */
  marginPercent: number | null;
}

export interface DashboardAgeingBucket {
  /** 0 = not yet due; 1… = overdue ranges. */
  index: number;
  label: string;
  minDays: number | null;
  maxDays: number | null;
  amount: Paise;
}

/** Receivables or payables (side-signed: positive = receivable / payable). */
export interface DashboardOutstanding {
  /** Net outstanding of the side (= Σ party balances on the side, incl. advances and on-account). */
  total: Paise;
  /** Bills past their due date. */
  overdue: Paise;
  overdueBillCount: number;
  overduePartyCount: number;
  /** Bills not yet due. */
  notDue: Paise;
  /** Advances (in the party's favour; negative on the side). */
  advance: Paise;
  /** Amounts not allocated to a bill. */
  onAccount: Paise;
  partyCount: number;
  /** Due-date ageing of the bills (default buckets: Not due · 1–30 · 31–60 · 61–90 · 91–180 · > 180). */
  ageing: DashboardAgeingBucket[];
  /** Bills falling due from asOf to asOf + days (due today included). */
  dueSoon: { days: number; until: string; amount: Paise; count: number };
}

export interface DashboardBalanceRow {
  ledgerId: number;
  name: string;
  /** Dr + / Cr − (a bank with a Cr balance is overdrawn). */
  balance: Paise;
  /** Bank OD / cash-credit account. */
  isOverdraft: boolean;
  /** Last 4 digits of the account number (banks), else null. */
  accountTail: string | null;
}

export interface DashboardCashBank {
  cashTotal: Paise;
  cash: DashboardBalanceRow[];
  bankTotal: Paise;
  banks: DashboardBalanceRow[];
}

export interface DashboardGst {
  /** 'MMYYYY' return period of asOf's month (gst.gstr3b {period}). */
  period: string;
  /** 'Oct 2026' */
  label: string;
  from: string;
  to: string;
  /** When the tax is due: GSTR-3B on the 20th (monthly filers); PMT-06 on the 25th / GSTR-3B on the 22nd or 24th (quarterly). */
  dueDate: string;
  dueForm: 'GSTR-3B' | 'PMT-06';
  filingFrequency: 'monthly' | 'quarterly';
  /** Tax on outward supplies (3.1(a) + 3.1(b)), net of credit notes. */
  outputTax: Paise;
  /** Reverse-charge tax payable in cash (3.1(d)). */
  reverseChargeTax: Paise;
  /** Net ITC available (4(C)). */
  inputTax: Paise;
  /** Estimated cash payable after set-off (forward charge + reverse charge, before interest/late fee). */
  netPayable: Paise;
  /** ITC left after set-off (carried forward). */
  creditCarriedForward: Paise;
  documentCount: number;
}

export interface DashboardTopCustomer {
  ledgerId: number;
  name: string;
  /** Net sales (Sales Accounts credits − debits) on vouchers with this party in the period. */
  amount: Paise;
  invoiceCount: number;
  /** Share of the period's sales, 2 decimals (null when sales are 0). */
  sharePercent: number | null;
}

export interface DashboardTopItem {
  itemId: number;
  name: string;
  unit: string;
  /** Net quantity sold (sales − sales returns), base unit. */
  qty: number;
  /** Net taxable value (paise). */
  amount: Paise;
  sharePercent: number | null;
}

export interface DashboardMonth {
  /** 'YYYY-MM' */
  month: string;
  from: string;
  to: string;
  sales: Paise;
  purchases: Paise;
}

export interface DashboardLowStockItem {
  itemId: number;
  name: string;
  unit: string;
  onHand: number;
  reorderLevel: number;
  /** reorderLevel − onHand (> 0). */
  shortfall: number;
}

export interface DashboardCompliance {
  /** null when the feature is off, GST is off or the user may not view GST. */
  einvoicePending: number | null;
  ewayPending: number | null;
  /** Range searched: start of the financial year of asOf → asOf. */
  from: string;
  to: string;
}

export interface DashboardVoucherRow {
  id: number;
  date: string;
  number: string | null;
  typeName: string;
  baseType: VoucherBaseType;
  partyName: string | null;
  amount: Paise;
  isCancelled: boolean;
  isOptional: boolean;
  isPostDated: boolean;
}

export interface DashboardPdcRow {
  id: number;
  date: string;
  number: string | null;
  typeName: string;
  baseType: VoucherBaseType;
  partyName: string | null;
  /** Unsigned amount moving through cash/bank. */
  amount: Paise;
  /** 'in' = money coming in (receipt), 'out' = going out (payment). */
  direction: 'in' | 'out';
  bankLedgerId: number | null;
  bankName: string | null;
  instrumentNo: string | null;
}

export interface DashboardPdc {
  count: number;
  inflow: Paise;
  outflow: Paise;
  /** Earliest first (at most 10). */
  rows: DashboardPdcRow[];
}

export interface DashboardBackup {
  lastBackupAt: string | null;
  /** Whole days since the last backup (null when never backed up). */
  daysSince: number | null;
}

/**
 * Facts behind the dashboard's "Get started" steps — each step is done when the books say so, not
 * when it was clicked (core/modules/dashboard/setup.ts).
 */
export interface DashboardSetup {
  /** Company Details has an address and a state. */
  profileComplete: boolean;
  /** Features (F11) were saved at least once with a change other than password protection. */
  featuresReviewed: boolean;
  /** Invoice printing differs from the defaults (template, copies, bank, UPI, wording…). */
  invoicePrintingSet: boolean;
  /** At least one ledger the user created (beyond the predefined ones). */
  hasOwnLedgers: boolean;
  /** At least one stock item. */
  hasItems: boolean;
  /** At least one sales voucher (any status). */
  hasSales: boolean;
  /** A backup folder is chosen in F12 › Backup. */
  backupFolderSet: boolean;
}

export interface DashboardFeatures {
  inventory: boolean;
  /** Inventory integrated with accounts (closing stock from the stock valuation). */
  integrated: boolean;
  gst: boolean;
  billWise: boolean;
  einvoice: boolean;
  ewayBill: boolean;
}

export interface DashboardSummary {
  asOf: string;
  /** Working date used for the post-dated rule. */
  today: string;
  booksFrom: string;
  ranges: DashboardRanges;
  features: DashboardFeatures;
  /** At least one voucher exists. */
  hasVouchers: boolean;
  /** Getting-started progress (the "Get started" card). */
  setup: DashboardSetup;
  sales: DashboardFlow;
  purchases: DashboardFlow;
  /** null without reports.financial. */
  grossProfit: DashboardGrossProfit | null;
  receivables: DashboardOutstanding;
  payables: DashboardOutstanding;
  cashBank: DashboardCashBank;
  /** The month of asOf so far. null when GST is off / not a regular registration / no gst.view. */
  gst: DashboardGst | null;
  /**
   * The previous month's return while it is still due (asOf on or before its due date, e.g. on 8-Oct
   * September's GSTR-3B due 20-Oct) — the payment the owner has to make next. null otherwise (and in
   * the cases where `gst` is null, or when that month is before the books begin).
   */
  gstDue: DashboardGst | null;
  topCustomers: DashboardTopCustomer[];
  /** Empty when inventory is off. */
  topItems: DashboardTopItem[];
  /** 12 calendar months ending with the month of `to`. */
  trend: DashboardMonth[];
  lowStock: { count: number; items: DashboardLowStockItem[] };
  compliance: DashboardCompliance;
  recentVouchers: DashboardVoucherRow[];
  postDated: DashboardPdc;
  backup: DashboardBackup;
  /** Served from the per-company memo (nothing changed in the books since an identical request). */
  cached: boolean;
  /** Server time spent on this call (ms). */
  elapsedMs: number;
}
