/**
 * Module-owned migration for 'gst' (additive only).
 *
 *  - gst_adjustments: manual return entries per form and return period (GSTR-3B: ISD credit, ITC
 *    reversals, reclaimed/ineligible ITC, interest, late fee) as JSON. One row per (form, period).
 *  - gst_doc_events: history of e-invoice / e-way bill actions per voucher (JSON exported, IRN imported,
 *    IRN cancelled, e-way bill recorded). The vouchers table keeps the current state (irn*, eway_*);
 *    this table keeps the trail, including the IRN cancellation reason. voucher_id is SET NULL when a
 *    voucher is deleted so the trail survives.
 *  - idx_gst_lines_books: GST reports scan gst_lines by date with the books filter.
 */
export const migration090 = {
  version: 90,
  name: 'gst',
  sql: /* sql */ `
CREATE TABLE gst_adjustments (
  form          TEXT NOT NULL DEFAULT 'gstr3b',
  return_period TEXT NOT NULL,          -- '042026' or '2026-27-Q1'
  data          TEXT NOT NULL,          -- JSON (Gstr3bAdjustments for 'gstr3b')
  updated_at    TEXT NOT NULL,
  updated_by    INTEGER,
  PRIMARY KEY (form, return_period)
);

CREATE TABLE gst_doc_events (
  id          INTEGER PRIMARY KEY,
  voucher_id  INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('einvoice','ewaybill')),
  action      TEXT NOT NULL,            -- exported|generated|cancelled|updated
  ref_no      TEXT,                     -- IRN or e-way bill number
  detail      TEXT,                     -- JSON (file name, ack no., reason …)
  ts          TEXT NOT NULL,
  user_id     INTEGER,
  username    TEXT
);
CREATE INDEX idx_gst_doc_events_voucher ON gst_doc_events(voucher_id, kind);

CREATE INDEX IF NOT EXISTS idx_gst_lines_books ON gst_lines(date, affects_books, voucher_id);
`,
} as const;
