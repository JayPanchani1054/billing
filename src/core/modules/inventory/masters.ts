/**
 * Tree masters: stock groups (with GST details and effective-dated GST history), stock categories
 * and godowns ('Main Location' is predefined and cannot be deleted).
 */
import { randomUUID } from 'node:crypto';
import type {
  DeleteResult,
  GodownDto,
  GodownSaveInput,
  ListResult,
  StockCategoryDto,
  StockCategorySaveInput,
  StockGroupDetail,
  StockGroupDto,
  StockGroupSaveInput,
  TreeListInput,
} from '../../../shared/types/inventory.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import {
  ancestors,
  assertNameFree,
  assertUnused,
  assertValidParent,
  cleanText,
  countOf,
  likePattern,
  nowIso,
  paging,
  patch,
  requirePermission,
  requireSavePermission,
  toBool,
  type TreeTable,
} from './common.ts';
import { deleteGstHistory, detailsFromColumns, listGstHistory, normalizeGstDetails, syncGstHistory } from './gst.ts';

export function booksFrom(db: Db): string {
  const d = db.value<string>('SELECT books_from FROM company WHERE id = 1');
  if (!d) throw notFound('Company');
  return d;
}

function treeWhere(table: TreeTable): string {
  return `WHERE (:like IS NULL OR t.name LIKE :like ESCAPE '\\' OR t.alias LIKE :like ESCAPE '\\')
            AND (:anyParent = 1 OR t.parent_id IS :parentId)`;
}

function treeParams(input: TreeListInput): Record<string, string | number | null> {
  return {
    like: likePattern(input.search),
    anyParent: input.parentId === undefined ? 1 : 0,
    parentId: input.parentId ?? null,
  };
}

function nameAndAlias(
  db: Db,
  table: TreeTable,
  noun: string,
  id: number | null,
  name: string | undefined,
  alias: string | null | undefined,
  current: { name: string; alias: string | null } | null,
): { name: string; alias: string | null } {
  const n = (name ?? current?.name ?? '').trim();
  if (!n) throw validation([{ path: 'name', message: `Enter the ${noun.toLowerCase()} name` }]);
  const a = patch(cleanText(alias), current?.alias ?? null);
  assertNameFree(db, table, n, id, 'name', noun);
  if (a !== null) {
    if (a.toLowerCase() === n.toLowerCase()) throw validation([{ path: 'alias', message: 'The alias must be different from the name' }]);
    assertNameFree(db, table, a, id, 'alias', noun);
  }
  return { name: n, alias: a };
}

// ───────────────────────────── Stock groups ─────────────────────────────

interface StockGroupRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parent_id: number | null;
  parent_name: string | null;
  add_quantities: number;
  gst_applicable: string;
  hsn_sac: string | null;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  cess_per_unit: number;
  child_count: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_GROUP = /* sql */ `
  SELECT t.*, p.name AS parent_name,
         (SELECT COUNT(*) FROM stock_groups c WHERE c.parent_id = t.id) AS child_count,
         (SELECT COUNT(*) FROM stock_items i WHERE i.group_id = t.id) AS item_count
  FROM stock_groups t LEFT JOIN stock_groups p ON p.id = t.parent_id`;

function groupDto(r: StockGroupRow): StockGroupDto {
  const gst = detailsFromColumns(r);
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    parentId: r.parent_id,
    parentName: r.parent_name,
    addQuantities: toBool(r.add_quantities),
    gstApplicable: gst.applicable,
    hsnSac: r.hsn_sac,
    taxability: r.gst_taxability === null ? null : gst.taxability,
    gstRate: r.gst_rate,
    cessRate: r.cess_rate,
    cessPerUnit: Number(r.cess_per_unit ?? 0),
    childCount: Number(r.child_count),
    itemCount: Number(r.item_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listStockGroups(db: Db, input: TreeListInput = {}): ListResult<StockGroupDto> {
  const { limit, offset } = paging(input);
  const params = treeParams(input);
  const where = treeWhere('stock_groups');
  const total = countOf(db, `SELECT COUNT(*) FROM stock_groups t ${where}`, params);
  const rows = db.all<StockGroupRow>(`${SELECT_GROUP} ${where} ORDER BY t.name COLLATE NOCASE LIMIT :limit OFFSET :offset`, {
    ...params,
    limit,
    offset,
  });
  return { rows: rows.map(groupDto), total };
}

export function getStockGroup(db: Db, id: number): StockGroupDetail {
  const row = db.get<StockGroupRow>(`${SELECT_GROUP} WHERE t.id = :id`, { id });
  if (!row) throw notFound('Stock group', id);
  return { ...groupDto(row), gstHistory: listGstHistory(db, 'stock_group', id), path: ancestors(db, 'stock_groups', id) };
}

export function saveStockGroup(ctx: CompanyCtx, input: StockGroupSaveInput): StockGroupDetail {
  requireSavePermission(ctx, input.id, 'stock groups');
  const { db } = ctx;
  const before = input.id !== undefined ? getStockGroup(db, input.id) : null;
  const id0 = before?.id ?? null;
  const { name, alias } = nameAndAlias(db, 'stock_groups', 'Stock group', id0, input.name, input.alias, before);
  const parentId = patch(input.parentId, before?.parentId ?? null);
  assertValidParent(db, 'stock_groups', id0, parentId, 'stock group');
  const addQuantities = input.addQuantities ?? before?.addQuantities ?? true;
  const prevGst = before
    ? {
        applicable: before.gstApplicable,
        hsnSac: before.hsnSac,
        taxability: before.taxability ?? 'taxable',
        rate: before.gstRate,
        cessRate: before.cessRate,
        cessPerUnit: before.cessPerUnit,
      }
    : null;
  const gst = normalizeGstDetails(input, prevGst, null);
  const ts = nowIso(ctx);
  const params = {
    name,
    alias,
    parentId,
    addQ: addQuantities,
    app: gst.applicable ? 'applicable' : 'not_applicable',
    hsn: gst.hsnSac,
    tax: gst.applicable || gst.taxability !== 'taxable' ? gst.taxability : null,
    rate: gst.rate,
    cess: gst.cessRate,
    cpu: gst.cessPerUnit,
    ts,
  };
  let id: number;
  if (before) {
    id = before.id;
    db.run(
      `UPDATE stock_groups SET name = :name, alias = :alias, parent_id = :parentId, add_quantities = :addQ, gst_applicable = :app,
              hsn_sac = :hsn, gst_taxability = :tax, gst_rate = :rate, cess_rate = :cess, cess_per_unit = :cpu, updated_at = :ts
       WHERE id = :id`,
      { ...params, id },
    );
  } else {
    id = db.run(
      `INSERT INTO stock_groups (guid, name, alias, parent_id, add_quantities, gst_applicable, hsn_sac, gst_taxability, gst_rate,
                                 cess_rate, cess_per_unit, created_at, updated_at)
       VALUES (:guid, :name, :alias, :parentId, :addQ, :app, :hsn, :tax, :rate, :cess, :cpu, :ts, :ts)`,
      { ...params, guid: randomUUID() },
    ).lastInsertRowid;
  }
  syncGstHistory(db, 'stock_group', id, name, prevGst, gst, input.gstApplicableFrom, booksFrom(db));
  const after = getStockGroup(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'stock_group',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.name,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function deleteStockGroup(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete stock groups');
  const { db } = ctx;
  const before = getStockGroup(db, id);
  assertUnused('stock group', before.name, [
    [before.childCount, 'sub-group(s)'],
    [before.itemCount, 'stock item(s)'],
  ]);
  deleteGstHistory(db, 'stock_group', id);
  db.run('DELETE FROM stock_groups WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'stock_group', entityId: id, entityGuid: before.guid, entityLabel: before.name, before });
  return { id, deleted: true };
}

// ───────────────────────────── Stock categories ─────────────────────────────

interface CategoryRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parent_id: number | null;
  parent_name: string | null;
  child_count: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_CATEGORY = /* sql */ `
  SELECT t.*, p.name AS parent_name,
         (SELECT COUNT(*) FROM stock_categories c WHERE c.parent_id = t.id) AS child_count,
         (SELECT COUNT(*) FROM stock_items i WHERE i.category_id = t.id) AS item_count
  FROM stock_categories t LEFT JOIN stock_categories p ON p.id = t.parent_id`;

function categoryDto(r: CategoryRow): StockCategoryDto {
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    parentId: r.parent_id,
    parentName: r.parent_name,
    childCount: Number(r.child_count),
    itemCount: Number(r.item_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listStockCategories(db: Db, input: TreeListInput = {}): ListResult<StockCategoryDto> {
  const { limit, offset } = paging(input);
  const params = treeParams(input);
  const where = treeWhere('stock_categories');
  const total = countOf(db, `SELECT COUNT(*) FROM stock_categories t ${where}`, params);
  const rows = db.all<CategoryRow>(`${SELECT_CATEGORY} ${where} ORDER BY t.name COLLATE NOCASE LIMIT :limit OFFSET :offset`, {
    ...params,
    limit,
    offset,
  });
  return { rows: rows.map(categoryDto), total };
}

export function getStockCategory(db: Db, id: number): StockCategoryDto {
  const row = db.get<CategoryRow>(`${SELECT_CATEGORY} WHERE t.id = :id`, { id });
  if (!row) throw notFound('Stock category', id);
  return categoryDto(row);
}

export function saveStockCategory(ctx: CompanyCtx, input: StockCategorySaveInput): StockCategoryDto {
  requireSavePermission(ctx, input.id, 'stock categories');
  const { db } = ctx;
  const before = input.id !== undefined ? getStockCategory(db, input.id) : null;
  const id0 = before?.id ?? null;
  const { name, alias } = nameAndAlias(db, 'stock_categories', 'Stock category', id0, input.name, input.alias, before);
  const parentId = patch(input.parentId, before?.parentId ?? null);
  assertValidParent(db, 'stock_categories', id0, parentId, 'stock category');
  const ts = nowIso(ctx);
  let id: number;
  if (before) {
    id = before.id;
    db.run('UPDATE stock_categories SET name = :name, alias = :alias, parent_id = :parentId, updated_at = :ts WHERE id = :id', {
      id,
      name,
      alias,
      parentId,
      ts,
    });
  } else {
    id = db.run(
      `INSERT INTO stock_categories (guid, name, alias, parent_id, created_at, updated_at) VALUES (:guid, :name, :alias, :parentId, :ts, :ts)`,
      { guid: randomUUID(), name, alias, parentId, ts },
    ).lastInsertRowid;
  }
  const after = getStockCategory(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'stock_category',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.name,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function deleteStockCategory(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete stock categories');
  const { db } = ctx;
  const before = getStockCategory(db, id);
  assertUnused('stock category', before.name, [
    [before.childCount, 'sub-categor(ies)'],
    [before.itemCount, 'stock item(s)'],
  ]);
  db.run('DELETE FROM stock_categories WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'stock_category', entityId: id, entityGuid: before.guid, entityLabel: before.name, before });
  return { id, deleted: true };
}

// ───────────────────────────── Godowns ─────────────────────────────

interface GodownRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parent_id: number | null;
  parent_name: string | null;
  address: string | null;
  is_predefined: number;
  is_third_party: number;
  child_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_GODOWN = /* sql */ `
  SELECT t.*, p.name AS parent_name, (SELECT COUNT(*) FROM godowns c WHERE c.parent_id = t.id) AS child_count
  FROM godowns t LEFT JOIN godowns p ON p.id = t.parent_id`;

function godownDto(r: GodownRow): GodownDto {
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    parentId: r.parent_id,
    parentName: r.parent_name,
    address: r.address,
    isPredefined: toBool(r.is_predefined),
    isThirdParty: toBool(r.is_third_party),
    childCount: Number(r.child_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Id of the predefined 'Main Location' godown. */
export function mainGodownId(db: Db): number {
  const id = db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1');
  if (id === undefined) throw rule("The predefined godown 'Main Location' is missing from this company.");
  return id;
}

export function listGodowns(db: Db, input: TreeListInput = {}): ListResult<GodownDto> {
  const { limit, offset } = paging(input);
  const params = treeParams(input);
  const where = treeWhere('godowns');
  const total = countOf(db, `SELECT COUNT(*) FROM godowns t ${where}`, params);
  const rows = db.all<GodownRow>(
    `${SELECT_GODOWN} ${where} ORDER BY t.is_predefined DESC, t.name COLLATE NOCASE LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  );
  return { rows: rows.map(godownDto), total };
}

export function getGodown(db: Db, id: number): GodownDto {
  const row = db.get<GodownRow>(`${SELECT_GODOWN} WHERE t.id = :id`, { id });
  if (!row) throw notFound('Godown', id);
  return godownDto(row);
}

export function saveGodown(ctx: CompanyCtx, input: GodownSaveInput): GodownDto {
  requireSavePermission(ctx, input.id, 'godowns');
  const { db } = ctx;
  const before = input.id !== undefined ? getGodown(db, input.id) : null;
  const id0 = before?.id ?? null;
  const { name, alias } = nameAndAlias(db, 'godowns', 'Godown', id0, input.name, input.alias, before);
  const parentId = patch(input.parentId, before?.parentId ?? null);
  assertValidParent(db, 'godowns', id0, parentId, 'godown');
  const address = patch(cleanText(input.address), before?.address ?? null);
  const isThirdParty = input.isThirdParty ?? before?.isThirdParty ?? false;
  if (before?.isPredefined && isThirdParty)
    throw validation([{ path: 'isThirdParty', message: "'Main Location' is your own godown; it cannot be marked as a third-party location" }]);
  const ts = nowIso(ctx);
  let id: number;
  if (before) {
    id = before.id;
    db.run(
      `UPDATE godowns SET name = :name, alias = :alias, parent_id = :parentId, address = :address, is_third_party = :tp, updated_at = :ts
       WHERE id = :id`,
      { id, name, alias, parentId, address, tp: isThirdParty, ts },
    );
  } else {
    id = db.run(
      `INSERT INTO godowns (guid, name, alias, parent_id, address, is_predefined, is_third_party, created_at, updated_at)
       VALUES (:guid, :name, :alias, :parentId, :address, 0, :tp, :ts, :ts)`,
      { guid: randomUUID(), name, alias, parentId, address, tp: isThirdParty, ts },
    ).lastInsertRowid;
  }
  const after = getGodown(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'godown',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.name,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function deleteGodown(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete godowns');
  const { db } = ctx;
  const before = getGodown(db, id);
  if (before.isPredefined) throw rule(`'${before.name}' is the predefined main godown and cannot be deleted.`);
  assertUnused('godown', before.name, [
    [before.childCount, 'sub-godown(s)'],
    [countOf(db, 'SELECT COUNT(DISTINCT item_id) FROM stock_openings WHERE godown_id = :id', { id }), 'opening stock row(s)'],
    [countOf(db, 'SELECT COUNT(DISTINCT voucher_id) FROM inventory_entries WHERE godown_id = :id', { id }), 'voucher(s)'],
  ]);
  db.run('DELETE FROM godowns WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'godown', entityId: id, entityGuid: before.guid, entityLabel: before.name, before });
  return { id, deleted: true };
}
