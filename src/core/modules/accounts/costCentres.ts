/**
 * Cost categories and cost centres (a tree of centres within each category).
 *
 * Rules: names are unique (centres: name and alias, case-insensitively); a centre's parent must be in
 * the same category; no cycles; changing a centre's category moves its whole sub-tree; delete only
 * when nothing depends on it (categories: no centres, not predefined; centres: no sub-centres, no
 * cost allocations in vouchers).
 */
import { randomUUID } from 'node:crypto';
import type {
  CostCategoryRow,
  CostCategorySaveInput,
  CostCentreListInput,
  CostCentreRow,
  CostCentreSaveInput,
  DeleteResult,
  ListResult,
} from '../../../shared/types/accounts.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { Issues, cleanText, plural, requirePermission, requireSavePermission } from './common.ts';

// ───────────────────────────── Categories ─────────────────────────────

interface CategoryDbRow {
  id: number;
  guid: string;
  name: string;
  allocate_revenue: number;
  allocate_non_revenue: number;
  is_predefined: number;
  created_at: string;
  updated_at: string;
  centre_count: number;
}

const CATEGORY_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM cost_centres cc WHERE cc.category_id = c.id) AS centre_count FROM cost_categories c`;

const toCategory = (r: CategoryDbRow): CostCategoryRow => ({
  id: r.id,
  guid: r.guid,
  name: r.name,
  allocateRevenue: r.allocate_revenue === 1,
  allocateNonRevenue: r.allocate_non_revenue === 1,
  isPredefined: r.is_predefined === 1,
  centreCount: r.centre_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listCostCategories(db: Db, input: { search?: string } = {}): ListResult<CostCategoryRow> {
  const term = input.search?.trim().toLowerCase();
  const rows = db
    .all<CategoryDbRow>(`${CATEGORY_SELECT} ORDER BY c.is_predefined DESC, c.name`)
    .map(toCategory)
    .filter((c) => !term || c.name.toLowerCase().includes(term));
  return { rows, total: rows.length };
}

export function getCostCategory(db: Db, id: number): CostCategoryRow {
  const r = db.get<CategoryDbRow>(`${CATEGORY_SELECT} WHERE c.id = :id`, { id });
  if (!r) throw notFound('Cost category', id);
  return toCategory(r);
}

export function saveCostCategory(ctx: CompanyCtx, input: CostCategorySaveInput): CostCategoryRow {
  requireSavePermission(ctx, input.id);
  const { db } = ctx;
  const id = db.transaction(() => {
    const before = input.id !== undefined ? getCostCategory(db, input.id) : null;
    const issues = new Issues();
    const name = input.name === undefined && before ? before.name : cleanText(input.name);
    if (!name) issues.add('name', 'Cost category name is required');
    else {
      const clash = db.value<string>('SELECT name FROM cost_categories WHERE name = :name AND id <> :id', { name, id: input.id ?? 0 });
      if (clash !== undefined) issues.add('name', `A cost category named '${clash}' already exists. Choose a different name.`);
    }
    issues.throwIfAny();
    const ts = ctx.clock.now().toISOString();
    const params = {
      name,
      rev: input.allocateRevenue ?? before?.allocateRevenue ?? true,
      nonRev: input.allocateNonRevenue ?? before?.allocateNonRevenue ?? false,
      ts,
    };
    let catId: number;
    let guid: string;
    if (!before) {
      guid = randomUUID();
      catId = db.run(
        `INSERT INTO cost_categories (guid, name, allocate_revenue, allocate_non_revenue, is_predefined, created_at, updated_at)
         VALUES (:guid, :name, :rev, :nonRev, 0, :ts, :ts)`,
        { ...params, guid },
      ).lastInsertRowid;
    } else {
      catId = before.id;
      guid = before.guid;
      db.run(
        'UPDATE cost_categories SET name = :name, allocate_revenue = :rev, allocate_non_revenue = :nonRev, updated_at = :ts WHERE id = :id',
        { ...params, id: catId },
      );
    }
    ctx.audit({
      action: before ? 'alter' : 'create',
      entityType: 'cost_category',
      entityId: catId,
      entityGuid: guid,
      entityLabel: name ?? '',
      before: before ?? undefined,
      after: getCostCategory(db, catId),
    });
    return catId;
  });
  return getCostCategory(db, id);
}

export function deleteCostCategory(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const before = getCostCategory(db, id);
    if (before.isPredefined) throw rule(`'${before.name}' is the predefined cost category and cannot be deleted. You can rename it.`);
    if (before.centreCount > 0) {
      throw rule(`Cost category '${before.name}' has ${plural(before.centreCount, 'cost centre')}. Move or delete them first.`);
    }
    db.run('DELETE FROM cost_categories WHERE id = :id', { id });
    ctx.audit({ action: 'delete', entityType: 'cost_category', entityId: id, entityGuid: before.guid, entityLabel: before.name, before });
    return { id, deleted: true };
  });
}

// ───────────────────────────── Centres ─────────────────────────────

interface CentreDbRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  category_id: number;
  category_name: string;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
}

/** All centres as rows in display order: by category name, then depth-first by name. */
function centreTree(db: Db): CostCentreRow[] {
  const all = db.all<CentreDbRow>(
    `SELECT cc.*, c.name AS category_name FROM cost_centres cc JOIN cost_categories c ON c.id = cc.category_id ORDER BY c.name, cc.name`,
  );
  const byId = new Map(all.map((r) => [r.id, r]));
  const children = new Map<number | null, CentreDbRow[]>();
  for (const r of all) {
    const key = r.parent_id !== null && byId.has(r.parent_id) ? r.parent_id : null;
    const list = children.get(key);
    if (list) list.push(r);
    else children.set(key, [r]);
  }
  const out: CostCentreRow[] = [];
  const seen = new Set<number>();
  const visit = (r: CentreDbRow, parent: CostCentreRow | null): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const row: CostCentreRow = {
      id: r.id,
      guid: r.guid,
      name: r.name,
      alias: r.alias,
      categoryId: r.category_id,
      categoryName: r.category_name,
      parentId: r.parent_id,
      parentName: parent?.name ?? null,
      depth: parent ? parent.depth + 1 : 0,
      path: parent ? [...parent.path, r.name] : [r.name],
      childCount: (children.get(r.id) ?? []).length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    out.push(row);
    for (const c of children.get(r.id) ?? []) visit(c, row);
  };
  for (const r of children.get(null) ?? []) visit(r, null);
  return out;
}

export function listCostCentres(db: Db, input: CostCentreListInput = {}): ListResult<CostCentreRow> {
  const term = input.search?.trim().toLowerCase();
  const rows = centreTree(db).filter(
    (r) =>
      (input.categoryId === undefined || r.categoryId === input.categoryId) &&
      (!term || r.name.toLowerCase().includes(term) || (r.alias ?? '').toLowerCase().includes(term)),
  );
  return { rows, total: rows.length };
}

export function getCostCentre(db: Db, id: number): CostCentreRow {
  const row = centreTree(db).find((r) => r.id === id);
  if (!row) throw notFound('Cost centre', id);
  return row;
}

function centreDescendants(db: Db, id: number): number[] {
  return db
    .all<{ id: number }>(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM cost_centres WHERE parent_id = :id
                                  UNION SELECT c.id FROM cost_centres c JOIN sub s ON c.parent_id = s.id)
       SELECT id FROM sub`,
      { id },
    )
    .map((r) => r.id);
}

export function saveCostCentre(ctx: CompanyCtx, input: CostCentreSaveInput): CostCentreRow {
  requireSavePermission(ctx, input.id);
  const { db } = ctx;
  const id = db.transaction(() => {
    const before = input.id !== undefined ? getCostCentre(db, input.id) : null;
    const issues = new Issues();
    const name = input.name === undefined && before ? before.name : cleanText(input.name);
    let alias = input.alias === undefined ? (before?.alias ?? null) : cleanText(input.alias);
    if (!name) issues.add('name', 'Cost centre name is required');
    if (alias && name && alias.toLowerCase() === name.toLowerCase()) alias = null;

    const categoryId = input.categoryId ?? before?.categoryId;
    if (categoryId === undefined) issues.add('categoryId', 'Choose the cost category of this cost centre');
    else if (db.value('SELECT 1 FROM cost_categories WHERE id = :id', { id: categoryId }) === undefined) {
      issues.add('categoryId', 'The selected cost category does not exist');
    }

    const parentId = input.parentId === undefined ? (before?.parentId ?? null) : input.parentId;
    if (parentId !== null) {
      const parent = db.get<{ category_id: number; name: string }>('SELECT category_id, name FROM cost_centres WHERE id = :id', { id: parentId });
      if (!parent) issues.add('parentId', 'The selected parent cost centre does not exist');
      else if (before && (parentId === before.id || centreDescendants(db, before.id).includes(parentId))) {
        issues.add('parentId', 'A cost centre cannot be placed under itself or under one of its own sub-centres');
      } else if (categoryId !== undefined && parent.category_id !== categoryId) {
        issues.add('parentId', `Parent cost centre '${parent.name}' belongs to another cost category. Choose a parent in the same category, or none.`);
      }
    }

    const clash = (value: string): string | undefined =>
      db.value<string>('SELECT name FROM cost_centres WHERE (name = :v OR alias = :v COLLATE NOCASE) AND id <> :id LIMIT 1', {
        v: value,
        id: before?.id ?? 0,
      });
    if (name) {
      const c = clash(name);
      if (c !== undefined) issues.add('name', `A cost centre named '${c}' (or with that alias) already exists. Choose a different name.`);
    }
    if (alias) {
      const c = clash(alias);
      if (c !== undefined) issues.add('alias', `Alias '${alias}' is already used by cost centre '${c}'. Choose a different alias.`);
    }
    issues.throwIfAny();

    const ts = ctx.clock.now().toISOString();
    let centreId: number;
    let guid: string;
    if (!before) {
      guid = randomUUID();
      centreId = db.run(
        `INSERT INTO cost_centres (guid, name, alias, category_id, parent_id, created_at, updated_at)
         VALUES (:guid, :name, :alias, :categoryId, :parentId, :ts, :ts)`,
        { guid, name, alias, categoryId, parentId, ts },
      ).lastInsertRowid;
    } else {
      centreId = before.id;
      guid = before.guid;
      db.run(
        'UPDATE cost_centres SET name = :name, alias = :alias, category_id = :categoryId, parent_id = :parentId, updated_at = :ts WHERE id = :id',
        { name, alias, categoryId, parentId, ts, id: centreId },
      );
      if (categoryId !== before.categoryId) {
        // The whole sub-tree moves with it.
        db.run(
          `WITH RECURSIVE sub(id) AS (SELECT id FROM cost_centres WHERE parent_id = :id
                                      UNION SELECT c.id FROM cost_centres c JOIN sub s ON c.parent_id = s.id)
           UPDATE cost_centres SET category_id = :categoryId, updated_at = :ts WHERE id IN (SELECT id FROM sub)`,
          { id: centreId, categoryId, ts },
        );
      }
    }
    ctx.audit({
      action: before ? 'alter' : 'create',
      entityType: 'cost_centre',
      entityId: centreId,
      entityGuid: guid,
      entityLabel: name ?? '',
      before: before ?? undefined,
      after: getCostCentre(db, centreId),
    });
    return centreId;
  });
  return getCostCentre(db, id);
}

export function deleteCostCentre(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const before = getCostCentre(db, id);
    if (before.childCount > 0) {
      throw rule(`Cost centre '${before.name}' has ${plural(before.childCount, 'sub-centre')}. Move or delete them first.`);
    }
    const vouchers = db.value<number>('SELECT COUNT(DISTINCT voucher_id) FROM cost_allocations WHERE cost_centre_id = :id', { id }) ?? 0;
    if (vouchers > 0) {
      throw rule(`Cost centre '${before.name}' cannot be deleted: it is used in ${plural(vouchers, 'voucher')}.`, { vouchers });
    }
    db.run('DELETE FROM cost_centres WHERE id = :id', { id });
    ctx.audit({ action: 'delete', entityType: 'cost_centre', entityId: id, entityGuid: before.guid, entityLabel: before.name, before });
    return { id, deleted: true };
  });
}
