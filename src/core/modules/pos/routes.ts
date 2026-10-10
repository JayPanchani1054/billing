/**
 * POS routes ('pos.*'). Bills and returns themselves are saved through vouchers.save / vouchers.preview
 * (VoucherInput.posBill); these routes serve the counter: context, scan lookup, customers, held bills,
 * returns, exchange credit, settings, tender modes and the day-end summary / register.
 * Everything except `pos.context` needs F11 › POS invoicing (BUSINESS_RULE otherwise). Reads are
 * transactional: false. Existing permissions only; every write is audited.
 */
import type { PosHeldBillSaveInput, PosRegisterInput, PosSettingsInput, PosSummaryInput, PosTenderModeSaveInput } from '../../../shared/types/pos.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { notFound } from '../../lib/errors.ts';
import { v } from '../../lib/validate.ts';
import { discardHeldBill, holdBill, listHeldBills, recallHeldBill } from './held.ts';
import { createCustomer, findCustomers, loadPosItem, lookupItem } from './lookup.ts';
import { posRegister, posSummary } from './reports.ts';
import { openExchangeCredits, returnContext, voucherPos } from './returns.ts';
import {
  CustomerCreateSchema,
  CustomerFindSchema,
  ExchangeCreditsSchema,
  HeldSaveSchema,
  ItemGetSchema,
  ItemLookupSchema,
  PosSettingsSchema,
  RegisterSchema,
  ReturnContextSchema,
  SummarySchema,
  TenderModeSaveSchema,
} from './schemas.ts';
import { assertPosEnabled, deleteTenderMode, getPosSettings, listTenderModes, posContext, savePosSettings, saveTenderMode } from './store.ts';

const IdSchema = v.object({ id: v.id() });

export const posRoutes = {
  /** Everything the counter needs (works with the feature off: enabled false). */
  'pos.context': companyRoute({
    access: 'vouchers.view',
    input: v.object({}),
    transactional: false,
    handler: (ctx) => posContext(ctx),
  }),
  'pos.settings.get': companyRoute({
    access: 'vouchers.view',
    input: v.object({}),
    transactional: false,
    handler: (ctx) => {
      assertPosEnabled(ctx.db);
      return getPosSettings(ctx.db);
    },
  }),
  'pos.settings.save': companyRoute({
    access: 'company.manage',
    input: PosSettingsSchema,
    handler: (ctx, input) => savePosSettings(ctx, input as PosSettingsInput),
  }),
  'pos.tenderMode.list': companyRoute({
    access: 'vouchers.view',
    input: v.object({ activeOnly: v.boolean().optional() }),
    transactional: false,
    handler: (ctx, input) => {
      assertPosEnabled(ctx.db);
      return listTenderModes(ctx.db, { activeOnly: input.activeOnly === true });
    },
  }),
  'pos.tenderMode.save': companyRoute({
    access: 'company.manage',
    input: TenderModeSaveSchema,
    handler: (ctx, input) => saveTenderMode(ctx, input as PosTenderModeSaveInput),
  }),
  'pos.tenderMode.delete': companyRoute({
    access: 'company.manage',
    input: IdSchema,
    handler: (ctx, input) => deleteTenderMode(ctx, input.id),
  }),
  /** Scan-to-add: barcode / part no. / alias / exact name → the item with price, slabs, MRP, stock. */
  'pos.item.lookup': companyRoute({
    access: 'vouchers.view',
    input: ItemLookupSchema,
    transactional: false,
    handler: (ctx, input) => lookupItem(ctx.db, input, ctx.clock.today()),
  }),
  /** One item with its counter price, slabs, MRP and stock (recalling a held bill, picking by name). */
  'pos.item.get': companyRoute({
    access: 'vouchers.view',
    input: ItemGetSchema,
    transactional: false,
    handler: (ctx, input) => {
      assertPosEnabled(ctx.db);
      const item = loadPosItem(ctx.db, input.itemId, 'name', { date: input.date, today: ctx.clock.today(), priceLevelId: input.priceLevelId, godownId: input.godownId });
      if (!item) throw notFound('Stock item', input.itemId);
      return item;
    },
  }),
  'pos.customer.find': companyRoute({
    access: 'vouchers.view',
    input: CustomerFindSchema,
    transactional: false,
    handler: (ctx, input) => findCustomers(ctx.db, input.mobile),
  }),
  'pos.customer.create': companyRoute({
    access: 'masters.create',
    input: CustomerCreateSchema,
    handler: (ctx, input) => createCustomer(ctx, input),
  }),
  'pos.held.list': companyRoute({
    access: 'vouchers.view',
    input: v.object({}),
    transactional: false,
    handler: (ctx) => listHeldBills(ctx.db),
  }),
  'pos.held.save': companyRoute({
    access: 'vouchers.create',
    input: HeldSaveSchema,
    handler: (ctx, input) => holdBill(ctx, input as PosHeldBillSaveInput),
  }),
  'pos.held.recall': companyRoute({
    access: 'vouchers.create',
    input: IdSchema,
    handler: (ctx, input) => recallHeldBill(ctx, input.id),
  }),
  'pos.held.discard': companyRoute({
    access: 'vouchers.create',
    input: IdSchema,
    handler: (ctx, input) => discardHeldBill(ctx, input.id),
  }),
  /** A POS bill's lines with the quantity still returnable, its tenders and the return voucher type. */
  'pos.return.context': companyRoute({
    access: 'vouchers.view',
    input: ReturnContextSchema,
    transactional: false,
    handler: (ctx, input) => returnContext(ctx.db, ctx.clock.today(), input),
  }),
  /** Exchange credit issued by POS returns and not used yet (optionally of one customer). */
  'pos.exchange.open': companyRoute({
    access: 'vouchers.view',
    input: ExchangeCreditsSchema,
    transactional: false,
    handler: (ctx, input) => openExchangeCredits(ctx.db, ctx.clock.today(), { partyLedgerId: input.partyLedgerId }),
  }),
  /** The POS side of a saved voucher (tenders, change, return of) — null for other vouchers (voucher view panel). */
  'pos.voucher': companyRoute({
    access: 'vouchers.view',
    input: IdSchema,
    transactional: false,
    handler: (ctx, input) => voucherPos(ctx.db, input.id),
  }),
  /** Day-end POS summary: by tender, user and counter; returns, credit, exchange, cash. */
  'pos.summary': companyRoute({
    access: 'reports.view',
    input: SummarySchema,
    transactional: false,
    handler: (ctx, input) => posSummary(ctx.db, ctx.clock.today(), input as PosSummaryInput),
  }),
  'pos.register': companyRoute({
    access: 'reports.view',
    input: RegisterSchema,
    transactional: false,
    handler: (ctx, input) => posRegister(ctx.db, ctx.clock.today(), input as PosRegisterInput),
  }),
} satisfies RouteMap;
