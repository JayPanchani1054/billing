/**
 * Stock quantity engine: on-hand quantity, batch balances and bulk per-item quantities.
 *
 * What moves stock (the single definition used by every function here and by valuation.ts):
 *   - stock_openings rows (opening stock as at books beginning; always counted), plus
 *   - inventory_entries joined to their voucher where
 *       ie.affects_stock = 1                                  (tracked invoice lines etc. carry 0)
 *       AND v.is_optional = 0 AND v.is_cancelled = 0         (optional / cancelled never move stock)
 *       AND (v.is_post_dated = 0 OR ie.date <= :today)       (post-dated only once their date arrives)
 *       AND v.base_type NOT IN ('sales_order','purchase_order','memorandum')
 *       AND ie.date <= :asOf
 * Quantities are signed in the item's base unit (inward +, outward −). An entry without a godown
 * counts in 'Main Location'. Godown filters are exact unless `includeSubGodowns` is set (then the
 * godown and every godown under it, like Tally's godown summary of a parent location).
 * Batch names match case-insensitively.
 */
import { roundTo } from '../../../shared/money.ts';
import type { BatchBalance } from '../../../shared/types/inventory.ts';
import type { Db } from '../../db/db.ts';
import { jsonIds } from './common.ts';

/** SQL condition selecting inventory_entries `ie` (joined to vouchers `v`) that move stock. Needs :today. */
export const STOCK_MOVEMENT_FILTER = /* sql */ `ie.affects_stock = 1 AND v.is_optional = 0 AND v.is_cancelled = 0
  AND (v.is_post_dated = 0 OR ie.date <= :today)
  AND v.base_type NOT IN ('sales_order', 'purchase_order', 'memorandum')`;

/** Quantities are REAL; sums are rounded to 6 decimals to drop binary noise (0.1 + 0.2). */
export const roundQty = (q: number): number => roundTo(q, 6);

const QTY_EPS = 1e-9;

function mainGodown(db: Db): number | null {
  return db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? null;
}

/** The godown itself, plus all godowns under it when `includeSub`. */
export function godownSet(db: Db, godownId: number, includeSub: boolean): Set<number> {
  if (!includeSub) return new Set([godownId]);
  return new Set(
    db
      .all<{ id: number }>(
        'WITH RECURSIVE t(id) AS (SELECT :id UNION SELECT g.id FROM godowns g JOIN t ON g.parent_id = t.id) SELECT id FROM t',
        { id: godownId },
      )
      .map((r) => r.id),
  );
}

/** Bound parameters for the `:gf` / `:gids` godown condition (GODOWN_IN / OPENING_GODOWN_IN). */
function godownParams(db: Db, godownId: number | null | undefined, includeSub: boolean | undefined): { gf: number; gids: string } {
  if (godownId === null || godownId === undefined) return { gf: 0, gids: '[]' };
  return { gf: 1, gids: jsonIds([...godownSet(db, godownId, includeSub === true)]) };
}

const GODOWN_IN = `(:gf = 0 OR COALESCE(ie.godown_id, :main) IN (SELECT value FROM json_each(:gids)))`;
const OPENING_GODOWN_IN = `(:gf = 0 OR godown_id IN (SELECT value FROM json_each(:gids)))`;

export interface StockOnHandQuery {
  itemId: number;
  godownId?: number | null;
  /** With godownId: include its sub-godowns. Default false (exact). */
  includeSubGodowns?: boolean;
  batchName?: string | null;
  asOf: string;
  /** Leave this voucher out (e.g. the voucher being altered). */
  excludeVoucherId?: number | null;
  /** Working date for the post-dated rule; default `asOf` (post-dated vouchers up to asOf count). */
  today?: string;
}

/** Quantity on hand (base unit) of an item, optionally in one godown and/or batch, as of a date. */
export function stockOnHand(db: Db, q: StockOnHandQuery): number {
  const params = {
    item: q.itemId,
    ...godownParams(db, q.godownId, q.includeSubGodowns),
    batch: q.batchName ?? null,
    asOf: q.asOf,
    today: q.today ?? q.asOf,
    exclude: q.excludeVoucherId ?? null,
    main: mainGodown(db),
  };
  const total = db.value<number>(
    `SELECT
       (SELECT COALESCE(SUM(qty), 0) FROM stock_openings
         WHERE item_id = :item AND ${OPENING_GODOWN_IN}
           AND (:batch IS NULL OR batch_name = :batch COLLATE NOCASE))
     + (SELECT COALESCE(SUM(ie.qty), 0) FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
         WHERE ie.item_id = :item AND ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
           AND ${GODOWN_IN}
           AND (:batch IS NULL OR ie.batch_name = :batch COLLATE NOCASE)
           AND ie.voucher_id IS NOT :exclude)`,
    params,
  );
  return roundQty(Number(total ?? 0));
}

export interface BatchQueryOptions {
  today?: string;
  excludeVoucherId?: number | null;
  /** With a godown: include its sub-godowns. Default false (exact). */
  includeSubGodowns?: boolean;
}

/**
 * Batches of an item with a positive balance as of `asOf` (optionally in one godown), in FEFO order:
 * earliest expiry first (batches without expiry last), then manufacturing date, then name.
 * Rows without a batch name are not listed.
 */
export function batchesFor(
  db: Db,
  itemId: number,
  godownId: number | null | undefined,
  asOf: string,
  opts: BatchQueryOptions = {},
): BatchBalance[] {
  const rows = db.all<{ batch_name: string; mfg: string | null; exp: string | null; qty: number }>(
    `SELECT batch_name, MIN(mfg_date) AS mfg, MIN(expiry_date) AS exp, SUM(qty) AS qty FROM (
       SELECT batch_name, mfg_date, expiry_date, qty FROM stock_openings
        WHERE item_id = :item AND batch_name IS NOT NULL AND batch_name <> '' AND ${OPENING_GODOWN_IN}
       UNION ALL
       SELECT ie.batch_name, ie.mfg_date, ie.expiry_date, ie.qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.item_id = :item AND ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
          AND ie.batch_name IS NOT NULL AND ie.batch_name <> ''
          AND ${GODOWN_IN}
          AND ie.voucher_id IS NOT :exclude
     )
     GROUP BY batch_name COLLATE NOCASE
     HAVING SUM(qty) > ${QTY_EPS}
     ORDER BY (exp IS NULL), exp, (mfg IS NULL), mfg, batch_name COLLATE NOCASE`,
    {
      item: itemId,
      ...godownParams(db, godownId, opts.includeSubGodowns),
      asOf,
      today: opts.today ?? asOf,
      exclude: opts.excludeVoucherId ?? null,
      main: mainGodown(db),
    },
  );
  return rows
    .map((r) => ({ batchName: r.batch_name, mfgDate: r.mfg, expiryDate: r.exp, qty: roundQty(Number(r.qty)) }))
    .filter((b) => b.qty > 0);
}

export interface StockByItemQuery {
  asOf: string;
  today?: string;
  godownId?: number | null;
  /** With godownId: include its sub-godowns. Default false (exact). */
  includeSubGodowns?: boolean;
  /** Restrict to these items (default: all). */
  itemIds?: readonly number[];
  /** Leave this voucher out (e.g. the voucher being altered). */
  excludeVoucherId?: number | null;
}

/** Quantity on hand per item (items with no stock rows are absent → 0). One query for any number of items. */
export function stockByItem(db: Db, q: StockByItemQuery): Map<number, number> {
  const filterItems = q.itemIds !== undefined;
  const params = {
    asOf: q.asOf,
    today: q.today ?? q.asOf,
    ...godownParams(db, q.godownId, q.includeSubGodowns),
    main: mainGodown(db),
    ids: filterItems ? jsonIds(q.itemIds ?? []) : '[]',
    filter: filterItems ? 1 : 0,
    exclude: q.excludeVoucherId ?? null,
  };
  const rows = db.all<{ item_id: number; qty: number }>(
    `SELECT item_id, SUM(qty) AS qty FROM (
       SELECT item_id, qty FROM stock_openings
        WHERE ${OPENING_GODOWN_IN}
          AND (:filter = 0 OR item_id IN (SELECT value FROM json_each(:ids)))
       UNION ALL
       SELECT ie.item_id, ie.qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
          AND ${GODOWN_IN}
          AND (:filter = 0 OR ie.item_id IN (SELECT value FROM json_each(:ids)))
          AND ie.voucher_id IS NOT :exclude
     ) GROUP BY item_id`,
    params,
  );
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.item_id, roundQty(Number(r.qty)));
  return out;
}

/** True when the item appears on any voucher (whatever its status). */
export function itemHasTransactions(db: Db, itemId: number): boolean {
  return db.value('SELECT 1 FROM inventory_entries WHERE item_id = :id LIMIT 1', { id: itemId }) !== undefined;
}
