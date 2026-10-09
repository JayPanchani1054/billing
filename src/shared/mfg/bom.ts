/**
 * Bill of Materials explosion — pure, shared by the core (Manufacturing Journal defaults, job work
 * orders, BOM cost) and the entry screen. Quantities scale linearly from the BOM's output quantity
 * and are rounded to each item's unit decimals (half away from zero).
 */
import { roundTo } from '../money.ts';
import type { BomLineKind, BomValueBasis } from '../types/mfg.ts';

export interface ExplodableLine {
  kind: BomLineKind;
  itemId: number;
  qty: number;
  godownId: number | null;
  valueBasis: BomValueBasis | null;
  valueRate: number | null;
  valuePct: number | null;
  /** Decimal places of the item's unit (default 6). */
  unitDecimals?: number;
}

export interface ExplodedLine<T extends ExplodableLine = ExplodableLine> {
  line: T;
  /** Scaled quantity (0 lines are dropped). */
  qty: number;
}

/** Lines needed to make `qty` of the item with a BOM written for `outputQty` (rounded to unit decimals). */
export function explodeBom<T extends ExplodableLine>(lines: readonly T[], outputQty: number, qty: number): Array<ExplodedLine<T>> {
  if (!(outputQty > 0) || !(qty > 0)) return [];
  const factor = qty / outputQty;
  const out: Array<ExplodedLine<T>> = [];
  for (const l of lines) {
    const dp = Math.max(0, Math.min(6, l.unitDecimals ?? 6));
    const q = roundTo(l.qty * factor, dp);
    if (q > 0) out.push({ line: l, qty: q });
  }
  return out;
}
