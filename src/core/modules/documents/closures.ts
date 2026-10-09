/**
 * Order pre-close (short-close) balances as the pending-order reports need them. DB reads only, no
 * module imports — stock/orders.ts (pending orders, reorder status) and vouchers/queries.ts
 * (trackingRefs) call these, so closed balances leave every pending list.
 *
 * A closure is per order + item (`order_closures`); it closes that item's pending balance from the
 * order's LAST lines backwards (the earliest lines are the ones deliveries fulfil first).
 */
import type { Db } from '../../db/db.ts';

/** Closed quantity per `${orderId}|${itemId}`; only closures dated on or before `asOf` when given. */
export function closedQtyByOrderItem(db: Db, asOf?: string): Map<string, number> {
  const rows =
    asOf === undefined
      ? db.all<{ voucher_id: number; item_id: number; qty: number }>('SELECT voucher_id, item_id, closed_qty AS qty FROM order_closures')
      : db.all<{ voucher_id: number; item_id: number; qty: number }>('SELECT voucher_id, item_id, closed_qty AS qty FROM order_closures WHERE date <= :asOf', { asOf });
  const out = new Map<string, number>();
  for (const r of rows) out.set(`${r.voucher_id}|${r.item_id}`, Number(r.qty));
  return out;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Reduce the pending quantity of order lines by the closures (in place, last lines first). `lines` are
 * in the order's line order (any interleaving of orders is fine). Returns the closed quantity per line
 * index (0 when none).
 */
export function applyClosures<T>(
  lines: readonly T[],
  closed: ReadonlyMap<string, number>,
  get: (l: T) => { orderId: number; itemId: number; pending: number },
  set: (l: T, pending: number, closedQty: number) => void,
): void {
  if (closed.size === 0) return;
  const left = new Map(closed);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const g = get(l);
    const key = `${g.orderId}|${g.itemId}`;
    const c = left.get(key) ?? 0;
    if (c <= 0 || g.pending <= 0) continue;
    const take = Math.min(c, g.pending);
    left.set(key, round6(c - take));
    set(l, round6(g.pending - take), round6(take));
  }
}
