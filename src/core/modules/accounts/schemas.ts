/**
 * Input schemas of the accounts routes. Each schema's inferred type is checked against the DTO in
 * src/shared/types/accounts.ts at compile time (see the Assert lines at the bottom), so the routes need
 * no casts.
 *
 * Patch semantics on alter: `patchNullable(x)` keeps omitted keys (undefined) and passes an explicit
 * null through (clear); `.optional()` maps both null and omitted to undefined (keep).
 */
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import { GST_NATURES, REGISTRATION_TYPES, TAXABILITIES } from '../../../shared/types/gst.ts';
import {
  LEDGER_CLASSES,
  type ChartInput,
  type CostCategorySaveInput,
  type CostCentreListInput,
  type CostCentreSaveInput,
  type CurrencySaveInput,
  type ExchangeRateListInput,
  type ExchangeRateSaveInput,
  type GroupListInput,
  type GroupSaveInput,
  type LedgerBalanceInput,
  type LedgerBulkCreateInput,
  type LedgerListInput,
  type LedgerPickerInput,
  type LedgerSaveInput,
  type VoucherTypeSaveInput,
} from '../../../shared/types/accounts.ts';
import { patchNullable } from '../../lib/schemas.ts';
import { v, type Infer } from '../../lib/validate.ts';
import { STOCK_JOURNAL_CLASSES } from '../../../shared/types/mfg.ts';

const text = (max: number) => patchNullable(v.string({ max }));
const flag = () => v.boolean().optional();
const search = () => v.string({ max: 100 }).optional();
const classes = () => v.array(v.enum(LEDGER_CLASSES), { max: LEDGER_CLASSES.length }).optional();
const groupIds = () => v.array(v.id(), { max: 1000 }).optional();

export const IdInputSchema = v.object({ id: v.id() });

// ───────────────────────────── Groups ─────────────────────────────

export const GroupListInputSchema = v.object({ includeCounts: flag(), search: search() });

export const GroupSaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ max: 100 }).optional(),
  alias: text(100),
  parentId: patchNullable(v.id()),
  nature: v.enum(['assets', 'liabilities', 'income', 'expenses'] as const).optional(),
  affectsGrossProfit: flag(),
  isSubledger: flag(),
  netBalances: flag(),
  usedForCalculation: flag(),
  sortOrder: v.int({ min: 0, max: 1_000_000 }).optional(),
});

// ───────────────────────────── Ledgers ─────────────────────────────

export const LedgerListInputSchema = v.object({
  search: search(),
  groupIds: groupIds(),
  includeSubgroups: flag(),
  classes: classes(),
  withBalance: flag(),
  asOf: v.date().optional(),
  activeOnly: flag(),
  limit: v.int({ min: 1, max: 10_000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
});

export const LedgerPickerInputSchema = v.object({
  classes: classes(),
  groupIds: groupIds(),
  includeSubgroups: flag(),
  asOf: v.date().optional(),
  includeInactive: flag(),
});

const OpeningBillSchema = v.object({
  billName: v.string({ min: 1, max: 50 }),
  billDate: v.date(),
  dueDate: patchNullable(v.date()),
  amount: v.paise(),
});

export const LedgerSaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ max: 200 }).optional(),
  alias: text(200),
  aliases: v.array(v.string({ max: 200 }), { max: 50 }).optional(),
  groupId: v.id().optional(),
  isActive: flag(),
  openingBalance: patchNullable(v.paise()),
  currencyId: patchNullable(v.id()),
  billWise: flag(),
  defaultCreditDays: patchNullable(v.int({ min: 0, max: 3650 })),
  creditLimit: patchNullable(v.paise({ min: 0 })),
  interestEnabled: flag(),
  interestRate: patchNullable(v.number({ min: 0, max: 100 })),
  costCentresApplicable: flag(),
  inventoryValuesAffected: flag(),
  mailingName: text(200),
  address: text(1000),
  stateCode: text(3),
  country: text(60),
  pincode: text(12),
  contactPerson: text(100),
  phone: text(40),
  mobile: text(20),
  email: text(254),
  pan: text(12),
  registrationType: patchNullable(v.enum(REGISTRATION_TYPES)),
  gstin: text(20),
  isEcommerceOperator: flag(),
  bankAccountHolder: text(100),
  bankAccountNo: text(30),
  bankIfsc: text(15),
  bankName: text(100),
  bankBranch: text(100),
  bankUpiId: text(320),
  chequeBookEnabled: flag(),
  taxType: patchNullable(v.enum(['GST', 'TDS', 'TCS', 'OTHER'] as const)),
  gstDutyHead: patchNullable(v.enum(['IGST', 'CGST', 'SGST', 'CESS'] as const)),
  gstTaxDirection: patchNullable(v.enum(['output', 'input', 'rcm_liability'] as const)),
  gstApplicable: flag(),
  gstTaxability: patchNullable(v.enum(TAXABILITIES)),
  gstRate: patchNullable(v.number({ min: 0, max: 100 })),
  cessRate: patchNullable(v.number({ min: 0, max: 400 })),
  hsnSac: text(12),
  gstSupplyType: patchNullable(v.enum(['goods', 'services'] as const)),
  isReverseCharge: flag(),
  itcEligibility: patchNullable(v.enum(['inputs', 'capital_goods', 'input_services', 'ineligible'] as const)),
  gstNatureOverride: patchNullable(v.enum(GST_NATURES)),
  includeInAssessable: patchNullable(v.enum(['none', 'goods', 'services'] as const)),
  appropriateBy: patchNullable(v.enum(['value', 'quantity'] as const)),
  tdsApplicable: flag(),
  tdsSection: text(20),
  notes: text(2000),
  openingBills: v.array(OpeningBillSchema, { max: 10_000 }).optional(),
  allowNonStandardRate: flag(),
  applicableFrom: v.date().optional(),
});

export const LedgerBulkCreateInputSchema = v.object({
  rows: v.array(
    v.object({
      name: v.string({ min: 1, max: 200 }),
      groupId: v.id(),
      openingBalance: v.paise().optional(),
      gstin: v.string({ max: 20 }).nullable().optional(),
      stateCode: v.string({ max: 3 }).nullable().optional(),
    }),
    { min: 1, max: 5000 },
  ),
});

export const LedgerBalanceInputSchema = v.object({
  ledgerId: v.id(),
  from: v.date().optional(),
  to: v.date().optional(),
});

// ───────────────────────────── Cost categories & centres ─────────────────────────────

export const SearchInputSchema = v.object({ search: search() });

export const CostCategorySaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ max: 100 }).optional(),
  allocateRevenue: flag(),
  allocateNonRevenue: flag(),
});

export const CostCentreListInputSchema = v.object({ categoryId: v.id().optional(), search: search() });

export const CostCentreSaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ max: 100 }).optional(),
  alias: text(100),
  categoryId: v.id().optional(),
  parentId: patchNullable(v.id()),
});

// ───────────────────────────── Currencies ─────────────────────────────

export const CurrencySaveInputSchema = v.object({
  id: v.id().optional(),
  symbol: v.string({ max: 8 }).optional(),
  formalName: v.string({ max: 60 }).optional(),
  isoCode: text(3),
  decimalPlaces: v.int({ min: 0, max: 4 }).optional(),
});

export const ExchangeRateListInputSchema = v.object({
  currencyId: v.id(),
  from: v.date().optional(),
  to: v.date().optional(),
  limit: v.int({ min: 1, max: 5000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
});

const rate = () => patchNullable(v.number({ min: 0, max: 1e9 }));
export const ExchangeRateSaveInputSchema = v.object({
  currencyId: v.id(),
  date: v.date(),
  standard: rate(),
  selling: rate(),
  buying: rate(),
});

// ───────────────────────────── Voucher types ─────────────────────────────

export const VoucherTypeListInputSchema = v.object({ search: search(), activeOnly: flag() });

export const VoucherTypeSaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ max: 60 }).optional(),
  alias: text(60),
  abbreviation: text(10),
  parentId: v.id().optional(),
  baseType: v.enum(VOUCHER_BASE_TYPES).optional(),
  isActive: flag(),
  numbering: v
    .object({
      method: v.enum(['automatic', 'automatic_override', 'manual', 'none'] as const).optional(),
      prefix: patchNullable(v.string({ max: 16 })),
      suffix: patchNullable(v.string({ max: 16 })),
      start: v.int({ min: 1, max: 999_999_999 }).optional(),
      width: v.int({ min: 0, max: 9 }).optional(),
      restart: v.enum(['yearly', 'monthly', 'never'] as const).optional(),
      // dataplus: dated prefix / suffix rows (replace all rows of that kind when given).
      prefixRows: v.array(v.object({ applicableFrom: v.date(), text: v.string({ max: 16 }).nullable() }), { max: 100 }).optional(),
      suffixRows: v.array(v.object({ applicableFrom: v.date(), text: v.string({ max: 16 }).nullable() }), { max: 100 }).optional(),
    })
    .optional(),
  preventDuplicates: flag(),
  useEffectiveDate: flag(),
  allowZeroValue: flag(),
  optionalByDefault: flag(),
  narrationPerEntry: flag(),
  printAfterSave: flag(),
  config: v
    .object({
      defaultLedgerId: patchNullable(v.id()),
      defaultPartyLedgerId: patchNullable(v.id()),
      printTitle: text(100),
      declaration: text(2000),
      terms: text(4000),
      bankLedgerId: patchNullable(v.id()),
      invoiceMode: patchNullable(v.enum(['item', 'accounting'] as const)),
      defaultGodownId: patchNullable(v.id()),
      printTemplate: patchNullable(v.enum(['classic', 'modern', 'compact'] as const)),
      // print group: MRP column on this type's documents (null = as in Invoice Printing).
      showMrp: patchNullable(v.boolean()),
      // mfg module: a stock journal type used as Manufacturing Journal / Material Out / Material In.
      stockJournalClass: patchNullable(v.enum(STOCK_JOURNAL_CLASSES)),
      // pos module: a sales type used as POS invoice (counter billing with split tender).
      posInvoice: patchNullable(v.boolean()),
    })
    .optional(),
});

// ───────────────────────────── Chart ─────────────────────────────

export const ChartInputSchema = v.object({
  asOf: v.date().optional(),
  includeLedgers: flag(),
  activeOnly: flag(),
});

// ───────────────────────────── Compile-time DTO checks ─────────────────────────────

type Assert<T extends U, U> = T;
export type SchemaChecks = [
  Assert<Infer<typeof GroupListInputSchema>, GroupListInput>,
  Assert<Infer<typeof GroupSaveInputSchema>, GroupSaveInput>,
  Assert<Infer<typeof LedgerListInputSchema>, LedgerListInput>,
  Assert<Infer<typeof LedgerPickerInputSchema>, LedgerPickerInput>,
  Assert<Infer<typeof LedgerSaveInputSchema>, LedgerSaveInput>,
  Assert<Infer<typeof LedgerBulkCreateInputSchema>, LedgerBulkCreateInput>,
  Assert<Infer<typeof LedgerBalanceInputSchema>, LedgerBalanceInput>,
  Assert<Infer<typeof CostCategorySaveInputSchema>, CostCategorySaveInput>,
  Assert<Infer<typeof CostCentreListInputSchema>, CostCentreListInput>,
  Assert<Infer<typeof CostCentreSaveInputSchema>, CostCentreSaveInput>,
  Assert<Infer<typeof CurrencySaveInputSchema>, CurrencySaveInput>,
  Assert<Infer<typeof ExchangeRateListInputSchema>, ExchangeRateListInput>,
  Assert<Infer<typeof ExchangeRateSaveInputSchema>, ExchangeRateSaveInput>,
  Assert<Infer<typeof VoucherTypeSaveInputSchema>, VoucherTypeSaveInput>,
  Assert<Infer<typeof ChartInputSchema>, ChartInput>,
];
