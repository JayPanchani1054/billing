/**
 * Price levels (e.g. Wholesale, Retail) and effective-dated price lists with quantity slabs.
 *
 * A price list for (level, item) is the set of slabs with the latest applicable_from ≤ date.
 * Slab k applies to quantities qtyFrom ≤ qty < qtyTo (qtyTo null = no upper limit). Slabs of one
 * item on one date must not overlap.
 */
import { randomUUID } from 'node:crypto';
import { formatDate } from '../../../shared/dates.ts';
import type {
  DeleteResult,
  ItemPriceListEntry,
  ListInput,
  ListResult,
  PriceForInput,
  PriceForResult,
  PriceLevelDto,
  PriceLevelSaveInput,
  PriceListDto,
  PriceListGetInput,
  PriceListItem,
  PriceListSaveInput,
  PriceSlab,
} from '../../../shared/types/inventory.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, validation } from '../../lib/errors.ts';
import {
  assertNameFree,
  assertUnused,
  countOf,
  jsonIds,
  likePattern,
  nowIso,
  paging,
  requirePermission,
  requireSavePermission,
  subtreeIds,
} from './common.ts';

interface LevelRow {
  id: number;
  guid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

const levelDto = (r: LevelRow): PriceLevelDto => ({ id: r.id, guid: r.guid, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at });

export function listPriceLevels(db: Db, input: ListInput = {}): ListResult<PriceLevelDto> {
  const { limit, offset } = paging(input);
  const like = likePattern(input.search);
  const where = `WHERE (:like IS NULL OR name LIKE :like ESCAPE '\\')`;
  const total = countOf(db, `SELECT COUNT(*) FROM price_levels ${where}`, { like });
  const rows = db.all<LevelRow>(`SELECT * FROM price_levels ${where} ORDER BY name COLLATE NOCASE LIMIT :limit OFFSET :offset`, {
    like,
    limit,
    offset,
  });
  return { rows: rows.map(levelDto), total };
}

export function getPriceLevel(db: Db, id: number): PriceLevelDto {
  const row = db.get<LevelRow>('SELECT * FROM price_levels WHERE id = :id', { id });
  if (!row) throw notFound('Price level', id);
  return levelDto(row);
}

export function savePriceLevel(ctx: CompanyCtx, input: PriceLevelSaveInput): PriceLevelDto {
  requireSavePermission(ctx, input.id, 'price levels');
  const { db } = ctx;
  const before = input.id !== undefined ? getPriceLevel(db, input.id) : null;
  const name = input.name.trim();
  if (!name) throw validation([{ path: 'name', message: 'Enter the price level name, e.g. Wholesale' }]);
  assertNameFree(db, 'price_levels', name, before?.id ?? null, 'name', 'Price level', false);
  const ts = nowIso(ctx);
  let id: number;
  if (before) {
    id = before.id;
    db.run('UPDATE price_levels SET name = :name, updated_at = :ts WHERE id = :id', { id, name, ts });
  } else {
    id = db.run('INSERT INTO price_levels (guid, name, created_at, updated_at) VALUES (:guid, :name, :ts, :ts)', {
      guid: randomUUID(),
      name,
      ts,
    }).lastInsertRowid;
  }
  const after = getPriceLevel(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'price_level',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.name,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function deletePriceLevel(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete price levels');
  const { db } = ctx;
  const before = getPriceLevel(db, id);
  assertUnused('price level', before.name, [[countOf(db, 'SELECT COUNT(*) FROM vouchers WHERE price_level_id = :id', { id }), 'voucher(s)']]);
  const listRows = countOf(db, 'SELECT COUNT(*) FROM price_list WHERE price_level_id = :id', { id });
  db.run('DELETE FROM price_list WHERE price_level_id = :id', { id });
  db.run('DELETE FROM price_levels WHERE id = :id', { id });
  ctx.audit({
    action: 'delete',
    entityType: 'price_level',
    entityId: id,
    entityGuid: before.guid,
    entityLabel: before.name,
    before: { ...before, priceListRows: listRows },
  });
  return { id, deleted: true };
}

// ───────────────────────────── Price lists ─────────────────────────────

interface SlabRow {
  item_id: number;
  applicable_from: string;
  qty_from: number;
  qty_to: number | null;
  rate: number;
  discount_pct: number;
}

const toSlab = (r: SlabRow): PriceSlab => ({ qtyFrom: r.qty_from, qtyTo: r.qty_to, rate: r.rate, discountPct: r.discount_pct });

/** Latest price list per item dated ≤ :date, for every item or (index-friendly, no catch-all flag) only :ids. */
function slabsSql(filterItems: boolean): string {
  return `WITH latest AS (
       SELECT item_id, MAX(applicable_from) AS af FROM price_list
        WHERE price_level_id = :lvl AND applicable_from <= :date
          ${filterItems ? 'AND item_id IN (SELECT value FROM json_each(:ids))' : ''}
        GROUP BY item_id)
     SELECT p.item_id, p.applicable_from, p.qty_from, p.qty_to, p.rate, p.discount_pct
       FROM price_list p JOIN latest l ON l.item_id = p.item_id AND l.af = p.applicable_from
      WHERE p.price_level_id = :lvl
      ORDER BY p.item_id, p.qty_from`;
}
const SLABS_ALL_SQL = slabsSql(false);
const SLABS_SOME_SQL = slabsSql(true);

/** Applicable slabs per item for a level on a date (latest list dated ≤ date). Optional item restriction. */
function applicableSlabs(db: Db, levelId: number, date: string, itemIds?: readonly number[]): Map<number, { from: string; slabs: PriceSlab[] }> {
  const rows = db.all<SlabRow>(itemIds ? SLABS_SOME_SQL : SLABS_ALL_SQL, itemIds ? { lvl: levelId, date, ids: jsonIds(itemIds) } : { lvl: levelId, date });
  const out = new Map<number, { from: string; slabs: PriceSlab[] }>();
  for (const r of rows) {
    let e = out.get(r.item_id);
    if (!e) {
      e = { from: r.applicable_from, slabs: [] };
      out.set(r.item_id, e);
    }
    e.slabs.push(toSlab(r));
  }
  return out;
}

/** The slab covering `qty` (qtyFrom ≤ qty < qtyTo), or null. */
export function slabForQty(slabs: readonly PriceSlab[], qty: number): PriceSlab | null {
  const q = Math.abs(qty);
  for (const s of slabs) if (q >= s.qtyFrom - 1e-9 && (s.qtyTo === null || q < s.qtyTo - 1e-9)) return s;
  return null;
}

/** Rate/discount for quantity 1 per item for the item picker. */
export function priceLevelRatesForPicker(db: Db, levelId: number, date: string): Map<number, { rate: number; discountPct: number }> {
  const out = new Map<number, { rate: number; discountPct: number }>();
  for (const [itemId, e] of applicableSlabs(db, levelId, date)) {
    const s = slabForQty(e.slabs, 1) ?? e.slabs[0];
    if (s) out.set(itemId, { rate: s.rate, discountPct: s.discountPct });
  }
  return out;
}

/** Price lists applicable to one item on `date`, per price level (for the item detail). One query. */
export function itemPriceLists(db: Db, itemId: number, date: string): ItemPriceListEntry[] {
  const rows = db.all<SlabRow & { price_level_id: number; level_name: string }>(
    `WITH latest AS (
       SELECT price_level_id, MAX(applicable_from) AS af FROM price_list
        WHERE item_id = :item AND applicable_from <= :date GROUP BY price_level_id)
     SELECT p.price_level_id, l.name AS level_name, p.item_id, p.applicable_from, p.qty_from, p.qty_to, p.rate, p.discount_pct
       FROM price_list p
       JOIN latest x ON x.price_level_id = p.price_level_id AND x.af = p.applicable_from
       JOIN price_levels l ON l.id = p.price_level_id
      WHERE p.item_id = :item
      ORDER BY l.name COLLATE NOCASE, l.id, p.qty_from`,
    { item: itemId, date },
  );
  const out: ItemPriceListEntry[] = [];
  for (const r of rows) {
    let e = out.at(-1);
    if (!e || e.priceLevelId !== r.price_level_id) {
      e = { priceLevelId: r.price_level_id, priceLevelName: r.level_name, applicableFrom: r.applicable_from, slabs: [] };
      out.push(e);
    }
    e.slabs.push(toSlab(r));
  }
  return out;
}

export function getPriceList(db: Db, input: PriceListGetInput): PriceListDto {
  const level = getPriceLevel(db, input.priceLevelId);
  const like = likePattern(input.search);
  const groupIds = input.groupId !== undefined ? subtreeIds(db, 'stock_groups', input.groupId) : null;
  const items = db.all<{ id: number; name: string; unit_symbol: string; selling_price: number | null }>(
    `SELECT i.id, i.name, u.symbol AS unit_symbol, i.selling_price FROM stock_items i JOIN units u ON u.id = i.unit_id
      WHERE (:like IS NULL OR i.name LIKE :like ESCAPE '\\' OR i.alias LIKE :like ESCAPE '\\')
        AND (:gf = 0 OR i.group_id IN (SELECT value FROM json_each(:gids)))
      ORDER BY i.name COLLATE NOCASE`,
    { like, gf: groupIds ? 1 : 0, gids: jsonIds(groupIds ?? []) },
  );
  const slabs = applicableSlabs(db, level.id, input.date);
  const rows: PriceListItem[] = [];
  for (const it of items) {
    const e = slabs.get(it.id);
    if (!e && !input.includeAllItems) continue;
    rows.push({
      itemId: it.id,
      itemName: it.name,
      unitSymbol: it.unit_symbol,
      sellingPrice: it.selling_price,
      applicableFrom: e?.from ?? null,
      slabs: e?.slabs ?? [],
    });
  }
  return { priceLevelId: level.id, priceLevelName: level.name, date: input.date, rows };
}

/** Validate one item's slabs: qtyTo > qtyFrom, and no two slabs overlap. Returns issues. */
export function slabIssues(slabs: Array<PriceSlab & { index: number }>, itemName: string): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const s of slabs) {
    if (s.qtyTo !== null && !(s.qtyTo > s.qtyFrom))
      issues.push({ path: `rows[${s.index}].qtyTo`, message: `${itemName}: 'quantity up to' (${s.qtyTo}) must be more than 'quantity from' (${s.qtyFrom})` });
  }
  if (issues.length) return issues;
  const sorted = [...slabs].sort((a, b) => a.qtyFrom - b.qtyFrom);
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1];
    const b = sorted[k];
    if (a.qtyTo === null || b.qtyFrom < a.qtyTo - 1e-9) {
      const range = a.qtyTo === null ? `${a.qtyFrom} and above` : `${a.qtyFrom} up to ${a.qtyTo}`;
      issues.push({
        path: `rows[${b.index}].qtyFrom`,
        message: `${itemName}: the slab from ${b.qtyFrom} overlaps the slab ${range}. Each quantity may fall in only one slab.`,
      });
    }
  }
  return issues;
}

export function savePriceList(ctx: CompanyCtx, input: PriceListSaveInput): PriceListDto {
  const { db } = ctx;
  const level = getPriceLevel(db, input.priceLevelId);
  const byItem = new Map<number, Array<PriceSlab & { index: number }>>();
  const issues: FieldIssue[] = [];
  input.rows.forEach((r, index) => {
    const list = byItem.get(r.itemId) ?? [];
    list.push({ qtyFrom: r.qtyFrom, qtyTo: r.qtyTo ?? null, rate: r.rate, discountPct: r.discountPct ?? 0, index });
    byItem.set(r.itemId, list);
  });
  const affected = [...new Set([...byItem.keys(), ...(input.clearItemIds ?? [])])];
  if (affected.length === 0) throw validation([{ path: 'rows', message: 'Add at least one price list row (item, quantity slab and rate)' }]);
  const names = new Map<number, string>();
  for (const r of db.all<{ id: number; name: string }>('SELECT id, name FROM stock_items WHERE id IN (SELECT value FROM json_each(:ids))', {
    ids: jsonIds(affected),
  })) {
    names.set(r.id, r.name);
  }
  input.rows.forEach((r, index) => {
    if (!names.has(r.itemId)) issues.push({ path: `rows[${index}].itemId`, message: 'The selected stock item does not exist' });
  });
  (input.clearItemIds ?? []).forEach((id, index) => {
    if (!names.has(id)) issues.push({ path: `clearItemIds[${index}]`, message: 'The selected stock item does not exist' });
  });
  if (issues.length) throw validation(issues);
  for (const [itemId, slabs] of byItem) issues.push(...slabIssues(slabs, names.get(itemId) ?? `Item ${itemId}`));
  if (issues.length) throw validation(issues);

  const existing = applicableAt(db, level.id, input.applicableFrom, affected);
  // Only clearing lists that do not exist on that date: nothing to change, nothing to audit.
  if (byItem.size === 0 && existing.size === 0) return getPriceList(db, { priceLevelId: level.id, date: input.applicableFrom });
  requirePermission(
    ctx,
    existing.size > 0 ? 'masters.alter' : 'masters.create',
    existing.size > 0 ? 'alter price lists' : 'create price lists',
  );
  for (const itemId of affected) {
    db.run('DELETE FROM price_list WHERE price_level_id = :lvl AND item_id = :item AND applicable_from = :af', {
      lvl: level.id,
      item: itemId,
      af: input.applicableFrom,
    });
    for (const s of [...(byItem.get(itemId) ?? [])].sort((a, b) => a.qtyFrom - b.qtyFrom)) {
      db.run(
        `INSERT INTO price_list (price_level_id, item_id, applicable_from, qty_from, qty_to, rate, discount_pct)
         VALUES (:lvl, :item, :af, :from, :to, :rate, :disc)`,
        { lvl: level.id, item: itemId, af: input.applicableFrom, from: s.qtyFrom, to: s.qtyTo, rate: s.rate, disc: s.discountPct },
      );
    }
  }
  const after = applicableAt(db, level.id, input.applicableFrom, affected);
  const snapshot = (m: Map<number, PriceSlab[]>): Record<string, PriceSlab[]> =>
    Object.fromEntries([...m].map(([id, slabs]) => [`${names.get(id) ?? id} (#${id})`, slabs]));
  ctx.audit({
    action: existing.size > 0 ? 'alter' : 'create',
    entityType: 'price_list',
    entityId: level.id,
    entityGuid: level.guid,
    entityLabel: `${level.name} price list from ${formatDate(input.applicableFrom)}`,
    before: existing.size > 0 ? { applicableFrom: input.applicableFrom, items: snapshot(existing) } : undefined,
    after: { applicableFrom: input.applicableFrom, items: snapshot(after) },
  });
  return getPriceList(db, { priceLevelId: level.id, date: input.applicableFrom });
}

/** Slabs stored exactly on `date` for these items. */
function applicableAt(db: Db, levelId: number, date: string, itemIds: readonly number[]): Map<number, PriceSlab[]> {
  const out = new Map<number, PriceSlab[]>();
  const rows = db.all<SlabRow>(
    `SELECT item_id, applicable_from, qty_from, qty_to, rate, discount_pct FROM price_list
      WHERE price_level_id = :lvl AND applicable_from = :date AND item_id IN (SELECT value FROM json_each(:ids))
      ORDER BY item_id, qty_from`,
    { lvl: levelId, date, ids: jsonIds(itemIds) },
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push(toSlab(r));
    out.set(r.item_id, list);
  }
  return out;
}

/**
 * Default rate for an item on a voucher line: the price-level slab covering `qty` on `date`, else
 * the item's default selling (or purchase) price. Rates are rupees per base unit.
 */
export function priceFor(db: Db, input: PriceForInput): PriceForResult {
  const item = db.get<{ selling_price: number | null; purchase_price: number | null }>(
    'SELECT selling_price, purchase_price FROM stock_items WHERE id = :id',
    { id: input.itemId },
  );
  if (!item) throw notFound('Stock item', input.itemId);
  if (input.side === 'purchase') return { rate: Number(item.purchase_price ?? 0) / 100, discountPct: 0, source: 'item_default' };
  if (input.priceLevelId !== undefined) {
    getPriceLevel(db, input.priceLevelId);
    const e = applicableSlabs(db, input.priceLevelId, input.date, [input.itemId]).get(input.itemId);
    const slab = e ? slabForQty(e.slabs, input.qty) : null;
    if (e && slab) return { rate: slab.rate, discountPct: slab.discountPct, source: 'price_list', applicableFrom: e.from };
  }
  return { rate: Number(item.selling_price ?? 0) / 100, discountPct: 0, source: 'item_default' };
}
