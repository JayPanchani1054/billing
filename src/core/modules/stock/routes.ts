/**
 * Stock (inventory reports) routes. All are read-only reports (transactional: false) open to
 * reports.view — except Item Profitability, which shows margins and needs reports.financial like
 * the P&L. DTOs: src/shared/types/stock.ts · semantics: README.md in this folder.
 */
import { ORDER_KINDS } from '../../../shared/types/stock.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { stockAgeing } from './ageing.ts';
import { batchSummary, negativeStock } from './exceptions.ts';
import { itemVouchers } from './itemVouchers.ts';
import { stockMovement } from './movement.ts';
import { pendingOrders, reorderStatus } from './orders.ts';
import { physicalVariance, profitability } from './profitability.ts';
import { categorySummary, godownSummary, stockSummary } from './summary.ts';

const period = { from: v.date(), to: v.date() };

export const StockSummarySchema = v.object({
  ...period,
  groupId: v.id().optional(),
  categoryId: v.id().optional(),
  godownId: v.id().optional(),
  showValues: v.boolean().optional(),
  showZero: v.boolean().optional(),
});
export const CategorySummarySchema = v.object({ ...period, godownId: v.id().optional(), showValues: v.boolean().optional(), showZero: v.boolean().optional() });
export const ItemVouchersSchema = v.object({ ...period, itemId: v.id(), godownId: v.id().optional() });
export const GodownSummarySchema = v.object({ godownId: v.id().optional(), asOf: v.date(), showZero: v.boolean().optional() });
export const MovementSchema = v.object({ ...period, itemId: v.id().optional(), groupId: v.id().optional() });
export const AgeingSchema = v.object({
  asOf: v.date(),
  buckets: v.array(v.int({ min: 1, max: 36_500 }), { max: 12 }).optional(),
  groupId: v.id().optional(),
});
export const AsOfSchema = v.object({ asOf: v.date() });
export const BatchesSchema = v.object({ itemId: v.id().optional(), asOf: v.date(), expiringWithinDays: v.int({ min: 0, max: 36_500 }).optional() });
export const PendingOrdersSchema = v.object({ kind: v.enum(ORDER_KINDS), asOf: v.date() });
export const ProfitabilitySchema = v.object({ ...period, groupId: v.id().optional() });
export const PhysicalVarianceSchema = v.object(period);

const today = (ctx: CompanyCtx): string => ctx.clock.today();

export const stockRoutes = {
  'stock.summary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: StockSummarySchema,
    handler: (ctx, input) => stockSummary(ctx.db, today(ctx), input),
  }),
  'stock.categorySummary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: CategorySummarySchema,
    handler: (ctx, input) => categorySummary(ctx.db, today(ctx), input),
  }),
  'stock.itemVouchers': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: ItemVouchersSchema,
    handler: (ctx, input) => itemVouchers(ctx.db, today(ctx), input),
  }),
  'stock.godownSummary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: GodownSummarySchema,
    handler: (ctx, input) => godownSummary(ctx.db, today(ctx), input),
  }),
  'stock.movement': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: MovementSchema,
    handler: (ctx, input) => stockMovement(ctx.db, today(ctx), input),
  }),
  'stock.ageing': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: AgeingSchema,
    handler: (ctx, input) => stockAgeing(ctx.db, today(ctx), input),
  }),
  'stock.reorder': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: AsOfSchema,
    handler: (ctx, input) => reorderStatus(ctx.db, today(ctx), input),
  }),
  'stock.negative': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: AsOfSchema,
    handler: (ctx, input) => negativeStock(ctx.db, today(ctx), input),
  }),
  'stock.batches': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: BatchesSchema,
    handler: (ctx, input) => batchSummary(ctx.db, today(ctx), input),
  }),
  'stock.pendingOrders': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: PendingOrdersSchema,
    handler: (ctx, input) => pendingOrders(ctx.db, input),
  }),
  'stock.profitability': companyRoute({
    // Gross profit by item is financial information (the P&L's gross profit, item by item).
    access: 'reports.financial',
    transactional: false,
    input: ProfitabilitySchema,
    handler: (ctx, input) => profitability(ctx.db, today(ctx), input),
  }),
  'stock.physicalVariance': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: PhysicalVarianceSchema,
    handler: (ctx, input) => physicalVariance(ctx.db, today(ctx), input),
  }),
} satisfies RouteMap;
