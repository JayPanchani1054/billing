/**
 * Print routes: read-only data for invoice / voucher documents. Rendering happens in the renderer
 * (src/renderer/modules/print) and the HTML goes to bahi.native('print.*'). DTOs: shared/types/print.ts.
 */
import { PRINT_BATCH_MAX, PRINT_COPIES, PRINT_TEMPLATES, SHARE_CHANNELS, type InvoicePrintOverrides, type ShareSubjectInput } from '../../../shared/types/print.ts';
import { validateUpiId } from '../../../shared/validators.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { buildBatch, buildPrintDataFor, listBankLedgers, loadPrintEnv } from './data.ts';
import { buildSampleData } from './sample.ts';
import { logShare, shareContext } from './share.ts';

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
  paperSize: v.enum(['A4', 'A5', 'A5-landscape', 'Letter', 'Legal'] as const).optional(),
  rollWidth: v.enum(['80mm', '58mm'] as const).optional(),
  showMrp: v.boolean().optional(),
});

/** Drop keys the validator left undefined so they don't override saved options. */
function cleanOverrides(o: InvoicePrintOverrides | undefined): InvoicePrintOverrides | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) if (val !== undefined) out[k] = val;
  return Object.keys(out).length > 0 ? (out as InvoicePrintOverrides) : undefined;
}

/** A voucher, or a party statement for a period (exactly one). */
const ShareSubjectShape = {
  voucherId: v.id().optional(),
  statement: v.object({ ledgerId: v.id(), from: v.date(), to: v.date() }).optional(),
};
const oneSubject = (i: ShareSubjectInput): string | null =>
  (i.voucherId === undefined) === (i.statement === undefined) ? 'Choose either a voucher or a statement to share' : null;

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
  // print group: sharing by e-mail / WhatsApp (the PDF is written by Electron main, see shared/bridge.ts share.*).
  'print.share.context': companyRoute({
    access: 'data.export',
    transactional: false,
    input: v.object(ShareSubjectShape).refine(oneSubject),
    handler: (ctx, input) => shareContext(ctx, input),
  }),
  'print.share.log': companyRoute({
    access: 'data.export',
    input: v
      .object({
        ...ShareSubjectShape,
        channel: v.enum(SHARE_CHANNELS),
        to: v.string({ max: 2000 }).optional(),
        fileName: v.string({ min: 1, max: 255 }),
      })
      .refine(oneSubject),
    handler: (ctx, input) => logShare(ctx, input),
  }),
  'print.bankLedgers': companyRoute({
    access: 'company.view',
    transactional: false,
    input: v.none(),
    handler: (ctx) => listBankLedgers(ctx.db),
  }),
} satisfies RouteMap;
