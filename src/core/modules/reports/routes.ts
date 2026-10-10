/**
 * Reports routes ("Display" reports). All are read-only: transactional: false. Access is
 * reports.view, or reports.financial for the Balance Sheet, P&L (and its monthly trend), ratios, cash flow
 * and funds flow.
 * DTOs: src/shared/types/reports.ts · semantics and formulas: README.md in this folder.
 */
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import { COMPARE_WITH, GROUP_SUMMARY_BASES, STATEMENT_MODES, TRIAL_BALANCE_MODES } from '../../../shared/types/reports.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { costCentreReport } from './costCentres.ts';
import { assertPeriod, loadReportEnv, type ReportEnv } from './engine.ts';
import { balanceSheet, profitLoss, profitTrend } from './financials.ts';
import { cashFlow, fundsFlow } from './flows.ts';
import { groupVouchers, ledgerReport, monthlySummary } from './ledger.ts';
import { ratiosReport } from './ratios.ts';
import { exceptions, register, statistics } from './registers.ts';
import { cashBank, groupSummary, trialBalance } from './trialBalance.ts';

const period = { from: v.date(), to: v.date() };
const limit = v.int({ min: 1, max: 100_000 }).optional();

export const PeriodSchema = v.object(period);
/** Scenario (documents module): include provisional / exclude voucher types — reports/scenario.ts. */
const scenarioId = v.id().optional();
export const TrialBalanceSchema = v.object({
  ...period,
  mode: v.enum(TRIAL_BALANCE_MODES).optional(),
  showOpening: v.boolean().optional(),
  showZero: v.boolean().optional(),
  scenarioId,
});
export const ProfitLossSchema = v.object({ ...period, mode: v.enum(STATEMENT_MODES).optional(), compareWith: v.enum(COMPARE_WITH).optional(), scenarioId });
/** Monthly P&L figures for the P&L graph (2.1): the P&L's period and scenario. */
export const ProfitTrendSchema = v.object({ ...period, scenarioId });
export const BalanceSheetSchema = v.object({ asOf: v.date(), mode: v.enum(STATEMENT_MODES).optional(), compareAsOf: v.date().optional(), scenarioId });
export const GroupSummarySchema = v.object({ ...period, groupId: v.id(), showZero: v.boolean().optional(), basis: v.enum(GROUP_SUMMARY_BASES).optional(), scenarioId });
export const GroupVouchersSchema = v.object({ ...period, groupId: v.id(), limit });
export const LedgerReportSchema = v.object({ ...period, ledgerId: v.id(), limit });
export const MonthlySummarySchema = v.object({ ...period, ledgerId: v.id().optional(), groupId: v.id().optional() });
export const RegisterSchema = v.object({
  ...period,
  baseType: v.enum(VOUCHER_BASE_TYPES).optional(),
  voucherTypeId: v.id().optional(),
  includeVouchers: v.boolean().optional(),
  limit,
});
export const ExceptionsSchema = v.object({ ...period, includeNoNarration: v.boolean().optional(), limit });
export const CostCentresSchema = v.object({ ...period, categoryId: v.id().optional(), costCentreId: v.id().optional() });

/** Report environment for a request (period checked first so a reversed range fails fast). */
function env(ctx: CompanyCtx, p?: { from: string; to: string }, scenarioId?: number): ReportEnv {
  if (p) assertPeriod(p.from, p.to);
  return loadReportEnv(ctx.db, ctx.clock.today(), scenarioId !== undefined ? { scenarioId } : {});
}

export const reportsRoutes = {
  'reports.trialBalance': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: TrialBalanceSchema,
    handler: (ctx, input) => trialBalance(env(ctx, input, input.scenarioId), input),
  }),
  'reports.profitLoss': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: ProfitLossSchema,
    handler: (ctx, input) => profitLoss(env(ctx, input, input.scenarioId), input),
  }),
  'reports.profitTrend': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: ProfitTrendSchema,
    handler: (ctx, input) => profitTrend(env(ctx, input, input.scenarioId), input),
  }),
  'reports.balanceSheet': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: BalanceSheetSchema,
    handler: (ctx, input) => balanceSheet(env(ctx, undefined, input.scenarioId), input),
  }),
  'reports.groupSummary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: GroupSummarySchema,
    handler: (ctx, input) => groupSummary(env(ctx, input, input.scenarioId), input),
  }),
  'reports.groupVouchers': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: GroupVouchersSchema,
    handler: (ctx, input) => groupVouchers(env(ctx, input), input),
  }),
  'reports.ledger': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: LedgerReportSchema,
    handler: (ctx, input) => ledgerReport(env(ctx, input), input),
  }),
  'reports.monthlySummary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: MonthlySummarySchema,
    handler: (ctx, input) => monthlySummary(env(ctx, input), input),
  }),
  'reports.cashBank': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: PeriodSchema,
    handler: (ctx, input) => cashBank(env(ctx, input), input),
  }),
  'reports.register': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: RegisterSchema,
    handler: (ctx, input) => register(env(ctx, input), input),
  }),
  'reports.cashFlow': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: PeriodSchema,
    handler: (ctx, input) => cashFlow(env(ctx, input), input),
  }),
  'reports.fundsFlow': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: PeriodSchema,
    handler: (ctx, input) => fundsFlow(env(ctx, input), input),
  }),
  'reports.ratios': companyRoute({
    access: 'reports.financial',
    transactional: false,
    input: PeriodSchema,
    handler: (ctx, input) => ratiosReport(env(ctx, input), input),
  }),
  'reports.exceptions': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: ExceptionsSchema,
    handler: (ctx, input) => exceptions(env(ctx, input), input),
  }),
  'reports.costCentres': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: CostCentresSchema,
    handler: (ctx, input) => costCentreReport(env(ctx, input), input),
  }),
  'reports.statistics': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: PeriodSchema,
    handler: (ctx, input) => statistics(env(ctx, input), input),
  }),
} satisfies RouteMap;
