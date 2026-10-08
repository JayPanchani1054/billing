/**
 * Stock Ageing: the closing stock of each item split by how long ago it came in.
 *
 * Whatever the costing method, ageing assumes goods leave first-in-first-out, so the stock on hand
 * is made of the LATEST inwards: walking the inwards from the newest back, each takes quantity until
 * the closing quantity is covered (opening stock is dated at the books beginning). Inwards are net
 * per voucher, so a stock-journal transfer between godowns (out of one, into another) does not make
 * old stock look new. Values always add up to the engine's closing value (item's costing method):
 * for FIFO items each slice is valued at the cost of the inward it came from (the remaining FIFO
 * layers), any rounding residue spread by quantity; for every other method all units on hand carry
 * one cost, so the closing value is split by quantity (largest remainder). Items with no stock,
 * negative stock and services are not listed.
 */
import { allocate, roundPaise } from '../../../shared/money.ts';
import { diffDays } from '../../../shared/dates.ts';
import type { AgeingBucket, StockAgeingInput, StockAgeingResult, StockAgeingRow } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { computeStockValuation, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';
import { booksBegin, EPS, itemsInGroup, loadItems, loadTree, roundQty } from './common.ts';
import { traceMovementValues } from './trace.ts';

export const DEFAULT_AGEING_BUCKETS: readonly number[] = [30, 60, 90, 180];

export function ageingBuckets(bounds: readonly number[]): AgeingBucket[] {
  const out: AgeingBucket[] = [];
  let lo = 0;
  for (const b of bounds) {
    out.push({ label: `${lo === 0 ? 0 : lo}–${b} days`, fromDays: lo, toDays: b });
    lo = b + 1;
  }
  out.push({ label: `Over ${bounds[bounds.length - 1]} days`, fromDays: lo, toDays: null });
  return out;
}

function checkBounds(bounds: readonly number[]): void {
  for (let i = 0; i < bounds.length; i++) {
    if (!Number.isInteger(bounds[i]) || bounds[i] < 1) {
      throw validation([{ path: `buckets[${i}]`, message: 'Each age bucket must be a whole number of days of at least 1.' }]);
    }
    if (i > 0 && bounds[i] <= bounds[i - 1]) {
      throw validation([{ path: `buckets[${i}]`, message: 'Age buckets must go up: for example 30, 60, 90, 180 days.' }]);
    }
  }
}

function bucketOf(buckets: AgeingBucket[], age: number): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.toDays === null || age <= b.toDays) return i;
  }
  return buckets.length - 1;
}

interface AgeEvent {
  date: string;
  qty: number;
  /** Null for opening stock. */
  voucherId: number | null;
  /** Paise per unit of this inward (FIFO items only; null when unknown). */
  unitCost: number | null;
}

/**
 * FIFO bucket values: each slice at its inward's cost; whatever the slices do not explain (unknown
 * costs, rounding of a partly consumed layer) is spread by quantity, so the buckets add up to the
 * engine's closing value exactly.
 */
export function fifoBucketValues(closingValue: number, slices: ReadonlyArray<{ bucket: number; qty: number; unitCost: number | null }>, bucketCount: number): number[] {
  const known = slices.map((s) => (s.unitCost === null ? null : roundPaise(s.qty * s.unitCost)));
  const residual = closingValue - known.reduce<number>((a, k) => a + (k ?? 0), 0);
  const unknownIdx = slices.map((_, i) => i).filter((i) => known[i] === null);
  const spreadOver = unknownIdx.length > 0 ? unknownIdx : slices.map((_, i) => i);
  const parts = allocate(residual, spreadOver.map((i) => slices[i].qty));
  const sliceValues = known.map((k) => k ?? 0);
  spreadOver.forEach((i, k) => (sliceValues[i] += parts[k]));
  const out = new Array<number>(bucketCount).fill(0);
  slices.forEach((s, i) => (out[s.bucket] += sliceValues[i]));
  return out;
}

export function stockAgeing(db: Db, today: string, input: StockAgeingInput): StockAgeingResult {
  const bounds = input.buckets && input.buckets.length > 0 ? input.buckets : DEFAULT_AGEING_BUCKETS;
  checkBounds(bounds);
  const buckets = ageingBuckets(bounds);
  const asOf = input.asOf;
  const items = loadItems(db);
  const scope = itemsInGroup(db, input.groupId);
  const groups = loadTree(db, 'group');
  const begin = booksBegin(db);

  const valuation = computeStockValuation(db, { from: asOf, to: asOf, today });
  const stocked = valuation.rows.filter((r) => r.closing.qty > EPS && (scope === null || scope.has(r.itemId)));
  if (stocked.length === 0) return { asOf, buckets, rows: [], totals: { value: 0, buckets: buckets.map(() => 0) } };

  // Inward events per item, newest first: net positive quantity per voucher, plus opening stock.
  const events = new Map<number, AgeEvent[]>();
  for (const r of db.all<{ item_id: number; voucher_id: number; date: string; qty: number }>(
    `SELECT ie.item_id, ie.voucher_id, ie.date, SUM(ie.qty) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
      GROUP BY ie.voucher_id, ie.item_id HAVING SUM(ie.qty) > 0
      ORDER BY ie.date DESC, ie.voucher_id DESC`,
    { asOf, today },
  )) {
    const list = events.get(r.item_id) ?? [];
    list.push({ date: r.date, qty: Number(r.qty), voucherId: r.voucher_id, unitCost: null });
    events.set(r.item_id, list);
  }
  const fifo = new Set(stocked.filter((r) => r.costingMethod === 'fifo').map((r) => r.itemId));
  // Opening stock: FIFO keeps each opening row as its own layer (newest row first), at its entered rate.
  for (const r of db.all<{ item_id: number; qty: number; value: number; method: string }>(
    `SELECT o.item_id, SUM(o.qty) AS qty, SUM(o.value) AS value, i.costing_method AS method
       FROM stock_openings o JOIN stock_items i ON i.id = o.item_id
      GROUP BY o.item_id, CASE WHEN i.costing_method = 'fifo' THEN o.id ELSE 0 END
      HAVING SUM(o.qty) > 0 ORDER BY o.item_id, MAX(o.id) DESC`,
  )) {
    const list = events.get(r.item_id) ?? [];
    const qty = Number(r.qty);
    list.push({ date: begin, qty, voucherId: null, unitCost: Number(r.value) / qty });
    events.set(r.item_id, list);
  }
  // FIFO: the stock on hand IS the latest layers, so each slice is valued at its own inward's cost
  // (the engine's value of that inward, from trace.ts); other methods hold every unit at one cost.
  if (fifo.size > 0) {
    const tr = traceMovementValues(db, { itemIds: [...fifo], from: begin < asOf ? begin : asOf, to: asOf, today });
    const inward = new Map<string, { qty: number; value: number }>();
    for (const m of tr.movements) {
      if (m.qty <= 0) continue;
      const key = `${m.itemId}|${m.voucherId}`;
      const a = inward.get(key) ?? { qty: 0, value: 0 };
      a.qty += m.qty;
      a.value += tr.values.get(m.id) ?? 0;
      inward.set(key, a);
    }
    for (const itemId of fifo) {
      for (const e of events.get(itemId) ?? []) {
        if (e.voucherId === null) continue;
        const a = inward.get(`${itemId}|${e.voucherId}`);
        if (a && a.qty > EPS) e.unitCost = a.value / a.qty;
      }
    }
  }

  const rows: StockAgeingRow[] = [];
  const totalBuckets = buckets.map(() => 0);
  let totalValue = 0;
  for (const v of stocked) {
    const it = items.get(v.itemId);
    if (!it || it.isService) continue;
    const qtyBy = buckets.map(() => 0);
    const slices: Array<{ bucket: number; qty: number; unitCost: number | null }> = [];
    let need = v.closing.qty;
    let oldest = asOf;
    let weighted = 0;
    for (const e of events.get(v.itemId) ?? []) {
      if (need <= EPS) break;
      const take = Math.min(need, e.qty);
      const age = Math.max(0, diffDays(e.date, asOf));
      const b = bucketOf(buckets, age);
      qtyBy[b] += take;
      slices.push({ bucket: b, qty: take, unitCost: e.unitCost });
      weighted += take * age;
      oldest = e.date;
      need -= take;
    }
    if (need > EPS) {
      // More on hand than recorded inwards (e.g. a count gain without an inward): treat as oldest stock.
      const age = Math.max(0, diffDays(begin, asOf));
      const b = bucketOf(buckets, age);
      qtyBy[b] += need;
      slices.push({ bucket: b, qty: need, unitCost: null });
      weighted += need * age;
      oldest = begin < oldest ? begin : oldest;
    }
    const values = fifo.has(v.itemId) ? fifoBucketValues(v.closing.value, slices, buckets.length) : allocate(v.closing.value, qtyBy);
    const row: StockAgeingRow = {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      groupId: it.groupId,
      groupName: it.groupId === null ? null : (groups.get(it.groupId)?.name ?? null),
      qty: v.closing.qty,
      value: v.closing.value,
      buckets: qtyBy.map((q, k) => ({ qty: roundQty(q), value: values[k] })),
      oldestDate: oldest,
      averageAgeDays: Math.round(weighted / v.closing.qty),
    };
    rows.push(row);
    totalValue += row.value;
    row.buckets.forEach((b, k) => (totalBuckets[k] += b.value));
  }
  return { asOf, buckets, rows, totals: { value: totalValue, buckets: totalBuckets } };
}
