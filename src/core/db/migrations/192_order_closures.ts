/**
 * Documents group, part 3: order pre-close / short-close (src/core/modules/documents/orders.ts).
 *
 * order_closures — the balance of a sales/purchase order item that will not be supplied, closed with
 * a reason on a date (Tally "Pre-close order"). One row per order + item: `closed_qty` is the quantity
 * that was pending when it was closed. The order itself is never altered (its history stays intact);
 * pending-order reports (stock.pendingOrders, vouchers.trackingRefs, reorder status) subtract
 * closures dated on or before their as-of date. Reopen deletes the rows (audited). Deleting the order
 * deletes its closures.
 */
export const migration192 = {
  version: 192,
  name: 'order_closures',
  sql: /* sql */ `
CREATE TABLE order_closures (
  id          INTEGER PRIMARY KEY,
  voucher_id  INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES stock_items(id),
  closed_qty  REAL NOT NULL CHECK (closed_qty > 0),
  date        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  INTEGER,
  UNIQUE (voucher_id, item_id)
);
CREATE INDEX idx_order_closures_item ON order_closures(item_id);
`,
} as const;
