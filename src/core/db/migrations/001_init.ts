/**
 * Schema v1 — the canonical company database.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 *  - Money columns are INTEGER paise. Signed amounts use Debit = positive, Credit = negative.
 *  - Quantities and rates are REAL (rates are rupees per unit, quantities in the item's base unit).
 *  - Dates are ISO 'YYYY-MM-DD' TEXT; timestamps are ISO-8601 UTC TEXT.
 *  - Every master/voucher has a stable `guid` (UUID v4) used for import/export and the audit log.
 *  - Child rows of a voucher are rewritten on every save; `date` and `affects_books`
 *    are denormalised onto them so reports never need to join back to `vouchers`.
 */
export const migration001 = {
  version: 1,
  name: 'init',
  sql: /* sql */ `
-- ───────────────────────────── Company & settings ─────────────────────────────
CREATE TABLE company (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  guid                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  mailing_name          TEXT,
  address               TEXT,
  state_code            TEXT,                -- GST state code, e.g. '27'
  country               TEXT NOT NULL DEFAULT 'India',
  pincode               TEXT,
  phone                 TEXT,
  mobile                TEXT,
  email                 TEXT,
  website               TEXT,
  gstin                 TEXT,
  gst_registration_type TEXT NOT NULL DEFAULT 'regular'
                        CHECK (gst_registration_type IN ('regular','composition','unregistered')),
  pan                   TEXT,
  tan                   TEXT,
  cin                   TEXT,
  fy_start_month        INTEGER NOT NULL DEFAULT 4,   -- April
  books_from            TEXT NOT NULL,                -- books beginning date
  base_currency         TEXT NOT NULL DEFAULT 'INR',
  logo                  BLOB,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Key/value JSON settings: features (F11), configuration (F12), print options, locks.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,           -- JSON
  updated_at TEXT NOT NULL
);

-- ───────────────────────────── Security ─────────────────────────────
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  permissions TEXT NOT NULL,          -- JSON array of permission strings
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,   -- scrypt$N$r$p$salt$hash
  role_id              INTEGER NOT NULL REFERENCES roles(id),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Tamper-evident edit log (MCA audit-trail requirement). Append-only, SHA-256 hash chained.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  user_id      INTEGER,
  username     TEXT,
  action       TEXT NOT NULL,   -- create|alter|delete|cancel|login|logout|login_failed|export|import|backup|restore|settings|security
  entity_type  TEXT,            -- company|ledger|group|stock_item|voucher|user|...
  entity_id    INTEGER,
  entity_guid  TEXT,
  entity_label TEXT,
  before_json  TEXT,
  after_json   TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ───────────────────────────── Accounting masters ─────────────────────────────
CREATE TABLE groups (
  id                    INTEGER PRIMARY KEY,
  guid                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias                 TEXT,
  parent_id             INTEGER REFERENCES groups(id),        -- NULL = primary group
  nature                TEXT NOT NULL CHECK (nature IN ('assets','liabilities','income','expenses')),
  affects_gross_profit  INTEGER NOT NULL DEFAULT 0,
  reserved_code         TEXT UNIQUE,                          -- stable code for predefined groups (see shared/constants.ts)
  is_predefined         INTEGER NOT NULL DEFAULT 0,
  is_subledger          INTEGER NOT NULL DEFAULT 0,           -- "behaves like a sub-ledger"
  net_balances          INTEGER NOT NULL DEFAULT 0,           -- net Dr/Cr balances for reporting
  used_for_calculation  INTEGER NOT NULL DEFAULT 0,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_groups_parent ON groups(parent_id);

CREATE TABLE currencies (
  id             INTEGER PRIMARY KEY,
  guid           TEXT NOT NULL UNIQUE,
  symbol         TEXT NOT NULL UNIQUE,
  formal_name    TEXT NOT NULL,
  iso_code       TEXT,
  decimal_places INTEGER NOT NULL DEFAULT 2,
  is_base        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE exchange_rates (
  id          INTEGER PRIMARY KEY,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  standard    REAL,
  selling     REAL,
  buying      REAL,
  UNIQUE (currency_id, date)
);

CREATE TABLE cost_categories (
  id                   INTEGER PRIMARY KEY,
  guid                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  allocate_revenue     INTEGER NOT NULL DEFAULT 1,
  allocate_non_revenue INTEGER NOT NULL DEFAULT 0,
  is_predefined        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE cost_centres (
  id          INTEGER PRIMARY KEY,
  guid        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias       TEXT,
  category_id INTEGER NOT NULL REFERENCES cost_categories(id),
  parent_id   INTEGER REFERENCES cost_centres(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE ledgers (
  id                        INTEGER PRIMARY KEY,
  guid                      TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias                     TEXT,
  group_id                  INTEGER NOT NULL REFERENCES groups(id),
  reserved_code             TEXT UNIQUE,                 -- CASH, PROFIT_LOSS, OUTPUT_IGST, ROUND_OFF, ... (shared/constants.ts)
  is_predefined             INTEGER NOT NULL DEFAULT 0,
  is_active                 INTEGER NOT NULL DEFAULT 1,
  opening_balance           INTEGER NOT NULL DEFAULT 0,  -- paise, Dr +, Cr -
  currency_id               INTEGER REFERENCES currencies(id),

  -- Bill-wise / credit control
  maintain_bill_wise        INTEGER NOT NULL DEFAULT 0,
  default_credit_days       INTEGER,
  credit_limit              INTEGER,                     -- paise
  -- Interest
  interest_enabled          INTEGER NOT NULL DEFAULT 0,
  interest_rate             REAL,                        -- % per annum
  -- Cost centres
  cost_centres_applicable   INTEGER NOT NULL DEFAULT 0,
  -- Inventory
  inventory_values_affected INTEGER NOT NULL DEFAULT 0,

  -- Mailing / party details
  mailing_name              TEXT,
  address                   TEXT,
  state_code                TEXT,
  country                   TEXT DEFAULT 'India',
  pincode                   TEXT,
  contact_person            TEXT,
  phone                     TEXT,
  mobile                    TEXT,
  email                     TEXT,
  pan                       TEXT,

  -- Party GST registration
  gst_registration_type     TEXT,   -- regular|composition|unregistered|consumer|sez|overseas|deemed_export|uin
  gstin                     TEXT,
  is_ecommerce_operator     INTEGER NOT NULL DEFAULT 0,

  -- Bank details (Bank Accounts / Bank OD groups)
  bank_account_holder       TEXT,
  bank_account_no           TEXT,
  bank_ifsc                 TEXT,
  bank_name                 TEXT,
  bank_branch               TEXT,
  bank_upi_id               TEXT,
  cheque_book_enabled       INTEGER NOT NULL DEFAULT 0,

  -- Duties & Taxes ledgers
  tax_type                  TEXT,   -- GST|TDS|TCS|OTHER
  gst_duty_head             TEXT,   -- IGST|CGST|SGST|CESS
  gst_tax_direction         TEXT,   -- output|input|rcm_liability

  -- Sales / Purchase / income / expense ledger GST details
  gst_applicable            TEXT NOT NULL DEFAULT 'not_applicable',  -- applicable|not_applicable
  gst_taxability            TEXT,   -- taxable|exempt|nil_rated|non_gst
  gst_rate                  REAL,
  cess_rate                 REAL,
  hsn_sac                   TEXT,
  gst_supply_type           TEXT,   -- goods|services
  is_reverse_charge         INTEGER NOT NULL DEFAULT 0,
  itc_eligibility           TEXT,   -- inputs|capital_goods|input_services|ineligible
  gst_nature_override       TEXT,   -- force a GST classification on vouchers using this ledger (e.g. export_lut)
  include_in_assessable     TEXT,   -- for additional charges: none|goods|services (appropriate to taxable value)
  appropriate_by            TEXT,   -- value|quantity

  -- TDS
  tds_applicable            INTEGER NOT NULL DEFAULT 0,
  tds_section               TEXT,

  notes                     TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX idx_ledgers_group ON ledgers(group_id);

-- Opening bill-wise balances (bills outstanding before books_from)
CREATE TABLE opening_bills (
  id         INTEGER PRIMARY KEY,
  ledger_id  INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  bill_name  TEXT NOT NULL,
  bill_date  TEXT NOT NULL,
  due_date   TEXT,
  amount     INTEGER NOT NULL,  -- paise, Dr +, Cr -
  UNIQUE (ledger_id, bill_name)
);

-- Effective-dated GST rate history for ledgers, stock groups and stock items.
CREATE TABLE gst_rate_history (
  id              INTEGER PRIMARY KEY,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('ledger','stock_group','stock_item')),
  entity_id       INTEGER NOT NULL,
  applicable_from TEXT NOT NULL,
  hsn_sac         TEXT,
  taxability      TEXT NOT NULL DEFAULT 'taxable',
  rate            REAL NOT NULL DEFAULT 0,
  cess_rate       REAL NOT NULL DEFAULT 0,
  cess_per_unit   INTEGER NOT NULL DEFAULT 0,   -- paise per unit (specific cess)
  UNIQUE (entity_type, entity_id, applicable_from)
);

-- ───────────────────────────── Voucher types ─────────────────────────────
CREATE TABLE voucher_types (
  id                   INTEGER PRIMARY KEY,
  guid                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias                TEXT,
  abbreviation         TEXT,
  base_type            TEXT NOT NULL,   -- see VOUCHER_BASE_TYPES in shared/constants.ts
  parent_id            INTEGER REFERENCES voucher_types(id),
  is_predefined        INTEGER NOT NULL DEFAULT 0,
  is_active            INTEGER NOT NULL DEFAULT 1,
  numbering_method     TEXT NOT NULL DEFAULT 'automatic',   -- automatic|automatic_override|manual|none
  numbering_prefix     TEXT,
  numbering_suffix     TEXT,
  numbering_start      INTEGER NOT NULL DEFAULT 1,
  numbering_width      INTEGER NOT NULL DEFAULT 0,          -- zero padding
  numbering_restart    TEXT NOT NULL DEFAULT 'yearly',      -- yearly|monthly|never
  prevent_duplicates   INTEGER NOT NULL DEFAULT 1,
  use_effective_date   INTEGER NOT NULL DEFAULT 0,
  allow_zero_value     INTEGER NOT NULL DEFAULT 0,
  optional_by_default  INTEGER NOT NULL DEFAULT 0,
  narration_per_entry  INTEGER NOT NULL DEFAULT 0,
  print_after_save     INTEGER NOT NULL DEFAULT 0,
  config               TEXT NOT NULL DEFAULT '{}',          -- JSON: default ledgers, invoice title, declaration, terms, print template, bank ledger
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE voucher_counters (
  voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
  period_key      TEXT NOT NULL,      -- '2025-26' (yearly), '2025-04' (monthly) or 'all'
  last_number     INTEGER NOT NULL,
  PRIMARY KEY (voucher_type_id, period_key)
);

-- ───────────────────────────── Inventory masters ─────────────────────────────
CREATE TABLE units (
  id             INTEGER PRIMARY KEY,
  guid           TEXT NOT NULL UNIQUE,
  symbol         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  formal_name    TEXT,
  uqc            TEXT,                  -- GST Unique Quantity Code
  decimal_places INTEGER NOT NULL DEFAULT 0,
  is_compound    INTEGER NOT NULL DEFAULT 0,
  first_unit_id  INTEGER REFERENCES units(id),
  conversion     REAL,                  -- 1 first_unit = conversion * second_unit
  second_unit_id INTEGER REFERENCES units(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE stock_groups (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias           TEXT,
  parent_id       INTEGER REFERENCES stock_groups(id),
  add_quantities  INTEGER NOT NULL DEFAULT 1,
  gst_applicable  TEXT NOT NULL DEFAULT 'not_applicable',
  hsn_sac         TEXT,
  gst_taxability  TEXT,
  gst_rate        REAL,
  cess_rate       REAL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE stock_categories (
  id         INTEGER PRIMARY KEY,
  guid       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias      TEXT,
  parent_id  INTEGER REFERENCES stock_categories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE godowns (
  id            INTEGER PRIMARY KEY,
  guid          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias         TEXT,
  parent_id     INTEGER REFERENCES godowns(id),
  address       TEXT,
  is_predefined INTEGER NOT NULL DEFAULT 0,      -- 'Main Location'
  is_third_party INTEGER NOT NULL DEFAULT 0,     -- our stock with third party / their stock with us
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE stock_items (
  id                   INTEGER PRIMARY KEY,
  guid                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  alias                TEXT,
  part_no              TEXT,
  barcode              TEXT,
  description          TEXT,
  group_id             INTEGER REFERENCES stock_groups(id),
  category_id          INTEGER REFERENCES stock_categories(id),
  unit_id              INTEGER NOT NULL REFERENCES units(id),
  alt_unit_id          INTEGER REFERENCES units(id),
  alt_conversion       REAL,                    -- base units per 1 alt unit
  maintain_batches     INTEGER NOT NULL DEFAULT 0,
  track_mfg_date       INTEGER NOT NULL DEFAULT 0,
  use_expiry           INTEGER NOT NULL DEFAULT 0,
  costing_method       TEXT NOT NULL DEFAULT 'avg_cost',   -- avg_cost|fifo|lifo|last_purchase|std_cost
  market_valuation     TEXT NOT NULL DEFAULT 'avg_price',
  is_service           INTEGER NOT NULL DEFAULT 0,
  -- GST (current values; history in gst_rate_history)
  gst_applicable       TEXT NOT NULL DEFAULT 'applicable',
  hsn_sac              TEXT,
  gst_taxability       TEXT NOT NULL DEFAULT 'taxable',
  gst_rate             REAL,
  cess_rate            REAL,
  cess_per_unit        INTEGER NOT NULL DEFAULT 0,          -- paise
  rate_inclusive_of_tax INTEGER NOT NULL DEFAULT 0,
  -- Pricing
  mrp                  INTEGER,       -- paise
  selling_price        INTEGER,       -- paise, default sales rate
  purchase_price       INTEGER,       -- paise, default purchase rate
  standard_cost        INTEGER,       -- paise
  reorder_level        REAL,
  min_order_qty        REAL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_items_group ON stock_items(group_id);

-- Opening stock per godown/batch
CREATE TABLE stock_openings (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  godown_id   INTEGER NOT NULL REFERENCES godowns(id),
  batch_name  TEXT,
  mfg_date    TEXT,
  expiry_date TEXT,
  qty         REAL NOT NULL,
  rate        REAL NOT NULL DEFAULT 0,
  value       INTEGER NOT NULL DEFAULT 0     -- paise
);
CREATE INDEX idx_stock_openings_item ON stock_openings(item_id);

CREATE TABLE price_levels (
  id         INTEGER PRIMARY KEY,
  guid       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE price_list (
  id             INTEGER PRIMARY KEY,
  price_level_id INTEGER NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  applicable_from TEXT NOT NULL,
  qty_from       REAL NOT NULL DEFAULT 0,
  qty_to         REAL,
  rate           REAL NOT NULL,
  discount_pct   REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_price_list_item ON price_list(item_id, price_level_id, applicable_from);

-- ───────────────────────────── Vouchers ─────────────────────────────
CREATE TABLE vouchers (
  id                    INTEGER PRIMARY KEY,
  guid                  TEXT NOT NULL UNIQUE,
  voucher_type_id       INTEGER NOT NULL REFERENCES voucher_types(id),
  base_type             TEXT NOT NULL,           -- denormalised from voucher_types
  number                TEXT,                    -- display number incl. prefix/suffix
  number_seq            INTEGER,                 -- numeric part, for ordering
  date                  TEXT NOT NULL,
  effective_date        TEXT,
  reference_no          TEXT,                    -- supplier invoice no. for purchases
  reference_date        TEXT,
  party_ledger_id       INTEGER REFERENCES ledgers(id),
  -- Buyer/supplier snapshot at the time of the voucher
  party_name            TEXT,
  party_address         TEXT,
  party_state_code      TEXT,
  party_gstin           TEXT,
  party_registration_type TEXT,
  place_of_supply       TEXT,                    -- state code; '96' for exports
  invoice_mode          TEXT,                    -- item|accounting|NULL (non-invoice vouchers)
  price_level_id        INTEGER REFERENCES price_levels(id),
  is_optional           INTEGER NOT NULL DEFAULT 0,
  is_post_dated         INTEGER NOT NULL DEFAULT 0,
  is_cancelled          INTEGER NOT NULL DEFAULT 0,
  affects_books         INTEGER NOT NULL DEFAULT 1,   -- 0 for optional/cancelled/memorandum/orders
  affects_stock         INTEGER NOT NULL DEFAULT 0,
  is_reverse_charge     INTEGER NOT NULL DEFAULT 0,
  narration             TEXT,
  -- Totals (paise) cached for registers and listings
  total_amount          INTEGER NOT NULL DEFAULT 0,
  taxable_amount        INTEGER NOT NULL DEFAULT 0,
  tax_amount            INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0,
  -- GST classification and compliance
  gst_nature            TEXT,                    -- shared/gst GstNature
  original_invoice_no   TEXT,                    -- credit/debit notes
  original_invoice_date TEXT,
  note_reason           TEXT,
  irn                   TEXT,
  irn_ack_no            TEXT,
  irn_ack_date          TEXT,
  irn_signed_qr         TEXT,
  irn_status            TEXT,                    -- pending|generated|cancelled
  eway_bill_no          TEXT,
  eway_bill_date        TEXT,
  eway_valid_upto       TEXT,
  -- JSON blobs for print/compliance-only details
  consignee             TEXT,     -- {name,address,stateCode,gstin,pincode}
  dispatch              TEXT,     -- {docNo,through,destination,vehicleNo,transporterId,transporterName,mode,distanceKm,lrNo,lrDate}
  order_details         TEXT,     -- {orderNo,orderDate,terms,otherRefs,buyersOrderNo,deliveryNoteNo}
  export_details        TEXT,     -- {shippingBillNo,shippingBillDate,portCode,lut:boolean,currency,exchangeRate}
  meta                  TEXT,
  created_by            INTEGER,
  created_at            TEXT NOT NULL,
  updated_by            INTEGER,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_vouchers_date ON vouchers(date);
CREATE INDEX idx_vouchers_type_date ON vouchers(voucher_type_id, date);
CREATE INDEX idx_vouchers_base_date ON vouchers(base_type, date);
CREATE INDEX idx_vouchers_party ON vouchers(party_ledger_id, date);
CREATE INDEX idx_vouchers_number ON vouchers(voucher_type_id, number);

CREATE TABLE ledger_entries (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  ledger_id       INTEGER NOT NULL REFERENCES ledgers(id),
  amount          INTEGER NOT NULL,           -- paise, Dr +, Cr -
  role            TEXT NOT NULL DEFAULT 'other',  -- party|sales|purchase|tax|round_off|charge|cash_bank|other
  gst_duty_head   TEXT,                       -- IGST|CGST|SGST|CESS for tax lines
  narration       TEXT,
  -- Banking / instrument details (cash & bank ledgers)
  instrument_type TEXT,                       -- cheque|dd|neft|rtgs|imps|upi|card|cash|other
  instrument_no   TEXT,
  instrument_date TEXT,
  bank_name       TEXT,
  favouring       TEXT,
  bank_date       TEXT,                       -- bank reconciliation date (BRS)
  forex_amount    REAL,
  exchange_rate   REAL,
  -- Denormalised for reporting
  date            TEXT NOT NULL,
  affects_books   INTEGER NOT NULL DEFAULT 1,
  is_post_dated   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_le_ledger_date ON ledger_entries(ledger_id, date);
CREATE INDEX idx_le_voucher ON ledger_entries(voucher_id);

CREATE TABLE bill_allocations (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  ledger_id       INTEGER NOT NULL REFERENCES ledgers(id),
  ref_type        TEXT NOT NULL CHECK (ref_type IN ('new','against','advance','on_account')),
  bill_name       TEXT,
  amount          INTEGER NOT NULL,           -- paise, Dr +, Cr -
  credit_days     INTEGER,
  due_date        TEXT,
  date            TEXT NOT NULL,
  affects_books   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_bills_ledger ON bill_allocations(ledger_id, bill_name);
CREATE INDEX idx_bills_voucher ON bill_allocations(voucher_id);

CREATE TABLE cost_allocations (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  ledger_id       INTEGER NOT NULL REFERENCES ledgers(id),
  cost_centre_id  INTEGER NOT NULL REFERENCES cost_centres(id),
  amount          INTEGER NOT NULL,           -- paise, Dr +, Cr -
  date            TEXT NOT NULL,
  affects_books   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_cost_alloc_centre ON cost_allocations(cost_centre_id, date);

CREATE TABLE inventory_entries (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  item_id         INTEGER NOT NULL REFERENCES stock_items(id),
  godown_id       INTEGER REFERENCES godowns(id),
  batch_name      TEXT,
  mfg_date        TEXT,
  expiry_date     TEXT,
  qty             REAL NOT NULL,              -- signed in base unit: inward +, outward -
  billed_qty      REAL,                       -- unsigned, as billed (may differ from actual)
  alt_qty         REAL,
  rate            REAL NOT NULL DEFAULT 0,    -- rupees per base unit, exclusive of tax
  discount_pct    REAL NOT NULL DEFAULT 0,
  amount          INTEGER NOT NULL DEFAULT 0, -- paise, unsigned line value (taxable value for invoices)
  ledger_id       INTEGER REFERENCES ledgers(id),   -- sales/purchase ledger allocation
  description     TEXT,
  hsn_sac         TEXT,
  gst_rate        REAL,
  tracking_ref    TEXT,                       -- links invoice line to delivery/receipt note or order
  order_ref       TEXT,
  is_consumption  INTEGER NOT NULL DEFAULT 0, -- stock journal source side
  date            TEXT NOT NULL,
  affects_stock   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ie_item_date ON inventory_entries(item_id, date);
CREATE INDEX idx_ie_voucher ON inventory_entries(voucher_id);
CREATE INDEX idx_ie_godown ON inventory_entries(godown_id, item_id);

-- Normalised GST lines — the single source for every GST report/return.
CREATE TABLE gst_lines (
  id                INTEGER PRIMARY KEY,
  voucher_id        INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL,
  source            TEXT NOT NULL,            -- item|ledger
  item_id           INTEGER REFERENCES stock_items(id),
  ledger_id         INTEGER REFERENCES ledgers(id),
  description       TEXT,
  hsn_sac           TEXT,
  uqc               TEXT,
  qty               REAL,
  supply_type       TEXT NOT NULL DEFAULT 'goods',   -- goods|services
  taxability        TEXT NOT NULL,                   -- taxable|exempt|nil_rated|non_gst
  rate              REAL NOT NULL DEFAULT 0,
  cess_rate         REAL NOT NULL DEFAULT 0,
  taxable_value     INTEGER NOT NULL,                -- paise, unsigned
  igst              INTEGER NOT NULL DEFAULT 0,
  cgst              INTEGER NOT NULL DEFAULT 0,
  sgst              INTEGER NOT NULL DEFAULT 0,      -- SGST or UTGST
  cess              INTEGER NOT NULL DEFAULT 0,
  is_reverse_charge INTEGER NOT NULL DEFAULT 0,
  itc_eligibility   TEXT,
  date              TEXT NOT NULL,
  affects_books     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_gst_voucher ON gst_lines(voucher_id);
CREATE INDEX idx_gst_date ON gst_lines(date);

-- ───────────────────────────── Banking ─────────────────────────────
CREATE TABLE import_batches (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,      -- bank_statement|gstr2a|gstr2b|gstr1|masters|vouchers|tally_xml
  file_name   TEXT,
  imported_at TEXT NOT NULL,
  user_id     INTEGER,
  meta        TEXT
);

CREATE TABLE bank_statement_lines (
  id               INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  ledger_id        INTEGER NOT NULL REFERENCES ledgers(id),
  txn_date         TEXT NOT NULL,
  value_date       TEXT,
  description      TEXT,
  reference        TEXT,
  amount           INTEGER NOT NULL,   -- paise from the bank's view: deposit (+) / withdrawal (-)
  balance          INTEGER,
  status           TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched|matched|ignored|created
  matched_entry_id INTEGER REFERENCES ledger_entries(id) ON DELETE SET NULL,
  match_score      REAL
);
CREATE INDEX idx_bsl_ledger ON bank_statement_lines(ledger_id, txn_date);

-- ───────────────────────────── GST reconciliation ─────────────────────────────
CREATE TABLE gst_portal_docs (
  id                 INTEGER PRIMARY KEY,
  batch_id           INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,        -- gstr2a|gstr2b|gstr1
  return_period      TEXT NOT NULL,        -- MMYYYY
  counterparty_gstin TEXT NOT NULL,
  counterparty_name  TEXT,
  doc_type           TEXT NOT NULL,        -- invoice|credit_note|debit_note
  doc_no             TEXT NOT NULL,
  doc_date           TEXT NOT NULL,
  place_of_supply    TEXT,
  is_reverse_charge  INTEGER NOT NULL DEFAULT 0,
  taxable_value      INTEGER NOT NULL DEFAULT 0,
  igst               INTEGER NOT NULL DEFAULT 0,
  cgst               INTEGER NOT NULL DEFAULT 0,
  sgst               INTEGER NOT NULL DEFAULT 0,
  cess               INTEGER NOT NULL DEFAULT 0,
  invoice_value      INTEGER NOT NULL DEFAULT 0,
  itc_available      INTEGER,
  filing_status      TEXT,
  raw                TEXT,
  match_status       TEXT NOT NULL DEFAULT 'pending',  -- pending|matched|partial|mismatch|missing_in_books|accepted|ignored
  matched_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  match_details      TEXT,
  remarks            TEXT
);
CREATE INDEX idx_portal_docs ON gst_portal_docs(source, return_period);
CREATE INDEX idx_portal_gstin ON gst_portal_docs(counterparty_gstin, doc_no);
`,
} as const;
