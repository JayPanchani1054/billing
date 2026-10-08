/**
 * Stock Summary (by stock group or by stock category) and Godown Summary.
 *
 * Values come straight from the inventory valuation engine (`computeStockValuation`) — the same
 * figures as the closing stock in the P&L and Balance Sheet. With `showValues: false` no valuation
 * runs: quantities are added up from the movements directly (fast) and every value is 0.
 *
 * Tree rules (Tally): sub-groups first, then items, each by name. A group's quantity is the sum of
 * its items' quantities only when the group has "Add quantities" on and all its items share one
 * unit; otherwise null (values always add up). Categories add quantities whenever the units agree.
 */
import { roundPaise } from '../../../shared/money.ts';
import type {
  GodownSummaryInput,
  GodownSummaryResult,
  GodownSummaryRow,
  StockCategorySummaryInput,
  StockSummaryInput,
  StockSummaryResult,
  StockSummaryRow,
} from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { computeStockValuation, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';
import {
  assertPeriod,
  descendants,
  EPS,
  godownScope,
  jsonIds,
  loadItems,
  loadTree,
  mainGodown,
  QtySum,
  rateOf,
  requireNode,
  roundQty,
  type ItemMeta,
  type TreeNode,
} from './common.ts';

interface Figures {
  openQty: number;
  openValue: number;
  inQty: number;
  inValue: number;
  outQty: number;
  outValue: number;
  closeQty: number;
  closeValue: number;
}

const ZERO: Figures = { openQty: 0, openValue: 0, inQty: 0, inValue: 0, outQty: 0, outValue: 0, closeQty: 0, closeValue: 0 };

function isZero(f: Figures): boolean {
  return (
    Math.abs(f.openQty) < EPS &&
    f.openValue === 0 &&
    Math.abs(f.inQty) < EPS &&
    f.inValue === 0 &&
    Math.abs(f.outQty) < EPS &&
    f.outValue === 0 &&
    Math.abs(f.closeQty) < EPS &&
    f.closeValue === 0
  );
}

/** Quantities only: opening (stock_openings + movements before `from`), inward/outward in the period. */
function quantityFigures(db: Db, q: { from: string; to: string; today: string; godowns: Set<number> | null }): Map<number, Figures> {
  const gf = q.godowns ? 1 : 0;
  const gids = q.godowns ? jsonIds(q.godowns) : '[]';
  const rows = db.all<{ item_id: number; open_q: number; in_q: number; out_q: number }>(
    `SELECT item_id, SUM(open_q) AS open_q, SUM(in_q) AS in_q, SUM(out_q) AS out_q FROM (
       SELECT item_id, qty AS open_q, 0 AS in_q, 0 AS out_q FROM stock_openings
        WHERE (:gf = 0 OR godown_id IN (SELECT value FROM json_each(:gids)))
       UNION ALL
       SELECT ie.item_id,
              CASE WHEN ie.date < :from THEN ie.qty ELSE 0 END,
              CASE WHEN ie.date >= :from AND ie.qty > 0 THEN ie.qty ELSE 0 END,
              CASE WHEN ie.date >= :from AND ie.qty < 0 THEN -ie.qty ELSE 0 END
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.date <= :to AND ${STOCK_MOVEMENT_FILTER}
          AND (:gf = 0 OR COALESCE(ie.godown_id, :main) IN (SELECT value FROM json_each(:gids)))
     ) GROUP BY item_id`,
    { from: q.from, to: q.to, today: q.today, gf, gids, main: mainGodown(db) },
  );
  const out = new Map<number, Figures>();
  for (const r of rows) {
    const open = roundQty(Number(r.open_q));
    const inq = roundQty(Number(r.in_q));
    const outq = roundQty(Number(r.out_q));
    out.set(r.item_id, { ...ZERO, openQty: open, inQty: inq, outQty: outq, closeQty: roundQty(open + inq - outq) });
  }
  return out;
}

function valuedFigures(db: Db, q: { from: string; to: string; today: string; godownId: number | null }): Map<number, Figures> {
  const res = computeStockValuation(db, { from: q.from, to: q.to, today: q.today, godownId: q.godownId, includeSubGodowns: true });
  const out = new Map<number, Figures>();
  for (const r of res.rows) {
    out.set(r.itemId, {
      openQty: r.opening.qty,
      openValue: r.opening.value,
      inQty: r.inward.qty,
      inValue: r.inward.value,
      outQty: r.outward.qty,
      outValue: r.outward.value,
      closeQty: r.closing.qty,
      closeValue: r.closing.value,
    });
  }
  return out;
}

class Agg {
  open = new QtySum();
  inw = new QtySum();
  outw = new QtySum();
  close = new QtySum();
  openValue = 0;
  inValue = 0;
  outValue = 0;
  closeValue = 0;
  add(unit: string, f: Figures): void {
    this.open.add(unit, f.openQty);
    this.inw.add(unit, f.inQty);
    this.outw.add(unit, f.outQty);
    this.close.add(unit, f.closeQty);
    this.openValue += f.openValue;
    this.inValue += f.inValue;
    this.outValue += f.outValue;
    this.closeValue += f.closeValue;
  }
  merge(o: Agg): void {
    for (const [a, b] of [
      [this.open, o.open],
      [this.inw, o.inw],
      [this.outw, o.outw],
      [this.close, o.close],
    ] as const) {
      if (b.unit === undefined) continue;
      if (b.unit === null) a.unit = null;
      else a.add(b.unit, b.qty);
    }
    this.openValue += o.openValue;
    this.inValue += o.inValue;
    this.outValue += o.outValue;
    this.closeValue += o.closeValue;
  }
}

interface TreeBuild {
  nodes: Map<number, TreeNode>;
  kind: 'group' | 'category';
  items: ItemMeta[];
  figures: Map<number, Figures>;
  parentOf: (item: ItemMeta) => number | null;
  /** Show the children of this node at level 0 (null: the whole tree). */
  rootId: number | null;
  /** Bucket for items without a node (categories: "Not categorised"); null → items stay at the top level. */
  noneBucket: string | null;
}

function summaryRow(
  key: string,
  kind: StockSummaryRow['kind'],
  id: number | null,
  name: string,
  level: number,
  parentKey: string | null,
  agg: Agg,
  opts: { addQty: boolean; unit: string | null; hasChildren: boolean; costing: ItemMeta['costingMethod'] | null },
): StockSummaryRow {
  const q = (s: QtySum): number | null => (opts.addQty ? s.result() : null);
  const closeQty = q(agg.close);
  const unit = opts.addQty ? (opts.unit ?? agg.close.commonUnit()) : null;
  return {
    key,
    kind,
    id,
    name,
    level,
    parentKey,
    hasChildren: opts.hasChildren,
    unit,
    costingMethod: opts.costing,
    opening: { qty: q(agg.open), value: agg.openValue },
    inward: { qty: q(agg.inw), value: agg.inValue },
    outward: { qty: q(agg.outw), value: agg.outValue },
    closing: { qty: closeQty, value: agg.closeValue, rate: rateOf(agg.closeValue, closeQty) },
  };
}

function buildTree(b: TreeBuild): { rows: StockSummaryRow[]; total: Agg } {
  const prefix = b.kind === 'group' ? 'g' : 'c';
  const childNodes = new Map<number | null, TreeNode[]>();
  for (const n of b.nodes.values()) {
    const list = childNodes.get(n.parentId) ?? [];
    list.push(n);
    childNodes.set(n.parentId, list);
  }
  const itemsOf = new Map<number | null, ItemMeta[]>();
  for (const it of b.items) {
    let p = b.parentOf(it);
    if (p !== null && !b.nodes.has(p)) p = null;
    const list = itemsOf.get(p) ?? [];
    list.push(it);
    itemsOf.set(p, list);
  }

  const itemRow = (it: ItemMeta, level: number, parentKey: string | null): { row: StockSummaryRow; agg: Agg } => {
    const agg = new Agg();
    agg.add(it.unit, b.figures.get(it.id) ?? ZERO);
    return { row: summaryRow(`i:${it.id}`, 'item', it.id, it.name, level, parentKey, agg, { addQty: true, unit: it.unit, hasChildren: false, costing: it.costingMethod }), agg };
  };

  /** Rows of the subtree under `nodeId` at `level` (node row not included). */
  const children = (nodeId: number | null, level: number, parentKey: string | null): { rows: StockSummaryRow[]; agg: Agg; count: number } => {
    const rows: StockSummaryRow[] = [];
    const agg = new Agg();
    let count = 0;
    for (const n of childNodes.get(nodeId) ?? []) {
      const key = `${prefix}:${n.id}`;
      const sub = children(n.id, level + 1, key);
      if (sub.count === 0) continue;
      rows.push(summaryRow(key, b.kind, n.id, n.name, level, parentKey, sub.agg, { addQty: n.addQuantities, unit: null, hasChildren: true, costing: null }), ...sub.rows);
      agg.merge(sub.agg);
      count += sub.count;
    }
    if (nodeId !== null || b.noneBucket === null) {
      for (const it of itemsOf.get(nodeId) ?? []) {
        const r = itemRow(it, level, parentKey);
        rows.push(r.row);
        agg.merge(r.agg);
        count++;
      }
    }
    return { rows, agg, count };
  };

  const top = children(b.rootId, 0, null);
  const rows = top.rows;
  const total = top.agg;
  if (b.rootId === null && b.noneBucket !== null) {
    const loose = itemsOf.get(null) ?? [];
    if (loose.length > 0) {
      const key = `${prefix}:none`;
      const agg = new Agg();
      const sub: StockSummaryRow[] = [];
      for (const it of loose) {
        const r = itemRow(it, 1, key);
        sub.push(r.row);
        agg.merge(r.agg);
      }
      rows.push(summaryRow(key, b.kind, null, b.noneBucket, 0, null, agg, { addQty: true, unit: null, hasChildren: true, costing: null }), ...sub);
      total.merge(agg);
    }
  }
  return { rows, total };
}

function figuresFor(db: Db, q: { from: string; to: string; today: string; godownId: number | null; showValues: boolean }): Map<number, Figures> {
  const godowns = godownScope(db, q.godownId);
  return q.showValues ? valuedFigures(db, q) : quantityFigures(db, { ...q, godowns });
}

function includeItem(it: ItemMeta, figures: Map<number, Figures>, showZero: boolean): boolean {
  if (it.isService) return false;
  const f = figures.get(it.id);
  return showZero || (f !== undefined && !isZero(f));
}

/** 'stock.summary' — stock groups → items with opening / inward / outward / closing. */
export function stockSummary(db: Db, today: string, input: StockSummaryInput): StockSummaryResult {
  assertPeriod(input.from, input.to);
  const showValues = input.showValues !== false;
  const groups = loadTree(db, 'group');
  if (input.groupId !== undefined) requireNode(groups, 'group', input.groupId);
  let categoryIds: Set<number> | null = null;
  if (input.categoryId !== undefined) {
    const cats = loadTree(db, 'category');
    requireNode(cats, 'category', input.categoryId);
    categoryIds = descendants(cats, input.categoryId);
  }
  const groupIds = input.groupId !== undefined ? descendants(groups, input.groupId) : null;
  const figures = figuresFor(db, { from: input.from, to: input.to, today, godownId: input.godownId ?? null, showValues });
  const items = [...loadItems(db).values()].filter(
    (it) =>
      includeItem(it, figures, input.showZero === true) &&
      (categoryIds === null || (it.categoryId !== null && categoryIds.has(it.categoryId))) &&
      (groupIds === null || (it.groupId !== null && groupIds.has(it.groupId))),
  );
  const { rows, total } = buildTree({
    nodes: groups,
    kind: 'group',
    items,
    figures,
    parentOf: (it) => it.groupId,
    rootId: input.groupId ?? null,
    noneBucket: null,
  });
  return {
    from: input.from,
    to: input.to,
    groupId: input.groupId ?? null,
    categoryId: input.categoryId ?? null,
    godownId: input.godownId ?? null,
    valuesShown: showValues,
    rows,
    totals: { openingValue: total.openValue, inwardValue: total.inValue, outwardValue: total.outValue, closingValue: total.closeValue },
  };
}

/** 'stock.categorySummary' — stock categories → items; items without a category under "Not categorised". */
export function categorySummary(db: Db, today: string, input: StockCategorySummaryInput): StockSummaryResult {
  assertPeriod(input.from, input.to);
  const showValues = input.showValues !== false;
  const cats = loadTree(db, 'category');
  const figures = figuresFor(db, { from: input.from, to: input.to, today, godownId: input.godownId ?? null, showValues });
  const items = [...loadItems(db).values()].filter((it) => includeItem(it, figures, input.showZero === true));
  const { rows, total } = buildTree({
    nodes: cats,
    kind: 'category',
    items,
    figures,
    parentOf: (it) => it.categoryId,
    rootId: null,
    noneBucket: 'Not categorised',
  });
  return {
    from: input.from,
    to: input.to,
    groupId: null,
    categoryId: null,
    godownId: input.godownId ?? null,
    valuesShown: showValues,
    rows,
    totals: { openingValue: total.openValue, inwardValue: total.inValue, outwardValue: total.outValue, closingValue: total.closeValue },
  };
}

// ───────────────────────────── Godown summary ─────────────────────────────

/** Quantity per (godown, item) as of a date, exact godown (no roll-up). */
function godownQuantities(db: Db, asOf: string, today: string): Map<number, Map<number, number>> {
  const rows = db.all<{ godown_id: number; item_id: number; qty: number }>(
    `SELECT godown_id, item_id, SUM(qty) AS qty FROM (
       SELECT godown_id, item_id, qty FROM stock_openings
       UNION ALL
       SELECT COALESCE(ie.godown_id, :main) AS godown_id, ie.item_id, ie.qty
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
     ) GROUP BY godown_id, item_id`,
    { asOf, today, main: mainGodown(db) },
  );
  const out = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const q = roundQty(Number(r.qty));
    if (Math.abs(q) < EPS || r.godown_id === null) continue;
    const m = out.get(r.godown_id) ?? new Map<number, number>();
    m.set(r.item_id, q);
    out.set(r.godown_id, m);
  }
  return out;
}

/** 'stock.godownSummary' — godowns (tree) → items held there, with closing quantity and value. */
export function godownSummary(db: Db, today: string, input: GodownSummaryInput): GodownSummaryResult {
  const tree = loadTree(db, 'godown');
  if (input.godownId !== undefined) requireNode(tree, 'godown', input.godownId);
  const items = loadItems(db);
  const qtys = godownQuantities(db, input.asOf, today);
  // Values: the engine per godown (exact godown), for the items held there.
  const values = new Map<number, Map<number, { qty: number; value: number }>>();
  for (const [gid, perItem] of qtys) {
    const ids = [...perItem.keys()].filter((id) => items.get(id)?.isService === false);
    if (ids.length === 0) continue;
    const res = computeStockValuation(db, { from: input.asOf, to: input.asOf, today, godownId: gid, includeSubGodowns: false, itemIds: ids });
    values.set(gid, new Map(res.rows.map((r) => [r.itemId, { qty: r.closing.qty, value: r.closing.value }])));
  }

  const childNodes = new Map<number | null, TreeNode[]>();
  for (const n of tree.values()) {
    const list = childNodes.get(n.parentId) ?? [];
    list.push(n);
    childNodes.set(n.parentId, list);
  }
  const emit = (n: TreeNode, level: number, parentKey: string | null): { rows: GodownSummaryRow[]; value: number; any: boolean } => {
    const key = `gd:${n.id}`;
    const rows: GodownSummaryRow[] = [];
    let value = 0;
    let any = false;
    for (const c of childNodes.get(n.id) ?? []) {
      const sub = emit(c, level + 1, key);
      if (!sub.any && input.showZero !== true) continue;
      rows.push(...sub.rows);
      value += sub.value;
      any = any || sub.any;
    }
    const own = values.get(n.id);
    const itemRows: GodownSummaryRow[] = [];
    for (const it of items.values()) {
      const v = own?.get(it.id);
      if (!v || Math.abs(v.qty) < EPS) continue;
      itemRows.push({
        key: `gi:${n.id}:${it.id}`,
        kind: 'item',
        godownId: n.id,
        itemId: it.id,
        name: it.name,
        level: level + 1,
        parentKey: key,
        hasChildren: false,
        unit: it.unit,
        qty: v.qty,
        rate: rateOf(v.value, v.qty),
        value: v.value,
        isThirdParty: n.isThirdParty,
      });
      value += v.value;
      any = true;
    }
    const head: GodownSummaryRow = {
      key,
      kind: 'godown',
      godownId: n.id,
      itemId: null,
      name: n.name,
      level,
      parentKey,
      hasChildren: rows.length + itemRows.length > 0,
      unit: null,
      qty: null,
      rate: null,
      value,
      isThirdParty: n.isThirdParty,
    };
    return { rows: [head, ...itemRows, ...rows], value, any };
  };

  const roots = input.godownId !== undefined ? [tree.get(input.godownId) as TreeNode] : (childNodes.get(null) ?? []);
  const rows: GodownSummaryRow[] = [];
  let totalValue = 0;
  for (const r of roots) {
    const sub = emit(r, 0, null);
    if (!sub.any && input.showZero !== true && input.godownId === undefined) continue;
    rows.push(...sub.rows);
    totalValue += sub.value;
  }
  return { asOf: input.asOf, godownId: input.godownId ?? null, rows, totalValue: roundPaise(totalValue) };
}
