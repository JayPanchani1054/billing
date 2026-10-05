/**
 * Module-owned migration for 'gstrecon' (additive only). Builds on the v1 tables import_batches and
 * gst_portal_docs (one row per portal document; match_status / matched_voucher_id / match_details are
 * rewritten by every reconciliation run).
 *
 *  - gst_portal_docs: section (b2b, cdnr, b2ba …), doc_key (supplier GSTIN | class | normalised doc no.
 *    — the identity that manual decisions survive re-imports by), supplier filing period/date and a
 *    `meta` JSON (rates, ITC reason, IRN, amendment origin …).
 *  - gstrecon_decisions: manual link / accept / ignore per (source, period, doc_key) for portal rows,
 *    or per (source, period, voucher_id) for books-only rows. A deleted voucher drops its books-only
 *    decision (CASCADE) and clears a manual link (SET NULL).
 *  - gstrecon_books_only: vouchers missing on the portal at the last run (status + details JSON).
 *  - gstrecon_runs: run history with the tolerance used and the books totals of the period.
 */
export const migration100 = {
  version: 100,
  name: 'gstrecon',
  sql: /* sql */ `
ALTER TABLE gst_portal_docs ADD COLUMN section TEXT;
ALTER TABLE gst_portal_docs ADD COLUMN doc_key TEXT;
ALTER TABLE gst_portal_docs ADD COLUMN supplier_period TEXT;
ALTER TABLE gst_portal_docs ADD COLUMN filing_date TEXT;
ALTER TABLE gst_portal_docs ADD COLUMN meta TEXT;
CREATE INDEX idx_portal_docs_batch ON gst_portal_docs(batch_id);
CREATE INDEX idx_portal_docs_key ON gst_portal_docs(source, doc_key);
CREATE INDEX idx_portal_docs_voucher ON gst_portal_docs(matched_voucher_id) WHERE matched_voucher_id IS NOT NULL;
CREATE INDEX idx_import_batches_kind ON import_batches(kind, imported_at);

CREATE TABLE gstrecon_decisions (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,                 -- gstr2b|gstr2a|gstr1
  return_period   TEXT NOT NULL,                 -- MMYYYY
  doc_key         TEXT,                          -- portal document identity; NULL for books-only rows
  voucher_id      INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,       -- books-only rows
  link_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,      -- manual link of a portal row
  resolution      TEXT CHECK (resolution IN ('accept','ignore')),
  remarks         TEXT,
  user_id         INTEGER,
  username        TEXT,
  updated_at      TEXT NOT NULL,
  CHECK (doc_key IS NOT NULL OR voucher_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_gstrecon_decisions_doc ON gstrecon_decisions(source, return_period, doc_key) WHERE doc_key IS NOT NULL;
CREATE UNIQUE INDEX ux_gstrecon_decisions_voucher ON gstrecon_decisions(source, return_period, voucher_id) WHERE doc_key IS NULL;
CREATE INDEX idx_gstrecon_decisions_link ON gstrecon_decisions(link_voucher_id) WHERE link_voucher_id IS NOT NULL;

CREATE TABLE gstrecon_books_only (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  return_period TEXT NOT NULL,
  voucher_id    INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,                   -- missing_in_portal|accepted|ignored
  details       TEXT NOT NULL,                   -- JSON: books snapshot, other period, duplicates, notes
  UNIQUE (source, return_period, voucher_id)
);
CREATE INDEX idx_gstrecon_books_only_voucher ON gstrecon_books_only(voucher_id);

CREATE TABLE gstrecon_runs (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  return_period TEXT NOT NULL,
  batch_id      INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  run_at        TEXT NOT NULL,
  user_id       INTEGER,
  username      TEXT,
  date_from     TEXT NOT NULL,
  date_to       TEXT NOT NULL,
  tolerance     TEXT NOT NULL,                   -- JSON ReconTolerance
  summary       TEXT NOT NULL                    -- JSON: counts, books totals, notes
);
CREATE INDEX idx_gstrecon_runs ON gstrecon_runs(source, return_period, id);
`,
} as const;
