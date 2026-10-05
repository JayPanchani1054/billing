import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../shared/settings.ts';
import type { CompanyConfigInput, CompanyFeaturesInput, CompanyProfileInput } from '../../../shared/types/company.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { patchNullable, requiredNullable } from '../../lib/schemas.ts';
import { v, type Schema } from '../../lib/validate.ts';
import {
  getCompanyProfile,
  getConfig,
  getFeatures,
  getOpenCompanySummary,
  saveCompanyProfile,
  saveConfig,
  saveFeatures,
  setPeriodLock,
} from './service.ts';
import { companyFieldShape } from './validation.ts';

const optText = (max: number) => v.string({ max }).nullable().optional();

export const CompanyProfileInputSchema = v.object({
  ...companyFieldShape,
  tan: optText(12),
  cin: optText(25),
  // undefined = keep, null = remove, string = data URL (decoded and checked by the service).
  logo: patchNullable(v.string({ max: 1_000_000 })),
}) as unknown as Schema<CompanyProfileInput>;

const featureShape = Object.fromEntries(
  (Object.keys(DEFAULT_FEATURES) as Array<keyof CompanyFeatures>).map((k) => [k, v.boolean().optional()]),
) as Record<keyof CompanyFeatures, Schema<boolean | undefined>>;
export const CompanyFeaturesInputSchema = v.object(featureShape) as unknown as Schema<CompanyFeaturesInput>;

const policy = v.enum(['allow', 'warn', 'block'] as const).optional();
const optDate = patchNullable(v.date());

export const CompanyConfigInputSchema = v.object({
  roundOff: v
    .object({
      enabled: v.boolean().optional(),
      method: v.enum(['nearest', 'up', 'down'] as const).optional(),
      unit: v.int({ min: 1, max: 100_00 }).optional(),
    })
    .optional(),
  invoice: v
    .object({
      printAfterSave: v.boolean().optional(),
      template: v.enum(['classic', 'modern', 'compact'] as const).optional(),
      copies: v.array(v.enum(['original', 'duplicate', 'triplicate'] as const), { min: 1, max: 3 }).optional(),
      showHsnSummary: v.boolean().optional(),
      showBankDetails: v.boolean().optional(),
      bankLedgerId: patchNullable(v.id()),
      showUpiQr: v.boolean().optional(),
      upiId: v
        .string({ max: 100 })
        .refine((s) => (s === '' || /^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(s) ? null : 'Enter a valid UPI ID, e.g. business@okbank'))
        .optional(),
      declaration: v.string({ max: 2000 }).optional(),
      terms: v.string({ max: 4000 }).optional(),
      signatoryLabel: v.string({ max: 100 }).optional(),
      itemwiseTax: v.boolean().optional(),
    })
    .optional(),
  gst: v
    .object({
      lutNumber: v.string({ max: 50 }).optional(),
      lutValidFrom: optDate,
      lutValidTo: optDate,
      hsnDigits: v.int({ min: 4, max: 8 }).refine((n) => (n === 4 || n === 6 || n === 8 ? null : 'HSN digits must be 4, 6 or 8')).optional(),
      b2clThresholdPaise: v.paise({ min: 0 }).optional(),
      ewayThresholdPaise: v.paise({ min: 0 }).optional(),
      filingFrequency: v.enum(['monthly', 'quarterly'] as const).optional(),
    })
    .optional(),
  guards: v
    .object({ negativeStock: policy, negativeCash: policy, creditLimit: policy, duplicateSupplierInvoice: policy })
    .optional(),
  backup: v
    .object({
      auto: v.boolean().optional(),
      keepLast: v.int({ min: 1, max: 365 }).optional(),
      folder: patchNullable(v.string({ max: 1000 })),
    })
    .optional(),
  display: v
    .object({
      showZeroBalances: v.boolean().optional(),
      dateFormat: v.enum(['DD-MM-YYYY', 'DD-MMM-YYYY'] as const).optional(),
    })
    .optional(),
}) as unknown as Schema<CompanyConfigInput>;

export const companyRoutes = {
  'company.profile.get': companyRoute({
    access: 'company.view',
    input: v.none(),
    handler: (ctx) => getCompanyProfile(ctx.db),
  }),
  'company.profile.save': companyRoute({
    access: 'company.manage',
    input: CompanyProfileInputSchema,
    handler: (ctx, input) => saveCompanyProfile(ctx, input),
  }),
  'company.features.get': companyRoute({
    access: 'authenticated',
    input: v.none(),
    handler: (ctx) => getFeatures(ctx.db),
  }),
  'company.features.save': companyRoute({
    access: 'company.manage',
    input: CompanyFeaturesInputSchema,
    handler: (ctx, input) => saveFeatures(ctx, input),
  }),
  'company.config.get': companyRoute({
    access: 'authenticated',
    input: v.none(),
    handler: (ctx) => getConfig(ctx.db),
  }),
  'company.config.save': companyRoute({
    access: 'company.manage',
    input: CompanyConfigInputSchema,
    handler: (ctx, input) => saveConfig(ctx, input),
  }),
  'company.periodLock.set': companyRoute({
    access: 'period.lock',
    input: v.object({ date: requiredNullable(v.date(), 'Choose a date to lock up to, or null to unlock') }),
    handler: (ctx, input) => setPeriodLock(ctx, input.date),
  }),
  'company.summary': companyRoute({
    access: 'authenticated',
    input: v.none(),
    handler: (ctx) => getOpenCompanySummary(ctx.db, ctx.company.id),
  }),
} satisfies RouteMap;
