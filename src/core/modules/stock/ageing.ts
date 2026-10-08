/**
 * Stock Ageing: the closing stock of each item split by how long ago it came in.
 *
 * Whatever the costing method, ageing assumes goods leave first-in-first-out, so the stock on hand
 * is made of the LATEST inwards: walking the inwards from the newest back, each takes quantity until
 * the closing quantity is covered (opening stock is dated at the books beginning). Inwards are net
 * per voucher, so a stock-journal transfer between godowns (out of one, into another) does not make
 * old stock look new. The closing value (engine, item's costing method) is split over the buckets
 * by quantity (largest remainder, so buckets add up to the paisa). Items with no stock, negative
 * stock and services are not listed.
 */
import { allocate } from '../../../shared/money.ts';
import { diffDays } from '../../../shared/dates.ts';
import type { AgeingBucket, StockAgeingInput, StockAgeingResult, StockAgeingRow } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { computeStockValuation, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';
import { booksBegin, EPS, itemsInGroup, loadItems, loadTree, roundQty } from './common.ts';

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
  const events = new Map<number, Array<{ date: string; qty: number }>>();
  for (const r of db.all<{ item_id: number; date: string; qty: number }>(
    `SELECT ie.item_id, ie.date, SUM(ie.qty) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
      GROUP BY ie.voucher_id, ie.item_id HAVING SUM(ie.qty) > 0
      ORDER BY ie.date DESC, ie.voucher_id DESC`,
    { asOf, today },
  )) {
    const list = events.get(r.item_id) ?? [];
    list.push({ date: r.date, qty: Number(r.qty) });
    events.set(r.item_id, list);
  }
  for (const r of db.all<{ item_id: number; qty: number }>('SELECT item_id, SUM(qty) AS qty FROM stock_openings GROUP BY item_id HAVING SUM(qty) > 0')) {
    const list = events.get(r.item_id) ?? [];
    list.push({ date: begin, qty: Number(r.qty) });
    events.set(r.item_id, list);
  }

  const rows: StockAgeingRow[] = [];
  const totalBuckets = buckets.map(() => 0);
  let totalValue = 0;
  for (const v of stocked) {
    const it = items.get(v.itemId);
    if (!it || it.isService) continue;
    const qtyBy = buckets.map(() => 0);
    let need = v.closing.qty;
    let oldest = asOf;
    let weighted = 0;
    for (const e of events.get(v.itemId) ?? []) {
      if (need <= EPS) break;
      const take = Math.min(need, e.qty);
      const age = Math.max(0, diffDays(e.date, asOf));
      qtyBy[bucketOf(buckets, age)] += take;
      weighted += take * age;
      oldest = e.date;
      need -= take;
    }
    if (need > EPS) {
      // More on hand than recorded inwards (e.g. a count gain without an inward): treat as oldest stock.
      const age = Math.max(0, diffDays(begin, asOf));
      qtyBy[bucketOf(buckets, age)] += need;
      weighted += need * age;
      oldest = begin < oldest ? begin : oldest;
    }
    const values = allocate(v.closing.value, qtyBy);
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
