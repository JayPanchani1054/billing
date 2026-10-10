/**
 * Input schemas of the forex module (also used by the vouchers schema for VoucherInput.forex).
 */
import { FOREX_RATE_TYPES } from '../../../shared/forex.ts';
import { v } from '../../lib/validate.ts';

/** Largest foreign amount accepted (major units) — far above any real document, below float precision trouble. */
export const MAX_FOREX = 1e12;
/** Largest rate of exchange accepted (rupees per unit). */
export const MAX_RATE = 1e6;

export const forexAmountSchema = v.number({ min: -MAX_FOREX, max: MAX_FOREX });
export const forexMagnitudeSchema = v.number({ min: 0, max: MAX_FOREX });
export const rateSchema = v.number({ min: 0, max: MAX_RATE });

export const VoucherForexSchema = v.object({
  currencyId: v.id(),
  rate: rateSchema,
  rateType: v.enum(FOREX_RATE_TYPES).optional(),
});

export const RateOverridesSchema = v.array(v.object({ currencyId: v.id(), rate: rateSchema }), { max: 200 });

export const ForexSettingsSchema = v.object({
  gainLossLedgerId: v.id().nullable().optional(),
  unrealisedLedgerId: v.id().nullable().optional(),
  revaluationRateType: v.enum(FOREX_RATE_TYPES).optional(),
});

export const RateSuggestSchema = v.object({
  currencyId: v.id(),
  date: v.date(),
  rateType: v.enum(FOREX_RATE_TYPES).optional(),
  baseType: v.string({ max: 40 }).optional(),
});

export const PendingBillsSchema = v.object({ ledgerId: v.id(), asOf: v.date(), excludeVoucherId: v.id().optional() });

export const OutstandingSchema = v.strictObject({
  asOf: v.date(),
  kind: v.enum(['receivable', 'payable', 'all'] as const).optional(),
  ledgerId: v.id().optional(),
  currencyId: v.id().optional(),
  rateType: v.enum(FOREX_RATE_TYPES).optional(),
});

export const LedgerStatementSchema = v.strictObject({ ledgerId: v.id(), from: v.date(), to: v.date() });

export const RevaluationSchema = v.strictObject({
  asOf: v.date(),
  rateType: v.enum(FOREX_RATE_TYPES).optional(),
  rates: RateOverridesSchema.optional(),
});

export const RevaluationPostSchema = v.object({
  asOf: v.date(),
  rateType: v.enum(FOREX_RATE_TYPES).optional(),
  rates: RateOverridesSchema.optional(),
  date: v.date().optional(),
  voucherTypeId: v.id().optional(),
  narration: v.string({ max: 4000 }).optional(),
  allowRepeat: v.boolean().optional(),
});

export const OpeningSchema = v.object({
  ledgerId: v.id(),
  openingForex: forexAmountSchema,
  bills: v.array(v.object({ billName: v.string({ min: 1, max: 100 }), forexAmount: forexAmountSchema }), { max: 5000 }).optional(),
});
