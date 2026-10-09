/**
 * DTOs for the accounts module (src/core/modules/accounts): groups, ledgers, cost categories &
 * centres, currencies & exchange rates, voucher types and the chart of accounts.
 *
 * Money is integer paise; signed balances are Debit + / Credit −. `debit`/`credit` period totals are
 * unsigned magnitudes (closing = opening + debit − credit). Dates are 'YYYY-MM-DD'.
 *
 * Route table (all scope 'company'):
 *
 *   'accounts.group.list'              GroupListInput           → ListResult<GroupRow>            masters.view
 *   'accounts.group.get'               { id }                   → GroupDetail                     masters.view
 *   'accounts.group.save'              GroupSaveInput           → GroupDetail                     masters.create / masters.alter
 *   'accounts.group.delete'            { id }                   → DeleteResult                    masters.delete
 *
 *   'accounts.ledger.list'             LedgerListInput          → ListResult<LedgerListRow>       masters.view
 *   'accounts.ledger.picker'           LedgerPickerInput        → LedgerPickerRow[]               masters.view
 *   'accounts.ledger.get'              { id }                   → LedgerDetail                    masters.view
 *   'accounts.ledger.save'             LedgerSaveInput          → LedgerDetail                    masters.create / masters.alter
 *   'accounts.ledger.delete'           { id }                   → DeleteResult                    masters.delete
 *   'accounts.ledger.bulkCreate'       LedgerBulkCreateInput    → LedgerBulkCreateResult          masters.create
 *   'accounts.ledger.balance'          LedgerBalanceInput       → LedgerBalance                   masters.view
 *   'accounts.openingBalances.summary' none                     → OpeningBalanceSummary           masters.view
 *
 *   'accounts.costCategory.list'       { search? }              → ListResult<CostCategoryRow>     masters.view
 *   'accounts.costCategory.get'        { id }                   → CostCategoryRow                 masters.view
 *   'accounts.costCategory.save'       CostCategorySaveInput    → CostCategoryRow                 masters.create / masters.alter
 *   'accounts.costCategory.delete'     { id }                   → DeleteResult                    masters.delete
 *   'accounts.costCentre.list'         CostCentreListInput      → ListResult<CostCentreRow>       masters.view
 *   'accounts.costCentre.get'          { id }                   → CostCentreRow                   masters.view
 *   'accounts.costCentre.save'         CostCentreSaveInput      → CostCentreRow                   masters.create / masters.alter
 *   'accounts.costCentre.delete'       { id }                   → DeleteResult                    masters.delete
 *
 *   'accounts.currency.list'           none                     → ListResult<CurrencyRow>         masters.view
 *   'accounts.currency.get'            { id }                   → CurrencyRow                     masters.view
 *   'accounts.currency.save'           CurrencySaveInput        → CurrencyRow                     masters.create / masters.alter
 *   'accounts.currency.delete'         { id }                   → DeleteResult                    masters.delete
 *   'accounts.exchangeRate.list'       ExchangeRateListInput    → ListResult<ExchangeRateRow>     masters.view
 *   'accounts.exchangeRate.save'       ExchangeRateSaveInput    → ExchangeRateRow                 masters.create / masters.alter
 *   'accounts.exchangeRate.delete'     { id }                   → DeleteResult                    masters.delete
 *
 *   'accounts.voucherType.list'        { search?, activeOnly? } → ListResult<VoucherTypeRow>      masters.view
 *   'accounts.voucherType.get'         { id }                   → VoucherTypeDetail               masters.view
 *   'accounts.voucherType.save'        VoucherTypeSaveInput     → VoucherTypeDetail               masters.create / masters.alter
 *   'accounts.voucherType.delete'      { id }                   → DeleteResult                    masters.delete
 *
 *   'accounts.chart'                   ChartInput               → ChartOfAccounts                 masters.view
 *
 * "save" creates when `id` is absent and alters when it is present. On alter, an omitted field keeps
 * its current value and `null` clears it (patch semantics); on create, omitted fields take defaults.
 */
import type { GroupCode, GroupNature, GstDutyHead, GstTaxDirection, LedgerCode, VoucherBaseType } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { GstNature, RegistrationType, SupplyKind, Taxability } from './gst.ts';

export interface ListResult<T> {
  rows: T[];
  /** Total matching rows before limit/offset. */
  total: number;
}

export interface IdInput {
  id: number;
}

export interface DeleteResult {
  id: number;
  deleted: true;
}

// ───────────────────────────── Groups ─────────────────────────────

export interface GroupListInput {
  /** Add ledgerCount / totalLedgerCount to every row. */
  includeCounts?: boolean;
  /** Matches name or alias (rows are still returned with their full path). */
  search?: string;
}

export interface GroupRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  /** null for a primary group. */
  parentId: number | null;
  parentName: string | null;
  /** 0 for a primary group, 1 for its sub-groups, … */
  depth: number;
  /** Group names from the primary group down to this group (inclusive). */
  path: string[];
  primaryGroupId: number;
  /** Reserved code of the primary group (null for a user-created primary group). */
  primaryCode: GroupCode | null;
  nature: GroupNature;
  affectsGrossProfit: boolean;
  /** Stable code of a predefined group (null for user-created groups). */
  reservedCode: GroupCode | null;
  isPredefined: boolean;
  isSubledger: boolean;
  netBalances: boolean;
  usedForCalculation: boolean;
  sortOrder: number;
  /** Direct sub-groups. */
  childCount: number;
  /** Ledgers directly in this group (only with includeCounts). */
  ledgerCount?: number;
  /** Ledgers in this group and all its sub-groups (only with includeCounts). */
  totalLedgerCount?: number;
}

export interface GroupDetail extends GroupRow {
  ledgerCount: number;
  totalLedgerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupSaveInput {
  id?: number;
  name?: string;
  alias?: string | null;
  /** null/omitted on create = primary group. On alter: omitted keeps the parent, null makes it primary. */
  parentId?: number | null;
  /** Required for a new primary group; sub-groups always take their parent's nature. */
  nature?: GroupNature;
  /** Only for primary income/expense groups; sub-groups inherit it. */
  affectsGrossProfit?: boolean;
  isSubledger?: boolean;
  netBalances?: boolean;
  usedForCalculation?: boolean;
  sortOrder?: number;
}

// ───────────────────────────── Ledger classification ─────────────────────────────

export const LEDGER_CLASSES = [
  'cash',
  'bank',
  'cash_bank',
  'party',
  'debtor',
  'creditor',
  'sales',
  'purchase',
  'duty_tax',
  'income',
  'expense',
  'asset',
  'liability',
] as const;
/**
 * cash: under Cash-in-Hand · bank: under Bank Accounts or Bank OD A/c · cash_bank: either ·
 * debtor/creditor: under Sundry Debtors/Creditors · party: either · sales/purchase: under Sales/Purchase
 * Accounts · duty_tax: under Duties & Taxes · income/expense/asset/liability: by group nature.
 */
export type LedgerClassName = (typeof LEDGER_CLASSES)[number];

/** What kind of account a ledger is, derived from its group chain. */
export interface LedgerClass {
  isCash: boolean;
  /** Bank Accounts or Bank OD A/c. */
  isBank: boolean;
  /** Bank OD A/c only. */
  isBankOd: boolean;
  isCashOrBank: boolean;
  isDebtor: boolean;
  isCreditor: boolean;
  isParty: boolean;
  isDutyTax: boolean;
  isSales: boolean;
  isPurchase: boolean;
  /** Nature income (includes Sales Accounts). */
  isIncome: boolean;
  /** Nature expenses (includes Purchase Accounts). */
  isExpense: boolean;
  nature: GroupNature;
  affectsGrossProfit: boolean;
  /** Reserved code of the primary group (null when the primary group is user-created). */
  primaryCode: GroupCode | null;
}

/** Balance of one ledger over a period (books filter applied). */
export interface LedgerBalance {
  /** Opening balance at the start of the period (ledger opening + earlier entries). Dr +, Cr −. */
  opening: Paise;
  /** Σ debit entries in the period (≥ 0). */
  debit: Paise;
  /** Σ credit entries in the period, as a positive number (≥ 0). */
  credit: Paise;
  /** opening + debit − credit. Dr +, Cr −. */
  closing: Paise;
}

export interface LedgerBalanceInput {
  ledgerId: number;
  /** Start of the period; omitted = from the beginning of the books. */
  from?: string;
  /** End of the period (default: today). */
  to?: string;
}

// ───────────────────────────── Ledgers ─────────────────────────────

export type LedgerTaxType = 'GST' | 'TDS' | 'TCS' | 'OTHER';
export type ItcEligibility = 'inputs' | 'capital_goods' | 'input_services' | 'ineligible';
export type IncludeInAssessable = 'none' | 'goods' | 'services';
export type AppropriateBy = 'value' | 'quantity';

export interface LedgerListInput {
  /** Matches name, alias or GSTIN (case-insensitive, substring). */
  search?: string;
  groupIds?: number[];
  /** With groupIds: also ledgers in their sub-groups (default true). */
  includeSubgroups?: boolean;
  /** Ledgers matching ANY of these classes. */
  classes?: LedgerClassName[];
  /** Add closingBalance (as of asOf) to each row. */
  withBalance?: boolean;
  /** Balance date (default: today). */
  asOf?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface LedgerListRow {
  id: number;
  name: string;
  alias: string | null;
  groupId: number;
  groupName: string;
  primaryGroupCode: GroupCode | null;
  classes: LedgerClassName[];
  gstin: string | null;
  stateCode: string | null;
  registrationType: RegistrationType | null;
  billWise: boolean;
  /** Only when withBalance. Dr +, Cr −. */
  closingBalance?: Paise;
  reservedCode: LedgerCode | null;
  isPredefined: boolean;
  isActive: boolean;
}

export interface LedgerPickerInput {
  classes?: LedgerClassName[];
  groupIds?: number[];
  /** With groupIds: also sub-groups (default true). */
  includeSubgroups?: boolean;
  /** Balance date (default: today). */
  asOf?: string;
  /** Inactive ledgers are left out unless this is true (they cannot be used in new vouchers). */
  includeInactive?: boolean;
}

export interface LedgerPickerRow {
  id: number;
  name: string;
  alias: string | null;
  groupId: number;
  groupName: string;
  classes: LedgerClassName[];
  /** Closing balance as of asOf. Dr +, Cr −. */
  balance: Paise;
  gstin: string | null;
  stateCode: string | null;
  registrationType: RegistrationType | null;
  billWise: boolean;
  isActive: boolean;
}

export interface OpeningBill {
  id: number;
  billName: string;
  billDate: string;
  dueDate: string | null;
  /** Dr +, Cr −. */
  amount: Paise;
}

export interface OpeningBillInput {
  billName: string;
  billDate: string;
  dueDate?: string | null;
  /** Dr +, Cr −. */
  amount: Paise;
}

export interface GstRateHistoryRow {
  id: number;
  applicableFrom: string;
  hsnSac: string | null;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  /** Paise per unit. */
  cessPerUnit: Paise;
}

/** All editable ledger fields. */
export interface LedgerFields {
  name: string;
  alias: string | null;
  groupId: number;
  isActive: boolean;
  /** Paise as at the books beginning date. Dr +, Cr −. */
  openingBalance: Paise;
  currencyId: number | null;
  // Bill-wise / credit control
  billWise: boolean;
  defaultCreditDays: number | null;
  /** Paise (≥ 0). */
  creditLimit: Paise | null;
  interestEnabled: boolean;
  /** % per annum. */
  interestRate: number | null;
  costCentresApplicable: boolean;
  inventoryValuesAffected: boolean;
  // Mailing / party
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  country: string | null;
  pincode: string | null;
  contactPerson: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  pan: string | null;
  registrationType: RegistrationType | null;
  gstin: string | null;
  isEcommerceOperator: boolean;
  // Bank (Bank Accounts / Bank OD A/c only)
  bankAccountHolder: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankUpiId: string | null;
  chequeBookEnabled: boolean;
  // Duties & Taxes only
  taxType: LedgerTaxType | null;
  gstDutyHead: GstDutyHead | null;
  gstTaxDirection: GstTaxDirection | null;
  // Sales / purchase / income / expense (and fixed asset) GST details
  gstApplicable: boolean;
  gstTaxability: Taxability | null;
  gstRate: number | null;
  cessRate: number | null;
  hsnSac: string | null;
  gstSupplyType: SupplyKind | null;
  isReverseCharge: boolean;
  itcEligibility: ItcEligibility | null;
  gstNatureOverride: GstNature | null;
  includeInAssessable: IncludeInAssessable | null;
  appropriateBy: AppropriateBy | null;
  // TDS
  tdsApplicable: boolean;
  tdsSection: string | null;
  notes: string | null;
}

export interface LedgerDetail extends LedgerFields {
  id: number;
  guid: string;
  groupName: string;
  groupPath: string[];
  primaryGroupCode: GroupCode | null;
  reservedCode: LedgerCode | null;
  isPredefined: boolean;
  classes: LedgerClassName[];
  openingBills: OpeningBill[];
  /** Effective-dated GST history, oldest first. */
  gstRateHistory: GstRateHistoryRow[];
  /** Closing balance as of today (books filter). */
  closingBalance: Paise;
  /** Vouchers with an entry for this ledger (any status). */
  voucherCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create (no id) or alter (id). On alter, omitted fields keep their value and null clears them.
 * `name` and `groupId` are required on create. Defaults on create (only for fields not given):
 * customers/suppliers keep bills when bill-wise details are on (F11); ledgers under Sales/Purchase
 * Accounts have "inventory values are affected" (inventory on) and GST applicable, taxable, rate from
 * the items (GST on) — like the predefined Sales and Purchase ledgers.
 */
export type LedgerSaveInput = { [K in keyof LedgerFields]?: LedgerFields[K] | null } & {
  id?: number;
  /** Replace the opening bills (omit to keep them). Σ amount must equal the opening balance. */
  openingBills?: OpeningBillInput[];
  /** Accept a GST rate that is not one of the notified slabs (GST_RATES). */
  allowNonStandardRate?: boolean;
  /**
   * Date from which GST details apply: the GST fields given in this save (gstRate, cessRate, hsnSac,
   * gstTaxability) are applied over the details in force on that date and written as a
   * gst_rate_history row from that date; other rows are kept. Without it a change corrects the latest
   * history row. The master always shows the latest row, so after a back-dated entry it keeps showing
   * the current details. Not allowed when GST is turned off or the rate is cleared (that removes the
   * rate history).
   */
  applicableFrom?: string;
};

export interface LedgerBulkRowInput {
  name: string;
  groupId: number;
  openingBalance?: Paise;
  gstin?: string | null;
  stateCode?: string | null;
}

export interface LedgerBulkCreateInput {
  rows: LedgerBulkRowInput[];
}

export interface LedgerBulkCreateResult {
  created: number;
  ids: number[];
}

export interface OpeningBalanceSummary {
  /** Σ debit opening balances of all ledgers (≥ 0). */
  totalDebit: Paise;
  /** Σ credit opening balances, as a positive number (≥ 0). */
  totalCredit: Paise;
  /** totalDebit − totalCredit: > 0 means debits exceed credits. Opening stock is added by reports. */
  difference: Paise;
  /** Ledgers with a non-zero opening balance. */
  ledgerCount: number;
}

// ───────────────────────────── Cost categories & centres ─────────────────────────────

export interface CostCategoryRow {
  id: number;
  guid: string;
  name: string;
  allocateRevenue: boolean;
  allocateNonRevenue: boolean;
  isPredefined: boolean;
  centreCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CostCategorySaveInput {
  id?: number;
  name?: string;
  allocateRevenue?: boolean;
  allocateNonRevenue?: boolean;
}

export interface CostCentreListInput {
  categoryId?: number;
  search?: string;
}

export interface CostCentreRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  parentName: string | null;
  depth: number;
  /** Names from the top-level centre down to this one. */
  path: string[];
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CostCentreSaveInput {
  id?: number;
  name?: string;
  alias?: string | null;
  /** Required on create. Changing it moves all sub-centres too. */
  categoryId?: number;
  /** Parent centre in the same category; null = top level. */
  parentId?: number | null;
}

// ───────────────────────────── Currencies ─────────────────────────────

export interface ExchangeRateRow {
  id: number;
  currencyId: number;
  date: string;
  /** Rupees per 1 unit of the currency. */
  standard: number | null;
  selling: number | null;
  buying: number | null;
}

export interface CurrencyRow {
  id: number;
  guid: string;
  symbol: string;
  formalName: string;
  isoCode: string | null;
  decimalPlaces: number;
  isBase: boolean;
  /** Most recent exchange rate (null for the base currency or when none is entered). */
  latestRate: ExchangeRateRow | null;
  ledgerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CurrencySaveInput {
  id?: number;
  symbol?: string;
  formalName?: string;
  isoCode?: string | null;
  decimalPlaces?: number;
}

export interface ExchangeRateListInput {
  currencyId: number;
  from?: string;
  to?: string;
  /** Page size (default and maximum 5,000). */
  limit?: number;
  offset?: number;
}

/** Upsert by (currency, date). */
export interface ExchangeRateSaveInput {
  currencyId: number;
  date: string;
  standard?: number | null;
  selling?: number | null;
  buying?: number | null;
}

// ───────────────────────────── Voucher types ─────────────────────────────

export type NumberingMethod = 'automatic' | 'automatic_override' | 'manual' | 'none';
export type NumberingRestart = 'yearly' | 'monthly' | 'never';

export interface VoucherNumbering {
  method: NumberingMethod;
  prefix: string | null;
  suffix: string | null;
  /** First number of each period (≥ 1). */
  start: number;
  /** Zero padding width (0–9). */
  width: number;
  restart: NumberingRestart;
}

export interface VoucherTypeConfig {
  /** Default sales ledger (sales-side types) or purchase ledger (purchase-side types). */
  defaultLedgerId?: number | null;
  /** Default party ledger, e.g. Cash for a "Cash Sales" type. */
  defaultPartyLedgerId?: number | null;
  /** Title printed on the document, e.g. 'Tax Invoice'. */
  printTitle?: string | null;
  declaration?: string | null;
  terms?: string | null;
  /** Bank ledger whose details are printed on invoices. */
  bankLedgerId?: number | null;
  /** Sales/purchase/credit/debit notes: item invoice or accounting invoice. */
  invoiceMode?: 'item' | 'accounting' | null;
  defaultGodownId?: number | null;
  printTemplate?: 'classic' | 'modern' | 'compact' | null;
  /** Stock journal types only (mfg module): Manufacturing Journal, Material Out or Material In. */
  stockJournalClass?: 'manufacturing' | 'material_out' | 'material_in' | null;
}

export interface VoucherTypeRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  abbreviation: string | null;
  baseType: VoucherBaseType;
  parentId: number | null;
  parentName: string | null;
  isPredefined: boolean;
  isActive: boolean;
  /** Tally-style hotkey of a predefined type ('F8'); null for custom types. */
  hotkey: string | null;
  numbering: VoucherNumbering;
  voucherCount: number;
}

export interface VoucherTypeDetail extends VoucherTypeRow {
  preventDuplicates: boolean;
  useEffectiveDate: boolean;
  allowZeroValue: boolean;
  optionalByDefault: boolean;
  narrationPerEntry: boolean;
  printAfterSave: boolean;
  config: VoucherTypeConfig;
  /** Non-blocking advice about the numbering (e.g. numbers will exceed 16 characters after 9,999). */
  numberingWarnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VoucherTypeSaveInput {
  id?: number;
  name?: string;
  alias?: string | null;
  abbreviation?: string | null;
  /** Create: the type this one is based on (its base type is inherited). */
  parentId?: number;
  /** Create: alternative to parentId — the predefined type of this base type becomes the parent. */
  baseType?: VoucherBaseType;
  isActive?: boolean;
  numbering?: Partial<VoucherNumbering>;
  preventDuplicates?: boolean;
  useEffectiveDate?: boolean;
  allowZeroValue?: boolean;
  optionalByDefault?: boolean;
  narrationPerEntry?: boolean;
  printAfterSave?: boolean;
  /** Key-level patch: omitted keys are kept, null clears a key. */
  config?: VoucherTypeConfig;
}

// ───────────────────────────── Chart of accounts ─────────────────────────────

export interface ChartInput {
  /** Balances as of this date (default: today). */
  asOf?: string;
  /** Include ledgers under their groups (default true). */
  includeLedgers?: boolean;
  /**
   * Leave out inactive ledgers (default false). An inactive ledger that still has a balance as of
   * `asOf` is kept, so every group's total equals the sum of the lines shown under it.
   */
  activeOnly?: boolean;
}

export interface ChartNode {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  alias: string | null;
  nature: GroupNature;
  /** GroupCode for predefined groups, LedgerCode for reserved ledgers. */
  reservedCode: string | null;
  isPredefined: boolean;
  /** Always true for groups. */
  isActive: boolean;
  /** Closing balance as of asOf (groups: rolled up). Dr +, Cr −. */
  closing: Paise;
  /** Sub-groups first, then ledgers (by name). Empty for ledgers. */
  children: ChartNode[];
}

export interface ChartOfAccounts {
  asOf: string;
  roots: ChartNode[];
  /** Σ debit closing balances of all ledgers. */
  totalDebit: Paise;
  /** Σ credit closing balances, as a positive number. */
  totalCredit: Paise;
  groupCount: number;
  ledgerCount: number;
}
