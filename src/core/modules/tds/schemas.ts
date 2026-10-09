/**
 * Input schemas of the tds module (routes + the `tds` field of VoucherInput, validated by
 * vouchers/routes.ts › VoucherInputSchema).
 */
import { DEDUCTEE_TYPES, TDS_KINDS } from '../../../shared/types/tds.ts';
import { v, type Schema } from '../../lib/validate.ts';

const MAX_PAISE = 1_00_00_00_00_000_00; // ₹1,00,000 crore
const amount = (): Schema<number> => v.paise({ min: 0, max: MAX_PAISE });
const optText = (max: number): Schema<string | undefined> => v.string({ max }).optional();
export const PERIOD = v.string({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/, patternMessage: 'Period must be a month (YYYY-MM)' });
const SECTION = v.string({ min: 1, max: 20 });

export const VoucherTdsOverrideSchema = v.object({
  natureId: v.id(),
  amount: amount(),
  reason: v.string({ min: 1, max: 300 }),
});

export const VoucherTdsChallanSchema = v.object({
  kind: v.enum(TDS_KINDS),
  section: SECTION,
  period: PERIOD,
  bsrCode: v.string({ pattern: /^\d{7}$/, patternMessage: 'BSR code must be 7 digits' }),
  challanNo: v.string({ pattern: /^\d{1,5}$/, patternMessage: 'Challan serial number must be up to 5 digits' }),
  depositDate: v.date(),
  minorHead: v.enum(['200', '400'] as const).optional(),
  tax: amount(),
  surcharge: amount().optional(),
  cess: amount().optional(),
  interest: amount().optional(),
  fee: amount().optional(),
  others: amount().optional(),
});

export const VoucherTdsInputSchema = v.object({
  natureId: v.id().optional(),
  overrides: v.array(VoucherTdsOverrideSchema, { max: 50 }).optional(),
  challan: VoucherTdsChallanSchema.optional(),
});

export const NatureRateSchema = v.object({
  applicableFrom: v.date(),
  rateIndividual: v.number({ min: 0, max: 100 }),
  rateCompany: v.number({ min: 0, max: 100 }),
  rateOthers: v.number({ min: 0, max: 100 }),
  rateNoPan: v.number({ min: 0, max: 100 }),
  thresholdSingle: amount().nullable(),
  thresholdAggregate: amount().nullable(),
  aggregatePeriod: v.enum(['fy', 'month'] as const),
  thresholdBasis: v.enum(['whole', 'excess'] as const),
  baseIncludesGst: v.boolean(),
  note: v.string({ max: 500 }).nullable(),
});

export const NatureSaveSchema = v.object({
  id: v.id().optional(),
  kind: v.enum(TDS_KINDS),
  name: v.string({ min: 1, max: 120 }),
  section: SECTION,
  section2025: optText(40),
  forNonResidents: v.boolean().optional(),
  isActive: v.boolean().optional(),
  rates: v.array(NatureRateSchema, { min: 1, max: 50 }),
});

export const CertificateSchema = v.object({
  number: v.string({ min: 1, max: 40 }),
  rate: v.number({ min: 0, max: 100 }),
  validFrom: v.date(),
  validTo: v.date(),
  limit: amount().nullable(),
  natureId: v.id().nullable(),
});

export const LedgerTdsSaveSchema = v.object({
  ledgerId: v.id(),
  applicable: v.boolean(),
  natureId: v.id().nullable().optional(),
  deducteeType: v.enum(DEDUCTEE_TYPES).nullable().optional(),
  nonResident: v.boolean().optional(),
  pan: v.string({ max: 10 }).nullable().optional(),
  certificate: CertificateSchema.nullable().optional(),
  deductorTan: v.string({ max: 10 }).nullable().optional(),
});

export const SettingsSchema = v.object({
  tan: v.string({ max: 10 }),
  deductorCategory: v.enum(['company', 'firm', 'individual', 'others', 'government'] as const),
  responsiblePerson: v.string({ max: 100 }),
  responsibleDesignation: v.string({ max: 100 }),
  buyer194Q: v.boolean(),
  roundToRupee: v.boolean(),
});

export const PeriodSchema = v.strictObject({ from: v.date(), to: v.date(), kind: v.enum(TDS_KINDS).optional() });
