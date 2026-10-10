/**
 * Cheques & e-payments (print group, block 170–179; module src/core/modules/cheques). Additive only.
 *
 *  - payee_bank_details: the beneficiary's bank account on a party / expense ledger (e-payment files)
 *    and the name to write on cheques. One row per ledger. No foreign key on purpose: these are the
 *    ledger's own particulars and go with it when the ledger is deleted (trigger below) instead of
 *    blocking the delete (accounts › otherLedgerReferences refuses deletes for FK references).
 *  - cheque_books: leaf ranges per bank ledger (numbers allocated to Payment / Contra cheques by the
 *    cheques voucher hook). Issued leaves are not stored: they are the bank ledger's entries with
 *    instrument type 'cheque' (the books are the single source).
 *  - cheque_leaf_marks: leaves cancelled / spoilt by the user, or cancelled with their voucher.
 *  - cheque_prints: every cheque printed (voucher, leaf, payee, amount) — reprint warning, and a leaf
 *    printed for a voucher it is no longer on counts as spoilt in the register.
 *  - cheque_layouts / cheque_bank_settings: print positions in millimetres (JSON) and the layout,
 *    'A/c Payee' default and signatory text per bank ledger (removed with the ledger, like payee details).
 *  - epayment_batches / epayment_batch_items: bulk payment files generated (re-export warning).
 */
export const migration170 = {
  version: 170,
  name: 'cheques',
  sql: /* sql */ `
CREATE TABLE payee_bank_details (
  ledger_id         INTEGER PRIMARY KEY,
  beneficiary_name  TEXT,
  account_no        TEXT,
  ifsc              TEXT,
  bank_name         TEXT,
  branch            TEXT,
  account_type      TEXT CHECK (account_type IS NULL OR account_type IN ('savings','current','cash_credit','overdraft','nre','nro','other')),
  cheque_name       TEXT,
  payment_mode      TEXT CHECK (payment_mode IS NULL OR payment_mode IN ('neft','rtgs','imps','cheque')),
  updated_at        TEXT NOT NULL
);

CREATE TABLE cheque_books (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  bank_ledger_id  INTEGER NOT NULL REFERENCES ledgers(id),
  name            TEXT NOT NULL,
  from_no         INTEGER NOT NULL CHECK (from_no >= 0),
  to_no           INTEGER NOT NULL CHECK (to_no >= from_no AND to_no - from_no < 10000),
  digits          INTEGER NOT NULL DEFAULT 6 CHECK (digits BETWEEN 1 AND 12),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_cheque_books_bank ON cheque_books(bank_ledger_id, from_no);

CREATE TABLE cheque_leaf_marks (
  id              INTEGER PRIMARY KEY,
  bank_ledger_id  INTEGER NOT NULL REFERENCES ledgers(id),
  cheque_no       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'cancelled' CHECK (status IN ('cancelled')),
  reason          TEXT,
  date            TEXT NOT NULL,
  voucher_id      INTEGER,
  created_by      INTEGER,
  created_at      TEXT NOT NULL,
  UNIQUE (bank_ledger_id, cheque_no)
);

CREATE TABLE cheque_prints (
  id              INTEGER PRIMARY KEY,
  voucher_id      INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  voucher_label   TEXT,
  bank_ledger_id  INTEGER NOT NULL,
  cheque_no       TEXT,
  cheque_date     TEXT NOT NULL,
  payee           TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  layout_id       INTEGER,
  printed_by      INTEGER,
  printed_at      TEXT NOT NULL
);
CREATE INDEX idx_cheque_prints_voucher ON cheque_prints(voucher_id);
CREATE INDEX idx_cheque_prints_bank ON cheque_prints(bank_ledger_id, cheque_no);

CREATE TABLE cheque_layouts (
  id          INTEGER PRIMARY KEY,
  guid        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  preset      TEXT,
  layout      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE cheque_bank_settings (
  bank_ledger_id  INTEGER PRIMARY KEY,
  layout_id       INTEGER REFERENCES cheque_layouts(id) ON DELETE SET NULL,
  ac_payee        INTEGER NOT NULL DEFAULT 1,
  signatory       TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE epayment_batches (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  bank_ledger_id  INTEGER,
  file_name       TEXT NOT NULL,
  rows            INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  created_by      INTEGER,
  created_at      TEXT NOT NULL
);
CREATE TABLE epayment_batch_items (
  batch_id    INTEGER NOT NULL REFERENCES epayment_batches(id) ON DELETE CASCADE,
  voucher_id  INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  PRIMARY KEY (batch_id, voucher_id)
);
CREATE INDEX idx_epayment_items_voucher ON epayment_batch_items(voucher_id);

CREATE TRIGGER payee_bank_details_ledger_deleted AFTER DELETE ON ledgers
BEGIN
  DELETE FROM payee_bank_details WHERE ledger_id = OLD.id;
  DELETE FROM cheque_bank_settings WHERE bank_ledger_id = OLD.id;
END;
`,
} as const;
