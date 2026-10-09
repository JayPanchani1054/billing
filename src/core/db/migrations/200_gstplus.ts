/**
 * GST plus (gst module, versions 200–209): advances (GSTR-1 Table 11), bills of entry, GST stat
 * adjustments / set-off / challans (electronic cash & credit ledgers), return filing status and the
 * GSTR-1 amendments log, composition rates and GST module settings. Additive only.
 *
 * Derived per-voucher tables (rebuilt by the gst voucher hook, src/core/modules/gst/hook.ts, inside the
 * voucher save transaction, like gst_lines) carry the voucher date / affects_books / is_post_dated so
 * reports apply the books filter without joining vouchers; they cascade on voucher delete:
 *
 *  - gst_advance_lines   advance received (receipt) / adjusted (sales invoice) / refunded (payment),
 *                        one row per voucher × advance; rate-wise and POS-wise for Table 11A / 11B.
 *  - gst_bill_of_entry   bill of entry of an import-of-goods purchase (IGST paid at customs → 3B 4(A)(1)).
 *  - gst_stat_lines      head-wise amounts of a GST stat adjustment journal (ITC reversal / reclaim,
 *                        reverse-charge liability), of the set-off journal (ITC utilised, cash utilised by
 *                        major × minor head) and of a GST challan (cash deposited by major × minor head).
 *  - gst_challans        challan (PMT-06) particulars of a GST payment voucher.
 *
 * Masters / logs (not derived):
 *  - gst_return_filings  a return marked as filed (form + period key), with ARN and a JSON snapshot of
 *                        the summary as filed.
 *  - gst_amendments      outward documents changed after their GSTR-1 period was filed (or added to it):
 *                        original + amended snapshot, reported in the GSTR-1 of `amend_period`.
 *  - gst_composition_rates  composition levy rate per category, effective-dated (editable master).
 *  - gst_settings        key → JSON (composition category).
 */
export const migration200 = {
  version: 200,
  name: 'gstplus',
  sql: /* sql */ `
CREATE TABLE gst_advance_lines (
  id                 INTEGER PRIMARY KEY,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('received','adjusted','refunded')),
  receipt_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,   -- the advance receipt (self for 'received')
  party_ledger_id    INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
  pos                TEXT NOT NULL,
  supply_type        TEXT NOT NULL DEFAULT 'services',
  rate               REAL NOT NULL DEFAULT 0,
  cess_rate          REAL NOT NULL DEFAULT 0,
  gross              INTEGER NOT NULL,          -- paise: advance amount incl. tax (received / adjusted / refunded)
  taxable_value      INTEGER NOT NULL,
  igst               INTEGER NOT NULL DEFAULT 0,
  cgst               INTEGER NOT NULL DEFAULT 0,
  sgst               INTEGER NOT NULL DEFAULT 0,
  cess               INTEGER NOT NULL DEFAULT 0,
  date               TEXT NOT NULL,
  affects_books      INTEGER NOT NULL DEFAULT 1,
  is_post_dated      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gst_adv_date ON gst_advance_lines(date, affects_books);
CREATE INDEX idx_gst_adv_voucher ON gst_advance_lines(voucher_id);
CREATE INDEX idx_gst_adv_receipt ON gst_advance_lines(receipt_voucher_id);

CREATE TABLE gst_bill_of_entry (
  voucher_id       INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  boe_no           TEXT NOT NULL,
  boe_date         TEXT NOT NULL,
  port_code        TEXT,
  assessable_value INTEGER NOT NULL DEFAULT 0,
  customs_duty     INTEGER NOT NULL DEFAULT 0,
  igst             INTEGER NOT NULL DEFAULT 0,
  cess             INTEGER NOT NULL DEFAULT 0,
  itc_claimed      INTEGER NOT NULL DEFAULT 1,
  date             TEXT NOT NULL,
  affects_books    INTEGER NOT NULL DEFAULT 1,
  is_post_dated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gst_boe_date ON gst_bill_of_entry(date, affects_books);

CREATE TABLE gst_stat_lines (
  id            INTEGER PRIMARY KEY,
  voucher_id    INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  nature        TEXT NOT NULL,              -- see shared/types/gst-plus.ts GST_STAT_NATURES
  return_period TEXT,                       -- '042026' / '2026-27-Q1'
  head          TEXT NOT NULL CHECK (head IN ('igst','cgst','sgst','cess')),
  minor         TEXT,                       -- tax|interest|penalty|fee|others (cash rows); target head for itc_utilised
  amount        INTEGER NOT NULL,           -- paise, positive
  taxable_value INTEGER NOT NULL DEFAULT 0, -- reverse-charge journals (3.1(d) value, on the first head row)
  date          TEXT NOT NULL,
  affects_books INTEGER NOT NULL DEFAULT 1,
  is_post_dated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gst_stat_date ON gst_stat_lines(date, affects_books, nature);
CREATE INDEX idx_gst_stat_voucher ON gst_stat_lines(voucher_id);
CREATE INDEX idx_gst_stat_period ON gst_stat_lines(return_period, nature);

CREATE TABLE gst_challans (
  voucher_id    INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  cpin          TEXT NOT NULL,
  cin           TEXT,
  brn           TEXT,
  challan_date  TEXT,
  bank_name     TEXT,
  mode          TEXT,
  return_period TEXT,
  date          TEXT NOT NULL,
  affects_books INTEGER NOT NULL DEFAULT 1,
  is_post_dated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gst_challans_date ON gst_challans(date);

CREATE TABLE gst_return_filings (
  form          TEXT NOT NULL,              -- gstr1 | gstr3b | cmp08 | gstr4
  return_period TEXT NOT NULL,              -- '042026', '2026-27-Q1', '2026-27' (GSTR-4)
  filed_on      TEXT NOT NULL,
  arn           TEXT,
  snapshot      TEXT,                       -- JSON summary as filed
  created_at    TEXT NOT NULL,
  created_by    INTEGER,
  PRIMARY KEY (form, return_period)
);

CREATE TABLE gst_amendments (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  voucher_guid    TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('amended','added')),
  original_period TEXT NOT NULL,            -- filed GSTR-1 period of the original document
  amend_period    TEXT NOT NULL,            -- GSTR-1 period that reports the amendment
  orig_number     TEXT,
  orig_date       TEXT NOT NULL,
  original        TEXT,                     -- JSON snapshot as filed (null for 'added')
  amended         TEXT,                     -- JSON snapshot after the change
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (voucher_id, amend_period)
);
CREATE INDEX idx_gst_amend_period ON gst_amendments(amend_period);

CREATE TABLE gst_composition_rates (
  id             INTEGER PRIMARY KEY,
  category       TEXT NOT NULL,             -- manufacturer | trader | restaurant | services
  effective_from TEXT NOT NULL,
  rate           REAL NOT NULL,             -- total % (CGST and SGST/UTGST half each)
  basis          TEXT NOT NULL CHECK (basis IN ('turnover','taxable_turnover')),
  note           TEXT,
  UNIQUE (category, effective_from)
);
-- Seed (CGST Rules r.7 as amended by Notification 3/2018-CT w.e.f. 1-Jan-2018; services under s.10(2A) by
-- Notification 2/2019-CT(R) w.e.f. 1-Apr-2019). The 'services' basis is our reading of "turnover" for
-- the 6% scheme; verify with your adviser. Editable under GST › Composition rates.
INSERT INTO gst_composition_rates (category, effective_from, rate, basis, note) VALUES
  ('manufacturer', '2017-07-01', 2, 'turnover', 'Manufacturers: 1% CGST + 1% SGST of turnover in the State (r.7 as notified in 2017)'),
  ('trader',       '2017-07-01', 1, 'turnover', 'Traders: 0.5% CGST + 0.5% SGST of turnover in the State (r.7 as notified in 2017)'),
  ('manufacturer', '2018-01-01', 1, 'turnover', 'Manufacturers (other than notified goods): 0.5% CGST + 0.5% SGST of turnover in the State (r.7, N/N 3/2018-CT)'),
  ('trader',       '2018-01-01', 1, 'taxable_turnover', 'Other suppliers (traders): 0.5% CGST + 0.5% SGST of turnover of taxable supplies in the State (r.7, N/N 3/2018-CT)'),
  ('restaurant',   '2017-07-01', 5, 'turnover', 'Restaurant service (s.10(1)(b)): 2.5% CGST + 2.5% SGST of turnover in the State (r.7)'),
  ('services',     '2019-04-01', 6, 'turnover', 'Service providers under s.10(2A): 3% CGST + 3% SGST (N/N 2/2019-CT(R)); verify the turnover basis');

CREATE TABLE gst_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);
`,
} as const;
