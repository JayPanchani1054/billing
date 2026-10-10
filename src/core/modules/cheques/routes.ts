/**
 * Cheques module routes (print group): payee bank details, cheque books and leaves, the cheque register,
 * cheque layouts and bank print settings, cheque printing and bulk e-payment files. DTOs:
 * shared/types/cheques.ts. Cheque books, register, layouts and printing need F11 › Cheque printing;
 * payee details and e-payments do not. Reads are `transactional: false`; every write is audited.
 */
import {
  CHEQUE_LEAF_STATUSES,
  PAYEE_ACCOUNT_TYPES,
  PAYEE_PAYMENT_MODES,
  type ChequeLayoutSpec,
} from '../../../shared/types/cheques.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { patchNullable } from '../../lib/schemas.ts';
import { v } from '../../lib/validate.ts';
import { cancelLeaf, deleteBook, listBooks, listChequeBanks, nextLeaf, restoreLeaf, saveBook } from './books.ts';
import { assertChequePrinting, can } from './common.ts';
import { exportEPayments, listEPayments } from './epayment.ts';
import { CHEQUE_PRESETS, deleteLayout, getBankSettings, listLayouts, saveBankSettings, saveLayout } from './layouts.ts';
import { getPayee, listPayees, savePayee } from './payees.ts';
import { CHEQUE_PRINT_MAX, chequePrintData, recordChequePrints } from './printData.ts';
import { chequeRegister } from './register.ts';
import { forbidden } from '../../lib/errors.ts';

const optText = (max: number) => patchNullable(v.string({ max }));

const point = v.object({ x: v.number({ min: -1000, max: 1000 }), y: v.number({ min: -1000, max: 1000 }), w: v.number({ min: 0, max: 1000 }).optional() });

const LayoutSpecSchema = v.object({
  widthMm: v.number({ min: 0, max: 1000 }),
  heightMm: v.number({ min: 0, max: 1000 }),
  fontPt: v.number({ min: 0, max: 100 }),
  date: v.object({ x: v.number({ min: -1000, max: 1000 }), y: v.number({ min: -1000, max: 1000 }), w: v.number({ min: 0, max: 1000 }).optional(), pitch: v.number({ min: 0, max: 100 }) }),
  payee: point,
  words: point,
  words2: point,
  figures: point,
  acPayee: point,
  signatory: point,
  offsetX: v.number({ min: -1000, max: 1000 }),
  offsetY: v.number({ min: -1000, max: 1000 }),
  placement: v.enum(['leaf', 'a4_left', 'a4_center'] as const),
  figuresPaise: v.boolean(),
});

const chequeNo = v.string({ min: 1, max: 12, pattern: /^\d+$/, patternMessage: 'Enter the cheque number (digits only)' });

export const chequesRoutes = {
  // ── Payee bank details (any party / expense ledger) ──
  'cheques.payee.get': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({ ledgerId: v.id() }),
    handler: (ctx, input) => getPayee(ctx.db, input.ledgerId),
  }),
  'cheques.payee.save': companyRoute({
    access: 'masters.alter',
    input: v.object({
      ledgerId: v.id(),
      beneficiaryName: optText(100),
      accountNo: optText(40),
      ifsc: optText(20),
      bankName: optText(100),
      branch: optText(100),
      accountType: patchNullable(v.enum(PAYEE_ACCOUNT_TYPES)),
      chequeName: optText(80),
      paymentMode: patchNullable(v.enum(PAYEE_PAYMENT_MODES)),
    }),
    handler: (ctx, input) => savePayee(ctx, input),
  }),
  'cheques.payee.list': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({
      search: v.string({ max: 100 }).optional(),
      withDetails: v.boolean().optional(),
      limit: v.int({ min: 1, max: 1000 }).optional(),
      offset: v.int({ min: 0 }).optional(),
    }),
    handler: (ctx, input) => listPayees(ctx.db, input),
  }),

  // ── Cheque books and leaves ──
  'cheques.banks': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.none(),
    handler: (ctx) => listChequeBanks(ctx.db),
  }),
  'cheques.book.list': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({ bankLedgerId: v.id().optional() }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return listBooks(ctx.db, input.bankLedgerId);
    },
  }),
  'cheques.book.save': companyRoute({
    access: 'masters.create',
    input: v.object({
      id: v.id().optional(),
      bankLedgerId: v.id(),
      name: v.string({ max: 100 }).optional(),
      fromNo: v.int({ min: 0, max: 999_999_999_999 }),
      toNo: v.int({ min: 0, max: 999_999_999_999 }),
      digits: v.int({ min: 1, max: 12 }).optional(),
      isActive: v.boolean().optional(),
    }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return saveBook(ctx, input);
    },
  }),
  'cheques.book.delete': companyRoute({
    access: 'masters.delete',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => deleteBook(ctx, input.id),
  }),
  'cheques.book.next': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ bankLedgerId: v.id(), voucherId: v.id().optional() }),
    handler: (ctx, input) => nextLeaf(ctx.db, input.bankLedgerId, { excludeVoucherId: input.voucherId ?? null }),
  }),
  'cheques.leaf.cancel': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ bankLedgerId: v.id(), chequeNo, reason: v.string({ min: 1, max: 300 }), date: v.date().optional() }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return cancelLeaf(ctx, input);
    },
  }),
  'cheques.leaf.restore': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ bankLedgerId: v.id(), chequeNo }),
    handler: (ctx, input) => restoreLeaf(ctx, input),
  }),
  'cheques.register': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: v.object({
      bankLedgerId: v.id(),
      bookId: v.id().optional(),
      status: v.enum([...CHEQUE_LEAF_STATUSES, 'all'] as const).optional(),
      asOf: v.date().optional(),
    }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return chequeRegister(ctx.db, ctx.clock.today(), input);
    },
  }),

  // ── Layouts and per-bank settings ──
  'cheques.layout.presets': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.none(),
    handler: () => CHEQUE_PRESETS,
  }),
  'cheques.layout.list': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.none(),
    handler: (ctx) => listLayouts(ctx.db),
  }),
  'cheques.layout.save': companyRoute({
    access: 'masters.alter',
    input: v.object({ id: v.id().optional(), name: v.string({ min: 1, max: 80 }), preset: patchNullable(v.string({ max: 40 })), spec: LayoutSpecSchema }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return saveLayout(ctx, { ...input, spec: input.spec as ChequeLayoutSpec });
    },
  }),
  'cheques.layout.delete': companyRoute({
    access: 'masters.alter',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => deleteLayout(ctx, input.id),
  }),
  'cheques.bank.get': companyRoute({
    access: 'masters.view',
    transactional: false,
    input: v.object({ bankLedgerId: v.id() }),
    handler: (ctx, input) => getBankSettings(ctx.db, input.bankLedgerId),
  }),
  'cheques.bank.save': companyRoute({
    access: 'masters.alter',
    input: v.object({ bankLedgerId: v.id(), layoutId: patchNullable(v.id()), acPayee: v.boolean().optional(), signatory: optText(100) }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return saveBankSettings(ctx, input);
    },
  }),

  // ── Printing ──
  'cheques.print.data': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ voucherIds: v.array(v.id(), { min: 1, max: CHEQUE_PRINT_MAX }), layoutId: v.id().nullable().optional() }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return chequePrintData(ctx, input.voucherIds, input.layoutId);
    },
  }),
  // Printing a cheque is an export of the books (data.export) and is in the edit log.
  'cheques.print.record': companyRoute({
    access: 'data.export',
    input: v.object({
      items: v.array(v.object({ voucherId: v.id(), lineNo: v.int({ min: 1 }) }), { min: 1, max: CHEQUE_PRINT_MAX }),
      layoutId: v.id().nullable().optional(),
    }),
    handler: (ctx, input) => {
      assertChequePrinting(ctx.db);
      return recordChequePrints(ctx, input);
    },
  }),

  // ── Bulk e-payment file ──
  'cheques.epayment.list': companyRoute({
    access: 'vouchers.view',
    transactional: false,
    input: v.object({ from: v.date(), to: v.date(), bankLedgerId: v.id().optional() }),
    handler: (ctx, input) => listEPayments(ctx.db, input),
  }),
  'cheques.epayment.export': companyRoute({
    access: 'data.export',
    input: v.object({ voucherIds: v.array(v.id(), { min: 1, max: 1000 }), valueDate: v.date().optional() }),
    handler: (ctx, input) => {
      if (!can(ctx, 'vouchers.view')) throw forbidden('You do not have permission to view vouchers.');
      return exportEPayments(ctx, input);
    },
  }),
} satisfies RouteMap;
