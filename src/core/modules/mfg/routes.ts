/**
 * mfg module routes: Bill of Materials, Manufacturing Journal / Material In / Out support, Production
 * Register, Job Work Orders, pending job work (s.143) and ITC-04. The journals themselves are saved
 * through 'vouchers.save' / 'vouchers.preview' with a `stockJournal` block (hook.ts).
 */
import { itc04Periods } from '../../../shared/mfg/jobwork.ts';
import { STOCK_JOURNAL_CLASSES } from '../../../shared/types/mfg.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { bomCost, bomRevisions, deleteBom, getBom, listBoms, saveBom } from './bom.ts';
import { itc04, jobWorkAlerts, pendingJobWork } from './jobwork.ts';
import { classedTypes, duplicateJournal, getJournal, journalContext, productionRegister } from './journalQueries.ts';
import { deleteJobWorkOrder, getJobWorkOrder, listJobWorkOrders, nextJobWorkOrderNumber, saveJobWorkOrder } from './orders.ts';
import { BomSaveSchema, JobWorkOrderSaveSchema } from './schemas.ts';

const id = v.object({ id: v.id() });
const DIRECTION = v.enum(['out', 'in'] as const);

export const mfgRoutes = {
  // ── Bill of Materials ──
  'mfg.bom.list': companyRoute({
    access: 'masters.view',
    input: v.object({
      itemId: v.id().optional(),
      search: v.string({ max: 100 }).optional(),
      includeInactive: v.boolean().optional(),
      limit: v.int({ min: 1, max: 5000 }).optional(),
      offset: v.int({ min: 0 }).optional(),
    }),
    handler: (ctx, input) => listBoms(ctx.db, input),
  }),
  'mfg.bom.get': companyRoute({ access: 'masters.view', input: id, handler: (ctx, { id: bomId }) => getBom(ctx.db, bomId) }),
  'mfg.bom.revisions': companyRoute({ access: 'masters.view', input: id, handler: (ctx, { id: bomId }) => bomRevisions(ctx.db, bomId) }),
  // Open to masters.view; the service requires masters.create (new) or masters.alter (existing).
  'mfg.bom.save': companyRoute({ access: 'masters.view', input: BomSaveSchema, handler: (ctx, input) => saveBom(ctx, input) }),
  'mfg.bom.delete': companyRoute({ access: 'masters.delete', input: id, handler: (ctx, { id: bomId }) => deleteBom(ctx, bomId) }),
  'mfg.bom.cost': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ id: v.id(), qty: v.number({ min: 0, max: 1e12 }).optional(), asOf: v.date() }),
    handler: (ctx, input) => bomCost(ctx.db, ctx.clock.today(), input),
  }),

  // ── Manufacturing Journal / Material In / Material Out ──
  'mfg.journal.types': companyRoute({
    access: 'vouchers.view',
    input: v.object({ includeInactive: v.boolean().optional() }),
    handler: (ctx, input) => classedTypes(ctx.db, input.includeInactive === true),
  }),
  'mfg.journal.context': companyRoute({
    access: 'vouchers.view',
    input: v.object({ voucherTypeId: v.id(), date: v.date() }),
    handler: (ctx, input) => journalContext(ctx, input),
  }),
  'mfg.journal.get': companyRoute({ access: 'vouchers.view', input: id, handler: (ctx, { id: voucherId }) => getJournal(ctx, voucherId) }),
  'mfg.journal.duplicate': companyRoute({ access: 'vouchers.view', input: id, handler: (ctx, { id: voucherId }) => duplicateJournal(ctx, voucherId) }),
  'mfg.production.register': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({
      from: v.date(),
      to: v.date(),
      itemId: v.id().optional(),
      bomId: v.id().optional(),
      class: v.enum(STOCK_JOURNAL_CLASSES).optional(),
    }),
    handler: (ctx, input) => productionRegister(ctx, input),
  }),

  // ── Job work orders ──
  'mfg.jobWorkOrder.list': companyRoute({
    access: 'vouchers.view',
    input: v.object({
      direction: DIRECTION.optional(),
      partyLedgerId: v.id().optional(),
      status: v.enum(['open', 'closed', 'all'] as const).optional(),
      search: v.string({ max: 100 }).optional(),
      limit: v.int({ min: 1, max: 2000 }).optional(),
      offset: v.int({ min: 0 }).optional(),
    }),
    handler: (ctx, input) => listJobWorkOrders(ctx.db, ctx.clock.today(), input),
  }),
  'mfg.jobWorkOrder.get': companyRoute({ access: 'vouchers.view', input: id, handler: (ctx, { id: orderId }) => getJobWorkOrder(ctx.db, orderId) }),
  'mfg.jobWorkOrder.nextNumber': companyRoute({
    access: 'vouchers.view',
    input: v.object({ direction: DIRECTION }),
    handler: (ctx, input) => nextJobWorkOrderNumber(ctx.db, input.direction),
  }),
  // Open to vouchers.view; the service requires vouchers.create (new) or vouchers.alter (existing).
  'mfg.jobWorkOrder.save': companyRoute({ access: 'vouchers.view', input: JobWorkOrderSaveSchema, handler: (ctx, input) => saveJobWorkOrder(ctx, input) }),
  'mfg.jobWorkOrder.delete': companyRoute({ access: 'vouchers.delete', input: id, handler: (ctx, { id: orderId }) => deleteJobWorkOrder(ctx, orderId) }),

  // ── Pending job work, s.143 alerts, ITC-04 ──
  'mfg.jobWork.pending': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({
      asOf: v.date(),
      direction: DIRECTION.optional(),
      partyLedgerId: v.id().optional(),
      warnDays: v.int({ min: 0, max: 365 }).optional(),
      onlyAlerts: v.boolean().optional(),
    }),
    handler: (ctx, input) => pendingJobWork(ctx.db, ctx.clock.today(), input),
  }),
  'mfg.jobWork.alerts': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ asOf: v.date().optional(), warnDays: v.int({ min: 0, max: 365 }).optional() }),
    handler: (ctx, input) => jobWorkAlerts(ctx.db, ctx.clock.today(), input.asOf ?? ctx.clock.today(), input.warnDays ?? 30),
  }),
  'mfg.itc04.periods': companyRoute({
    access: 'gst.view',
    input: v.object({ date: v.date(), aatoAbove5Cr: v.boolean().optional() }),
    handler: (_ctx, input) => itc04Periods(input.date, input.aatoAbove5Cr === true),
  }),
  'mfg.itc04.report': companyRoute({
    access: 'gst.view',
    transactional: false,
    input: v.object({ from: v.date(), to: v.date(), aatoAbove5Cr: v.boolean().optional() }),
    handler: (ctx, input) => itc04(ctx.db, ctx.clock.today(), input),
  }),
} satisfies RouteMap;
