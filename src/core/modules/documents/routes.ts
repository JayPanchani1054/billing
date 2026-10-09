/**
 * Documents module routes (route table: README.md). Importing this file registers the module's
 * voucher hook (hook.ts) — src/core/api/routes.ts imports every module's routes.
 */
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import {
  BILLS_PENDING_KINDS,
  BUDGET_BASES,
  BUDGET_LINE_KINDS,
  DOCUMENT_BASE_TYPES,
  DOCUMENT_DECISIONS,
  DOCUMENT_STATUSES,
  RECURRING_FREQUENCIES,
} from '../../../shared/types/documents.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { billsPending } from './billsPending.ts';
import { budgetColumns, budgetVariance, deleteBudget, getBudget, listBudgets, saveBudget } from './budgets.ts';
import { fieldIssue } from './common.ts';
import './hook.ts';
import { orderClosures, precloseOrder, reopenOrder } from './orders.ts';
import { draftVoucher, listDocuments, setDocumentStatus, voucherLinks } from './quotations.ts';
import {
  deleteTemplate,
  dueOccurrences,
  getTemplate,
  listTemplates,
  occurrenceInput,
  postOccurrences,
  saveTemplate,
  setTemplateActive,
  skipOccurrence,
  suggestFromVoucher,
  unskipOccurrence,
} from './recurring.ts';
import { deleteScenario, getScenario, listScenarios, saveScenario } from './scenarios.ts';
import { documentsSummary } from './summary.ts';

const optText = (max: number) => v.string({ max }).optional();
const periodKey = v.string({ min: 7, max: 10, pattern: /^\d{4}-\d{2}(-\d{2})?$/, patternMessage: 'Period must be YYYY-MM or YYYY-MM-DD' });

const ScheduleShape = {
  frequency: v.enum(RECURRING_FREQUENCIES),
  intervalDays: v.int({ min: 1, max: 366 }).nullable().optional(),
  dayOfMonth: v.int({ min: 0, max: 31 }).nullable().optional(),
  startDate: v.date(),
  endDate: v.date().nullable().optional(),
};

export const documentsRoutes = {
  // ── Quotations / proforma ──
  'documents.quotation.list': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.strictObject({
      baseType: v.enum(DOCUMENT_BASE_TYPES),
      from: v.date(),
      to: v.date(),
      status: v.enum(DOCUMENT_STATUSES).optional(),
      partyLedgerId: v.id().optional(),
      search: optText(100),
      limit: v.int({ min: 1, max: 5000 }).optional(),
    }),
    handler: (ctx, input) => listDocuments(ctx, input),
  }),
  'documents.quotation.setStatus': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ id: v.id(), status: v.enum(DOCUMENT_DECISIONS), reason: optText(500) }),
    handler: (ctx, input) => setDocumentStatus(ctx, input),
  }),
  'documents.links': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ voucherId: v.id() }),
    handler: (ctx, input) => voucherLinks(ctx, input.voucherId),
  }),
  'documents.draft': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({
      sourceId: v.id().optional(),
      targetBaseType: v.enum(VOUCHER_BASE_TYPES).optional(),
      voucherTypeId: v.id().optional(),
      date: v.date().optional(),
      templateId: v.id().optional(),
      periodKey: periodKey.optional(),
    }),
    handler: (ctx, input) => {
      if (input.templateId !== undefined) {
        if (input.periodKey === undefined) throw fieldIssue('periodKey', 'Choose the occurrence (period) to post.');
        return occurrenceInput(ctx, input.templateId, input.periodKey, input.date !== undefined ? { date: input.date } : {});
      }
      if (input.sourceId === undefined) throw fieldIssue('sourceId', 'Choose the document to convert.');
      if (input.targetBaseType === undefined) throw fieldIssue('targetBaseType', 'Choose what to convert the document into.');
      return draftVoucher(ctx, { ...input, sourceId: input.sourceId, targetBaseType: input.targetBaseType });
    },
  }),

  // ── Recurring vouchers ──
  'documents.recurring.list': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({}),
    handler: (ctx) => listTemplates(ctx),
  }),
  'documents.recurring.get': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => getTemplate(ctx, input.id),
  }),
  'documents.recurring.fromVoucher': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ voucherId: v.id() }),
    handler: (ctx, input) => suggestFromVoucher(ctx, input.voucherId),
  }),
  'documents.recurring.save': companyRoute({
    access: 'vouchers.create',
    input: v.object({
      id: v.id().optional(),
      name: v.string({ min: 1, max: 100 }),
      sourceVoucherId: v.id().optional(),
      amount: v.paise({ min: 1 }).optional(),
      isActive: v.boolean().optional(),
      notes: optText(500),
      ...ScheduleShape,
    }),
    handler: (ctx, input) => saveTemplate(ctx, input),
  }),
  'documents.recurring.setActive': companyRoute({
    access: 'vouchers.create',
    input: v.object({ id: v.id(), active: v.boolean() }),
    handler: (ctx, input) => setTemplateActive(ctx, input.id, input.active),
  }),
  'documents.recurring.delete': companyRoute({
    access: 'vouchers.delete',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => deleteTemplate(ctx, input.id),
  }),
  'documents.recurring.due': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ asOf: v.date().optional() }),
    handler: (ctx, input) => dueOccurrences(ctx, input.asOf ?? ctx.clock.today()),
  }),
  'documents.recurring.post': companyRoute({
    access: 'vouchers.create',
    input: v.object({
      items: v.array(v.object({ templateId: v.id(), periodKey, date: v.date().optional(), amount: v.paise({ min: 1 }).optional() }), { min: 1, max: 500 }),
      acknowledgeWarnings: v.boolean().optional(),
    }),
    handler: (ctx, input) => postOccurrences(ctx, input),
  }),
  'documents.recurring.skip': companyRoute({
    access: 'vouchers.create',
    input: v.object({ templateId: v.id(), periodKey, reason: optText(500) }),
    handler: (ctx, input) => skipOccurrence(ctx, input.templateId, input.periodKey, input.reason),
  }),
  'documents.recurring.unskip': companyRoute({
    access: 'vouchers.create',
    input: v.object({ templateId: v.id(), periodKey }),
    handler: (ctx, input) => unskipOccurrence(ctx, input.templateId, input.periodKey),
  }),

  // ── Bills pending / orders ──
  'documents.billsPending': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.strictObject({ kind: v.enum(BILLS_PENDING_KINDS), asOf: v.date(), partyLedgerId: v.id().optional(), itemId: v.id().optional() }),
    handler: (ctx, input) => billsPending(ctx.db, input),
  }),
  'documents.order.preclose': companyRoute({
    access: 'vouchers.alter',
    input: v.object({
      orderId: v.id(),
      date: v.date().optional(),
      reason: v.string({ min: 1, max: 500 }),
      items: v.array(v.object({ itemId: v.id(), qty: v.number({ min: 0, max: 1e12 }).optional() }), { min: 1, max: 5000 }).optional(),
    }),
    handler: (ctx, input) => precloseOrder(ctx, input),
  }),
  'documents.order.reopen': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ orderId: v.id(), itemId: v.id().optional() }),
    handler: (ctx, input) => reopenOrder(ctx, input),
  }),
  'documents.order.closures': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ orderId: v.id() }),
    handler: (ctx, input) => orderClosures(ctx.db, input.orderId),
  }),

  // ── Scenarios ──
  'documents.scenario.list': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({}),
    handler: (ctx) => listScenarios(ctx.db),
  }),
  'documents.scenario.get': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => getScenario(ctx.db, input.id),
  }),
  'documents.scenario.save': companyRoute({
    access: 'masters.view',
    input: v.object({
      id: v.id().optional(),
      name: v.string({ min: 1, max: 100 }),
      includeActuals: v.boolean(),
      includeTypeIds: v.array(v.id(), { max: 200 }),
      excludeTypeIds: v.array(v.id(), { max: 200 }),
    }),
    handler: (ctx, input) => saveScenario(ctx, input),
  }),
  'documents.scenario.delete': companyRoute({
    access: 'masters.delete',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => deleteScenario(ctx, input.id),
  }),

  // ── Budgets ──
  'documents.budget.list': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({}),
    handler: (ctx) => listBudgets(ctx.db),
  }),
  'documents.budget.get': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => getBudget(ctx.db, input.id),
  }),
  'documents.budget.save': companyRoute({
    access: 'masters.view',
    input: v.object({
      id: v.id().optional(),
      name: v.string({ min: 1, max: 100 }),
      from: v.date(),
      to: v.date(),
      notes: optText(500),
      lines: v.array(v.object({ kind: v.enum(BUDGET_LINE_KINDS), refId: v.id(), basis: v.enum(BUDGET_BASES), amount: v.paise() }), { max: 5000 }),
    }),
    handler: (ctx, input) => saveBudget(ctx, input),
  }),
  'documents.budget.delete': companyRoute({
    access: 'masters.delete',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => deleteBudget(ctx, input.id),
  }),
  'documents.budget.variance': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: v.strictObject({ budgetId: v.id(), from: v.date().optional(), to: v.date().optional(), scenarioId: v.id().optional() }),
    handler: (ctx, input) => budgetVariance(ctx, input),
  }),
  'documents.budget.columns': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.strictObject({ budgetId: v.id(), from: v.date(), to: v.date() }),
    handler: (ctx, input) => budgetColumns(ctx, input),
  }),

  // ── Summary ──
  'documents.summary': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ asOf: v.date().optional() }),
    handler: (ctx, input) => documentsSummary(ctx, input.asOf ?? ctx.clock.today()),
  }),
} satisfies RouteMap;
