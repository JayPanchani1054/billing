/**
 * Costing rule of a manufacturing journal / job-work stock journal — ONE implementation used by the
 * stock valuation engine (inventory/valuation.ts, the figures every report shows), by the entry
 * screen's estimate (mfg.journal.preview) and by its tests. Pure: integer paise in, integer paise out.
 *
 *   consumed C  = Σ cost of the consumption (source) lines that are not the source of a transfer,
 *                 each valued by the item's costing method at its point in the replay
 *   additional A = Σ additional costs: an amount (paise) or a percentage of C
 *   pool P       = C + A
 *   production lines by basis
 *     'source'   value = cost of the consumption line it was transferred from (pro rata when the
 *                quantities differ) — godown transfers to / from a job worker keep their own cost
 *     'fixed'    value = the line's own amount (by-product / scrap at a rate; 0 = no value)
 *     'percent'  value = round(P × pct / 100)
 *     'residual' value = share of max(0, P − Σ fixed − Σ percent), split by quantity (largest
 *                remainder) — the finished goods: (consumption + additional − by-products) / qty
 *   With nothing to share (no consumption and no additional cost) residual lines enter at the item's
 *   current cost (value null), exactly like an ordinary stock journal.
 */
import { allocate, roundPaise } from '../money.ts';

export const PRODUCTION_BASES = ['residual', 'fixed', 'percent', 'source'] as const;
export type ProductionBasis = (typeof PRODUCTION_BASES)[number];

export const ADDITIONAL_COST_BASES = ['amount', 'percent'] as const;
export type AdditionalCostBasis = (typeof ADDITIONAL_COST_BASES)[number];

export interface ProductionTerm {
  basis: ProductionBasis;
  /** 'percent': share of the pool, in percent. */
  pct?: number | null;
  /** 'source': line_no of the consumption line it comes from. */
  sourceLineNo?: number | null;
}

export interface AdditionalCostTerm {
  basis: AdditionalCostBasis;
  /** 'amount': paise; 'percent': percent of the consumed cost C. */
  value: number;
}

export interface JournalCostInput {
  /** Consumption lines with the cost the engine issued them at (paise, unsigned) and their quantity (> 0). */
  consumption: ReadonlyArray<{ lineNo: number; qty: number; cost: number }>;
  /** Production lines: quantity (> 0) and own amount (paise; used by 'fixed'). */
  production: ReadonlyArray<{ lineNo: number; qty: number; amount: number }>;
  /** Basis per production line (missing → 'residual'). */
  terms: ReadonlyMap<number, ProductionTerm>;
  additional: readonly AdditionalCostTerm[];
}

export interface JournalCostResult {
  /** C: consumed cost pooled into production (transfer sources excluded). */
  consumed: number;
  /** Cost carried by transfer ('source') lines. */
  transferred: number;
  /** A, and each additional cost line's paise value in input order. */
  additional: number;
  additionalValues: number[];
  /** P = C + A. */
  pool: number;
  /** Σ values of fixed and percent lines (by-products, scrap). */
  byProducts: number;
  /** Value per production line; null = enter at the item's current cost. */
  values: Map<number, number | null>;
  /** > 0 when fixed/percent values exceed the pool (the residual lines then get 0). */
  shortfall: number;
}

/** Apply the costing rule (see the top of this file). */
export function costJournal(input: JournalCostInput): JournalCostResult {
  const consByLine = new Map<number, { qty: number; cost: number }>();
  for (const c of input.consumption) consByLine.set(c.lineNo, { qty: c.qty, cost: c.cost });

  const sources = new Set<number>();
  for (const p of input.production) {
    const t = input.terms.get(p.lineNo);
    if (t?.basis === 'source' && typeof t.sourceLineNo === 'number' && consByLine.has(t.sourceLineNo)) sources.add(t.sourceLineNo);
  }
  let consumed = 0;
  let transferred = 0;
  for (const c of input.consumption) {
    if (sources.has(c.lineNo)) transferred += c.cost;
    else consumed += c.cost;
  }
  const additionalValues = input.additional.map((a) => (a.basis === 'percent' ? roundPaise((consumed * a.value) / 100) : roundPaise(a.value)));
  const additional = additionalValues.reduce((s, x) => s + x, 0);
  const pool = consumed + additional;

  const values = new Map<number, number | null>();
  const residual: Array<{ lineNo: number; qty: number }> = [];
  let byProducts = 0;
  // A consumption line transferred to several production lines is split between them by quantity.
  const sourceTakers = new Map<number, Array<{ lineNo: number; qty: number }>>();
  for (const p of input.production) {
    const t = input.terms.get(p.lineNo) ?? { basis: 'residual' as const };
    if (t.basis === 'source') {
      const src = typeof t.sourceLineNo === 'number' ? consByLine.get(t.sourceLineNo) : undefined;
      if (!src) {
        values.set(p.lineNo, null);
        continue;
      }
      const list = sourceTakers.get(t.sourceLineNo as number) ?? [];
      list.push({ lineNo: p.lineNo, qty: p.qty });
      sourceTakers.set(t.sourceLineNo as number, list);
    } else if (t.basis === 'fixed') {
      const v = Math.max(0, roundPaise(p.amount));
      values.set(p.lineNo, v);
      byProducts += v;
    } else if (t.basis === 'percent') {
      const v = Math.max(0, roundPaise((pool * Number(t.pct ?? 0)) / 100));
      values.set(p.lineNo, v);
      byProducts += v;
    } else {
      residual.push({ lineNo: p.lineNo, qty: p.qty });
    }
  }
  for (const [srcLine, takers] of sourceTakers) {
    const src = consByLine.get(srcLine) as { qty: number; cost: number };
    const takenQty = takers.reduce((s, t) => s + t.qty, 0);
    // Transfer of the whole quantity carries the whole cost; a smaller quantity carries its share.
    const carried = takenQty >= src.qty - 1e-9 || src.qty <= 0 ? src.cost : roundPaise((src.cost * takenQty) / src.qty);
    const parts = allocate(carried, takers.map((t) => t.qty));
    takers.forEach((t, k) => values.set(t.lineNo, parts[k]));
  }
  const left = pool - byProducts;
  const shortfall = left < 0 && residual.length > 0 ? -left : 0;
  if (residual.length > 0) {
    if (input.consumption.length - sources.size <= 0 && additional === 0) {
      for (const r of residual) values.set(r.lineNo, null);
    } else {
      const parts = allocate(Math.max(0, left), residual.map((r) => r.qty));
      residual.forEach((r, k) => values.set(r.lineNo, parts[k]));
    }
  }
  return { consumed, transferred, additional, additionalValues, pool, byProducts, values, shortfall };
}
