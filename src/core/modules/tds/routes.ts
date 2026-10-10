/**
 * TDS / TCS routes ('tds.*'). Reports are read-only (transactional: false). Every route needs the TDS
 * or TCS feature (F11) — the kind a route works on must be turned on.
 */
import { TDS_FORMS } from '../../../shared/tds/rules.ts';
import type { Quarter } from '../../../shared/tds/rules.ts';
import { TDS_KINDS, type TdsKind } from '../../../shared/types/tds.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { rule } from '../../lib/errors.ts';
import { v } from '../../lib/validate.ts';
import { getFeatures } from '../company/service.ts';
import { loadVoucherRow, parseMeta } from '../vouchers/service.ts';
import { saveChallan, suggestChallan } from './challan.ts';
import {
  deleteNature,
  getLedgerDetails,
  getNature,
  listLedgerDetails,
  listNatures,
  saveLedgerDetails,
  saveNature,
  saveSettings,
  saveStatementStatus,
} from './masters.ts';
import { import26as, receivable } from './receivable.ts';
import { challanRegister, computation, exceptions, lineRows, outstanding, returnData, voucherTds } from './reports.ts';
import { challanCsv, deducteeCsv, returnFileName } from './returnCsv.ts';
import { LedgerTdsSaveSchema, NatureSaveSchema, PERIOD, SettingsSchema, VoucherTdsChallanSchema } from './schemas.ts';
import { ensureReceivableLedger, getTdsSettings } from './store.ts';

/** The feature of `kind` (or either, when no kind) must be on. */
export function assertTdsEnabled(ctx: CompanyCtx, kind?: TdsKind): void {
  const f = getFeatures(ctx.db);
  const on = kind === 'tds' ? f.tds : kind === 'tcs' ? f.tcs : f.tds || f.tcs;
  if (!on) {
    const what = kind === 'tcs' ? 'TCS' : kind === 'tds' ? 'TDS' : 'TDS or TCS';
    throw rule(`${what} is turned off for this company. Turn it on in F11 › Features › Taxation.`);
  }
}

const kindOpt = v.enum(TDS_KINDS).optional();
const range = { from: v.date(), to: v.date() };
const FormSchema = v.enum(TDS_FORMS);
const QuarterSchema = v.int({ min: 1, max: 4 });
const FySchema = v.int({ min: 2000, max: 2100 });

export const tdsRoutes = {
  // ───────────── Setup ─────────────
  'tds.settings.get': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.none(),
    handler: (ctx) => {
      assertTdsEnabled(ctx);
      return getTdsSettings(ctx.db);
    },
  }),
  'tds.settings.save': companyRoute({
    access: 'tds.manage',
    input: SettingsSchema,
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return saveSettings(ctx, input);
    },
  }),

  // ───────────── Natures ─────────────
  // Voucher entry offers natures (advance payments), so anyone who may view vouchers may list them.
  'tds.natures.list': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.strictObject({ kind: kindOpt, asOf: v.date().optional(), includeInactive: v.boolean().optional() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return listNatures(ctx.db, { kind: input.kind, asOf: input.asOf ?? ctx.clock.today(), includeInactive: input.includeInactive });
    },
  }),
  'tds.natures.get': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.object({ id: v.id(), asOf: v.date().optional() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return getNature(ctx.db, input.id, input.asOf ?? ctx.clock.today());
    },
  }),
  'tds.natures.save': companyRoute({
    access: 'tds.manage',
    input: NatureSaveSchema,
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return saveNature(ctx, input);
    },
  }),
  'tds.natures.delete': companyRoute({
    access: 'tds.manage',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return deleteNature(ctx, input.id);
    },
  }),

  // ───────────── Ledger TDS details ─────────────
  'tds.ledgers.list': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({
      role: v.enum(['party', 'expense', 'income', 'all'] as const).optional(),
      search: v.string({ max: 100 }).optional(),
      onlyConfigured: v.boolean().optional(),
    }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return listLedgerDetails(ctx.db, input);
    },
  }),
  'tds.ledgers.get': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.object({ ledgerId: v.id() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return getLedgerDetails(ctx.db, input.ledgerId);
    },
  }),
  'tds.ledgers.save': companyRoute({
    access: 'tds.manage',
    input: LedgerTdsSaveSchema,
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      return saveLedgerDetails(ctx, input);
    },
  }),
  'tds.receivableLedger.ensure': companyRoute({
    access: 'tds.manage',
    input: v.none(),
    handler: (ctx) => {
      assertTdsEnabled(ctx);
      return { ledgerId: ensureReceivableLedger(ctx) };
    },
  }),

  // ───────────── Reports ─────────────
  'tds.computation': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ ...range, kind: kindOpt }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return computation(ctx.db, { ...input, today: ctx.clock.today() });
    },
  }),
  'tds.lines': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({
      ...range,
      kind: kindOpt,
      partyLedgerId: v.id().optional(),
      natureId: v.id().optional(),
      section: v.string({ max: 20 }).optional(),
      period: PERIOD.optional(),
    }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return lineRows(ctx.db, { ...input, today: ctx.clock.today() });
    },
  }),
  // Voucher view panel: shown for any voucher, so it answers (empty) instead of refusing when TDS/TCS is off.
  'tds.voucher': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.strictObject({ voucherId: v.id() }),
    handler: (ctx, input) => {
      const f = getFeatures(ctx.db);
      if (!f.tds && !f.tcs) return { lines: [], challan: null };
      return voucherTds(ctx.db, { voucherId: input.voucherId, today: ctx.clock.today() });
    },
  }),
  'tds.outstanding': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ asOf: v.date(), kind: v.enum(TDS_KINDS), includeSettled: v.boolean().optional() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return outstanding(ctx.db, { ...input, today: ctx.clock.today() });
    },
  }),
  'tds.challans': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ ...range, kind: kindOpt }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return challanRegister(ctx.db, { ...input, today: ctx.clock.today() });
    },
  }),
  'tds.exceptions': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ ...range, kind: kindOpt }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      const today = ctx.clock.today();
      return exceptions(ctx.db, { ...input, asOf: today, today });
    },
  }),

  // ───────────── Challans ─────────────
  'tds.challan.suggest': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({
      kind: v.enum(TDS_KINDS),
      section: v.string({ min: 1, max: 20 }),
      period: PERIOD,
      depositDate: v.date(),
      excludeVoucherId: v.id().optional(),
    }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.kind);
      return suggestChallan(ctx, input);
    },
  }),
  'tds.challan.get': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.object({ voucherId: v.id() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx);
      const row = loadVoucherRow(ctx.db, input.voucherId);
      const meta = row ? parseMeta(row.meta) : null;
      const c = meta?.input?.tds?.challan;
      if (!row || !c) throw rule('This voucher is not a TDS/TCS challan.');
      const bank = meta?.input?.ledgers?.find((l) => l.amount < 0)?.ledgerId ?? null;
      return { voucherId: row.id, number: row.number, date: row.date, bankLedgerId: bank, narration: row.narration, challan: c, updatedAt: row.updated_at, cancelled: row.is_cancelled === 1 };
    },
  }),
  'tds.challan.save': companyRoute({
    access: 'tds.view',
    input: v.object({
      voucherId: v.id().optional(),
      voucherTypeId: v.id().optional(),
      date: v.date(),
      bankLedgerId: v.id(),
      narration: v.string({ max: 4000 }).optional(),
      challan: VoucherTdsChallanSchema,
      acknowledgeWarnings: v.boolean().optional(),
      expectedUpdatedAt: v.string({ max: 40 }).optional(),
    }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.challan.kind);
      return saveChallan(ctx, input);
    },
  }),

  // ───────────── Quarterly statements ─────────────
  'tds.return.data': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ form: FormSchema, fyStart: FySchema, quarter: QuarterSchema }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.form === '27EQ' ? 'tcs' : 'tds');
      const today = ctx.clock.today();
      return returnData(ctx.db, { form: input.form, fyStart: input.fyStart, quarter: input.quarter as Quarter, today, asOf: today });
    },
  }),
  'tds.return.export': companyRoute({
    access: 'tds.file',
    transactional: false,
    input: v.strictObject({ form: FormSchema, fyStart: FySchema, quarter: QuarterSchema, part: v.enum(['deductees', 'challans'] as const) }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.form === '27EQ' ? 'tcs' : 'tds');
      const today = ctx.clock.today();
      const data = returnData(ctx.db, { form: input.form, fyStart: input.fyStart, quarter: input.quarter as Quarter, today, asOf: today });
      const fileName = returnFileName(data, input.part);
      const content = input.part === 'deductees' ? deducteeCsv(data) : challanCsv(data);
      ctx.db.transaction(() =>
        ctx.audit({
          action: 'export',
          entityType: 'tds_return',
          entityLabel: `Form ${input.form} Q${input.quarter} ${input.fyStart}-${String(input.fyStart + 1).slice(-2)} ${input.part} (${fileName})`,
        }),
      );
      return { fileName, content, rows: input.part === 'deductees' ? data.deductees.length : data.challans.length };
    },
  }),
  'tds.statement.save': companyRoute({
    access: 'tds.file',
    input: v.object({
      form: FormSchema,
      fyStart: FySchema,
      quarter: QuarterSchema,
      filedOn: v.date().nullable(),
      tokenNo: v.string({ max: 40 }).optional(),
      note: v.string({ max: 300 }).optional(),
    }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, input.form === '27EQ' ? 'tcs' : 'tds');
      return saveStatementStatus(ctx, { ...input, quarter: input.quarter as Quarter });
    },
  }),

  // ───────────── TDS receivable (26AS) ─────────────
  'tds.receivable': companyRoute({
    access: 'tds.view',
    transactional: false,
    input: v.strictObject({ fyStart: FySchema }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, 'tds');
      return receivable(ctx.db, { fyStart: input.fyStart, today: ctx.clock.today() });
    },
  }),
  'tds.26as.import': companyRoute({
    access: 'tds.manage',
    input: v.object({ fyStart: FySchema, content: v.string({ min: 1, max: 20_000_000, trim: false }), replace: v.boolean().optional() }),
    handler: (ctx, input) => {
      assertTdsEnabled(ctx, 'tds');
      return import26as(ctx, input);
    },
  }),
} satisfies RouteMap;
