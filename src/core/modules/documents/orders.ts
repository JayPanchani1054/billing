/**
 * Order pre-close / short-close ("Pre-close order"): close the balance quantity of a sales or
 * purchase order that will not be supplied, with a reason and a date, without altering the order.
 * Closed balances leave Sales/Purchase Orders Pending, Reorder Status and the "From orders" picker
 * (closures.ts). Reopen removes the closure. Both are audited on the order, need vouchers.alter (and
 * vouchers.backdate for a date before today) and respect the period lock.
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatQty } from '../../../shared/format.ts';
import type { OrderClosureRow, OrderPrecloseInput, OrderReopenInput } from '../../../shared/types/documents.ts';
import type { OrderKind } from '../../../shared/types/stock.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { forbidden, notFound, rule } from '../../lib/errors.ts';
import { assertDateUnlocked } from '../company/service.ts';
import { orderPositions } from '../stock/orders.ts';
import { can, fieldIssue, nowIso, requirePermission, txt, userName } from './common.ts';

const KIND: Record<string, OrderKind> = { sales_order: 'sales', purchase_order: 'purchase' };

interface OrderDbRow {
  id: number;
  guid: string;
  number: string | null;
  date: string;
  base_type: string;
  is_cancelled: number;
  is_optional: number;
  type_name: string;
}

function loadOrder(db: Db, id: number): OrderDbRow & { kind: OrderKind } {
  const r = db.get<OrderDbRow>(
    `SELECT v.id, v.guid, v.number, v.date, v.base_type, v.is_cancelled, v.is_optional, vt.name AS type_name
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id },
  );
  if (!r) throw notFound('Voucher', id);
  const kind = KIND[r.base_type];
  if (!kind) throw rule('Only sales orders and purchase orders can be pre-closed.');
  return { ...r, kind };
}

const label = (o: OrderDbRow): string => `${o.type_name} ${o.number ?? '(no number)'} dated ${formatDate(o.date)}`;

export function orderClosures(db: Db, orderId: number): OrderClosureRow[] {
  return db
    .all<{ voucher_id: number; item_id: number; item_name: string; unit: string; closed_qty: number; date: string; reason: string; created_at: string; by_name: string | null }>(
      `SELECT c.voucher_id, c.item_id, si.name AS item_name, u.symbol AS unit, c.closed_qty, c.date, c.reason, c.created_at,
              COALESCE(us.display_name, us.username) AS by_name
         FROM order_closures c
         JOIN stock_items si ON si.id = c.item_id
         JOIN units u ON u.id = si.unit_id
         LEFT JOIN users us ON us.id = c.created_by
        WHERE c.voucher_id = :id ORDER BY si.name COLLATE NOCASE`,
      { id: orderId },
    )
    .map((r) => ({
      orderId: r.voucher_id,
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      closedQty: Number(r.closed_qty),
      date: r.date,
      reason: r.reason,
      createdAt: r.created_at,
      createdBy: r.by_name,
    }));
}

function assertMayDate(ctx: CompanyCtx, date: string): void {
  if (date < ctx.clock.today() && !can(ctx, 'vouchers.backdate')) {
    throw forbidden(`You do not have permission to work with dates before today (${formatDate(ctx.clock.today())}).`);
  }
  assertDateUnlocked(ctx.db, date);
}

/** 'documents.order.preclose' */
export function precloseOrder(ctx: CompanyCtx, input: OrderPrecloseInput): { orderId: number; closures: OrderClosureRow[] } {
  requirePermission(ctx, 'vouchers.alter', 'pre-close orders');
  const { db } = ctx;
  const order = loadOrder(db, input.orderId);
  if (order.is_cancelled === 1) throw rule(`${label(order)} is cancelled; there is nothing to pre-close.`);
  if (order.is_optional === 1) throw rule(`${label(order)} is optional (not a firm order); make it regular or delete it instead.`);
  const date = input.date ?? ctx.clock.today();
  if (date < order.date) throw fieldIssue('date', `The pre-close date cannot be before the order date (${formatDate(order.date)}).`);
  assertMayDate(ctx, date);
  const reason = txt(input.reason);
  if (!reason) throw fieldIssue('reason', 'Give the reason the balance will not be supplied (customer cancelled, item discontinued …).');

  // Pending per item of this order as of the pre-close date (deliveries / receipts dated after it do not count).
  const lines = orderPositions(db, order.kind, date).filter((p) => p.voucher_id === order.id);
  const pendingByItem = new Map<number, number>();
  for (const l of lines) pendingByItem.set(l.item_id, Math.round(((pendingByItem.get(l.item_id) ?? 0) + l.pending) * 1e6) / 1e6);
  const already = new Set(db.all<{ item_id: number }>('SELECT item_id FROM order_closures WHERE voucher_id = :id', { id: order.id }).map((r) => r.item_id));
  const itemName = (id: number): string => db.value<string>('SELECT name FROM stock_items WHERE id = :id', { id }) ?? `Item ${id}`;

  const wanted: Array<{ itemId: number; qty?: number }> = input.items ?? [...pendingByItem.entries()].filter(([id, q]) => q > 1e-9 && !already.has(id)).map(([itemId]) => ({ itemId }));
  if (wanted.length === 0) throw rule(`${label(order)} has no pending balance to close as of ${formatDate(date)}.`);
  const now = nowIso(ctx);
  const added: Array<{ itemId: number; item: string; qty: number }> = [];
  const listed = new Set<number>();
  wanted.forEach((w, i) => {
    if (listed.has(w.itemId)) throw fieldIssue(`items[${i}].itemId`, `${itemName(w.itemId)} is listed twice. Enter one quantity per item.`);
    listed.add(w.itemId);
    if (already.has(w.itemId)) throw fieldIssue(`items[${i}].itemId`, `${itemName(w.itemId)} of this order is already pre-closed. Reopen it first to change the quantity.`);
    const pending = pendingByItem.get(w.itemId);
    if (pending === undefined) throw fieldIssue(`items[${i}].itemId`, `${itemName(w.itemId)} is not on ${label(order)}.`);
    if (pending <= 1e-9) throw fieldIssue(`items[${i}].itemId`, `${itemName(w.itemId)} has no pending balance on ${label(order)} as of ${formatDate(date)}.`);
    const qty = w.qty ?? pending;
    if (!(qty > 0)) throw fieldIssue(`items[${i}].qty`, 'Enter the quantity to close (more than zero).');
    if (qty > pending + 1e-9) {
      const u = db.get<{ symbol: string; dp: number }>('SELECT u.symbol, u.decimal_places AS dp FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id = :id', { id: w.itemId });
      const dp = Math.max(0, Math.min(6, u?.dp ?? 0));
      throw fieldIssue(`items[${i}].qty`, `Only ${formatQty(pending, dp, u?.symbol)} of ${itemName(w.itemId)} is pending; you cannot close ${formatQty(qty, dp, u?.symbol)}.`);
    }
    added.push({ itemId: w.itemId, item: itemName(w.itemId), qty });
  });
  // Every item checked first: a refused line leaves nothing half-closed (also when called outside a route transaction).
  db.transaction(() => {
    for (const a of added) {
      db.run(
        `INSERT INTO order_closures (voucher_id, item_id, closed_qty, date, reason, created_at, created_by)
         VALUES (:v, :item, :qty, :date, :reason, :now, :by)`,
        { v: order.id, item: a.itemId, qty: a.qty, date, reason, now, by: ctx.session.userId },
      );
    }
  });
  ctx.audit({
    action: 'alter',
    entityType: 'voucher',
    entityId: order.id,
    entityGuid: order.guid,
    entityLabel: label(order),
    before: { preclosed: [] },
    after: { preclosed: added, date, reason, by: userName(ctx) },
  });
  return { orderId: order.id, closures: orderClosures(db, order.id) };
}

/** 'documents.order.reopen' */
export function reopenOrder(ctx: CompanyCtx, input: OrderReopenInput): { orderId: number; closures: OrderClosureRow[] } {
  requirePermission(ctx, 'vouchers.alter', 'reopen pre-closed orders');
  const { db } = ctx;
  const order = loadOrder(db, input.orderId);
  const current = orderClosures(db, order.id).filter((c) => input.itemId === undefined || c.itemId === input.itemId);
  if (current.length === 0) throw rule(`${label(order)} has no pre-closed balance${input.itemId !== undefined ? ' for that item' : ''}.`);
  for (const c of current) assertMayDate(ctx, c.date);
  if (input.itemId === undefined) db.run('DELETE FROM order_closures WHERE voucher_id = :id', { id: order.id });
  else db.run('DELETE FROM order_closures WHERE voucher_id = :id AND item_id = :item', { id: order.id, item: input.itemId });
  ctx.audit({
    action: 'alter',
    entityType: 'voucher',
    entityId: order.id,
    entityGuid: order.guid,
    entityLabel: label(order),
    before: { preclosed: current.map((c) => ({ itemId: c.itemId, item: c.itemName, qty: c.closedQty, date: c.date, reason: c.reason })) },
    after: { reopened: current.map((c) => c.itemId), by: userName(ctx) },
  });
  return { orderId: order.id, closures: orderClosures(db, order.id) };
}
