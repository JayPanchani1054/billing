/**
 * Domain constants shared by main and renderer. Pure data — no imports from node or DOM.
 */

export const APP_NAME = 'Bahi ERP';
export const APP_ID = 'com.bahi.erp';

// ───────────────────────────── Voucher base types ─────────────────────────────
export const VOUCHER_BASE_TYPES = [
  'sales',
  'purchase',
  'payment',
  'receipt',
  'contra',
  'journal',
  'credit_note',
  'debit_note',
  'sales_order',
  'purchase_order',
  'delivery_note',
  'receipt_note',
  'rejection_in',
  'rejection_out',
  'stock_journal',
  'physical_stock',
  'memorandum',
  'reversing_journal',
  // Non-accounting pre-sale documents (documents module): own numbering, never in the books or GST returns.
  'quotation',
  'proforma',
] as const;
export type VoucherBaseType = (typeof VOUCHER_BASE_TYPES)[number];

/** Base types that post to the books of accounts. */
export const ACCOUNTING_BASE_TYPES: readonly VoucherBaseType[] = [
  'sales', 'purchase', 'payment', 'receipt', 'contra', 'journal', 'credit_note', 'debit_note',
];
/** Base types that never affect ledger balances. */
export const NON_ACCOUNTING_BASE_TYPES: readonly VoucherBaseType[] = [
  'sales_order', 'purchase_order', 'delivery_note', 'receipt_note', 'rejection_in', 'rejection_out',
  'stock_journal', 'physical_stock', 'memorandum', 'reversing_journal', 'quotation', 'proforma',
];
/** Base types that can carry GST (and therefore gst_lines). */
export const GST_BASE_TYPES: readonly VoucherBaseType[] = ['sales', 'purchase', 'credit_note', 'debit_note'];

export interface PredefinedVoucherType {
  name: string;
  baseType: VoucherBaseType;
  abbreviation: string;
  /** Tally-style hotkey shown in the UI (e.g. 'F8'). */
  hotkey?: string;
}

export const PREDEFINED_VOUCHER_TYPES: readonly PredefinedVoucherType[] = [
  { name: 'Contra', baseType: 'contra', abbreviation: 'Ctra', hotkey: 'F4' },
  { name: 'Payment', baseType: 'payment', abbreviation: 'Pymt', hotkey: 'F5' },
  { name: 'Receipt', baseType: 'receipt', abbreviation: 'Rcpt', hotkey: 'F6' },
  { name: 'Journal', baseType: 'journal', abbreviation: 'Jrnl', hotkey: 'F7' },
  { name: 'Sales', baseType: 'sales', abbreviation: 'Sale', hotkey: 'F8' },
  { name: 'Purchase', baseType: 'purchase', abbreviation: 'Purc', hotkey: 'F9' },
  { name: 'Credit Note', baseType: 'credit_note', abbreviation: 'C/Note', hotkey: 'Ctrl+F8' },
  { name: 'Debit Note', baseType: 'debit_note', abbreviation: 'D/Note', hotkey: 'Ctrl+F9' },
  { name: 'Sales Order', baseType: 'sales_order', abbreviation: 'S/Ord', hotkey: 'Alt+F5' },
  { name: 'Purchase Order', baseType: 'purchase_order', abbreviation: 'P/Ord', hotkey: 'Alt+F6' },
  { name: 'Delivery Note', baseType: 'delivery_note', abbreviation: 'Dl/Nt', hotkey: 'Alt+F8' },
  { name: 'Receipt Note', baseType: 'receipt_note', abbreviation: 'Rc/Nt', hotkey: 'Alt+F9' },
  { name: 'Rejections In', baseType: 'rejection_in', abbreviation: 'Rej In', hotkey: 'Ctrl+F6' },
  { name: 'Rejections Out', baseType: 'rejection_out', abbreviation: 'Rej Out', hotkey: 'Ctrl+F5' },
  { name: 'Stock Journal', baseType: 'stock_journal', abbreviation: 'Stk Jrn', hotkey: 'Alt+F7' },
  { name: 'Physical Stock', baseType: 'physical_stock', abbreviation: 'Phy Stk', hotkey: 'Ctrl+F7' },
  { name: 'Memorandum', baseType: 'memorandum', abbreviation: 'Memo', hotkey: 'Ctrl+F10' },
  { name: 'Reversing Journal', baseType: 'reversing_journal', abbreviation: 'Rev Jrn', hotkey: 'F10' },
  // No hotkey (Tally has none either): Gateway › Transactions, Go To and F10 open them.
  { name: 'Quotation', baseType: 'quotation', abbreviation: 'Quote' },
  { name: 'Proforma Invoice', baseType: 'proforma', abbreviation: 'Pro Inv' },
];

// ───────────────────────────── Accounting groups ─────────────────────────────
export type GroupNature = 'assets' | 'liabilities' | 'income' | 'expenses';

export const GROUP_CODES = {
  BRANCH_DIVISIONS: 'BRANCH_DIVISIONS',
  CAPITAL_ACCOUNT: 'CAPITAL_ACCOUNT',
  CURRENT_ASSETS: 'CURRENT_ASSETS',
  CURRENT_LIABILITIES: 'CURRENT_LIABILITIES',
  DIRECT_EXPENSES: 'DIRECT_EXPENSES',
  DIRECT_INCOMES: 'DIRECT_INCOMES',
  FIXED_ASSETS: 'FIXED_ASSETS',
  INDIRECT_EXPENSES: 'INDIRECT_EXPENSES',
  INDIRECT_INCOMES: 'INDIRECT_INCOMES',
  INVESTMENTS: 'INVESTMENTS',
  LOANS_LIABILITY: 'LOANS_LIABILITY',
  MISC_EXPENSES_ASSET: 'MISC_EXPENSES_ASSET',
  PURCHASE_ACCOUNTS: 'PURCHASE_ACCOUNTS',
  SALES_ACCOUNTS: 'SALES_ACCOUNTS',
  SUSPENSE_ACCOUNT: 'SUSPENSE_ACCOUNT',
  BANK_ACCOUNTS: 'BANK_ACCOUNTS',
  BANK_OD: 'BANK_OD',
  CASH_IN_HAND: 'CASH_IN_HAND',
  DEPOSITS_ASSET: 'DEPOSITS_ASSET',
  DUTIES_TAXES: 'DUTIES_TAXES',
  LOANS_ADVANCES_ASSET: 'LOANS_ADVANCES_ASSET',
  PROVISIONS: 'PROVISIONS',
  RESERVES_SURPLUS: 'RESERVES_SURPLUS',
  SECURED_LOANS: 'SECURED_LOANS',
  STOCK_IN_HAND: 'STOCK_IN_HAND',
  SUNDRY_CREDITORS: 'SUNDRY_CREDITORS',
  SUNDRY_DEBTORS: 'SUNDRY_DEBTORS',
  UNSECURED_LOANS: 'UNSECURED_LOANS',
} as const;
export type GroupCode = keyof typeof GROUP_CODES;

export interface PredefinedGroup {
  code: GroupCode;
  name: string;
  parent: GroupCode | null;
  nature: GroupNature;
  affectsGrossProfit: boolean;
  isSubledger?: boolean;
}

/** The 28 predefined groups (15 primary + 13 sub-groups), in Balance Sheet / P&L order. */
export const PREDEFINED_GROUPS: readonly PredefinedGroup[] = [
  // Primary — Balance Sheet
  { code: 'CAPITAL_ACCOUNT', name: 'Capital Account', parent: null, nature: 'liabilities', affectsGrossProfit: false },
  { code: 'LOANS_LIABILITY', name: 'Loans (Liability)', parent: null, nature: 'liabilities', affectsGrossProfit: false },
  { code: 'CURRENT_LIABILITIES', name: 'Current Liabilities', parent: null, nature: 'liabilities', affectsGrossProfit: false },
  { code: 'FIXED_ASSETS', name: 'Fixed Assets', parent: null, nature: 'assets', affectsGrossProfit: false },
  { code: 'INVESTMENTS', name: 'Investments', parent: null, nature: 'assets', affectsGrossProfit: false },
  { code: 'CURRENT_ASSETS', name: 'Current Assets', parent: null, nature: 'assets', affectsGrossProfit: false },
  { code: 'BRANCH_DIVISIONS', name: 'Branch / Divisions', parent: null, nature: 'liabilities', affectsGrossProfit: false },
  { code: 'MISC_EXPENSES_ASSET', name: 'Misc. Expenses (ASSET)', parent: null, nature: 'assets', affectsGrossProfit: false },
  { code: 'SUSPENSE_ACCOUNT', name: 'Suspense A/c', parent: null, nature: 'liabilities', affectsGrossProfit: false },
  // Primary — Profit & Loss
  { code: 'SALES_ACCOUNTS', name: 'Sales Accounts', parent: null, nature: 'income', affectsGrossProfit: true },
  { code: 'PURCHASE_ACCOUNTS', name: 'Purchase Accounts', parent: null, nature: 'expenses', affectsGrossProfit: true },
  { code: 'DIRECT_INCOMES', name: 'Direct Incomes', parent: null, nature: 'income', affectsGrossProfit: true },
  { code: 'DIRECT_EXPENSES', name: 'Direct Expenses', parent: null, nature: 'expenses', affectsGrossProfit: true },
  { code: 'INDIRECT_INCOMES', name: 'Indirect Incomes', parent: null, nature: 'income', affectsGrossProfit: false },
  { code: 'INDIRECT_EXPENSES', name: 'Indirect Expenses', parent: null, nature: 'expenses', affectsGrossProfit: false },
  // Sub-groups
  { code: 'RESERVES_SURPLUS', name: 'Reserves & Surplus', parent: 'CAPITAL_ACCOUNT', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'BANK_OD', name: 'Bank OD A/c', parent: 'LOANS_LIABILITY', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'SECURED_LOANS', name: 'Secured Loans', parent: 'LOANS_LIABILITY', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'UNSECURED_LOANS', name: 'Unsecured Loans', parent: 'LOANS_LIABILITY', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'DUTIES_TAXES', name: 'Duties & Taxes', parent: 'CURRENT_LIABILITIES', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'PROVISIONS', name: 'Provisions', parent: 'CURRENT_LIABILITIES', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'SUNDRY_CREDITORS', name: 'Sundry Creditors', parent: 'CURRENT_LIABILITIES', nature: 'liabilities', affectsGrossProfit: false },
  { code: 'STOCK_IN_HAND', name: 'Stock-in-Hand', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
  { code: 'DEPOSITS_ASSET', name: 'Deposits (Asset)', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
  { code: 'LOANS_ADVANCES_ASSET', name: 'Loans & Advances (Asset)', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
  { code: 'SUNDRY_DEBTORS', name: 'Sundry Debtors', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
  { code: 'CASH_IN_HAND', name: 'Cash-in-Hand', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
  { code: 'BANK_ACCOUNTS', name: 'Bank Accounts', parent: 'CURRENT_ASSETS', nature: 'assets', affectsGrossProfit: false },
];

// ───────────────────────────── Reserved ledgers ─────────────────────────────
export const LEDGER_CODES = {
  CASH: 'CASH',
  PROFIT_LOSS: 'PROFIT_LOSS',
  ROUND_OFF: 'ROUND_OFF',
  OUTPUT_IGST: 'OUTPUT_IGST',
  OUTPUT_CGST: 'OUTPUT_CGST',
  OUTPUT_SGST: 'OUTPUT_SGST',
  OUTPUT_CESS: 'OUTPUT_CESS',
  INPUT_IGST: 'INPUT_IGST',
  INPUT_CGST: 'INPUT_CGST',
  INPUT_SGST: 'INPUT_SGST',
  INPUT_CESS: 'INPUT_CESS',
  RCM_IGST: 'RCM_IGST',
  RCM_CGST: 'RCM_CGST',
  RCM_SGST: 'RCM_SGST',
  RCM_CESS: 'RCM_CESS',
  SALES: 'SALES',
  PURCHASE: 'PURCHASE',
} as const;
export type LedgerCode = keyof typeof LEDGER_CODES;

export type GstDutyHead = 'IGST' | 'CGST' | 'SGST' | 'CESS';
export type GstTaxDirection = 'output' | 'input' | 'rcm_liability';

export interface PredefinedLedger {
  code: LedgerCode;
  name: string;
  group: GroupCode;
  /** Only created when the company has GST enabled. */
  gstOnly?: boolean;
  dutyHead?: GstDutyHead;
  direction?: GstTaxDirection;
}

export const PREDEFINED_LEDGERS: readonly PredefinedLedger[] = [
  { code: 'CASH', name: 'Cash', group: 'CASH_IN_HAND' },
  { code: 'PROFIT_LOSS', name: 'Profit & Loss A/c', group: 'CAPITAL_ACCOUNT' },
  { code: 'ROUND_OFF', name: 'Round Off', group: 'INDIRECT_EXPENSES' },
  { code: 'SALES', name: 'Sales', group: 'SALES_ACCOUNTS' },
  { code: 'PURCHASE', name: 'Purchase', group: 'PURCHASE_ACCOUNTS' },
  { code: 'OUTPUT_IGST', name: 'Output IGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'IGST', direction: 'output' },
  { code: 'OUTPUT_CGST', name: 'Output CGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CGST', direction: 'output' },
  { code: 'OUTPUT_SGST', name: 'Output SGST/UTGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'SGST', direction: 'output' },
  { code: 'OUTPUT_CESS', name: 'Output Cess', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CESS', direction: 'output' },
  { code: 'INPUT_IGST', name: 'Input IGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'IGST', direction: 'input' },
  { code: 'INPUT_CGST', name: 'Input CGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CGST', direction: 'input' },
  { code: 'INPUT_SGST', name: 'Input SGST/UTGST', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'SGST', direction: 'input' },
  { code: 'INPUT_CESS', name: 'Input Cess', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CESS', direction: 'input' },
  { code: 'RCM_IGST', name: 'IGST Payable (Reverse Charge)', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'IGST', direction: 'rcm_liability' },
  { code: 'RCM_CGST', name: 'CGST Payable (Reverse Charge)', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CGST', direction: 'rcm_liability' },
  { code: 'RCM_SGST', name: 'SGST Payable (Reverse Charge)', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'SGST', direction: 'rcm_liability' },
  { code: 'RCM_CESS', name: 'Cess Payable (Reverse Charge)', group: 'DUTIES_TAXES', gstOnly: true, dutyHead: 'CESS', direction: 'rcm_liability' },
];

// ───────────────────────────── Units ─────────────────────────────
export const DEFAULT_UNITS: ReadonlyArray<{ symbol: string; formalName: string; uqc: string; decimals: number }> = [
  { symbol: 'Nos', formalName: 'Numbers', uqc: 'NOS', decimals: 0 },
  { symbol: 'Pcs', formalName: 'Pieces', uqc: 'PCS', decimals: 0 },
  { symbol: 'Kg', formalName: 'Kilograms', uqc: 'KGS', decimals: 3 },
  { symbol: 'Gm', formalName: 'Grams', uqc: 'GMS', decimals: 0 },
  { symbol: 'Ltr', formalName: 'Litres', uqc: 'LTR', decimals: 3 },
  { symbol: 'Mtr', formalName: 'Metres', uqc: 'MTR', decimals: 2 },
  { symbol: 'Box', formalName: 'Box', uqc: 'BOX', decimals: 0 },
  { symbol: 'Dozen', formalName: 'Dozens', uqc: 'DOZ', decimals: 0 },
  { symbol: 'Set', formalName: 'Sets', uqc: 'SET', decimals: 0 },
  { symbol: 'Hrs', formalName: 'Hours', uqc: 'OTH', decimals: 2 },
];

export const MAIN_GODOWN_NAME = 'Main Location';

// ───────────────────────────── Security ─────────────────────────────
export const PERMISSIONS = [
  'company.view',
  'company.manage',          // alter company profile, features, configuration
  'masters.view',
  'masters.create',
  'masters.alter',
  'masters.delete',
  'vouchers.view',
  'vouchers.create',
  'vouchers.alter',
  'vouchers.delete',
  'vouchers.backdate',       // create/alter vouchers dated before today
  'reports.view',
  'reports.financial',       // Balance Sheet, P&L, ratios, cash flow
  'gst.view',
  'gst.file',                // export returns JSON, e-invoice/e-way bill JSON
  'banking.reconcile',
  'data.export',
  'data.import',
  'data.backup',
  'data.restore',
  'security.manage',         // users, roles, password policy, vault
  'audit.view',
  'period.lock',             // lock/unlock books up to a date
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES: ReadonlyArray<{ name: string; description: string; permissions: readonly Permission[] | 'all' }> = [
  { name: 'Owner', description: 'Full access including security administration', permissions: 'all' },
  {
    name: 'Accountant',
    description: 'All accounting work; no security administration',
    permissions: PERMISSIONS.filter((p) => p !== 'security.manage' && p !== 'data.restore'),
  },
  {
    name: 'Data Entry',
    description: 'Create masters and vouchers; view basic reports',
    permissions: ['company.view', 'masters.view', 'masters.create', 'vouchers.view', 'vouchers.create', 'reports.view', 'gst.view'],
  },
  {
    name: 'Auditor',
    description: 'Read-only access to books, reports and the edit log',
    permissions: ['company.view', 'masters.view', 'vouchers.view', 'reports.view', 'reports.financial', 'gst.view', 'audit.view', 'data.export'],
  },
];

// ───────────────────────────── Thresholds (configurable defaults) ─────────────────────────────
/** Inter-state B2C invoices above this value are reported in B2CL (₹1,00,000 from 1-Aug-2024). In paise. */
export const B2CL_THRESHOLD_PAISE = 1_00_000_00;
/** E-way bill consignment value threshold, in paise. */
export const EWAY_BILL_THRESHOLD_PAISE = 50_000_00;
