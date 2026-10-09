/**
 * Manufacturing & job work (group 'mfg', versions 210–219). Additive only.
 *
 *  - godowns.third_party_kind: whose stock a godown holds —
 *      'none'            our own premises;
 *      'ours_with_party' OUR stock lying with a job worker / agent (valued, in the Balance Sheet);
 *      'party_with_us'   a PRINCIPAL's stock lying with us for job work (never valued; stock reports
 *                        show the quantity only). Existing third-party godowns (is_third_party = 1)
 *                        were valued as own stock, so they become 'ours_with_party' (no change in value).
 *    godowns.party_ledger_id: the job worker / principal the godown belongs to (optional).
 *  - boms / bom_lines / bom_revisions: Bill of Materials per finished item (several named BOMs, one
 *    default), components / by-products / scrap per `output_qty` of the finished item, and a JSON
 *    snapshot of every saved revision (alteration history).
 *  - stock_journal_details / stock_journal_lines / stock_journal_costs: rebuilt with every save of a
 *    Manufacturing Journal, Material Out or Material In (stock journals with a class) in the same
 *    transaction (vouchers/extensions.ts). They carry the BOM used, the job work party / order, each
 *    line's role and costing basis, and the additional costs; the stock valuation engine reads the
 *    costing basis so every report values the finished goods the same way.
 *    stock_journal_details denormalises date / affects_stock / is_post_dated like gst_lines does.
 *  - job_work_orders / job_work_order_lines: Job Work Out / In Orders (planning documents, no stock).
 */
export const migration210 = {
  version: 210,
  name: 'mfg',
  sql: /* sql */ `
ALTER TABLE godowns ADD COLUMN third_party_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (third_party_kind IN ('none', 'ours_with_party', 'party_with_us'));
ALTER TABLE godowns ADD COLUMN party_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL;
UPDATE godowns SET third_party_kind = 'ours_with_party' WHERE is_third_party = 1;
CREATE INDEX idx_godowns_party ON godowns(party_ledger_id) WHERE party_ledger_id IS NOT NULL;

CREATE TABLE boms (
  id          INTEGER PRIMARY KEY,
  guid        TEXT NOT NULL UNIQUE,
  item_id     INTEGER NOT NULL REFERENCES stock_items(id),
  name        TEXT NOT NULL,
  output_qty  REAL NOT NULL CHECK (output_qty > 0),   -- components are per this quantity of the item
  is_default  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_boms_item_name ON boms(item_id, name COLLATE NOCASE);

CREATE TABLE bom_lines (
  id          INTEGER PRIMARY KEY,
  bom_id      INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('component', 'by_product', 'scrap')),
  item_id     INTEGER NOT NULL REFERENCES stock_items(id),
  qty         REAL NOT NULL CHECK (qty > 0),
  godown_id   INTEGER REFERENCES godowns(id) ON DELETE SET NULL,
  value_basis TEXT CHECK (value_basis IN ('nil', 'rate', 'percent')),   -- by-products / scrap only
  value_rate  REAL,                                                   -- rupees per base unit
  value_pct   REAL,                                                   -- % of the production cost
  notes       TEXT
);
CREATE INDEX idx_bom_lines_bom ON bom_lines(bom_id, line_no);
CREATE INDEX idx_bom_lines_item ON bom_lines(item_id);

CREATE TABLE bom_revisions (
  id              INTEGER PRIMARY KEY,
  bom_id          INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  snapshot        TEXT NOT NULL,
  changed_at      TEXT NOT NULL,
  changed_by      INTEGER,
  changed_by_name TEXT,
  UNIQUE (bom_id, revision)
);

CREATE TABLE job_work_orders (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  direction       TEXT NOT NULL CHECK (direction IN ('out', 'in')),   -- out: we send to a job worker; in: a principal sends to us
  number          TEXT NOT NULL,
  number_seq      INTEGER,
  date            TEXT NOT NULL,
  party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
  godown_id       INTEGER REFERENCES godowns(id) ON DELETE SET NULL,
  item_id         INTEGER REFERENCES stock_items(id),
  qty             REAL,
  bom_id          INTEGER REFERENCES boms(id) ON DELETE SET NULL,
  due_date        TEXT,
  process         TEXT,
  rate            REAL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  narration       TEXT,
  created_by      INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_jwo_number ON job_work_orders(direction, number COLLATE NOCASE);
CREATE INDEX idx_jwo_party ON job_work_orders(party_ledger_id, date);
CREATE INDEX idx_jwo_item ON job_work_orders(item_id);
CREATE INDEX idx_jwo_bom ON job_work_orders(bom_id);

CREATE TABLE job_work_order_lines (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES job_work_orders(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES stock_items(id),
  qty         REAL NOT NULL CHECK (qty > 0),
  goods_type  TEXT NOT NULL DEFAULT 'inputs' CHECK (goods_type IN ('inputs', 'capital_goods', 'tools'))
);
CREATE INDEX idx_jwo_lines_order ON job_work_order_lines(order_id, line_no);
CREATE INDEX idx_jwo_lines_item ON job_work_order_lines(item_id);

CREATE TABLE stock_journal_details (
  voucher_id            INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  class                 TEXT NOT NULL CHECK (class IN ('manufacturing', 'material_out', 'material_in')),
  item_id               INTEGER REFERENCES stock_items(id),          -- finished goods
  qty                   REAL,
  bom_id                INTEGER REFERENCES boms(id) ON DELETE SET NULL,
  bom_revision          INTEGER,
  party_ledger_id       INTEGER REFERENCES ledgers(id),
  job_work_order_id     INTEGER REFERENCES job_work_orders(id) ON DELETE SET NULL,
  third_party_godown_id INTEGER REFERENCES godowns(id),
  job_work_direction    TEXT CHECK (job_work_direction IN ('out', 'in')),
  process               TEXT,
  date                  TEXT NOT NULL,
  affects_stock         INTEGER NOT NULL DEFAULT 1,
  is_post_dated         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sjd_item_date ON stock_journal_details(item_id, date);
CREATE INDEX idx_sjd_bom ON stock_journal_details(bom_id);
CREATE INDEX idx_sjd_order ON stock_journal_details(job_work_order_id);
CREATE INDEX idx_sjd_party_date ON stock_journal_details(party_ledger_id, date);
CREATE INDEX idx_sjd_class_date ON stock_journal_details(class, date);

CREATE TABLE stock_journal_lines (
  voucher_id     INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,          -- inventory_entries.line_no
  role           TEXT NOT NULL CHECK (role IN ('component', 'product', 'by_product', 'scrap', 'transfer_out', 'transfer_in', 'receipt', 'issue')),
  basis          TEXT CHECK (basis IN ('residual', 'fixed', 'percent', 'source')),   -- production side only
  pct            REAL,
  source_line_no INTEGER,
  goods_type     TEXT CHECK (goods_type IN ('inputs', 'capital_goods', 'tools')),
  challan_value  INTEGER,                    -- paise: value declared on the job work challan (ITC-04)
  extended_to    TEXT,                       -- s.143 time limit extended by the Commissioner up to this date
  PRIMARY KEY (voucher_id, line_no)
);

CREATE TABLE stock_journal_costs (
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no    INTEGER NOT NULL,
  ledger_id  INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
  label      TEXT,
  basis      TEXT NOT NULL CHECK (basis IN ('amount', 'percent')),
  value      REAL NOT NULL,                 -- paise ('amount') or percent of the consumed cost
  PRIMARY KEY (voucher_id, line_no)
);
CREATE INDEX idx_sjc_ledger ON stock_journal_costs(ledger_id) WHERE ledger_id IS NOT NULL;
`,
} as const;
