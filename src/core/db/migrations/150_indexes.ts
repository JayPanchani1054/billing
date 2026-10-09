/**
 * Maintenance migration: drop indexes that duplicate another one (every voucher save / alter /
 * delete maintains each index of ledger_entries, gst_lines, …; a duplicate is pure write cost and
 * file size — idx_le_ledger_date alone was 6.7 MB on a 60,000-voucher company).
 *
 *  - idx_le_ledger_date (ledger_id, date)  — a strict prefix of idx_le_books (ledger_id, date,
 *    affects_books, is_post_dated, amount) (030_accounts): every ledger look-up uses that one.
 *  - idx_gst_date (date)                   — a prefix of idx_gst_lines_books (date, affects_books,
 *    voucher_id) (090_gst).
 *  - idx_bsl_matched_entry                 — duplicates the partial idx_bsl_entry (110_banking); the
 *    partial index also serves the ON DELETE SET NULL look-up from ledger_entries (`= ?` implies
 *    NOT NULL), so deleting ledger entries stays indexed.
 *  - idx_portal_matched_voucher            — duplicates the partial idx_portal_docs_voucher
 *    (100_gstrecon), likewise for vouchers.
 *
 * Why a version above every module range instead of 031 / 051 / 091: migrations are driven by
 * PRAGMA user_version, so a follow-up numbered below a version a company has already reached (every
 * company is at 140) would never run there — only new companies would lose the duplicates.
 */
export const migration150 = {
  version: 150,
  name: 'indexes',
  sql: /* sql */ `
DROP INDEX IF EXISTS idx_le_ledger_date;
DROP INDEX IF EXISTS idx_gst_date;
DROP INDEX IF EXISTS idx_bsl_matched_entry;
DROP INDEX IF EXISTS idx_portal_matched_voucher;
`,
} as const;
