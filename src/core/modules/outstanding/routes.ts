/**
 * Outstanding routes (Tally "Statements of Accounts › Outstandings"). All are read-only reports:
 * access 'reports.view', transactional: false. DTOs: src/shared/types/outstanding.ts; semantics:
 * README.md in this folder.
 */
import { OUTSTANDING_BILL_SORTS, OUTSTANDING_SIDES, AGEING_BASES, NON_BILL_WISE_MODES } from '../../../shared/types/outstanding.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { validation } from '../../lib/errors.ts';
import { v } from '../../lib/validate.ts';
import { bucketLimitsProblem } from './ageing.ts';
import { interestReport } from './interest.ts';
import { ledgerBills, statement } from './ledger.ts';
import { reminders } from './reminders.ts';
import { ageing, dueSoon, outstandingBills, partySummary } from './reports.ts';

const side = v.enum(OUTSTANDING_SIDES);
const nonBillWise = v.enum(NON_BILL_WISE_MODES).optional();
const buckets = v
  .array(v.int(), { max: 12 })
  .refine((b) => bucketLimitsProblem(b))
  .optional();
const search = v.string({ max: 200 }).optional();

/** from ≤ to, reported on the `to` field. */
function assertPeriod(input: { from: string; to: string }): void {
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The end date must be on or after the start date' }]);
}

export const BillsInput = v.object({
  side,
  asOf: v.date(),
  groupId: v.id().optional(),
  ledgerId: v.id().optional(),
  overdueOnly: v.boolean().optional(),
  minOverdueDays: v.int({ min: 0, max: 36_500 }).optional(),
  search,
  sort: v.enum(OUTSTANDING_BILL_SORTS).optional(),
  limit: v.int({ min: 1, max: 10_000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
  nonBillWise,
  includeOnAccount: v.boolean().optional(),
});

export const PartySummaryInput = v.object({
  side,
  asOf: v.date(),
  groupId: v.id().optional(),
  search,
  nonBillWise,
  includeZero: v.boolean().optional(),
});

export const LedgerBillsInput = v.object({
  ledgerId: v.id(),
  asOf: v.date(),
  includeSettled: v.boolean().optional(),
  nonBillWise,
});

export const AgeingInput = v.object({
  side,
  asOf: v.date(),
  buckets,
  basis: v.enum(AGEING_BASES).optional(),
  groupId: v.id().optional(),
  ledgerId: v.id().optional(),
  search,
  nonBillWise,
});

export const InterestInput = v.object({
  ledgerId: v.id().optional(),
  groupId: v.id().optional(),
  from: v.date(),
  to: v.date(),
  ratePercent: v.number({ min: 0.01, max: 100 }).optional(),
  basis: v.enum(AGEING_BASES).optional(),
  graceDays: v.int({ min: 0, max: 3650 }).optional(),
  method: v.enum(['simple_365'] as const).optional(),
});

export const StatementInput = v.object({
  ledgerId: v.id(),
  from: v.date(),
  to: v.date(),
  nonBillWise,
  buckets,
});

export const RemindersInput = v.object({
  asOf: v.date(),
  minOverdueDays: v.int({ min: 1, max: 36_500 }).optional(),
  side: v.enum(['receivable'] as const).optional(),
  groupId: v.id().optional(),
  ledgerId: v.id().optional(),
  nonBillWise,
});

export const DueSoonInput = v.object({
  side,
  asOf: v.date(),
  days: v.int({ min: 0, max: 366 }),
  groupId: v.id().optional(),
  limit: v.int({ min: 1, max: 1000 }).optional(),
  nonBillWise,
});

export const outstandingRoutes = {
  'outstanding.bills': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: BillsInput,
    handler: (ctx, input) => outstandingBills(ctx.db, ctx.clock.today(), input),
  }),
  'outstanding.partySummary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: PartySummaryInput,
    handler: (ctx, input) => partySummary(ctx.db, ctx.clock.today(), input),
  }),
  'outstanding.ledgerBills': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: LedgerBillsInput,
    handler: (ctx, input) => ledgerBills(ctx.db, ctx.clock.today(), input),
  }),
  'outstanding.ageing': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: AgeingInput,
    handler: (ctx, input) => ageing(ctx.db, ctx.clock.today(), input),
  }),
  'outstanding.interest': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: InterestInput,
    handler: (ctx, input) => {
      assertPeriod(input);
      return interestReport(ctx.db, ctx.clock.today(), input);
    },
  }),
  'outstanding.statement': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: StatementInput,
    handler: (ctx, input) => {
      assertPeriod(input);
      return statement(ctx.db, ctx.clock.today(), input);
    },
  }),
  'outstanding.reminders': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: RemindersInput,
    handler: (ctx, input) => reminders(ctx.db, ctx.clock.today(), input),
  }),
  'outstanding.dueSoon': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: DueSoonInput,
    handler: (ctx, input) => dueSoon(ctx.db, ctx.clock.today(), input),
  }),
} satisfies RouteMap;
