/**
 * Forex routes ('forex.*'). Everything except `forex.context` needs F11 › Multiple currencies.
 * Reports are read-only (transactional: false). Existing permissions only.
 */
import type { ForexOpeningInput, ForexOutstandingInput, ForexRevaluationInput, ForexRevaluationPostInput, ForexSettings } from '../../../shared/types/forex.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { forexLedgerStatement, forexOutstanding, forexRevaluation, postForexRevaluation } from './reports.ts';
import {
  LedgerStatementSchema,
  OpeningSchema,
  OutstandingSchema,
  PendingBillsSchema,
  RateSuggestSchema,
  RevaluationPostSchema,
  RevaluationSchema,
  ForexSettingsSchema,
} from './schemas.ts';
import { assertForexEnabled, forexContext, forexPendingBills, getForexOpening, saveForexOpening, saveForexSettings, suggestRate, voucherForex } from './service.ts';
import { settingsView } from './store.ts';

const IdSchema = v.object({ id: v.id() });
const LedgerIdSchema = v.object({ ledgerId: v.id() });

export const forexRoutes = {
  /** Currencies, ledgers kept in a foreign currency and settings, for entry screens (works with the feature off: enabled false). */
  'forex.context': companyRoute({
    access: 'vouchers.view',
    input: v.object({}),
    transactional: false,
    handler: (ctx) => forexContext(ctx.db),
  }),
  'forex.settings.get': companyRoute({
    access: 'masters.view',
    input: v.object({}),
    transactional: false,
    handler: (ctx) => {
      assertForexEnabled(ctx.db);
      return settingsView(ctx.db);
    },
  }),
  'forex.settings.save': companyRoute({
    access: 'company.manage',
    input: ForexSettingsSchema,
    handler: (ctx, input) => saveForexSettings(ctx, input as Partial<ForexSettings>),
  }),
  /** Rate of exchange of a currency on a date (master), by rate type or the voucher type's default. */
  'forex.rate.suggest': companyRoute({
    access: 'vouchers.view',
    input: RateSuggestSchema,
    transactional: false,
    handler: (ctx, input) => {
      assertForexEnabled(ctx.db);
      return suggestRate(ctx.db, input);
    },
  }),
  /** Pending bills of a foreign-currency ledger in both currencies (bill-wise dialog). */
  'forex.pendingBills': companyRoute({
    access: 'vouchers.view',
    input: PendingBillsSchema,
    transactional: false,
    handler: (ctx, input) => {
      assertForexEnabled(ctx.db);
      return forexPendingBills(ctx.db, ctx.clock.today(), input);
    },
  }),
  /** Forex side of a saved voucher (view / print). */
  'forex.voucher': companyRoute({
    access: 'vouchers.view',
    input: IdSchema,
    transactional: false,
    handler: (ctx, input) => voucherForex(ctx.db, input.id),
  }),
  'forex.outstanding': companyRoute({
    access: 'reports.view',
    input: OutstandingSchema,
    transactional: false,
    handler: (ctx, input) => forexOutstanding(ctx.db, ctx.clock.today(), input as ForexOutstandingInput),
  }),
  'forex.ledger': companyRoute({
    access: 'reports.view',
    input: LedgerStatementSchema,
    transactional: false,
    handler: (ctx, input) => forexLedgerStatement(ctx.db, ctx.clock.today(), input),
  }),
  'forex.revaluation.report': companyRoute({
    access: 'reports.view',
    input: RevaluationSchema,
    transactional: false,
    handler: (ctx, input) => forexRevaluation(ctx.db, ctx.clock.today(), input as ForexRevaluationInput),
  }),
  /** Post the "Forex adjustment" journal (vouchers.create; back-dated / locked rules of saveVoucher apply). */
  'forex.revaluation.post': companyRoute({
    access: 'vouchers.create',
    input: RevaluationPostSchema,
    handler: (ctx, input) => postForexRevaluation(ctx, input as ForexRevaluationPostInput),
  }),
  'forex.opening.get': companyRoute({
    access: 'masters.view',
    input: LedgerIdSchema,
    transactional: false,
    handler: (ctx, input) => {
      assertForexEnabled(ctx.db);
      return getForexOpening(ctx.db, input.ledgerId);
    },
  }),
  'forex.opening.save': companyRoute({
    access: 'masters.alter',
    input: OpeningSchema,
    handler: (ctx, input) => saveForexOpening(ctx, input as ForexOpeningInput),
  }),
} satisfies RouteMap;
