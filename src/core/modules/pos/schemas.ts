/**
 * Input schemas of the pos module (routes.ts) and of `VoucherInput.posBill` (vouchers/routes.ts).
 */
import { v } from '../../lib/validate.ts';

/** ₹1 crore per tender / bill is far above any counter sale; it only stops absurd numbers. */
const MAX_PAISE = 1_00_00_000_00;

export const PosTenderSchema = v.object({
  modeId: v.id(),
  amount: v.int({ min: 1, max: MAX_PAISE }),
  reference: v.string({ max: 50 }).optional(),
  exchangeVoucherId: v.id().optional(),
});

/** VoucherInput.posBill */
export const VoucherPosSchema = v.object({
  tenders: v.array(PosTenderSchema, { max: 20 }),
  cashTendered: v.int({ min: 0, max: MAX_PAISE }).optional(),
  returnOfId: v.id().optional(),
  counter: v.string({ max: 40 }).optional(),
});

export const PosSettingsSchema = v.object({
  saleVoucherTypeId: v.id().nullable().optional(),
  returnVoucherTypeId: v.id().nullable().optional(),
  walkInLedgerId: v.id().nullable().optional(),
  priceLevelId: v.id().nullable().optional(),
  godownId: v.id().nullable().optional(),
  printAfterSave: v.boolean().optional(),
  askCustomerFirst: v.boolean().optional(),
});

export const TenderModeSaveSchema = v.object({
  id: v.id().optional(),
  name: v.string({ min: 1, max: 40 }),
  // 'exchange' is accepted only to rename / reorder the system mode (store.ts › saveTenderMode).
  kind: v.enum(['cash', 'card', 'upi', 'wallet', 'other', 'exchange'] as const),
  ledgerId: v.id(),
  sortOrder: v.int({ min: 0, max: 100_000 }).optional(),
  isActive: v.boolean().optional(),
});

export const ItemLookupSchema = v.strictObject({
  code: v.string({ min: 1, max: 200 }),
  date: v.date(),
  priceLevelId: v.id().optional(),
  godownId: v.id().optional(),
});

export const ItemGetSchema = v.strictObject({
  itemId: v.id(),
  date: v.date(),
  priceLevelId: v.id().optional(),
  godownId: v.id().optional(),
});

export const CustomerFindSchema = v.strictObject({ mobile: v.string({ min: 1, max: 20 }) });

export const CustomerCreateSchema = v.object({
  name: v.string({ min: 1, max: 100 }),
  mobile: v.string({ min: 1, max: 20 }),
  stateCode: v.string({ max: 2, pattern: /^(\d{2})?$/, patternMessage: 'State must be a two-digit GST state code' }).optional(),
});

const DraftLineSchema = v.object({
  itemId: v.id(),
  qty: v.number({ min: 0, max: 1e9 }),
  rate: v.number({ min: 0, max: 1e9 }),
  discountPct: v.number({ min: 0, max: 100 }).optional(),
  batchName: v.string({ max: 100 }).optional(),
});

export const HeldSaveSchema = v.object({
  id: v.id().optional(),
  label: v.string({ max: 80 }).optional(),
  total: v.int({ min: -MAX_PAISE, max: MAX_PAISE }),
  draft: v.object({
    voucherTypeId: v.id(),
    partyLedgerId: v.id().optional(),
    customerName: v.string({ max: 100 }).optional(),
    customerMobile: v.string({ max: 20 }).optional(),
    placeOfSupply: v.string({ max: 2, pattern: /^(\d{2})?$/, patternMessage: 'Place of supply must be a two-digit state code' }).optional(),
    lines: v.array(DraftLineSchema, { max: 500 }),
    narration: v.string({ max: 500 }).optional(),
  }),
});

export const ReturnContextSchema = v.strictObject({
  voucherId: v.id().optional(),
  number: v.string({ max: 50 }).optional(),
  voucherTypeId: v.id().optional(),
  date: v.date(),
});

export const ExchangeCreditsSchema = v.strictObject({ partyLedgerId: v.id().optional() });

const PeriodShape = {
  from: v.date(),
  to: v.date(),
  voucherTypeIds: v.array(v.id(), { max: 50 }).optional(),
  userId: v.id().nullable().optional(),
  counter: v.string({ max: 40 }).optional(),
  modeId: v.id().optional(),
};

export const SummarySchema = v.strictObject(PeriodShape);

export const RegisterSchema = v.strictObject({
  ...PeriodShape,
  kind: v.enum(['sale', 'return'] as const).optional(),
  search: v.string({ max: 100 }).optional(),
  limit: v.int({ min: 1, max: 1000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
});
