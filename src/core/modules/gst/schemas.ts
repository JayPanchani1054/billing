/**
 * Input schema of VoucherInput.gstDetails (validated by vouchers.save / vouchers.preview; the rules
 * are applied by the gst voucher hook, hook.ts). Kept here so the vouchers module only references it.
 */
import { CASH_MINOR_HEADS, GST_ADJUSTMENT_NATURES } from '../../../shared/types/gst-plus.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { v } from '../../lib/validate.ts';

const periodKey = v.string({ min: 6, max: 10, pattern: /^((0[1-9]|1[0-2])\d{4}|\d{4}-\d{2}-Q[1-4])$/, patternMessage: "Return period must look like '042026' or '2026-27-Q1'" });

const AdvanceRef = v.object({ receiptVoucherId: v.id(), amount: v.paise({ min: 1 }) });

const CashHead = v.object({ head: v.enum(TAX_HEADS), minor: v.enum(CASH_MINOR_HEADS), amount: v.paise({ min: 0 }) });

export const VoucherGstDetailsSchema = v.object({
  advance: v
    .object({
      supplyType: v.enum(['goods', 'services'] as const),
      rate: v.number({ min: 0, max: 100 }),
      cessRate: v.number({ min: 0, max: 400 }).optional(),
      placeOfSupply: v.string({ max: 2, pattern: /^(\d{2})?$/, patternMessage: 'Place of supply must be a two-digit state code' }).optional(),
      amount: v.paise({ min: 1 }).optional(),
    })
    .optional(),
  advanceAdjustments: v.array(AdvanceRef, { max: 100 }).optional(),
  advanceRefund: AdvanceRef.optional(),
  billOfEntry: v
    .object({
      number: v.string({ min: 1, max: 20 }),
      date: v.date(),
      portCode: v.string({ max: 10 }).optional(),
      assessableValue: v.paise({ min: 0 }),
      customsDuty: v.paise({ min: 0 }).optional(),
      igst: v.paise({ min: 0 }),
      cess: v.paise({ min: 0 }).optional(),
      creditLedgerId: v.id().optional(),
    })
    .optional(),
  adjustment: v
    .object({
      nature: v.enum(GST_ADJUSTMENT_NATURES),
      period: periodKey.optional(),
      taxableValue: v.paise({ min: 0 }).optional(),
    })
    .optional(),
  challan: v
    .object({
      cpin: v.string({ min: 1, max: 20 }),
      cin: v.string({ max: 30 }).optional(),
      brn: v.string({ max: 40 }).optional(),
      challanDate: v.date().optional(),
      bankName: v.string({ max: 100 }).optional(),
      mode: v.enum(['epayment', 'neft_rtgs', 'otc'] as const).optional(),
      period: periodKey.optional(),
      heads: v.array(CashHead, { min: 1, max: 20 }),
    })
    .optional(),
  setoff: v
    .object({
      period: periodKey,
      cash: v.array(CashHead, { max: 20 }),
      credit: v.array(v.object({ from: v.enum(TAX_HEADS), to: v.enum(TAX_HEADS), amount: v.paise({ min: 0 }) }), { max: 16 }),
    })
    .optional(),
});
