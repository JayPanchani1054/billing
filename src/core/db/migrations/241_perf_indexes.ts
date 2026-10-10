/**
 * Final wave — performance with every voucher hook on (block 240–249). Indexes only, additive: a voucher
 * save / alter / delete must touch the rows of its own voucher and of the party / bank / period it
 * needs, never a whole table (regression test: src/core/modules/vouchers/perf-hooks.test.ts).
 *
 *  - idx_le_cheques: cheque leaves issued from a bank (cheques hook `compose` picks the next free leaf,
 *    `adjust` checks a typed number, the cheque register). Without it each Payment / Contra by cheque
 *    read EVERY entry of the bank ledger (idx_le_books, ledger_id = ?) — receipts, NEFTs and all — to
 *    find the cheque lines. Partial (instrument_type = 'cheque'): only cheque lines are indexed, so
 *    ordinary entries pay no write cost. Covering for the leaf look-up.
 *  - idx_gstrecon_decisions_voucher: the ON DELETE CASCADE look-up of a deleted voucher's books-only
 *    reconciliation decision (100_gstrecon indexed only the SET NULL column link_voucher_id), which
 *    scanned the whole table on every voucher delete. Partial like idx_gstrecon_decisions_link
 *    (`voucher_id = ?` implies NOT NULL, so the FK look-up uses it).
 *  - idx_tds_lines_kind_date: TDS / TCS reports read a period of one kind (computation, outstanding,
 *    return data, exceptions). The only kind-led index was (kind, section, date), whose date column is
 *    unusable without a section, so every report read all lines of the kind since the books began.
 *  - idx_vouchers_eway: the "this e-way bill number is already on another voucher" check
 *    (gst/ewaybill.ts) scanned every voucher. Partial: only vouchers with an e-way bill.
 *
 * Why 241: migrations run by PRAGMA user_version, so this follow-up is numbered above every version
 * already registered (240).
 */
export const migration241 = {
  version: 241,
  name: 'perf_indexes',
  sql: /* sql */ `
CREATE INDEX idx_le_cheques ON ledger_entries(ledger_id, instrument_no, voucher_id, amount) WHERE instrument_type = 'cheque';
CREATE INDEX idx_gstrecon_decisions_voucher ON gstrecon_decisions(voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX idx_tds_lines_kind_date ON tds_lines(kind, date);
CREATE INDEX idx_vouchers_eway ON vouchers(eway_bill_no) WHERE eway_bill_no IS NOT NULL;
`,
} as const;
