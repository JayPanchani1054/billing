/**
 * Final wave — correctness gaps (block 240–249): filed GSTR-3B protection and the Rule 37 180-day check
 * (src/core/modules/gst/filed3b.ts, rule37.ts, README §18–§19), and the bill a TDS / TCS line belongs to
 * (src/core/modules/tds/hook.ts: reversal on debit / credit notes, TDS journals on bills booked gross).
 *
 *  - gst_3b_changes: a voucher whose GSTR-3B effect (outward tax, reverse charge, ITC, reversals) changes
 *    in a return period whose GSTR-3B is marked filed — altered, added late (dated in the filed period)
 *    or deleted / cancelled. `original` / `amended` are JSON snapshots of the voucher's GSTR-3B effect
 *    (null = not in the books); the change is reported in `report_period` (the first period after the
 *    document's that is not filed). Like gst_amendments for GSTR-1: the filed period keeps its figures.
 *    Keyed by voucher_guid (the voucher may be deleted: voucher_id is then set to NULL).
 *  - gst_rule37_links: which purchase invoices a Rule 37 reversal (or a Rule 37(4) reclaim) journal is
 *    for, and how much credit per head — so the 180-day report does not suggest reversing twice. Written
 *    by the gst voucher hook in the journal's own save transaction; goes with either voucher (CASCADE).
 *
 *  - tds_lines.bill_voucher_id: on a debit note (TDS) / credit note (TCS) the bill whose tax the note
 *    reverses in proportion (negative line), on a TDS journal for a bill booked gross the bill the tax
 *    was deducted on. NULL otherwise. The reports net a reversal into its bill's deduction.
 *
 * Additive only (new tables / column / indexes).
 */
export const migration240 = {
  version: 240,
  name: 'final_gaps',
  sql: /* sql */ `
CREATE TABLE gst_3b_changes (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  voucher_guid    TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('altered', 'added', 'removed')),
  original_period TEXT NOT NULL,
  report_period   TEXT NOT NULL,
  label           TEXT NOT NULL,
  doc_date        TEXT NOT NULL,
  original        TEXT,
  amended         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (voucher_guid, report_period)
);
CREATE INDEX idx_gst_3b_changes_report ON gst_3b_changes(report_period);
CREATE INDEX idx_gst_3b_changes_voucher ON gst_3b_changes(voucher_id);
CREATE INDEX idx_gst_3b_changes_original ON gst_3b_changes(original_period);

CREATE TABLE gst_rule37_links (
  id                   INTEGER PRIMARY KEY,
  voucher_id           INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  purchase_voucher_id  INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('reversal', 'reclaim')),
  igst                 INTEGER NOT NULL DEFAULT 0,
  cgst                 INTEGER NOT NULL DEFAULT 0,
  sgst                 INTEGER NOT NULL DEFAULT 0,
  cess                 INTEGER NOT NULL DEFAULT 0,
  date                 TEXT NOT NULL,
  affects_books        INTEGER NOT NULL DEFAULT 1,
  is_post_dated        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gst_rule37_links_voucher ON gst_rule37_links(voucher_id);
CREATE INDEX idx_gst_rule37_links_purchase ON gst_rule37_links(purchase_voucher_id);

ALTER TABLE tds_lines ADD COLUMN bill_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL;
CREATE INDEX idx_tds_lines_bill ON tds_lines(bill_voucher_id) WHERE bill_voucher_id IS NOT NULL;
`,
};
