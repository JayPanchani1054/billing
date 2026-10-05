/**
 * GST module routes. Reads need gst.view; anything that produces a return / bulk file or changes
 * GST state needs gst.file. Report routes are transactional: false (read-only; file exports write
 * their audit entry in their own small transaction). See README.md for inputs and outputs.
 */
import type {
  EinvoiceImportResult,
  EinvoicePendingResult,
  EwayPendingResult,
  GstBulkJsonFile,
  GstDocEvent,
  GstDocStatusResult,
  GstExceptionsResult,
  GstHsnSummaryResult,
  GstItcResult,
  GstJsonFile,
  GstPeriodsResult,
  GstRegisterResult,
  Gstr1SectionResult,
  Gstr1Summary,
  Gstr3bSummary,
  Gstr9Summary,
} from '../../../shared/types/gst-returns.ts';
import { GSTR1_SECTIONS, GSTR3B_ADJUSTMENT_KEYS } from '../../../shared/types/gst-returns.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { rule } from '../../lib/errors.ts';
import { v, type Schema } from '../../lib/validate.ts';
import { loadCompany, loadDocs, type GstCompany } from './docs.ts';
import { einvoiceJson, importIrpResponse, markIrnCancelled, pendingEinvoices } from './einvoice.ts';
import { ewayJson, pendingEwayBills, updateEwayBill } from './ewaybill.ts';
import { computeGstr1, gstr1Section, gstr1Summary } from './gstr1.ts';
import { buildGstr1Json } from './gstr1-json.ts';
import { buildGstr3bJson, computeGstr3b, saveAdjustments } from './gstr3b.ts';
import { computeGstr9 } from './gstr9.ts';
import { listPeriods, requireReturnPeriod, resolvePeriod } from './period.ts';
import { collectIssues, exceptionsReport, gstRegister, hsnSummary, itcReport } from './reports.ts';

/** The open company's GST profile; refuses companies without GST. */
export function gstCompany(ctx: CompanyCtx): GstCompany {
  const c = loadCompany(ctx.db);
  if (!c.features.gst) throw rule('GST is turned off for this company. Turn it on under Features (F11) to use GST reports.');
  if (c.registration === 'unregistered') throw rule('This company is not registered under GST. Set its GST registration in the company profile to use GST returns.');
  return c;
}

const periodShape = {
  period: v.string({ max: 20 }).optional(),
  from: v.date().optional(),
  to: v.date().optional(),
};
const PeriodInput = v.object(periodShape);
const ReturnPeriodInput = v.object({ period: v.string({ min: 1, max: 20 }) });
const rangeShape = { from: v.date(), to: v.date() };
const checkRange = <T extends { from: string; to: string }>(s: Schema<T>): Schema<T> =>
  s.refine((x) => (x.from > x.to ? 'The To date is before the From date' : null));
const RangeInput = checkRange(v.object(rangeShape));
const VoucherIds = v.object({ voucherIds: v.array(v.id(), { min: 1, max: 1000 }) });

const taxShape = v
  .object({
    igst: v.paise({ min: 0 }).optional(),
    cgst: v.paise({ min: 0 }).optional(),
    sgst: v.paise({ min: 0 }).optional(),
    cess: v.paise({ min: 0 }).optional(),
  })
  .optional();
const adjustmentShape = Object.fromEntries(GSTR3B_ADJUSTMENT_KEYS.map((k) => [k, taxShape])) as Record<
  (typeof GSTR3B_ADJUSTMENT_KEYS)[number],
  typeof taxShape
>;

function auditExport(ctx: CompanyCtx, label: string): void {
  ctx.db.transaction(() => ctx.audit({ action: 'export', entityType: 'gst_return', entityLabel: label }));
}

export const gstRoutes = {
  'gst.periods': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.none(),
    handler: (ctx): GstPeriodsResult => {
      gstCompany(ctx);
      return listPeriods(ctx.db, ctx.clock.today());
    },
  }),

  // ───────────── GSTR-1 ─────────────
  'gst.gstr1.summary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: PeriodInput,
    handler: (ctx, input): Gstr1Summary => gstr1Summary(computeGstr1(ctx.db, gstCompany(ctx), resolvePeriod(input), ctx.clock.today())),
  }),
  'gst.gstr1.section': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ ...periodShape, section: v.enum(GSTR1_SECTIONS) }),
    handler: (ctx, input): Gstr1SectionResult =>
      gstr1Section(computeGstr1(ctx.db, gstCompany(ctx), resolvePeriod(input), ctx.clock.today()), input.section),
  }),
  'gst.gstr1.json': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: ReturnPeriodInput,
    handler: (ctx, input): GstJsonFile => {
      const company = gstCompany(ctx);
      if (company.registration !== 'regular') throw rule('Only regular taxpayers file GSTR-1.');
      const period = requireReturnPeriod(input);
      const file = buildGstr1Json(computeGstr1(ctx.db, company, period, ctx.clock.today()));
      auditExport(ctx, `GSTR-1 ${period.label} (${file.fileName})`);
      return file;
    },
  }),

  // ───────────── GSTR-3B ─────────────
  'gst.gstr3b.summary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: PeriodInput,
    handler: (ctx, input): Gstr3bSummary => {
      const company = gstCompany(ctx);
      const period = resolvePeriod(input);
      const today = ctx.clock.today();
      const docs = loadDocs(ctx.db, company, { from: period.from, to: period.to, today, includeCancelled: true });
      const issues = collectIssues(ctx.db, company, period.from, period.to, today, docs);
      const errors = issues.filter((i) => i.severity === 'error').length;
      return computeGstr3b(ctx.db, company, period, today, { errors, warnings: issues.length - errors }, docs);
    },
  }),
  'gst.gstr3b.saveAdjustments': companyRoute({
    access: 'gst.file',
    input: v.object({ period: v.string({ min: 1, max: 20 }), values: v.object(adjustmentShape) }),
    handler: (ctx, input): Gstr3bSummary => {
      const company = gstCompany(ctx);
      const period = requireReturnPeriod(input);
      saveAdjustments(ctx, period, input.values);
      return computeGstr3b(ctx.db, company, period, ctx.clock.today());
    },
  }),
  'gst.gstr3b.json': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: ReturnPeriodInput,
    handler: (ctx, input): GstJsonFile => {
      const company = gstCompany(ctx);
      if (company.registration !== 'regular') throw rule('Only regular taxpayers file GSTR-3B (composition taxpayers file CMP-08).');
      const period = requireReturnPeriod(input);
      const file = buildGstr3bJson(computeGstr3b(ctx.db, company, period, ctx.clock.today()));
      auditExport(ctx, `GSTR-3B ${period.label} (${file.fileName})`);
      return file;
    },
  }),

  // ───────────── Registers & analysis ─────────────
  'gst.hsnSummary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: checkRange(v.object({ ...rangeShape, direction: v.enum(['outward', 'inward'] as const) })),
    handler: (ctx, input): GstHsnSummaryResult => hsnSummary(ctx.db, gstCompany(ctx), input.from, input.to, input.direction, ctx.clock.today()),
  }),
  'gst.register': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: checkRange(v.object({ ...rangeShape, kind: v.enum(['sales', 'purchase'] as const) })),
    handler: (ctx, input): GstRegisterResult => gstRegister(ctx.db, gstCompany(ctx), input.from, input.to, input.kind, ctx.clock.today()),
  }),
  'gst.itc': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: RangeInput,
    handler: (ctx, input): GstItcResult => itcReport(ctx.db, gstCompany(ctx), input.from, input.to, ctx.clock.today()),
  }),
  'gst.exceptions': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: RangeInput,
    handler: (ctx, input): GstExceptionsResult => exceptionsReport(ctx.db, gstCompany(ctx), input.from, input.to, ctx.clock.today()),
  }),

  // ───────────── e-Invoice ─────────────
  'gst.einvoice.pending': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: RangeInput,
    handler: (ctx, input): EinvoicePendingResult => pendingEinvoices(ctx.db, gstCompany(ctx), input.from, input.to, ctx.clock.today()),
  }),
  'gst.einvoice.json': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: VoucherIds,
    handler: (ctx, input): GstBulkJsonFile => einvoiceJson(ctx, gstCompany(ctx), input.voucherIds),
  }),
  'gst.einvoice.importResponse': companyRoute({
    access: 'gst.file',
    input: v.object({ fileName: v.string({ min: 1, max: 260 }), bytes: v.bytes({ max: 20 * 1024 * 1024 }) }),
    handler: (ctx, input): EinvoiceImportResult => {
      gstCompany(ctx);
      return importIrpResponse(ctx, input.fileName, input.bytes);
    },
  }),
  'gst.einvoice.markCancelled': companyRoute({
    access: 'gst.file',
    input: v.object({ voucherId: v.id(), reason: v.string({ min: 1, max: 200 }) }),
    handler: (ctx, input): GstDocStatusResult => {
      gstCompany(ctx);
      return markIrnCancelled(ctx, input.voucherId, input.reason);
    },
  }),

  // ───────────── e-Way bill ─────────────
  'gst.ewaybill.pending': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: RangeInput,
    handler: (ctx, input): EwayPendingResult => pendingEwayBills(ctx.db, gstCompany(ctx), input.from, input.to, ctx.clock.today()),
  }),
  'gst.ewaybill.json': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: VoucherIds,
    handler: (ctx, input): GstBulkJsonFile => ewayJson(ctx, gstCompany(ctx), input.voucherIds),
  }),
  'gst.ewaybill.update': companyRoute({
    access: 'gst.file',
    input: v.object({
      voucherId: v.id(),
      ewayBillNo: v.string({ min: 1, max: 20 }),
      date: v.date(),
      validUpto: v.date().nullable().optional(),
    }),
    handler: (ctx, input): GstDocStatusResult => {
      gstCompany(ctx);
      return updateEwayBill(ctx, input);
    },
  }),

  // ───────────── Document trail ─────────────
  'gst.docEvents': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ voucherId: v.id() }),
    handler: (ctx, input): GstDocEvent[] =>
      ctx.db
        .all<{ id: number; kind: string; action: string; ref_no: string | null; detail: string | null; ts: string; username: string | null }>(
          `SELECT id, kind, action, ref_no, detail, ts, username FROM gst_doc_events WHERE voucher_id = :id ORDER BY id`,
          { id: input.voucherId },
        )
        .map((r) => ({
          id: r.id,
          kind: r.kind as 'einvoice' | 'ewaybill',
          action: r.action,
          refNo: r.ref_no,
          detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
          at: r.ts,
          by: r.username,
        })),
  }),

  // ───────────── GSTR-9 ─────────────
  'gst.gstr9.summary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ fy: v.string({ min: 7, max: 7, pattern: /^\d{4}-\d{2}$/, patternMessage: 'Financial year must look like 2026-27' }) }),
    handler: (ctx, input): Gstr9Summary => computeGstr9(ctx.db, gstCompany(ctx), input.fy, ctx.clock.today()),
  }),
} satisfies RouteMap;
