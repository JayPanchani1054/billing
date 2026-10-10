/**
 * pos group (block 180–189), part 1: POS / counter billing (src/core/modules/pos).
 *
 *  - pos_tender_modes: how customers pay at the counter (Cash, Card, UPI, wallet …), each posting to a
 *    ledger the user chooses; `exchange` is the single system mode for exchange credit (goods returned
 *    and taken in goods later), whose ledger the pos module creates on demand. A mode that was used is
 *    kept (RESTRICT): deactivate it instead.
 *  - pos_bills / pos_payments: DERIVED per-voucher rows of a POS bill (Sales voucher of a POS type)
 *    or POS return (Credit Note), rebuilt by the pos voucher hook inside the voucher's own save
 *    transaction (like gst_lines). They carry `date`, `affects_books`, `is_post_dated` so the summary
 *    applies the books filter without joining back; `amount` on pos_payments is signed like the ledger
 *    entry it explains (Dr + received on a bill, Cr − refunded on a return). `exchange_voucher_id` links
 *    exchange credit used on a bill to the return that issued it.
 *  - pos_held_bills: bills parked at the counter (no voucher yet), recalled later; `draft` is the
 *    validated counter draft (JSON).
 *  - Lookup indexes for scan-to-add: stock_items.barcode (exact) and part_no (case-insensitive).
 *
 * Depends only on tables of 001_init.
 */
export const migration180 = {
  version: 180,
  name: 'pos',
  sql: /* sql */ `
CREATE TABLE pos_tender_modes (
  id         INTEGER PRIMARY KEY,
  guid       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT NOT NULL CHECK (kind IN ('cash', 'card', 'upi', 'wallet', 'other', 'exchange')),
  ledger_id  INTEGER NOT NULL REFERENCES ledgers(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pos_tender_modes_exchange ON pos_tender_modes(kind) WHERE kind = 'exchange';
CREATE INDEX idx_pos_tender_modes_ledger ON pos_tender_modes(ledger_id);

CREATE TABLE pos_bills (
  voucher_id    INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('sale', 'return')),
  return_of_id  INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  bill_value    INTEGER NOT NULL,
  paid          INTEGER NOT NULL,
  credit        INTEGER NOT NULL,
  cash_tendered INTEGER,
  change_due    INTEGER NOT NULL DEFAULT 0,
  counter       TEXT,
  date          TEXT NOT NULL,
  affects_books INTEGER NOT NULL DEFAULT 1,
  is_post_dated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_bills_date ON pos_bills(date);
CREATE INDEX idx_pos_bills_return_of ON pos_bills(return_of_id) WHERE return_of_id IS NOT NULL;

CREATE TABLE pos_payments (
  id                  INTEGER PRIMARY KEY,
  voucher_id          INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no             INTEGER NOT NULL,
  mode_id             INTEGER NOT NULL REFERENCES pos_tender_modes(id),
  mode_name           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  ledger_id           INTEGER NOT NULL REFERENCES ledgers(id),
  amount              INTEGER NOT NULL,
  reference           TEXT,
  exchange_voucher_id INTEGER REFERENCES vouchers(id),
  date                TEXT NOT NULL,
  affects_books       INTEGER NOT NULL DEFAULT 1,
  is_post_dated       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_payments_voucher ON pos_payments(voucher_id);
CREATE INDEX idx_pos_payments_date ON pos_payments(date);
CREATE INDEX idx_pos_payments_mode ON pos_payments(mode_id);
CREATE INDEX idx_pos_payments_exchange ON pos_payments(exchange_voucher_id) WHERE exchange_voucher_id IS NOT NULL;

CREATE TABLE pos_held_bills (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  voucher_type_id INTEGER REFERENCES voucher_types(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  customer_name   TEXT,
  line_count      INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  draft           TEXT NOT NULL CHECK (json_valid(draft)),
  created_by      INTEGER,
  created_by_name TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_pos_held_bills_created ON pos_held_bills(created_at);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON stock_items(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_part_no ON stock_items(part_no COLLATE NOCASE) WHERE part_no IS NOT NULL;
`,
} as const;
