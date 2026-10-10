/**
 * Stock items: list / get / save (create or alter) / delete / bulk create / picker.
 *
 * Save rules (all messages are shown to the user):
 *  - name and alias unique across all items' names and aliases; barcode unique;
 *  - base unit must exist; it cannot change once the item is used on vouchers;
 *  - alternate unit needs a conversion > 0 (base units per 1 alternate unit) and must differ from the base unit;
 *  - batches need the company's Batches feature (warning otherwise); mfg/expiry tracking needs batches;
 *  - GST: HSN (goods) / SAC (services) checked; rate must be a notified slab unless allowNonStandardRate;
 *    exempt / nil-rated / non-GST carry rate 0 and no cess; cess ≥ 0; dated changes go to gst_rate_history;
 *  - prices (mrp, selling, purchase, standard cost) are paise ≥ 0; standard cost is required for std_cost;
 *  - opening stock: godown required when Multiple Godowns is on (else Main Location), batch name required
 *    for batch items (and not allowed otherwise), qty > 0 within the unit's decimal places,
 *    value = qty × rate rounded to paise unless given; services cannot have opening stock.
 */
import { randomUUID } from 'node:crypto';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { MAX_LINE_PAISE } from '../../../shared/gst/index.ts';
import { lineAmount, roundTo } from '../../../shared/money.ts';
import type {
  CostingMethod,
  DeleteResult,
  ItemPickerInput,
  ItemPickerRow,
  ListResult,
  MarketValuation,
  StockItemBulkCreateInput,
  StockItemBulkCreateResult,
  StockItemDetail,
  StockItemListInput,
  StockItemListRow,
  StockItemSaveInput,
  StockItemSaveResult,
  StockOpeningInput,
  StockOpeningRow,
} from '../../../shared/types/inventory.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { aliasClashIssues, aliasListIssues, allAliases, extraAliasLike, extraAliasMap, extraAliases, normalizeAliases, writeExtraAliases } from '../../lib/masterAliases.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { itemMfgUses } from '../mfg/usage.ts';
import {
  assertNameFree,
  cleanText,
  countOf,
  jsonIds,
  likePattern,
  nowIso,
  paging,
  patch,
  requirePermission,
  requireSavePermission,
  subtreeIds,
  toBool,
} from './common.ts';
import {
  columnGstDetails,
  createGstResolver,
  deleteGstHistory,
  detailsFromColumns,
  listGstHistory,
  normalizeGstDetails,
  resolveItemGstProfile,
  syncGstHistory,
  type GstDetails,
} from './gst.ts';
import { booksFrom, mainGodownId } from './masters.ts';
import { getPriceLevel, itemPriceLists, priceLevelRatesForPicker } from './prices.ts';
import { itemHasTransactions, roundQty, stockByItem } from './stock.ts';

interface ItemRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  part_no: string | null;
  barcode: string | null;
  description: string | null;
  group_id: number | null;
  category_id: number | null;
  unit_id: number;
  alt_unit_id: number | null;
  alt_conversion: number | null;
  maintain_batches: number;
  track_mfg_date: number;
  use_expiry: number;
  costing_method: string;
  market_valuation: string;
  is_service: number;
  gst_applicable: string;
  hsn_sac: string | null;
  gst_taxability: string;
  gst_rate: number | null;
  cess_rate: number | null;
  cess_per_unit: number;
  rate_inclusive_of_tax: number;
  mrp: number | null;
  selling_price: number | null;
  purchase_price: number | null;
  standard_cost: number | null;
  reorder_level: number | null;
  min_order_qty: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  unit_symbol: string;
  unit_decimals: number;
  alt_unit_symbol: string | null;
  group_name: string | null;
  category_name: string | null;
}

const SELECT_ITEM = /* sql */ `
  SELECT i.*, u.symbol AS unit_symbol, u.decimal_places AS unit_decimals, au.symbol AS alt_unit_symbol,
         g.name AS group_name, c.name AS category_name
    FROM stock_items i
    JOIN units u ON u.id = i.unit_id
    LEFT JOIN units au ON au.id = i.alt_unit_id
    LEFT JOIN stock_groups g ON g.id = i.group_id
    LEFT JOIN stock_categories c ON c.id = i.category_id`;

const asCosting = (s: string): CostingMethod => (['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'].includes(s) ? (s as CostingMethod) : 'avg_cost');
const asMarket = (s: string): MarketValuation => (['avg_price', 'last_sale', 'std_price'].includes(s) ? (s as MarketValuation) : 'avg_price');

function openingRows(db: Db, itemId: number): StockOpeningRow[] {
  return db
    .all<{
      id: number;
      godown_id: number;
      godown_name: string;
      batch_name: string | null;
      mfg_date: string | null;
      expiry_date: string | null;
      qty: number;
      rate: number;
      value: number;
    }>(
      `SELECT o.id, o.godown_id, g.name AS godown_name, o.batch_name, o.mfg_date, o.expiry_date, o.qty, o.rate, o.value
         FROM stock_openings o JOIN godowns g ON g.id = o.godown_id WHERE o.item_id = :id ORDER BY o.id`,
      { id: itemId },
    )
    .map((o) => ({
      id: o.id,
      godownId: o.godown_id,
      godownName: o.godown_name,
      batchName: o.batch_name,
      mfgDate: o.mfg_date,
      expiryDate: o.expiry_date,
      qty: o.qty,
      rate: o.rate,
      value: Number(o.value),
    }));
}

/** Full item detail. `asOf` (normally the working date) drives effectiveGst and priceLists. */
export function getItem(db: Db, id: number, asOf: string): StockItemDetail {
  const r = db.get<ItemRow>(`${SELECT_ITEM} WHERE i.id = :id`, { id });
  if (!r) throw notFound('Stock item', id);
  const openings = openingRows(db, id);
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    aliases: allAliases(r.alias, extraAliases(db, 'stock_item', r.id)),
    partNo: r.part_no,
    barcode: r.barcode,
    description: r.description,
    groupId: r.group_id,
    groupName: r.group_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    unitId: r.unit_id,
    unitSymbol: r.unit_symbol,
    unitDecimals: r.unit_decimals,
    altUnitId: r.alt_unit_id,
    altUnitSymbol: r.alt_unit_symbol,
    altConversion: r.alt_conversion,
    maintainBatches: toBool(r.maintain_batches),
    trackMfgDate: toBool(r.track_mfg_date),
    useExpiry: toBool(r.use_expiry),
    costingMethod: asCosting(r.costing_method),
    marketValuation: asMarket(r.market_valuation),
    isService: toBool(r.is_service),
    gstApplicable: detailsFromColumns(r).applicable,
    hsnSac: r.hsn_sac,
    taxability: detailsFromColumns(r).taxability,
    gstRate: r.gst_rate,
    cessRate: r.cess_rate,
    cessPerUnit: Number(r.cess_per_unit ?? 0),
    rateInclusiveOfTax: toBool(r.rate_inclusive_of_tax),
    mrp: r.mrp,
    sellingPrice: r.selling_price,
    purchasePrice: r.purchase_price,
    standardCost: r.standard_cost,
    reorderLevel: r.reorder_level,
    minOrderQty: r.min_order_qty,
    isActive: toBool(r.is_active),
    openings,
    openingTotal: {
      qty: roundQty(openings.reduce((s, o) => s + o.qty, 0)),
      value: openings.reduce((s, o) => s + o.value, 0),
    },
    gstHistory: listGstHistory(db, 'stock_item', id),
    effectiveGst: resolveItemGstProfile(db, id, asOf),
    priceLists: itemPriceLists(db, id, asOf),
    hasTransactions: itemHasTransactions(db, id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ───────────────────────────── List ─────────────────────────────

export function listItems(db: Db, input: StockItemListInput, today: string): ListResult<StockItemListRow> {
  const { limit, offset } = paging(input, 100, 2000);
  const sub = input.includeSubgroups ?? true;
  const groupIds = input.groupId === undefined ? null : sub ? subtreeIds(db, 'stock_groups', input.groupId) : [input.groupId];
  const catIds = input.categoryId === undefined ? null : sub ? subtreeIds(db, 'stock_categories', input.categoryId) : [input.categoryId];
  const params = {
    like: likePattern(input.search),
    gf: groupIds ? 1 : 0,
    gids: jsonIds(groupIds ?? []),
    cf: catIds ? 1 : 0,
    cids: jsonIds(catIds ?? []),
    active: input.activeOnly ? 1 : 0,
  };
  const where = `WHERE (:like IS NULL OR i.name LIKE :like ESCAPE '\\' OR i.alias LIKE :like ESCAPE '\\'
                        OR i.part_no LIKE :like ESCAPE '\\' OR i.barcode LIKE :like ESCAPE '\\' OR ${extraAliasLike('stock_item', 'i.id', 'like')})
                   AND (:gf = 0 OR i.group_id IN (SELECT value FROM json_each(:gids)))
                   AND (:cf = 0 OR i.category_id IN (SELECT value FROM json_each(:cids)))
                   AND (:active = 0 OR i.is_active = 1)`;
  const total = countOf(db, `SELECT COUNT(*) FROM stock_items i ${where}`, params);
  const rows = db.all<ItemRow>(`${SELECT_ITEM} ${where} ORDER BY i.name COLLATE NOCASE LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  const stock = input.withStock
    ? stockByItem(db, { asOf: input.asOf ?? today, today, itemIds: rows.map((r) => r.id) })
    : null;
  const otherAliases = extraAliasMap(db, 'stock_item', rows.map((r) => r.id));
  return {
    rows: rows.map((r) => {
      const row: StockItemListRow = {
        id: r.id,
        name: r.name,
        alias: r.alias,
        partNo: r.part_no,
        barcode: r.barcode,
        groupId: r.group_id,
        groupName: r.group_name,
        categoryId: r.category_id,
        categoryName: r.category_name,
        unitId: r.unit_id,
        unitSymbol: r.unit_symbol,
        hsnSac: r.hsn_sac,
        gstRate: r.gst_rate,
        isService: toBool(r.is_service),
        isActive: toBool(r.is_active),
        maintainBatches: toBool(r.maintain_batches),
        costingMethod: asCosting(r.costing_method),
        sellingPrice: r.selling_price,
        mrp: r.mrp,
      };
      if (stock) row.stockQty = stock.get(r.id) ?? 0;
      const more = otherAliases.get(r.id);
      if (more) row.otherAliases = more;
      return row;
    }),
    total,
  };
}

// ───────────────────────────── Save ─────────────────────────────

interface NormalizedOpening {
  godownId: number;
  batchName: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number;
  rate: number;
  value: number;
}

const decimalsOk = (qty: number, places: number): boolean => Math.abs(roundTo(qty, places) - qty) < 1e-9;

/** Largest opening quantity accepted (base units) — far beyond any real stock, well inside float precision. */
const MAX_OPENING_QTY = 1e12;

function normalizeOpenings(
  db: Db,
  rows: readonly StockOpeningInput[],
  ctx: { multipleGodowns: boolean; maintainBatches: boolean; batchesFeature: boolean; unitSymbol: string; unitDecimals: number },
): NormalizedOpening[] {
  const issues: FieldIssue[] = [];
  const out: NormalizedOpening[] = [];
  const seen = new Map<string, number>();
  const main = mainGodownId(db);
  rows.forEach((r, i) => {
    const p = (f: string): string => `openings[${i}].${f}`;
    const before = issues.length;
    let godownId = r.godownId ?? null;
    if (godownId === null) {
      if (ctx.multipleGodowns) issues.push({ path: p('godownId'), message: 'Choose the godown that holds this opening stock' });
      godownId = main;
    } else if (db.value('SELECT 1 FROM godowns WHERE id = :id', { id: godownId }) === undefined) {
      issues.push({ path: p('godownId'), message: 'The selected godown does not exist' });
    }
    const batchName = cleanText(r.batchName) ?? null;
    // Vouchers record batches only while the company's Batches feature is on, so a batch name is
    // demanded only then (the form hides batch fields otherwise); one given anyway is kept.
    if (ctx.maintainBatches && ctx.batchesFeature && batchName === null)
      issues.push({ path: p('batchName'), message: 'Enter the batch name: this item is maintained in batches' });
    if (!ctx.maintainBatches && batchName !== null)
      issues.push({ path: p('batchName'), message: "Batch names apply only to items maintained in batches. Turn on 'Maintain in batches' or clear the batch." });
    const mfgDate = r.mfgDate ?? null;
    const expiryDate = r.expiryDate ?? null;
    if ((mfgDate !== null || expiryDate !== null) && batchName === null)
      issues.push({ path: p('expiryDate'), message: 'Manufacturing and expiry dates are kept per batch; enter a batch name first' });
    if (mfgDate !== null && expiryDate !== null && expiryDate < mfgDate)
      issues.push({ path: p('expiryDate'), message: 'The expiry date is before the manufacturing date' });
    if (!(r.qty > 0)) issues.push({ path: p('qty'), message: 'Opening quantity must be more than 0 (remove the row for no stock)' });
    else if (r.qty > MAX_OPENING_QTY)
      issues.push({ path: p('qty'), message: `Opening quantity ${r.qty} is too large. Check the quantity (the limit is ${MAX_OPENING_QTY.toExponential()}).` });
    else if (!decimalsOk(r.qty, ctx.unitDecimals))
      issues.push({
        path: p('qty'),
        message: `${r.qty} has more decimal places than the unit '${ctx.unitSymbol}' allows (${ctx.unitDecimals})`,
      });
    if (r.rate !== undefined && r.rate !== null && !(r.rate >= 0)) issues.push({ path: p('rate'), message: 'Rate cannot be negative' });
    if (r.value !== undefined && r.value !== null && !(r.value >= 0)) issues.push({ path: p('value'), message: 'Value cannot be negative' });
    const key = `${godownId}|${(batchName ?? '').toLowerCase()}`;
    if (seen.has(key))
      issues.push({ path: p(batchName ? 'batchName' : 'godownId'), message: `Row ${(seen.get(key) ?? 0) + 1} already has opening stock for this godown${batchName ? ' and batch' : ''}` });
    seen.set(key, i);
    if (issues.length > before) return;
    // Value in paise must stay a safe integer (it is summed into Balance Sheet totals): qty × rate is
    // checked before rounding, so a huge rate is reported to the user instead of failing internally.
    const raw = r.value ?? r.qty * (r.rate ?? 0) * 100;
    if (!Number.isFinite(raw) || raw > MAX_LINE_PAISE) {
      issues.push({
        path: p(r.value !== undefined && r.value !== null ? 'value' : 'rate'),
        message: `The opening value of this row is too large (more than ${formatMoney(MAX_LINE_PAISE, { symbol: true })}). Check the quantity and rate.`,
      });
      return;
    }
    const value = r.value ?? lineAmount(r.qty, r.rate ?? 0);
    const rate = r.rate ?? roundTo(value / 100 / r.qty, 6);
    out.push({ godownId, batchName, mfgDate, expiryDate, qty: r.qty, rate, value });
  });
  if (issues.length) throw validation(issues);
  return out;
}

/** True when the normalised rows differ from the stored opening rows (order-insensitive). */
function openingsChanged(current: readonly StockOpeningRow[], next: readonly NormalizedOpening[]): boolean {
  const key = (o: { godownId: number; batchName: string | null; mfgDate: string | null; expiryDate: string | null; qty: number; rate: number; value: number }): string =>
    JSON.stringify([o.godownId, o.batchName, o.mfgDate, o.expiryDate, o.qty, o.rate, o.value]);
  if (current.length !== next.length) return true;
  const a = current.map(key).sort();
  const b = next.map(key).sort();
  return a.some((k, i) => k !== b[i]);
}

/**
 * Opening stock is dated at the books beginning, so it is part of every period from then on: once
 * the books are locked on or after that date it cannot change (as for vouchers in a locked period).
 */
function assertOpeningStockUnlocked(db: Db, itemName: string): void {
  const lockedUpTo = getConfig(db).lockedUpTo;
  const from = booksFrom(db);
  if (lockedUpTo && from <= lockedUpTo) {
    throw new AppError(
      'LOCKED',
      `The opening stock of '${itemName}' is dated ${formatDate(from)} (books beginning) and the books are locked up to ${formatDate(lockedUpTo)}. ` +
        'Unlock the period first, or bring the stock in with a voucher (e.g. Stock Journal or Physical Stock) dated after the lock.',
      { lockedUpTo },
    );
  }
}

function unitInfo(db: Db, id: number, path: string): { id: number; symbol: string; decimal_places: number } {
  const u = db.get<{ id: number; symbol: string; decimal_places: number }>('SELECT id, symbol, decimal_places FROM units WHERE id = :id', { id });
  if (!u) throw validation([{ path, message: 'The selected unit does not exist. Choose another unit.' }]);
  return u;
}

/** Save without the permission check (shared by save and bulk create). */
function saveItemCore(ctx: CompanyCtx, input: StockItemSaveInput): StockItemSaveResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  const before = input.id !== undefined ? getItem(db, input.id, today) : null;
  const features = getFeatures(db);
  const warnings: string[] = [];
  const id0 = before?.id ?? null;

  // Identity
  const name = (input.name ?? before?.name ?? '').trim();
  if (!name) throw validation([{ path: 'name', message: 'Enter the stock item name' }]);
  assertNameFree(db, 'stock_items', name, id0, 'name', 'Stock item');
  // Aliases (dataplus): `aliases` is the complete list (first → the alias column, the rest → stock_item_aliases).
  let alias: string | null;
  let extras: string[];
  if (Array.isArray(input.aliases)) {
    const list = normalizeAliases(name, input.aliases);
    alias = list[0] ?? null;
    extras = list.slice(1);
  } else {
    alias = patch(cleanText(input.alias), before?.alias ?? null);
    if (alias !== null && alias.toLowerCase() === name.toLowerCase()) throw validation([{ path: 'alias', message: 'The alias must be different from the name' }]);
    const full = normalizeAliases(name, [alias, ...(id0 !== null ? extraAliases(db, 'stock_item', id0) : [])]);
    alias = full[0] ?? null;
    extras = full.slice(1);
  }
  if (alias !== null) assertNameFree(db, 'stock_items', alias, id0, 'alias', 'Stock item');
  {
    const problems = [...aliasListIssues(allAliases(alias, extras)), ...aliasClashIssues(db, 'stock_item', name, allAliases(alias, extras), id0)];
    if (problems.length > 0) throw validation(problems);
  }
  const partNo = patch(cleanText(input.partNo), before?.partNo ?? null);
  const barcode = patch(cleanText(input.barcode), before?.barcode ?? null);
  if (barcode !== null) {
    const other = db.get<{ name: string }>('SELECT name FROM stock_items WHERE barcode = :b AND id IS NOT :id', { b: barcode, id: id0 });
    if (other) throw validation([{ path: 'barcode', message: `Barcode ${barcode} is already used by '${other.name}'` }]);
  }
  const description = patch(cleanText(input.description), before?.description ?? null);

  // Classification
  const groupId = patch(input.groupId, before?.groupId ?? null);
  if (groupId !== null && db.value('SELECT 1 FROM stock_groups WHERE id = :id', { id: groupId }) === undefined)
    throw validation([{ path: 'groupId', message: 'The selected stock group does not exist' }]);
  const categoryId = patch(input.categoryId, before?.categoryId ?? null);
  if (categoryId !== null && db.value('SELECT 1 FROM stock_categories WHERE id = :id', { id: categoryId }) === undefined)
    throw validation([{ path: 'categoryId', message: 'The selected stock category does not exist' }]);

  // Units
  const unitId = input.unitId ?? before?.unitId;
  if (unitId === undefined) throw validation([{ path: 'unitId', message: 'Choose the unit of measure (e.g. Nos, Kg)' }]);
  const unit = unitInfo(db, unitId, 'unitId');
  const hasTx = before?.hasTransactions ?? false;
  if (before && unitId !== before.unitId && hasTx)
    throw rule(
      `The unit of '${before.name}' cannot change from ${before.unitSymbol} to ${unit.symbol} because it is already used on vouchers. Create a new item instead.`,
    );
  const altUnitId = patch(input.altUnitId, before?.altUnitId ?? null);
  let altConversion = patch(input.altConversion, before?.altConversion ?? null);
  if (altUnitId !== null) {
    const alt = unitInfo(db, altUnitId, 'altUnitId');
    if (alt.id === unit.id) throw validation([{ path: 'altUnitId', message: 'The alternate unit must be different from the base unit' }]);
    if (altConversion === null || !(altConversion > 0))
      throw validation([
        { path: 'altConversion', message: `Enter how many ${unit.symbol} make 1 ${alt.symbol} (a number more than 0)` },
      ]);
  } else if (input.altConversion !== undefined && input.altConversion !== null) {
    throw validation([{ path: 'altUnitId', message: 'Choose the alternate unit for this conversion, or clear the conversion' }]);
  } else {
    altConversion = null;
  }

  // Behaviour
  const isService = input.isService ?? before?.isService ?? false;
  const maintainBatches = input.maintainBatches ?? before?.maintainBatches ?? false;
  const trackMfgDate = input.trackMfgDate ?? before?.trackMfgDate ?? false;
  const useExpiry = input.useExpiry ?? before?.useExpiry ?? false;
  if (isService && maintainBatches)
    throw validation([{ path: 'maintainBatches', message: 'A service has no stock, so it cannot be maintained in batches' }]);
  if ((trackMfgDate || useExpiry) && !maintainBatches)
    throw validation([
      { path: trackMfgDate ? 'trackMfgDate' : 'useExpiry', message: "Manufacturing and expiry dates are kept per batch. Turn on 'Maintain in batches' first." },
    ]);
  if (maintainBatches && !features.batches)
    warnings.push("Batches are turned off for this company (F11 › Batches). Turn them on to enter batch details in vouchers.");
  if (useExpiry && !features.expiryDates)
    warnings.push('Expiry dates are turned off for this company (F11 › Expiry dates). Turn them on to enter expiry dates in vouchers.');
  if (isService && before && !before.isService && hasTx)
    throw rule(`'${before.name}' already has stock movements on vouchers, so it cannot be turned into a service.`);
  const costingMethod = input.costingMethod ?? before?.costingMethod ?? 'avg_cost';
  const marketValuation = input.marketValuation ?? before?.marketValuation ?? 'avg_price';

  // GST
  const prevGst: GstDetails | null = before
    ? {
        applicable: before.gstApplicable,
        hsnSac: before.hsnSac,
        taxability: before.taxability,
        rate: before.gstRate,
        cessRate: before.cessRate,
        cessPerUnit: before.cessPerUnit,
      }
    : null;
  const gst = normalizeGstDetails(input, prevGst, isService ? 'services' : 'goods');
  const columnsGst = columnGstDetails(db, 'stock_item', id0, prevGst, gst, input);
  if (columnsGst.backdatedBefore !== null && input.gstApplicableFrom !== undefined)
    warnings.push(
      `The GST details from ${formatDate(input.gstApplicableFrom)} were added to the rate history. ` +
        `The current details (in force from ${formatDate(columnsGst.backdatedBefore)}) are unchanged.`,
    );
  const rateInclusiveOfTax = input.rateInclusiveOfTax ?? before?.rateInclusiveOfTax ?? false;

  // Prices & stock levels
  const mrp = patch(input.mrp, before?.mrp ?? null);
  const sellingPrice = patch(input.sellingPrice, before?.sellingPrice ?? null);
  const purchasePrice = patch(input.purchasePrice, before?.purchasePrice ?? null);
  const standardCost = patch(input.standardCost, before?.standardCost ?? null);
  const priceIssues: FieldIssue[] = [];
  const checkPaise = (v: number | null, path: string, label: string): void => {
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) priceIssues.push({ path, message: `${label} cannot be negative` });
  };
  checkPaise(mrp, 'mrp', 'MRP');
  checkPaise(sellingPrice, 'sellingPrice', 'Selling price');
  checkPaise(purchasePrice, 'purchasePrice', 'Purchase price');
  checkPaise(standardCost, 'standardCost', 'Standard cost');
  if (costingMethod === 'std_cost' && standardCost === null)
    priceIssues.push({ path: 'standardCost', message: "Enter the standard cost: the costing method is 'Standard Cost'" });
  const reorderLevel = patch(input.reorderLevel, before?.reorderLevel ?? null);
  const minOrderQty = patch(input.minOrderQty, before?.minOrderQty ?? null);
  if (reorderLevel !== null && !(reorderLevel >= 0)) priceIssues.push({ path: 'reorderLevel', message: 'Reorder level cannot be negative' });
  if (minOrderQty !== null && !(minOrderQty >= 0)) priceIssues.push({ path: 'minOrderQty', message: 'Minimum order quantity cannot be negative' });
  if (priceIssues.length) throw validation(priceIssues);
  const isActive = input.isActive ?? before?.isActive ?? true;

  // Opening stock
  let openings: NormalizedOpening[] | null = null;
  if (input.openings !== undefined) {
    if (isService && input.openings.length > 0)
      throw validation([{ path: 'openings', message: 'A service has no stock: remove the opening stock rows' }]);
    openings = normalizeOpenings(db, input.openings, {
      multipleGodowns: features.multipleGodowns,
      maintainBatches,
      batchesFeature: features.batches,
      unitSymbol: unit.symbol,
      unitDecimals: unit.decimal_places,
    });
    if (openingsChanged(before?.openings ?? [], openings)) assertOpeningStockUnlocked(db, name);
  } else if (before) {
    if (isService && before.openings.length > 0)
      throw validation([{ path: 'openings', message: 'A service has no stock: remove the opening stock before marking the item as a service' }]);
    if (maintainBatches && !before.maintainBatches && features.batches && before.openings.some((o) => !o.batchName))
      throw validation([{ path: 'openings', message: 'Give each opening stock row a batch name before maintaining this item in batches' }]);
    if (!maintainBatches && before.maintainBatches && before.openings.some((o) => o.batchName))
      throw validation([
        {
          path: 'openings',
          message: "The opening stock is entered batch-wise. Re-enter it without batch names, or keep 'Maintain in batches' on.",
        },
      ]);
    if (unitId !== before.unitId && before.openings.some((o) => !decimalsOk(o.qty, unit.decimal_places)))
      throw validation([{ path: 'unitId', message: `The opening quantities have more decimal places than '${unit.symbol}' allows` }]);
  }

  // Write
  const ts = nowIso(ctx);
  const params = {
    name,
    alias,
    partNo,
    barcode,
    description,
    groupId,
    categoryId,
    unitId: unit.id,
    altUnitId,
    altConversion,
    batches: maintainBatches,
    mfg: trackMfgDate,
    expiry: useExpiry,
    costing: costingMethod,
    market: marketValuation,
    service: isService,
    gstApp: columnsGst.details.applicable ? 'applicable' : 'not_applicable',
    hsn: columnsGst.details.hsnSac,
    tax: columnsGst.details.taxability,
    rate: columnsGst.details.rate,
    cess: columnsGst.details.cessRate,
    cpu: columnsGst.details.cessPerUnit,
    incl: rateInclusiveOfTax,
    mrp,
    sell: sellingPrice,
    buy: purchasePrice,
    std: standardCost,
    reorder: reorderLevel,
    moq: minOrderQty,
    active: isActive,
    ts,
  };
  let id: number;
  if (before) {
    id = before.id;
    db.run(
      `UPDATE stock_items SET name = :name, alias = :alias, part_no = :partNo, barcode = :barcode, description = :description,
              group_id = :groupId, category_id = :categoryId, unit_id = :unitId, alt_unit_id = :altUnitId, alt_conversion = :altConversion,
              maintain_batches = :batches, track_mfg_date = :mfg, use_expiry = :expiry, costing_method = :costing,
              market_valuation = :market, is_service = :service, gst_applicable = :gstApp, hsn_sac = :hsn, gst_taxability = :tax,
              gst_rate = :rate, cess_rate = :cess, cess_per_unit = :cpu, rate_inclusive_of_tax = :incl, mrp = :mrp,
              selling_price = :sell, purchase_price = :buy, standard_cost = :std, reorder_level = :reorder, min_order_qty = :moq,
              is_active = :active, updated_at = :ts
        WHERE id = :id`,
      { ...params, id },
    );
  } else {
    id = db.run(
      `INSERT INTO stock_items (guid, name, alias, part_no, barcode, description, group_id, category_id, unit_id, alt_unit_id,
              alt_conversion, maintain_batches, track_mfg_date, use_expiry, costing_method, market_valuation, is_service,
              gst_applicable, hsn_sac, gst_taxability, gst_rate, cess_rate, cess_per_unit, rate_inclusive_of_tax, mrp,
              selling_price, purchase_price, standard_cost, reorder_level, min_order_qty, is_active, created_at, updated_at)
       VALUES (:guid, :name, :alias, :partNo, :barcode, :description, :groupId, :categoryId, :unitId, :altUnitId,
              :altConversion, :batches, :mfg, :expiry, :costing, :market, :service,
              :gstApp, :hsn, :tax, :rate, :cess, :cpu, :incl, :mrp,
              :sell, :buy, :std, :reorder, :moq, :active, :ts, :ts)`,
      { ...params, guid: randomUUID() },
    ).lastInsertRowid;
  }
  if (openings !== null) {
    db.run('DELETE FROM stock_openings WHERE item_id = :id', { id });
    for (const o of openings) {
      db.run(
        `INSERT INTO stock_openings (item_id, godown_id, batch_name, mfg_date, expiry_date, qty, rate, value)
         VALUES (:id, :godown, :batch, :mfg, :exp, :qty, :rate, :value)`,
        { id, godown: o.godownId, batch: o.batchName, mfg: o.mfgDate, exp: o.expiryDate, qty: o.qty, rate: o.rate, value: o.value },
      );
    }
  }
  syncGstHistory(db, 'stock_item', id, name, prevGst, gst, input, booksFrom(db));
  writeExtraAliases(db, 'stock_item', id, extras);

  const after = getItem(db, id, today);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'stock_item',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.name,
    before: before ? auditSnapshot(before) : undefined,
    after: auditSnapshot(after),
  });
  return { item: after, warnings };
}

/** Audit snapshot: the master data only (derived fields such as price lists and effective GST left out). */
export function auditSnapshot(
  d: StockItemDetail,
): Omit<StockItemDetail, 'effectiveGst' | 'priceLists' | 'hasTransactions' | 'aliases'> & { otherAliases?: string[] } {
  const { effectiveGst: _e, priceLists: _p, hasTransactions: _h, aliases = [], ...rest } = d;
  // Additional aliases only when there are some (images written before dataplus stay comparable).
  return aliases.length > (d.alias ? 1 : 0) ? { ...rest, otherAliases: aliases.slice(d.alias ? 1 : 0) } : rest;
}

export function saveItem(ctx: CompanyCtx, input: StockItemSaveInput): StockItemSaveResult {
  requireSavePermission(ctx, input.id, 'stock items');
  return saveItemCore(ctx, input);
}

/** Keyboard-first "Multiple Stock Items" creation: all rows are created, or none (first error reported with its row). */
export function bulkCreateItems(ctx: CompanyCtx, input: StockItemBulkCreateInput): StockItemBulkCreateResult {
  requirePermission(ctx, 'masters.create', 'create stock items');
  const created: Array<{ id: number; name: string }> = [];
  const warnings = new Set<string>();
  ctx.db.transaction(() => {
    input.rows.forEach((row, i) => {
      if (row.id !== undefined)
        throw validation([{ path: `rows[${i}].id`, message: `Row ${i + 1}: multiple creation only creates new items; alter existing items one by one` }]);
      const rowInput: StockItemSaveInput = { ...row, groupId: row.groupId === undefined ? (input.groupId ?? null) : row.groupId };
      try {
        const res = saveItemCore(ctx, rowInput);
        created.push({ id: res.item.id, name: res.item.name });
        for (const w of res.warnings) warnings.add(w);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        const label = `Row ${i + 1}${row.name ? ` (${row.name.trim()})` : ''}`;
        const details = Array.isArray(err.details)
          ? (err.details as FieldIssue[]).map((d) => ({ path: `rows[${i}].${d.path}`, message: `${label}: ${d.message}` }))
          : err.details;
        throw new AppError(err.code, `${label}: ${err.message}`, details);
      }
    });
  });
  return { created, warnings: [...warnings] };
}

export function deleteItem(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete stock items');
  const { db } = ctx;
  const before = getItem(db, id, ctx.clock.today());
  const vouchers = countOf(db, 'SELECT COUNT(DISTINCT voucher_id) FROM inventory_entries WHERE item_id = :id', { id });
  const gstLines = countOf(db, 'SELECT COUNT(DISTINCT voucher_id) FROM gst_lines WHERE item_id = :id', { id });
  if (vouchers + gstLines > 0)
    throw rule(
      `Cannot delete stock item '${before.name}': it is used in ${Math.max(vouchers, gstLines)} voucher(s). ` +
        'Delete those vouchers first, or mark the item inactive to hide it.',
    );
  // Bills of materials and job work orders (mfg module) keep their items.
  const mfgUses = itemMfgUses(db, id).filter(([n]) => n > 0);
  if (mfgUses.length > 0) {
    throw rule(
      `Cannot delete stock item '${before.name}': it is used in ${mfgUses.map(([n, what]) => `${n} ${what}`).join(', ')}. ` +
        'Remove it there first, or mark the item inactive to hide it.',
    );
  }
  // Attached files (dataplus) are evidence: remove them first (the FK would refuse anyway).
  const files = countOf(db, 'SELECT COUNT(*) FROM attachments WHERE stock_item_id = :id', { id });
  if (files > 0) throw rule(`Cannot delete stock item '${before.name}': it has ${files} attached file(s). Remove the attachments first, or mark the item inactive to hide it.`);
  if (before.openings.length > 0) assertOpeningStockUnlocked(db, before.name);
  // Every price-list slab of the item (all levels and dates) goes with it: keep them in the edit log.
  const priceListRows = db.all<{ level: string; applicable_from: string; qty_from: number; qty_to: number | null; rate: number; discount_pct: number }>(
    `SELECT l.name AS level, p.applicable_from, p.qty_from, p.qty_to, p.rate, p.discount_pct
       FROM price_list p JOIN price_levels l ON l.id = p.price_level_id
      WHERE p.item_id = :id ORDER BY l.name COLLATE NOCASE, p.applicable_from, p.qty_from`,
    { id },
  );
  db.run('DELETE FROM stock_openings WHERE item_id = :id', { id });
  db.run('DELETE FROM price_list WHERE item_id = :id', { id });
  deleteGstHistory(db, 'stock_item', id);
  db.run('DELETE FROM stock_items WHERE id = :id', { id });
  ctx.audit({
    action: 'delete',
    entityType: 'stock_item',
    entityId: id,
    entityGuid: before.guid,
    entityLabel: before.name,
    before: priceListRows.length ? { ...auditSnapshot(before), priceListRows } : auditSnapshot(before),
  });
  return { id, deleted: true };
}

// ───────────────────────────── Picker ─────────────────────────────

/** Positional row of the picker query (see PICKER_SQL), decoded from one JSON array. */
type PickerTuple = [
  id: number,
  name: string,
  alias: string | null,
  partNo: string | null,
  barcode: string | null,
  groupId: number | null,
  groupName: string | null,
  unitSymbol: string,
  unitDecimals: number,
  altUnitId: number | null,
  altSymbol: string | null,
  altConversion: number | null,
  gstApplicable: string,
  gstTaxability: string | null,
  gstRate: number | null,
  cessRate: number | null,
  cessPerUnit: number | null,
  hsnSac: string | null,
  sellingPrice: number | null,
  purchasePrice: number | null,
  mrp: number | null,
  isService: number,
  maintainBatches: number,
];

/**
 * Active items as ONE JSON text (json_group_array, ordered by name): materialising 20,000 wide
 * row objects through the driver costs ~4× more than parsing one JSON document.
 * Optional `:like` search (name, alias, part no., barcode; names starting with the text first) and
 * `:limit` (−1 = all).
 */
const PICKER_SQL = /* sql */ `
  SELECT json_group_array(json_array(
           id, name, alias, part_no, barcode, group_id, group_name, unit_symbol, unit_decimals,
           alt_unit_id, alt_symbol, alt_conversion, gst_applicable, gst_taxability, gst_rate, cess_rate,
           cess_per_unit, hsn_sac, selling_price, purchase_price, mrp, is_service, maintain_batches)
         ORDER BY rank, name COLLATE NOCASE, id)
    FROM (
      SELECT i.id, i.name, i.alias, i.part_no, i.barcode, i.group_id, g.name AS group_name, u.symbol AS unit_symbol,
             u.decimal_places AS unit_decimals, i.alt_unit_id, au.symbol AS alt_symbol, i.alt_conversion, i.gst_applicable,
             i.gst_taxability, i.gst_rate, i.cess_rate, i.cess_per_unit, i.hsn_sac, i.selling_price, i.purchase_price, i.mrp,
             i.is_service, i.maintain_batches,
             CASE WHEN :prefix IS NOT NULL AND i.name LIKE :prefix ESCAPE '\\' THEN 0 ELSE 1 END AS rank
        FROM stock_items i
        JOIN units u ON u.id = i.unit_id
        LEFT JOIN units au ON au.id = i.alt_unit_id
        LEFT JOIN stock_groups g ON g.id = i.group_id
       WHERE i.is_active = 1
         AND (:like IS NULL OR i.name LIKE :like ESCAPE '\\' OR i.alias LIKE :like ESCAPE '\\'
              OR i.part_no LIKE :like ESCAPE '\\' OR i.barcode LIKE :like ESCAPE '\\'
              OR ${extraAliasLike('stock_item', 'i.id', 'like')})
       ORDER BY rank, i.name COLLATE NOCASE, i.id
       LIMIT :limit)`;

/**
 * Compact list of active items for voucher-line pickers and Go To: GST resolved as of `asOf`
 * (same precedence as resolveItemGstProfile), stock as of `asOf` (optionally one godown),
 * optional price-level rate for quantity 1, optional search/limit. A handful of queries regardless
 * of the number of items.
 */
export function itemPicker(db: Db, input: ItemPickerInput, today: string): ItemPickerRow[] {
  const asOf = input.asOf ?? today;
  if (input.priceLevelId !== undefined) getPriceLevel(db, input.priceLevelId); // NOT_FOUND for a wrong level
  const like = likePattern(input.search);
  const filtered = like !== null || input.limit !== undefined;
  const tuples = JSON.parse(
    db.value<string>(PICKER_SQL, { like, prefix: like === null ? null : like.slice(1), limit: input.limit ?? -1 }) ?? '[]',
  ) as PickerTuple[];
  const resolve = createGstResolver(db, asOf);
  const stock = stockByItem(db, {
    asOf,
    today,
    godownId: input.godownId ?? null,
    itemIds: filtered ? tuples.map((r) => r[0]) : undefined,
  });
  const levels = input.priceLevelId !== undefined ? priceLevelRatesForPicker(db, input.priceLevelId, asOf) : null;
  const otherAliases = extraAliasMap(db, 'stock_item', filtered ? tuples.map((r) => r[0]) : undefined);
  const out: ItemPickerRow[] = new Array(tuples.length);
  for (let k = 0; k < tuples.length; k++) {
    const [id, name, alias, partNo, barcode, groupId, groupName, unitSymbol, unitDecimals, altUnitId, altSymbol, altConversion] = tuples[k];
    const r = tuples[k];
    const p = resolve({
      id,
      group_id: groupId,
      gst_applicable: r[12],
      gst_taxability: r[13],
      gst_rate: r[14],
      cess_rate: r[15],
      cess_per_unit: r[16],
      hsn_sac: r[17],
    });
    const more = otherAliases.get(id);
    out[k] = {
      id,
      name,
      alias,
      ...(more ? { otherAliases: more } : {}),
      partNo,
      barcode,
      unitSymbol,
      unitDecimals,
      altUnit: altUnitId !== null && altSymbol !== null && altConversion !== null ? { id: altUnitId, symbol: altSymbol, conversion: altConversion } : null,
      groupName,
      gst: p ? { rate: p.rate, cessRate: p.cessRate, cessPerUnit: p.cessPerUnit, taxability: p.taxability, hsnSac: p.hsnSac } : null,
      sellingPrice: r[18],
      purchasePrice: r[19],
      mrp: r[20],
      priceLevel: levels?.get(id) ?? null,
      stockQty: stock.get(id) ?? 0,
      isService: r[21] === 1,
      maintainBatches: r[22] === 1,
    };
  }
  return out;
}
