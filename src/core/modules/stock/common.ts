/**
 * Shared helpers of the stock reports: input checks, master lookups (items, stock groups,
 * categories, godowns as trees) and the movement loader. Every SQL value is a bound parameter; the
 * only interpolated fragment is the inventory module's constant STOCK_MOVEMENT_FILTER.
 */
import { roundTo } from '../../../shared/money.ts';
import type { CostingMethod } from '../../../shared/types/inventory.ts';
import type { Db } from '../../db/db.ts';
import { notFound, validation } from '../../lib/errors.ts';
import { godownSet, roundQty, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';

export { roundQty };

export const EPS = 1e-9;

/** JSON array of ids for `IN (SELECT value FROM json_each(:ids))`. */
export function jsonIds(ids: Iterable<number>): string {
  return JSON.stringify([...ids].filter((n) => Number.isSafeInteger(n)));
}

/** VALIDATION when the period is reversed. */
export function assertPeriod(from: string, to: string): void {
  if (from > to) throw validation([{ path: 'to', message: 'The period ends before it starts. Choose an end date on or after the start date.' }]);
}

/** Rupees per unit from paise ÷ qty (4 decimals); null when the quantity is null or ~0. */
export function rateOf(value: number, qty: number | null): number | null {
  if (qty === null || Math.abs(qty) < EPS) return null;
  return roundTo(value / qty / 100, 4);
}

export function booksBegin(db: Db): string {
  return db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? '0000-01-01';
}

export function mainGodown(db: Db): number | null {
  return db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? null;
}

// ───────────────────────────── Masters ─────────────────────────────

export interface ItemMeta {
  id: number;
  name: string;
  unit: string;
  unitDecimals: number;
  groupId: number | null;
  categoryId: number | null;
  costingMethod: CostingMethod;
  isService: boolean;
  reorderLevel: number | null;
  minOrderQty: number | null;
  maintainBatches: boolean;
}

interface ItemDbRow {
  id: number;
  name: string;
  unit: string;
  decimals: number;
  group_id: number | null;
  category_id: number | null;
  costing_method: string;
  is_service: number;
  reorder_level: number | null;
  min_order_qty: number | null;
  maintain_batches: number;
}

const ITEM_SQL = `SELECT i.id, i.name, u.symbol AS unit, u.decimal_places AS decimals, i.group_id, i.category_id, i.costing_method,
         i.is_service, i.reorder_level, i.min_order_qty, i.maintain_batches
    FROM stock_items i JOIN units u ON u.id = i.unit_id`;

function toItem(r: ItemDbRow): ItemMeta {
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    unitDecimals: r.decimals,
    groupId: r.group_id,
    categoryId: r.category_id,
    costingMethod: r.costing_method as CostingMethod,
    isService: r.is_service === 1,
    reorderLevel: r.reorder_level,
    minOrderQty: r.min_order_qty,
    maintainBatches: r.maintain_batches === 1,
  };
}

/** All stock items by id (name order kept in iteration order). */
export function loadItems(db: Db): Map<number, ItemMeta> {
  const out = new Map<number, ItemMeta>();
  for (const r of db.all<ItemDbRow>(`${ITEM_SQL} ORDER BY i.name COLLATE NOCASE, i.id`)) out.set(r.id, toItem(r));
  return out;
}

export function getItemMeta(db: Db, itemId: number): ItemMeta {
  const r = db.get<ItemDbRow>(`${ITEM_SQL} WHERE i.id = :id`, { id: itemId });
  if (!r) throw notFound('Stock item', itemId);
  return toItem(r);
}

export interface TreeNode {
  id: number;
  name: string;
  parentId: number | null;
  /** stock_groups.add_quantities (groups); true otherwise. */
  addQuantities: boolean;
  isThirdParty: boolean;
}

export type TreeKind = 'group' | 'category' | 'godown';

/** Groups / categories / godowns by id. The table name is chosen from a constant map (never user input). */
export function loadTree(db: Db, kind: TreeKind): Map<number, TreeNode> {
  const sql =
    kind === 'group'
      ? 'SELECT id, name, parent_id, add_quantities AS addq, 0 AS third FROM stock_groups ORDER BY name COLLATE NOCASE, id'
      : kind === 'category'
        ? 'SELECT id, name, parent_id, 1 AS addq, 0 AS third FROM stock_categories ORDER BY name COLLATE NOCASE, id'
        : 'SELECT id, name, parent_id, 1 AS addq, is_third_party AS third FROM godowns ORDER BY is_predefined DESC, name COLLATE NOCASE, id';
  const out = new Map<number, TreeNode>();
  for (const r of db.all<{ id: number; name: string; parent_id: number | null; addq: number; third: number }>(sql)) {
    out.set(r.id, { id: r.id, name: r.name, parentId: r.parent_id, addQuantities: r.addq === 1, isThirdParty: r.third === 1 });
  }
  return out;
}

/** The node and every node under it. */
export function descendants(tree: Map<number, TreeNode>, rootId: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const n of tree.values()) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const out = new Set<number>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    for (const c of children.get(id) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

const TREE_LABEL: Record<TreeKind, string> = { group: 'Stock group', category: 'Stock category', godown: 'Godown' };

/** NOT_FOUND unless the id exists in the tree. */
export function requireNode(tree: Map<number, TreeNode>, kind: TreeKind, id: number): TreeNode {
  const n = tree.get(id);
  if (!n) throw notFound(TREE_LABEL[kind], id);
  return n;
}

/** Item ids of a stock group subtree (null = every item). */
export function itemsInGroup(db: Db, groupId: number | undefined): Set<number> | null {
  if (groupId === undefined) return null;
  const tree = loadTree(db, 'group');
  requireNode(tree, 'group', groupId);
  const groups = descendants(tree, groupId);
  const out = new Set<number>();
  for (const r of db.all<{ id: number; group_id: number | null }>('SELECT id, group_id FROM stock_items')) {
    if (r.group_id !== null && groups.has(r.group_id)) out.add(r.id);
  }
  return out;
}

/** Godown ids for a filter: the godown and every godown under it (null = all godowns). */
export function godownScope(db: Db, godownId: number | undefined | null): Set<number> | null {
  if (godownId === undefined || godownId === null) return null;
  if (db.value('SELECT 1 FROM godowns WHERE id = :id', { id: godownId }) === undefined) throw notFound('Godown', godownId);
  return godownSet(db, godownId, true);
}

// ───────────────────────────── Movements ─────────────────────────────

/** One inventory_entries row that moves stock (the engine's STOCK_MOVEMENT_FILTER). */
export interface MovementRow {
  id: number;
  voucherId: number;
  lineNo: number;
  itemId: number;
  /** Main Location when the entry has none. */
  godownId: number | null;
  batchName: string | null;
  qty: number;
  amount: number;
  rate: number;
  discountPct: number;
  date: string;
  baseType: string;
}

interface MovementDbRow {
  id: number;
  voucher_id: number;
  line_no: number;
  item_id: number;
  godown_id: number | null;
  batch_name: string | null;
  qty: number;
  amount: number;
  rate: number;
  discount_pct: number;
  date: string;
  base_type: string;
}

export interface MovementQuery {
  from?: string;
  to: string;
  today: string;
  /** null/undefined = every item. */
  itemIds?: Iterable<number> | null;
}

/**
 * Stock movements (non-zero quantities) in [from, to] in the engine's replay order: date, voucher
 * id, line, entry id.
 */
export function loadMovements(db: Db, q: MovementQuery): MovementRow[] {
  const filter = q.itemIds === undefined || q.itemIds === null ? 0 : 1;
  const rows = db.all<MovementDbRow>(
    `SELECT ie.id, ie.voucher_id, ie.line_no, ie.item_id, COALESCE(ie.godown_id, :main) AS godown_id, ie.batch_name, ie.qty,
            ie.amount, ie.rate, ie.discount_pct, ie.date, v.base_type
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.date >= :from AND ie.date <= :to AND ie.qty <> 0 AND ${STOCK_MOVEMENT_FILTER}
        AND (:filter = 0 OR ie.item_id IN (SELECT value FROM json_each(:ids)))
      ORDER BY ie.date, ie.voucher_id, ie.line_no, ie.id`,
    {
      from: q.from ?? '0000-01-01',
      to: q.to,
      today: q.today,
      main: mainGodown(db),
      filter,
      ids: filter ? jsonIds(q.itemIds as Iterable<number>) : '[]',
    },
  );
  return rows.map((r) => ({
    id: r.id,
    voucherId: r.voucher_id,
    lineNo: r.line_no,
    itemId: r.item_id,
    godownId: r.godown_id,
    batchName: r.batch_name,
    qty: Number(r.qty),
    amount: Number(r.amount),
    rate: Number(r.rate),
    discountPct: Number(r.discount_pct ?? 0),
    date: r.date,
    baseType: r.base_type,
  }));
}

/** Sum quantities, null when units differ. */
export class QtySum {
  unit: string | null | undefined = undefined;
  qty = 0;
  add(unit: string, qty: number): void {
    if (this.unit === undefined) this.unit = unit;
    else if (this.unit !== null && this.unit.toLowerCase() !== unit.toLowerCase()) this.unit = null;
    this.qty += qty;
  }
  /** Mixed units → null; nothing added → 0. */
  result(): number | null {
    return this.unit === null ? null : roundQty(this.qty);
  }
  commonUnit(): string | null {
    return this.unit ?? null;
  }
}
