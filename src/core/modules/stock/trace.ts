/**
 * Per-movement cost values for the stock reports (item ledger, profitability, physical variance).
 *
 * The inventory engine itself produces them: `traceStockMovements` runs the ONE valuation replay
 * (inventory/valuation.ts) and records the cost it applied to every line of the traced items and
 * each item's closing at the end of every day with a movement. There is no second engine run and no
 * per-day fallback: the figures are the engine's own, so a report's lines always add up to the Stock
 * Summary (trace.test.ts keeps the equivalence with per-day engine runs as a property test).
 *
 * Performance: one replay. A few items read their lines through the item index (milliseconds); many
 * items share one sequential scan of the movements (about the cost of a Stock Summary).
 */
import type { Db } from '../../db/db.ts';
import { traceStockMovements, type DayClose } from '../inventory/index.ts';
import type { MovementRow } from './common.ts';

export type { DayClose };

export interface TraceResult {
  /** Movements of the requested items in the period (only the traced days when `onlyDates`). */
  movements: MovementRow[];
  /** Cost value (paise, unsigned) by inventory_entries id. */
  values: Map<number, number>;
  /** Closing per item at the end of each day in [from, to] that has one of its movements (in the godown scope when one was given). */
  closing: Map<number, Map<string, DayClose>>;
}

export interface TraceOptions {
  itemIds: readonly number[];
  from: string;
  to: string;
  today: string;
  /** Value only the movements of these days (all movements of the period otherwise). */
  onlyDates?: ReadonlySet<string>;
  /** Godown scope (with its sub-godowns): only its movements; closing at the item's overall unit cost. */
  godownId?: number | null;
}

/** Cost value of every movement of `itemIds` in [from, to] — see the top of this file. */
export function traceMovementValues(db: Db, opts: TraceOptions): TraceResult {
  const itemIds = [...new Set(opts.itemIds)];
  if (itemIds.length === 0) return { movements: [], values: new Map(), closing: new Map() };
  const tr = traceStockMovements(db, {
    from: opts.from,
    to: opts.to,
    today: opts.today,
    itemIds,
    godownId: opts.godownId ?? null,
    includeSubGodowns: true,
    traceItemIds: itemIds,
  });
  const only = opts.onlyDates;
  const movements = only ? tr.movements.filter((m) => only.has(m.date)) : tr.movements;
  return { movements, values: tr.values, closing: tr.closing };
}
