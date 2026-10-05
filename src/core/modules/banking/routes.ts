/**
 * Banking routes: BRS, bank dates, statement import, matching, vouchers from statement lines and registers.
 * DTOs: src/shared/types/banking.ts; semantics, worked example and scoring: README.md in this folder.
 *
 * Read-only reports use access 'reports.view' and transactional: false. Reconciliation changes need
 * 'banking.reconcile' (creating vouchers also 'vouchers.create', checked by the service). The statement
 * import parses outside the database transaction and writes in its own transaction.
 */
import {
  BANK_PRESET_IDS,
  BRS_SHOW,
  CHEQUE_STATUS_FILTERS,
  FROM_LINE_KINDS,
  STATEMENT_AMOUNT_SIGNS,
  STATEMENT_DATE_ORDERS,
  STATEMENT_DELIMITERS,
  STATEMENT_LINE_STATUSES,
} from '../../../shared/types/banking.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { validation } from '../../lib/errors.ts';
import { requiredNullable } from '../../lib/schemas.ts';
import { v } from '../../lib/validate.ts';
import { bankSummary, brs, setBankDates } from './brs.ts';
import { createFromLine, createFromLines } from './create.ts';
import { autoMatch, ignoreLine, matchLine, suggestions, unmatchLine } from './matching.ts';
import { STATEMENT_MAX_BYTES } from './parse.ts';
import { chequeRegister, depositSlip, postDatedCheques } from './registers.ts';
import { deleteBatch, importStatement, listPresets, previewStatement, statementBatches, statementLines } from './statements.ts';

const col = v.int({ min: 0, max: 16_383 });

export const ColumnMapSchema = v.object({
  date: col,
  valueDate: col.optional(),
  description: col.optional(),
  reference: col.optional(),
  debit: col.optional(),
  credit: col.optional(),
  amount: col.optional(),
  drCr: col.optional(),
  balance: col.optional(),
  balanceDrCr: col.optional(),
});

export const MappingSchema = v.object({
  preset: v.enum(BANK_PRESET_IDS),
  sheet: v.string({ max: 200, trim: false }).optional(),
  delimiter: v.enum(STATEMENT_DELIMITERS).optional(),
  headerRow: v.int({ min: 0, max: 1_000_000 }),
  columns: ColumnMapSchema,
  dateOrder: v.enum(STATEMENT_DATE_ORDERS).default('auto'),
  amountSign: v.enum(STATEMENT_AMOUNT_SIGNS).optional(),
});

const fileName = v.string({ min: 1, max: 260 });
const bytes = v.bytes({ max: STATEMENT_MAX_BYTES });

export const BrsInputSchema = v.object({
  ledgerId: v.id(),
  asOf: v.date(),
  show: v.enum(BRS_SHOW).optional(),
  from: v.date().optional(),
});

export const SetBankDatesSchema = v.object({
  entries: v.array(
    v.object({
      ledgerEntryId: v.id(),
      bankDate: requiredNullable(v.date(), 'Bank date is required (send null to clear it)'),
    }),
    { min: 1, max: 5000 },
  ),
});

export const StatementLinesSchema = v.object({
  ledgerId: v.id(),
  from: v.date(),
  to: v.date(),
  status: v.enum([...STATEMENT_LINE_STATUSES, 'all'] as const).optional(),
  batchId: v.id().optional(),
  search: v.string({ max: 100 }).optional(),
  limit: v.int({ min: 1, max: 10_000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
});

export const AutoMatchSchema = v.object({
  ledgerId: v.id(),
  batchId: v.id().optional(),
  dateWindowDays: v.int({ min: 0, max: 60 }).optional(),
  threshold: v.int({ min: 50, max: 100 }).optional(),
  apply: v.boolean().optional(),
});

export const CreateFromLineSchema = v.object({
  lineId: v.id(),
  kind: v.enum(FROM_LINE_KINDS),
  contraLedgerId: v.id(),
  narration: v.string({ max: 4000 }).optional(),
  voucherTypeId: v.id().optional(),
  acknowledgeWarnings: v.boolean().optional(),
});

export const ChequeRegisterSchema = v.object({
  ledgerId: v.id().optional(),
  from: v.date(),
  to: v.date(),
  status: v.enum(CHEQUE_STATUS_FILTERS).optional(),
  direction: v.enum(['issued', 'received', 'all'] as const).optional(),
});

function assertPeriod(input: { from: string; to: string }): void {
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The end date must be on or after the start date' }]);
}

export const bankingRoutes = {
  'banking.brs': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: BrsInputSchema,
    handler: (ctx, input) => brs(ctx.db, ctx.clock.today(), input),
  }),
  'banking.setBankDates': companyRoute({
    access: 'banking.reconcile',
    input: SetBankDatesSchema,
    handler: (ctx, input) => setBankDates(ctx, input),
  }),
  'banking.summary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ asOf: v.date() }),
    handler: (ctx, input) => bankSummary(ctx.db, ctx.clock.today(), input.asOf),
  }),

  'banking.statement.presets': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.none(),
    handler: () => listPresets(),
  }),
  'banking.statement.preview': companyRoute({
    access: 'banking.reconcile',
    transactional: false,
    input: v.object({ ledgerId: v.id(), fileName, bytes, mapping: MappingSchema.optional() }),
    handler: (ctx, input) => previewStatement(ctx.db, input),
  }),
  'banking.statement.import': companyRoute({
    access: 'banking.reconcile',
    transactional: false,
    input: v.object({ ledgerId: v.id(), fileName, bytes, mapping: MappingSchema }),
    handler: (ctx, input) => importStatement(ctx, input),
  }),
  'banking.statement.lines': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: StatementLinesSchema,
    handler: (ctx, input) => {
      assertPeriod(input);
      return statementLines(ctx.db, input);
    },
  }),
  'banking.statement.batches': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ ledgerId: v.id().optional() }),
    handler: (ctx, input) => statementBatches(ctx.db, input.ledgerId),
  }),
  'banking.statement.deleteBatch': companyRoute({
    access: 'banking.reconcile',
    input: v.object({ batchId: v.id(), unmatch: v.boolean().optional() }),
    handler: (ctx, input) => deleteBatch(ctx, input.batchId, input.unmatch === true),
  }),

  'banking.autoMatch': companyRoute({
    access: 'banking.reconcile',
    input: AutoMatchSchema,
    handler: (ctx, input) => autoMatch(ctx, input),
  }),
  'banking.suggestions': companyRoute({
    access: 'banking.reconcile',
    transactional: false,
    input: v.object({ lineId: v.id(), dateWindowDays: v.int({ min: 0, max: 92 }).optional() }),
    handler: (ctx, input) => suggestions(ctx.db, ctx.clock.today(), input.lineId, input.dateWindowDays),
  }),
  'banking.match': companyRoute({
    access: 'banking.reconcile',
    input: v.object({ lineId: v.id(), ledgerEntryId: v.id() }),
    handler: (ctx, input) => matchLine(ctx, input.lineId, input.ledgerEntryId),
  }),
  'banking.unmatch': companyRoute({
    access: 'banking.reconcile',
    input: v.object({ lineId: v.id() }),
    handler: (ctx, input) => unmatchLine(ctx, input.lineId),
  }),
  'banking.ignoreLine': companyRoute({
    access: 'banking.reconcile',
    input: v.object({ lineId: v.id(), ignore: v.boolean() }),
    handler: (ctx, input) => ignoreLine(ctx, input.lineId, input.ignore),
  }),
  'banking.createVoucher': companyRoute({
    access: 'banking.reconcile',
    input: CreateFromLineSchema,
    handler: (ctx, input) => createFromLine(ctx, input),
  }),
  'banking.createVouchers': companyRoute({
    access: 'banking.reconcile',
    input: v.object({ items: v.array(CreateFromLineSchema, { min: 1, max: 500 }), acknowledgeWarnings: v.boolean().optional() }),
    handler: (ctx, input) => createFromLines(ctx, input.items, input.acknowledgeWarnings),
  }),

  'banking.chequeRegister': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: ChequeRegisterSchema,
    handler: (ctx, input) => chequeRegister(ctx.db, ctx.clock.today(), input),
  }),
  'banking.pdc': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ asOf: v.date(), ledgerId: v.id().optional(), includeMatured: v.boolean().optional() }),
    handler: (ctx, input) => postDatedCheques(ctx.db, input),
  }),
  'banking.depositSlip': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({ ledgerId: v.id(), date: v.date() }),
    handler: (ctx, input) => depositSlip(ctx.db, input),
  }),
} satisfies RouteMap;
