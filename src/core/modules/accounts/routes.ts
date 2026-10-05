/**
 * Accounts module routes (groups, ledgers, cost centres, currencies, voucher types, chart).
 * DTOs: src/shared/types/accounts.ts. Reference: ./README.md.
 *
 * Access: read routes need masters.view. "save" routes are declared with masters.view because one
 * route both creates and alters: the service then requires masters.create (no id) or masters.alter
 * (with id) and answers FORBIDDEN otherwise. Delete routes need masters.delete (checked again in the
 * services, which other modules may call directly).
 */
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { chartOfAccounts } from './chart.ts';
import {
  deleteCostCategory,
  deleteCostCentre,
  getCostCategory,
  getCostCentre,
  listCostCategories,
  listCostCentres,
  saveCostCategory,
  saveCostCentre,
} from './costCentres.ts';
import {
  deleteCurrency,
  deleteExchangeRate,
  getCurrency,
  listCurrencies,
  listExchangeRates,
  saveCurrency,
  saveExchangeRate,
} from './currencies.ts';
import { deleteGroup, getGroup, listGroups, saveGroup } from './groups.ts';
import {
  bulkCreateLedgers,
  deleteLedger,
  getLedger,
  getLedgerBalance,
  ledgerPicker,
  listLedgers,
  openingBalanceSummary,
  saveLedger,
} from './ledgers.ts';
import {
  ChartInputSchema,
  CostCategorySaveInputSchema,
  CostCentreListInputSchema,
  CostCentreSaveInputSchema,
  CurrencySaveInputSchema,
  ExchangeRateListInputSchema,
  ExchangeRateSaveInputSchema,
  GroupListInputSchema,
  GroupSaveInputSchema,
  IdInputSchema,
  LedgerBalanceInputSchema,
  LedgerBulkCreateInputSchema,
  LedgerListInputSchema,
  LedgerPickerInputSchema,
  LedgerSaveInputSchema,
  SearchInputSchema,
  VoucherTypeListInputSchema,
  VoucherTypeSaveInputSchema,
} from './schemas.ts';
import { deleteVoucherType, getVoucherType, listVoucherTypes, saveVoucherType } from './voucherTypes.ts';

export const accountsRoutes = {
  // ── Groups ──
  'accounts.group.list': companyRoute({
    access: 'masters.view',
    input: GroupListInputSchema,
    handler: (ctx, input) => listGroups(ctx.db, input),
  }),
  'accounts.group.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getGroup(ctx.db, id),
  }),
  'accounts.group.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: GroupSaveInputSchema,
    handler: (ctx, input) => saveGroup(ctx, input),
  }),
  'accounts.group.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteGroup(ctx, id),
  }),

  // ── Ledgers ──
  'accounts.ledger.list': companyRoute({
    access: 'masters.view',
    input: LedgerListInputSchema,
    transactional: false,
    handler: (ctx, input) => listLedgers(ctx.db, input, ctx.clock.today()),
  }),
  'accounts.ledger.picker': companyRoute({
    access: 'masters.view',
    input: LedgerPickerInputSchema,
    transactional: false,
    handler: (ctx, input) => ledgerPicker(ctx.db, input, ctx.clock.today()),
  }),
  'accounts.ledger.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getLedger(ctx.db, id, ctx.clock.today()),
  }),
  'accounts.ledger.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: LedgerSaveInputSchema,
    handler: (ctx, input) => saveLedger(ctx, input),
  }),
  'accounts.ledger.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteLedger(ctx, id),
  }),
  'accounts.ledger.bulkCreate': companyRoute({
    access: 'masters.create',
    input: LedgerBulkCreateInputSchema,
    handler: (ctx, input) => bulkCreateLedgers(ctx, input),
  }),
  'accounts.ledger.balance': companyRoute({
    access: 'masters.view',
    input: LedgerBalanceInputSchema,
    transactional: false,
    handler: (ctx, input) => getLedgerBalance(ctx.db, input, ctx.clock.today()),
  }),
  'accounts.openingBalances.summary': companyRoute({
    access: 'masters.view',
    input: v.none(),
    transactional: false,
    handler: (ctx) => openingBalanceSummary(ctx.db),
  }),

  // ── Cost categories & centres ──
  'accounts.costCategory.list': companyRoute({
    access: 'masters.view',
    input: SearchInputSchema,
    handler: (ctx, input) => listCostCategories(ctx.db, input),
  }),
  'accounts.costCategory.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getCostCategory(ctx.db, id),
  }),
  'accounts.costCategory.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: CostCategorySaveInputSchema,
    handler: (ctx, input) => saveCostCategory(ctx, input),
  }),
  'accounts.costCategory.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteCostCategory(ctx, id),
  }),
  'accounts.costCentre.list': companyRoute({
    access: 'masters.view',
    input: CostCentreListInputSchema,
    handler: (ctx, input) => listCostCentres(ctx.db, input),
  }),
  'accounts.costCentre.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getCostCentre(ctx.db, id),
  }),
  'accounts.costCentre.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: CostCentreSaveInputSchema,
    handler: (ctx, input) => saveCostCentre(ctx, input),
  }),
  'accounts.costCentre.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteCostCentre(ctx, id),
  }),

  // ── Currencies & exchange rates ──
  'accounts.currency.list': companyRoute({
    access: 'masters.view',
    input: v.none(),
    handler: (ctx) => listCurrencies(ctx.db),
  }),
  'accounts.currency.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getCurrency(ctx.db, id),
  }),
  'accounts.currency.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: CurrencySaveInputSchema,
    handler: (ctx, input) => saveCurrency(ctx, input),
  }),
  'accounts.currency.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteCurrency(ctx, id),
  }),
  'accounts.exchangeRate.list': companyRoute({
    access: 'masters.view',
    input: ExchangeRateListInputSchema,
    handler: (ctx, input) => listExchangeRates(ctx.db, input),
  }),
  'accounts.exchangeRate.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: ExchangeRateSaveInputSchema,
    handler: (ctx, input) => saveExchangeRate(ctx, input),
  }),
  'accounts.exchangeRate.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteExchangeRate(ctx, id),
  }),

  // ── Voucher types ──
  'accounts.voucherType.list': companyRoute({
    access: 'masters.view',
    input: VoucherTypeListInputSchema,
    handler: (ctx, input) => listVoucherTypes(ctx.db, input),
  }),
  'accounts.voucherType.get': companyRoute({
    access: 'masters.view',
    input: IdInputSchema,
    handler: (ctx, { id }) => getVoucherType(ctx.db, id),
  }),
  'accounts.voucherType.save': companyRoute({
    access: 'masters.view', // + masters.create / masters.alter in the service
    input: VoucherTypeSaveInputSchema,
    handler: (ctx, input) => saveVoucherType(ctx, input),
  }),
  'accounts.voucherType.delete': companyRoute({
    access: 'masters.delete',
    input: IdInputSchema,
    handler: (ctx, { id }) => deleteVoucherType(ctx, id),
  }),

  // ── Chart of accounts ──
  'accounts.chart': companyRoute({
    access: 'masters.view',
    input: ChartInputSchema,
    transactional: false,
    handler: (ctx, input) => chartOfAccounts(ctx.db, input, ctx.clock.today()),
  }),
} satisfies RouteMap;
