/**
 * Per-movement cost values, built ON TOP of the inventory valuation engine (no second costing
 * implementation). The inventory module exports period totals only (`computeStockValuation`), so a
 * value per voucher line is derived from one engine run per day that has movements:
 *
 *   1. The engine values day d alone (`from = to = d`): per item the inward value, outward value
 *      and closing quantity / value — exact, with the item's costing method and everything before d.
 *   2. Within that day and item:
 *        - an inward that the engine takes at its OWN amount (purchase, receipt note, any type not
 *          re-entered at cost, stock-journal production with an amount) gets that amount (taxable
 *          value, or qty × rate less discount), exactly as the engine does;
 *        - the rest of the day's inward value (returns, rejections in, physical-stock gains,
 *          production without an amount — all valued at cost) is split over those lines by quantity;
 *        - the day's outward value is split over the day's outward lines by quantity.
 *      Splits use the largest-remainder method, so the lines of a day always add up to the engine's
 *      day totals to the paisa, and the day's closing is the engine's closing.
 *
 * When several outwards of one item fall on the same day their individual values can differ by a
 * paisa from separate valuation (the engine rounds each), never the day total. Every Stock Summary
 * figure ties to these values: Σ day inward/outward values over a period = the period's values.
 */
import { allocate, lineAmount } from '../../../shared/money.ts';
import type { Db } from '../../db/db.ts';
import { computeStockValuation } from '../inventory/index.ts';
import { loadMovements, type MovementRow } from './common.ts';

/** Inwards that the engine re-enters at current cost (mirrors the engine's documented contract). */
const AT_COST_INWARD = new Set(['credit_note', 'rejection_in', 'physical_stock', 'sales', 'delivery_note', 'debit_note', 'rejection_out']);

/** Own value of an inward line as the engine takes it: the taxable amount, else qty × rate less discount, else 0. */
function ownAmount(m: MovementRow): number {
  const amt = Math.abs(m.amount);
  if (amt > 0) return amt;
  if (m.rate > 0) return Math.abs(lineAmount(m.qty, m.rate, m.discountPct));
  return 0;
}

/** True when the engine values this inward at its own amount (not at current cost / consumption share). */
function isPricedInward(m: MovementRow): boolean {
  if (m.baseType === 'stock_journal') return ownAmount(m) > 0;
  return !AT_COST_INWARD.has(m.baseType);
}

export interface DayClose {
  qty: number;
  value: number;
}

export interface TraceResult {
  /** Movements of the requested items in the period (only the traced days when `onlyDates`). */
  movements: MovementRow[];
  /** Cost value (paise, unsigned) by inventory_entries id. */
  values: Map<number, number>;
  /** Engine closing per item and traced day (in the godown scope when one was given). */
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
  /** Godown ids of that scope (from godownScope). */
  godowns?: ReadonlySet<number> | null;
}

/** Cost value of every movement of `itemIds` in [from, to] — see the top of this file. */
export function traceMovementValues(db: Db, opts: TraceOptions): TraceResult {
  const values = new Map<number, number>();
  const closing = new Map<number, Map<string, DayClose>>();
  if (opts.itemIds.length === 0) return { movements: [], values, closing };
  const godowns = opts.godowns ?? null;
  let movements = loadMovements(db, { from: opts.from, to: opts.to, today: opts.today, itemIds: opts.itemIds });
  if (godowns) movements = movements.filter((m) => m.godownId !== null && godowns.has(m.godownId));
  if (opts.onlyDates) {
    const only = opts.onlyDates;
    movements = movements.filter((m) => only.has(m.date));
  }

  // Movements per day, then per item (replay order kept).
  const byDay = new Map<string, Map<number, MovementRow[]>>();
  for (const m of movements) {
    let day = byDay.get(m.date);
    if (!day) {
      day = new Map();
      byDay.set(m.date, day);
    }
    const list = day.get(m.itemId) ?? [];
    list.push(m);
    day.set(m.itemId, list);
  }

  for (const [date, perItem] of byDay) {
    const res = computeStockValuation(db, {
      from: date,
      to: date,
      today: opts.today,
      itemIds: [...perItem.keys()],
      godownId: opts.godownId ?? null,
      includeSubGodowns: true,
    });
    const rowByItem = new Map(res.rows.map((r) => [r.itemId, r]));
    for (const [itemId, lines] of perItem) {
      const row = rowByItem.get(itemId);
      if (!row) continue;
      let closes = closing.get(itemId);
      if (!closes) {
        closes = new Map();
        closing.set(itemId, closes);
      }
      closes.set(date, { qty: row.closing.qty, value: row.closing.value });

      const outs = lines.filter((m) => m.qty < 0);
      const ins = lines.filter((m) => m.qty > 0);
      if (outs.length > 0) {
        const parts = allocate(row.outward.value, outs.map((m) => -m.qty));
        outs.forEach((m, k) => values.set(m.id, parts[k]));
      }
      if (ins.length > 0) {
        const priced = ins.filter(isPricedInward);
        const atCost = ins.filter((m) => !isPricedInward(m));
        let pricedSum = 0;
        for (const m of priced) {
          const v = ownAmount(m);
          values.set(m.id, v);
          pricedSum += v;
        }
        if (atCost.length > 0) {
          const parts = allocate(row.inward.value - pricedSum, atCost.map((m) => m.qty));
          atCost.forEach((m, k) => values.set(m.id, parts[k]));
        }
      }
    }
  }
  return { movements, values, closing };
}
