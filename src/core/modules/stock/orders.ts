/**
 * Order processing reports: pending sales / purchase orders, and the Reorder Status that uses them.
 *
 * An order line carries its order's own number in `inventory_entries.order_ref`; the documents that
 * fulfil it carry the same number in `order_ref` (vouchers README › Tracking):
 *   sales order    ← delivery notes, and sales invoices that do not bill a delivery note
 *   purchase order ← receipt notes, and purchase invoices that do not bill a receipt note
 * (an invoice billing a note that already fulfilled the order is not counted twice). Fulfilment is
 * matched per party + order number + item and applied to the order's lines in date order — the same
 * rule as `vouchers.trackingRefs` — but only documents dated on or before `asOf` count, so the
 * report can be run for any past date. Optional and cancelled documents never count.
 */
import { diffDays } from '../../../shared/dates.ts';
import { lineAmount } from '../../../shared/money.ts';
import type { OrderKind, PendingOrderLine, PendingOrdersInput, PendingOrdersResult, ReorderRow, ReorderStatusInput, ReorderStatusResult } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { applyClosures, closedQtyByOrderItem } from '../documents/closures.ts';
import { stockByItem } from '../inventory/index.ts';
import { EPS, loadItems, loadTree, roundQty } from './common.ts';

const ORDER_BASE: Record<OrderKind, string> = { sales: 'sales_order', purchase: 'purchase_order' };
const NOTE_BASE: Record<OrderKind, string> = { sales: 'delivery_note', purchase: 'receipt_note' };
const INVOICE_BASE: Record<OrderKind, string> = { sales: 'sales', purchase: 'purchase' };

interface OrderLineDb {
  voucher_id: number;
  line_no: number;
  number: string | null;
  date: string;
  due: string | null;
  party_ledger_id: number | null;
  party_name: string | null;
  ref: string;
  item_id: number;
  qty: number;
  rate: number;
  discount_pct: number;
}

/**
 * Order lines with their pending quantity as of `asOf` (fully fulfilled lines included, pending 0).
 * Balances pre-closed on or before `asOf` (documents module, order_closures) are taken off the
 * pending quantity (`closed`), last lines of the order first.
 */
export function orderPositions(db: Db, kind: OrderKind, asOf: string): Array<OrderLineDb & { fulfilled: number; closed: number; pending: number }> {
  const lines = db.all<OrderLineDb>(
    `SELECT ie.voucher_id, ie.line_no, v.number, v.date, v.effective_date AS due, v.party_ledger_id,
            COALESCE(l.name, v.party_name) AS party_name, ie.order_ref AS ref, ie.item_id, ABS(ie.qty) AS qty, ie.rate, ie.discount_pct
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE v.base_type = :base AND v.is_cancelled = 0 AND v.is_optional = 0 AND v.date <= :asOf AND ie.order_ref IS NOT NULL
      ORDER BY v.date, v.id, ie.line_no`,
    { base: ORDER_BASE[kind], asOf },
  );
  const consumed = new Map<string, number>();
  for (const c of db.all<{ party: number | null; ref: string; item_id: number; qty: number }>(
    `SELECT v.party_ledger_id AS party, ie.order_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.is_cancelled = 0 AND v.is_optional = 0 AND v.date <= :asOf AND ie.order_ref IS NOT NULL
        AND (v.base_type = :note OR (v.base_type = :invoice AND ie.tracking_ref IS NULL))
      GROUP BY v.party_ledger_id, ie.order_ref, ie.item_id`,
    { asOf, note: NOTE_BASE[kind], invoice: INVOICE_BASE[kind] },
  )) {
    consumed.set(`${c.party ?? 0}|${c.ref}|${c.item_id}`, Number(c.qty));
  }
  const out = lines.map((l) => {
    const key = `${l.party_ledger_id ?? 0}|${l.ref}|${l.item_id}`;
    const left = consumed.get(key) ?? 0;
    const take = Math.min(left, Number(l.qty));
    consumed.set(key, left - take);
    return { ...l, qty: Number(l.qty), fulfilled: roundQty(take), closed: 0, pending: roundQty(Number(l.qty) - take) };
  });
  applyClosures(
    out,
    closedQtyByOrderItem(db, asOf),
    (l) => ({ orderId: l.voucher_id, itemId: l.item_id, pending: l.pending }),
    (l, pending, closed) => {
      l.pending = roundQty(pending);
      l.closed = roundQty(l.closed + closed);
    },
  );
  return out;
}

/** 'stock.pendingOrders' — lines of sales or purchase orders not yet fully delivered / received. */
export function pendingOrders(db: Db, input: PendingOrdersInput): PendingOrdersResult {
  const items = loadItems(db);
  const rows: PendingOrderLine[] = [];
  const orders = new Set<number>();
  let pendingValue = 0;
  let overdueLines = 0;
  for (const p of orderPositions(db, input.kind, input.asOf)) {
    if (p.pending <= EPS) continue;
    const it = items.get(p.item_id);
    const value = lineAmount(p.pending, Number(p.rate), Number(p.discount_pct ?? 0));
    const overdue = p.due !== null ? diffDays(p.due, input.asOf) : null;
    const line: PendingOrderLine = {
      key: `o:${p.voucher_id}:${p.line_no}`,
      orderId: p.voucher_id,
      orderNo: p.number,
      orderDate: p.date,
      dueDate: p.due,
      overdueDays: overdue !== null && overdue > 0 ? overdue : null,
      partyLedgerId: p.party_ledger_id,
      partyName: p.party_name ?? '',
      itemId: p.item_id,
      itemName: it?.name ?? '',
      unit: it?.unit ?? '',
      orderedQty: roundQty(p.qty),
      fulfilledQty: p.fulfilled,
      ...(p.closed > 0 ? { closedQty: p.closed } : {}),
      pendingQty: p.pending,
      rate: Number(p.rate),
      discountPct: Number(p.discount_pct ?? 0),
      pendingValue: value,
    };
    rows.push(line);
    orders.add(p.voucher_id);
    pendingValue += value;
    if (line.overdueDays !== null) overdueLines++;
  }
  return { kind: input.kind, asOf: input.asOf, rows, totals: { orders: orders.size, pendingValue, overdueLines } };
}

/** Pending quantity per item of open orders as of a date. */
export function pendingQtyByItem(db: Db, kind: OrderKind, asOf: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of orderPositions(db, kind, asOf)) {
    if (p.pending <= EPS) continue;
    out.set(p.item_id, roundQty((out.get(p.item_id) ?? 0) + p.pending));
  }
  return out;
}

/**
 * 'stock.reorder' — items whose stock (net of open orders) is below the reorder level:
 * net available = closing + pending purchase orders − pending sales orders;
 * shortfall = reorder level − net available; order = max(shortfall, minimum order quantity).
 */
export function reorderStatus(db: Db, today: string, input: ReorderStatusInput): ReorderStatusResult {
  const items = [...loadItems(db).values()].filter((it) => !it.isService && it.reorderLevel !== null && it.reorderLevel > 0);
  if (items.length === 0) return { asOf: input.asOf, rows: [], itemsWithLevel: 0 };
  const groups = loadTree(db, 'group');
  const closing = stockByItem(db, { asOf: input.asOf, today, itemIds: items.map((i) => i.id) });
  const po = pendingQtyByItem(db, 'purchase', input.asOf);
  const so = pendingQtyByItem(db, 'sales', input.asOf);
  const rows: ReorderRow[] = [];
  for (const it of items) {
    const level = Number(it.reorderLevel);
    const close = closing.get(it.id) ?? 0;
    const pp = po.get(it.id) ?? 0;
    const ps = so.get(it.id) ?? 0;
    const net = roundQty(close + pp - ps);
    const shortfall = roundQty(level - net);
    if (shortfall <= EPS && close >= level - EPS) continue;
    const need = Math.max(0, shortfall);
    const min = it.minOrderQty !== null && it.minOrderQty > 0 ? it.minOrderQty : 0;
    rows.push({
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      groupName: it.groupId === null ? null : (groups.get(it.groupId)?.name ?? null),
      closingQty: close,
      reorderLevel: level,
      minOrderQty: it.minOrderQty,
      pendingPurchaseQty: pp,
      pendingSalesQty: ps,
      netAvailable: net,
      shortfall: roundQty(need),
      suggestedQty: need > EPS ? roundQty(Math.max(need, min)) : 0,
    });
  }
  rows.sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name));
  return { asOf: input.asOf, rows, itemsWithLevel: items.length };
}
