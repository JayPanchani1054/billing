/**
 * Module-owned migration for 'vouchers' (additive only).
 *
 *  - vouchers.party_pincode: buyer/supplier PIN in the party snapshot (e-invoice / e-way bill need it).
 *  - is_post_dated on bill_allocations, cost_allocations, inventory_entries and gst_lines, so every child
 *    table can apply the books filter `affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`
 *    (ledger_entries already had it) without joining back to vouchers.
 *  - Indexes for tracking/order references, supplier-invoice duplicate checks and bill-wise lookups.
 */
export const migration050 = {
  version: 50,
  name: 'vouchers',
  sql: /* sql */ `
ALTER TABLE vouchers ADD COLUMN party_pincode TEXT;
ALTER TABLE bill_allocations ADD COLUMN is_post_dated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cost_allocations ADD COLUMN is_post_dated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_entries ADD COLUMN is_post_dated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gst_lines ADD COLUMN is_post_dated INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_ie_tracking_ref ON inventory_entries(tracking_ref) WHERE tracking_ref IS NOT NULL;
CREATE INDEX idx_ie_order_ref ON inventory_entries(order_ref) WHERE order_ref IS NOT NULL;
CREATE INDEX idx_vouchers_party_ref ON vouchers(party_ledger_id, reference_no);
CREATE INDEX idx_bills_ledger_date ON bill_allocations(ledger_id, date);
CREATE INDEX idx_cost_alloc_voucher ON cost_allocations(voucher_id);
`,
} as const;
