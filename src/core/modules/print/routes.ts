/**
 * Print routes: read-only data for invoice / voucher documents. Rendering happens in the renderer
 * (src/renderer/modules/print) and the HTML goes to bahi.native('print.*'). DTOs: shared/types/print.ts.
 */
import { PRINT_BATCH_MAX, PRINT_COPIES, PRINT_TEMPLATES, type InvoicePrintOverrides } from '../../../shared/types/print.ts';
import { validateUpiId } from '../../../shared/validators.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { buildBatch, buildPrintDataFor, listBankLedgers, loadPrintEnv } from './data.ts';
import { buildSampleData } from './sample.ts';

const text = (max: number) => v.string({ max }).optional();

/** Preview-only overrides of F12 › Invoice printing (never saved by these routes). */
export const OverridesSchema = v.object({
  printAfterSave: v.boolean().optional(),
  template: v.enum(PRINT_TEMPLATES).optional(),
  copies: v.array(v.enum(PRINT_COPIES), { min: 1, max: 3 }).optional(),
  showHsnSummary: v.boolean().optional(),
  showBankDetails: v.boolean().optional(),
  bankLedgerId: v.id().nullable().optional(),
  showUpiQr: v.boolean().optional(),
  upiId: v
    .string({ max: 320 })
    .refine((s) => (s.trim() === '' ? null : validateUpiId(s.trim())))
    .optional(),
  declaration: text(2000),
  terms: text(4000),
  signatoryLabel: text(100),
  itemwiseTax: v.boolean().optional(),
});

/** Drop keys the validator left undefined so they don't override saved options. */
function cleanOverrides(o: InvoicePrintOverrides | undefined): InvoicePrintOverrides | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) if (val !== undefined) out[k] = val;
  return Object.keys(out).length > 0 ? (out as InvoicePrintOverrides) : undefined;
}

export const printRoutes = {
  'print.voucherData': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ id: v.id(), overrides: OverridesSchema.optional() }),
    handler: (ctx, input) => buildPrintDataFor(ctx, input.id, cleanOverrides(input.overrides as InvoicePrintOverrides | undefined)),
  }),
  'print.batchData': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ ids: v.array(v.id(), { min: 1, max: PRINT_BATCH_MAX }) }),
    handler: (ctx, input) => buildBatch(ctx, input.ids),
  }),
  'print.sample': companyRoute({
    access: 'company.view',
    transactional: false,
    input: v.object({ overrides: OverridesSchema.optional() }),
    handler: (ctx, input) => buildSampleData(loadPrintEnv(ctx), cleanOverrides(input.overrides as InvoicePrintOverrides | undefined)),
  }),
  'print.bankLedgers': companyRoute({
    access: 'company.view',
    transactional: false,
    input: v.none(),
    handler: (ctx) => listBankLedgers(ctx.db),
  }),
} satisfies RouteMap;
