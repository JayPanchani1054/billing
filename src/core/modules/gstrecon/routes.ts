/**
 * GST reconciliation routes. DTOs: src/shared/types/gstrecon.ts; semantics: README.md in this folder.
 *
 * Access: imports, runs and decisions need 'gst.file'; read routes and the follow-up e-mail need 'gst.view';
 * the export needs 'gst.view' + 'data.export'. Heavy routes
 * (import, run, exports, reads) are transactional: false and open their own transaction for writes.
 */
import { RECON_SOURCES, RECON_STATUS_FILTERS } from '../../../shared/types/gstrecon.ts';
import type { ReconSource } from '../../../shared/types/gstrecon.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { forbidden } from '../../lib/errors.ts';
import { v } from '../../lib/validate.ts';
import { buildSupplierFollowUp, exportReconFile } from './export.ts';
import { getResults, getSuggestions, getSummary, getSupplierSummary } from './queries.ts';
import { deleteBatch, importPortalFile, linkDoc, listBatches, resolveDocs, runHistory, runRecon, unlinkDoc } from './service.ts';
import { periodShort } from './values.ts';
import { RECON_SOURCE_LABELS } from '../../../shared/types/gstrecon.ts';

const source = v.enum(RECON_SOURCES);
const period = v.string({ min: 1, max: 12 });
const ids = v.array(v.id(), { max: 10_000 });
const remarks = v.string({ max: 500 }).optional();

export const ToleranceInput = v
  .object({
    amountPaise: v.int({ min: 0, max: 1_00_00_000 }).optional(),
    dateDays: v.int({ min: 0, max: 366 }).optional(),
    fuzzyDocNo: v.boolean().optional(),
  })
  .optional();

export const ImportInput = v.object({
  source,
  period: v.string({ max: 12 }).optional(),
  fileName: v.string({ min: 1, max: 260 }),
  bytes: v.bytes({ max: 60 * 1024 * 1024 }),
  replace: v.boolean().optional(),
});

export const PeriodSourceInput = v.object({ period, source });

export const ResultsInput = v.object({
  period,
  source,
  status: v.enum(RECON_STATUS_FILTERS).optional(),
  supplierGstin: v.string({ max: 20 }).optional(),
  search: v.string({ max: 200 }).optional(),
  limit: v.int({ min: 1, max: 10_000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
});

export const DecisionInput = v
  .object({
    portalDocIds: ids.optional(),
    voucherIds: ids.optional(),
    period: v.string({ max: 12 }).optional(),
    source: source.optional(),
    remarks,
  })
  .refine((x) => ((x.portalDocIds?.length ?? 0) + (x.voucherIds?.length ?? 0) === 0 ? 'Choose at least one row' : null));

export const UnlinkInput = v
  .object({
    portalDocId: v.id().optional(),
    voucherId: v.id().optional(),
    period: v.string({ max: 12 }).optional(),
    source: source.optional(),
  })
  .refine((x) => (x.portalDocId === undefined && x.voucherId === undefined ? 'Choose a portal document or a voucher' : null));

export const SuggestionsInput = v
  .object({
    portalDocId: v.id().optional(),
    voucherId: v.id().optional(),
    period: v.string({ max: 12 }).optional(),
    source: source.optional(),
  })
  .refine((x) => (x.portalDocId === undefined && x.voucherId === undefined ? 'Choose a portal document or a voucher' : null));

/** Audit an export (read-only routes run outside a transaction, so open one for the audit row). */
function auditExport(ctx: CompanyCtx, what: string, src: ReconSource, p: string): void {
  ctx.db.transaction(() => ctx.audit({ action: 'export', entityType: 'gst_reconciliation', entityLabel: `${RECON_SOURCE_LABELS[src]} ${periodShort(p)}: ${what}` }));
}

export const gstreconRoutes = {
  'gstrecon.import': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: ImportInput,
    handler: (ctx, input) => importPortalFile(ctx, input),
  }),
  'gstrecon.batches': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ period: v.string({ max: 12 }).optional(), source: source.optional() }),
    handler: (ctx, input) => listBatches(ctx.db, input),
  }),
  'gstrecon.batch.delete': companyRoute({
    access: 'gst.file',
    input: v.object({ id: v.id() }),
    handler: (ctx, { id }) => deleteBatch(ctx, id),
  }),
  'gstrecon.run': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: v.object({ period, source, tolerance: ToleranceInput }),
    handler: (ctx, input) => runRecon(ctx, input),
  }),
  'gstrecon.gstr1.compare': companyRoute({
    access: 'gst.file',
    transactional: false,
    input: v.object({ period, tolerance: ToleranceInput }),
    handler: (ctx, input) => runRecon(ctx, { period: input.period, source: 'gstr1', tolerance: input.tolerance }),
  }),
  'gstrecon.runs': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: PeriodSourceInput,
    handler: (ctx, input) => runHistory(ctx.db, input.source, input.period),
  }),
  'gstrecon.summary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: PeriodSourceInput,
    handler: (ctx, input) => getSummary(ctx.db, input),
  }),
  'gstrecon.results': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: ResultsInput,
    handler: (ctx, input) => getResults(ctx.db, input),
  }),
  'gstrecon.supplierSummary': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: PeriodSourceInput,
    handler: (ctx, input) => getSupplierSummary(ctx.db, input),
  }),
  'gstrecon.suggestions': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: SuggestionsInput,
    handler: (ctx, input) => getSuggestions(ctx.db, ctx.clock.today(), input),
  }),
  'gstrecon.link': companyRoute({
    access: 'gst.file',
    input: v.object({ portalDocId: v.id(), voucherId: v.id() }),
    handler: (ctx, input) => linkDoc(ctx, input),
  }),
  'gstrecon.unlink': companyRoute({
    access: 'gst.file',
    input: UnlinkInput,
    handler: (ctx, input) => unlinkDoc(ctx, input),
  }),
  'gstrecon.accept': companyRoute({
    access: 'gst.file',
    input: DecisionInput,
    handler: (ctx, input) => resolveDocs(ctx, 'accept', input),
  }),
  'gstrecon.ignore': companyRoute({
    access: 'gst.file',
    input: DecisionInput,
    handler: (ctx, input) => resolveDocs(ctx, 'ignore', input),
  }),
  'gstrecon.export': companyRoute({
    access: 'gst.view', // plus 'data.export', checked below (read-only roles such as Auditor can export)
    transactional: false,
    input: v.object({ period, source, format: v.enum(['xlsx', 'csv'] as const) }),
    handler: (ctx, input) => {
      if (!ctx.session.isOwner && !ctx.session.permissions.has('data.export')) {
        throw forbidden('Exporting the reconciliation also needs the "Export data" permission. Ask an Owner to grant it.');
      }
      const out = exportReconFile(ctx.db, input);
      auditExport(ctx, out.fileName, input.source, input.period);
      return out;
    },
  }),
  'gstrecon.supplierFollowUp': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ period, supplierGstin: v.string({ min: 1, max: 20 }), source: source.optional() }),
    handler: (ctx, input) => {
      const out = buildSupplierFollowUp(ctx.db, input);
      auditExport(ctx, `follow-up for ${out.gstin}`, input.source ?? 'gstr2b', input.period);
      return out;
    },
  }),
} satisfies RouteMap;
