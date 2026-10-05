/**
 * Inventory routes (see src/shared/types/inventory.ts for the route table and DTOs).
 *
 * Access: reads need masters.view; saves are routed with masters.view and the service then requires
 * masters.create (new) or masters.alter (existing); deletes need masters.delete; the valuation report
 * needs reports.view and runs outside a transaction (read-only, potentially heavy).
 */
import type { FieldIssue } from '../../../shared/api.ts';
import { TAXABILITIES } from '../../../shared/gst/index.ts';
import {
  COSTING_METHODS,
  MARKET_VALUATIONS,
  type CompoundUnitSaveInput,
  type SimpleUnitSaveInput,
  type StockItemSaveInput,
  type UnitSaveInput,
} from '../../../shared/types/inventory.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { notFound } from '../../lib/errors.ts';
import { customSchema, patchNullable } from '../../lib/schemas.ts';
import { v, type Schema } from '../../lib/validate.ts';
import { resolveItemGstProfile } from './gst.ts';
import { bulkCreateItems, deleteItem, getItem, itemPicker, listItems, saveItem } from './items.ts';
import {
  deleteGodown,
  deleteStockCategory,
  deleteStockGroup,
  getGodown,
  getStockCategory,
  getStockGroup,
  listGodowns,
  listStockCategories,
  listStockGroups,
  saveGodown,
  saveStockCategory,
  saveStockGroup,
} from './masters.ts';
import { deletePriceLevel, getPriceList, listPriceLevels, priceFor, savePriceLevel, savePriceList } from './prices.ts';
import { batchesFor, stockOnHand } from './stock.ts';
import { deleteUnit, getUnit, listUnits, saveUnit } from './units.ts';
import { computeStockValuation } from './valuation.ts';

// ───────────────────────────── Schemas ─────────────────────────────

const IdInput = v.object({ id: v.id() });

const listShape = {
  search: v.string({ max: 200 }).optional(),
  limit: v.int({ min: 1, max: 5000 }).optional(),
  offset: v.int({ min: 0 }).optional(),
};
const ListInput = v.object(listShape);
const TreeListInput = v.object({ ...listShape, parentId: patchNullable(v.id()) });

const text = (max: number) => patchNullable(v.string({ max }));

const SimpleUnitSchema = v.object({
  id: v.id().optional(),
  kind: v.literal('simple'),
  symbol: v.string({ min: 1, max: 30 }),
  formalName: text(100),
  uqc: text(10),
  decimalPlaces: v.int().optional(),
});
const CompoundUnitSchema = v.object({
  id: v.id().optional(),
  kind: v.literal('compound'),
  firstUnitId: v.id(),
  conversion: v.number(),
  secondUnitId: v.id(),
});

export const UnitSaveSchema: Schema<UnitSaveInput> = customSchema<UnitSaveInput>((value, path, issues: FieldIssue[]) => {
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
  if (kind === 'compound') return CompoundUnitSchema.check(value, path, issues) as CompoundUnitSaveInput | undefined;
  if (kind === 'simple' || kind === undefined) {
    const withKind = typeof value === 'object' && value !== null ? { ...(value as object), kind: 'simple' } : value;
    return SimpleUnitSchema.check(withKind, path, issues) as SimpleUnitSaveInput | undefined;
  }
  issues.push({ path: path ? `${path}.kind` : 'kind', message: "Unit kind must be 'simple' or 'compound'" });
  return undefined;
});

const gstShape = {
  gstApplicable: v.boolean().optional(),
  hsnSac: text(20),
  taxability: v.enum(TAXABILITIES).optional(),
  gstRate: patchNullable(v.number()),
  cessRate: patchNullable(v.number()),
  cessPerUnit: patchNullable(v.int()),
  gstApplicableFrom: v.date().optional(),
  allowNonStandardRate: v.boolean().optional(),
};

const StockGroupSaveSchema = v.object({
  id: v.id().optional(),
  name: v.string({ min: 1, max: 200 }),
  alias: text(200),
  parentId: patchNullable(v.id()),
  addQuantities: v.boolean().optional(),
  ...gstShape,
});

const StockCategorySaveSchema = v.object({
  id: v.id().optional(),
  name: v.string({ min: 1, max: 200 }),
  alias: text(200),
  parentId: patchNullable(v.id()),
});

const GodownSaveSchema = v.object({
  id: v.id().optional(),
  name: v.string({ min: 1, max: 200 }),
  alias: text(200),
  parentId: patchNullable(v.id()),
  address: text(1000),
  isThirdParty: v.boolean().optional(),
});

const OpeningSchema = v.object({
  godownId: v.id().optional(),
  batchName: v.string({ max: 100 }).optional(),
  mfgDate: v.date().optional(),
  expiryDate: v.date().optional(),
  qty: v.number(),
  rate: v.number().optional(),
  value: v.int().optional(),
});

const itemShape = {
  id: v.id().optional(),
  name: v.string({ max: 200 }).optional(),
  alias: text(200),
  partNo: text(100),
  barcode: text(100),
  description: text(2000),
  groupId: patchNullable(v.id()),
  categoryId: patchNullable(v.id()),
  unitId: v.id().optional(),
  altUnitId: patchNullable(v.id()),
  altConversion: patchNullable(v.number()),
  maintainBatches: v.boolean().optional(),
  trackMfgDate: v.boolean().optional(),
  useExpiry: v.boolean().optional(),
  costingMethod: v.enum(COSTING_METHODS).optional(),
  marketValuation: v.enum(MARKET_VALUATIONS).optional(),
  isService: v.boolean().optional(),
  rateInclusiveOfTax: v.boolean().optional(),
  mrp: patchNullable(v.int()),
  sellingPrice: patchNullable(v.int()),
  purchasePrice: patchNullable(v.int()),
  standardCost: patchNullable(v.int()),
  reorderLevel: patchNullable(v.number()),
  minOrderQty: patchNullable(v.number()),
  isActive: v.boolean().optional(),
  openings: v.array(OpeningSchema, { max: 10_000 }).optional(),
  ...gstShape,
};
export const StockItemSaveSchema = v.object(itemShape) as unknown as Schema<StockItemSaveInput>;

const StockItemListSchema = v.object({
  ...listShape,
  groupId: v.id().optional(),
  categoryId: v.id().optional(),
  includeSubgroups: v.boolean().optional(),
  withStock: v.boolean().optional(),
  asOf: v.date().optional(),
  activeOnly: v.boolean().optional(),
});

const BulkCreateSchema = v.object({
  groupId: patchNullable(v.id()),
  rows: v.array(StockItemSaveSchema, { min: 1, max: 1000 }),
});

const PickerSchema = v.object({
  asOf: v.date().optional(),
  godownId: v.id().optional(),
  priceLevelId: v.id().optional(),
});

const PriceForSchema = v.object({
  itemId: v.id(),
  priceLevelId: v.id().optional(),
  date: v.date(),
  qty: v.number({ min: 0 }),
  side: v.enum(['sales', 'purchase'] as const).optional(),
});

const PriceLevelSaveSchema = v.object({ id: v.id().optional(), name: v.string({ min: 1, max: 100 }) });

const PriceListGetSchema = v.object({
  priceLevelId: v.id(),
  date: v.date(),
  search: v.string({ max: 200 }).optional(),
  groupId: v.id().optional(),
  includeAllItems: v.boolean().optional(),
});

const PriceListSaveSchema = v.object({
  priceLevelId: v.id(),
  applicableFrom: v.date(),
  rows: v.array(
    v.object({
      itemId: v.id(),
      qtyFrom: v.number({ min: 0 }),
      qtyTo: patchNullable(v.number()),
      rate: v.number({ min: 0 }),
      discountPct: v.number({ min: 0, max: 100 }).optional(),
    }),
    { max: 50_000 },
  ),
  clearItemIds: v.array(v.id(), { max: 50_000 }).optional(),
});

const StockOnHandSchema = v.object({
  itemId: v.id(),
  godownId: v.id().optional(),
  batchName: v.string({ min: 1, max: 100 }).optional(),
  asOf: v.date(),
});

const BatchesSchema = v.object({ itemId: v.id(), godownId: v.id().optional(), asOf: v.date() });

const ValuationSchema = v
  .object({
    from: v.date(),
    to: v.date(),
    itemIds: v.array(v.id(), { max: 100_000 }).optional(),
    godownId: v.id().optional(),
  })
  .refine((x) => (x.to < x.from ? 'The period end date is before its start date' : null));

const GstProfileSchema = v.object({ itemId: v.id(), date: v.date() });

const assertItem = (db: import('../../db/db.ts').Db, id: number): void => {
  if (db.value('SELECT 1 FROM stock_items WHERE id = :id', { id }) === undefined) throw notFound('Stock item', id);
};

// ───────────────────────────── Routes ─────────────────────────────

export const inventoryRoutes = {
  // Units
  'inventory.unit.list': companyRoute({
    access: 'masters.view',
    input: v.object({ ...listShape, kind: v.enum(['simple', 'compound'] as const).optional() }),
    handler: (ctx, input) => listUnits(ctx.db, input),
  }),
  'inventory.unit.get': companyRoute({ access: 'masters.view', input: IdInput, handler: (ctx, { id }) => getUnit(ctx.db, id) }),
  'inventory.unit.save': companyRoute({ access: 'masters.view', input: UnitSaveSchema, handler: (ctx, input) => saveUnit(ctx, input) }),
  'inventory.unit.delete': companyRoute({ access: 'masters.delete', input: IdInput, handler: (ctx, { id }) => deleteUnit(ctx, id) }),

  // Stock groups
  'inventory.group.list': companyRoute({ access: 'masters.view', input: TreeListInput, handler: (ctx, input) => listStockGroups(ctx.db, input) }),
  'inventory.group.get': companyRoute({ access: 'masters.view', input: IdInput, handler: (ctx, { id }) => getStockGroup(ctx.db, id) }),
  'inventory.group.save': companyRoute({
    access: 'masters.view',
    input: StockGroupSaveSchema,
    handler: (ctx, input) => saveStockGroup(ctx, input),
  }),
  'inventory.group.delete': companyRoute({ access: 'masters.delete', input: IdInput, handler: (ctx, { id }) => deleteStockGroup(ctx, id) }),

  // Stock categories
  'inventory.category.list': companyRoute({
    access: 'masters.view',
    input: TreeListInput,
    handler: (ctx, input) => listStockCategories(ctx.db, input),
  }),
  'inventory.category.get': companyRoute({ access: 'masters.view', input: IdInput, handler: (ctx, { id }) => getStockCategory(ctx.db, id) }),
  'inventory.category.save': companyRoute({
    access: 'masters.view',
    input: StockCategorySaveSchema,
    handler: (ctx, input) => saveStockCategory(ctx, input),
  }),
  'inventory.category.delete': companyRoute({
    access: 'masters.delete',
    input: IdInput,
    handler: (ctx, { id }) => deleteStockCategory(ctx, id),
  }),

  // Godowns
  'inventory.godown.list': companyRoute({ access: 'masters.view', input: TreeListInput, handler: (ctx, input) => listGodowns(ctx.db, input) }),
  'inventory.godown.get': companyRoute({ access: 'masters.view', input: IdInput, handler: (ctx, { id }) => getGodown(ctx.db, id) }),
  'inventory.godown.save': companyRoute({ access: 'masters.view', input: GodownSaveSchema, handler: (ctx, input) => saveGodown(ctx, input) }),
  'inventory.godown.delete': companyRoute({ access: 'masters.delete', input: IdInput, handler: (ctx, { id }) => deleteGodown(ctx, id) }),

  // Stock items
  'inventory.item.list': companyRoute({
    access: 'masters.view',
    input: StockItemListSchema,
    handler: (ctx, input) => listItems(ctx.db, input, ctx.clock.today()),
  }),
  'inventory.item.get': companyRoute({
    access: 'masters.view',
    input: IdInput,
    handler: (ctx, { id }) => getItem(ctx.db, id, ctx.clock.today()),
  }),
  'inventory.item.save': companyRoute({ access: 'masters.view', input: StockItemSaveSchema, handler: (ctx, input) => saveItem(ctx, input) }),
  'inventory.item.delete': companyRoute({ access: 'masters.delete', input: IdInput, handler: (ctx, { id }) => deleteItem(ctx, id) }),
  'inventory.item.bulkCreate': companyRoute({
    access: 'masters.create',
    input: BulkCreateSchema,
    handler: (ctx, input) => bulkCreateItems(ctx, input),
  }),
  'inventory.item.picker': companyRoute({
    access: 'masters.view',
    input: PickerSchema,
    transactional: false,
    handler: (ctx, input) => itemPicker(ctx.db, input, ctx.clock.today()),
  }),
  'inventory.item.priceFor': companyRoute({ access: 'masters.view', input: PriceForSchema, handler: (ctx, input) => priceFor(ctx.db, input) }),
  'inventory.item.gstProfile': companyRoute({
    access: 'masters.view',
    input: GstProfileSchema,
    handler: (ctx, { itemId, date }) => {
      assertItem(ctx.db, itemId);
      return resolveItemGstProfile(ctx.db, itemId, date);
    },
  }),

  // Price levels & lists
  'inventory.priceLevel.list': companyRoute({ access: 'masters.view', input: ListInput, handler: (ctx, input) => listPriceLevels(ctx.db, input) }),
  'inventory.priceLevel.save': companyRoute({
    access: 'masters.view',
    input: PriceLevelSaveSchema,
    handler: (ctx, input) => savePriceLevel(ctx, input),
  }),
  'inventory.priceLevel.delete': companyRoute({ access: 'masters.delete', input: IdInput, handler: (ctx, { id }) => deletePriceLevel(ctx, id) }),
  'inventory.priceList.get': companyRoute({ access: 'masters.view', input: PriceListGetSchema, handler: (ctx, input) => getPriceList(ctx.db, input) }),
  'inventory.priceList.save': companyRoute({
    access: 'masters.view',
    input: PriceListSaveSchema,
    handler: (ctx, input) => savePriceList(ctx, input),
  }),

  // Stock engine
  'inventory.stockOnHand': companyRoute({
    access: 'masters.view',
    input: StockOnHandSchema,
    handler: (ctx, input) => {
      assertItem(ctx.db, input.itemId);
      const qty = stockOnHand(ctx.db, { ...input, today: ctx.clock.today() });
      return { itemId: input.itemId, godownId: input.godownId ?? null, batchName: input.batchName ?? null, asOf: input.asOf, qty };
    },
  }),
  'inventory.batches': companyRoute({
    access: 'masters.view',
    input: BatchesSchema,
    handler: (ctx, input) => {
      assertItem(ctx.db, input.itemId);
      return batchesFor(ctx.db, input.itemId, input.godownId, input.asOf, { today: ctx.clock.today() });
    },
  }),
  'inventory.valuation': companyRoute({
    access: 'reports.view',
    input: ValuationSchema,
    transactional: false,
    handler: (ctx, input) => computeStockValuation(ctx.db, { ...input, today: ctx.clock.today() }),
  }),
} satisfies RouteMap;
