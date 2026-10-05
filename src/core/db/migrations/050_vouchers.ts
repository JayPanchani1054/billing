/**
 * Module-owned migration for 'vouchers' (additive only).
 *
 *  - vouchers.party_pincode: buyer/supplier PIN in the party snapshot (e-invoice / e-way bill need it).
 *  - is_post_dated on bill_allocations, cost_allocations, inventory_entries and gst_lines, so every child
 *    table can apply the books filter `affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`
 *    (ledger_entries already had it) without joining back to vouchers.
 *  - Indexes for tracking/order references, supplier-invoice duplicate checks and bill-wise lookups.
 *  - Indexes on every child column whose parent row is deleted by a voucher alter/delete/cancel
 *    (foreign-key actions ON DELETE CASCADE / SET NULL). Without them SQLite scans the whole child
 *    table once per deleted parent row: an alter rewrites every ledger entry, so a 500-line voucher
 *    would scan bill_allocations, cost_allocations and bank_statement_lines 500 times each.
 *      bill_allocations.ledger_entry_id, cost_allocations.ledger_entry_id  → ledger_entries (CASCADE)
 *      bank_statement_lines.matched_entry_id                              → ledger_entries (SET NULL)
 *      gst_portal_docs.matched_voucher_id                                  → vouchers (SET NULL)
 *    (ledger_entries / inventory_entries / gst_lines / bill_allocations .voucher_id and
 *    gst_doc_events.voucher_id already have indexes.)
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

CREATE INDEX IF NOT EXISTS idx_bills_entry ON bill_allocations(ledger_entry_id);
CREATE INDEX IF NOT EXISTS idx_cost_alloc_entry ON cost_allocations(ledger_entry_id);
CREATE INDEX IF NOT EXISTS idx_bsl_matched_entry ON bank_statement_lines(matched_entry_id);
CREATE INDEX IF NOT EXISTS idx_portal_matched_voucher ON gst_portal_docs(matched_voucher_id);
`,
} as const;
