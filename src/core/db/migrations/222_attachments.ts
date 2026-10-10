/**
 * dataplus group (block 220–229), part 3: file attachments of vouchers, ledgers and stock items
 * (src/core/modules/attachments).
 *
 *  - attachments: one row per attached file. Exactly one owner column is set; the row goes with its
 *    voucher (CASCADE). A ledger / stock item that still has attachments cannot be deleted (the
 *    services refuse; the FK would too). The file itself lives in <company folder>/attachments/
 *    named `<sha256>.<ext>` (content-addressed: the same scan attached twice is stored once);
 *    `sha256` / `size_bytes` let the data check prove the file is unchanged.
 *  - attachment_blobs: TRANSPORT ONLY — always empty in a live company. A backup copies each
 *    attached file into this table of the database snapshot (so the .pvqbak container format, its
 *    checksums and its AES-GCM encryption cover the files with no format change); a restore writes
 *    them back into the restored company's attachments folder and empties the table.
 *  - permissions attachments.add / attachments.remove for the system roles of existing companies
 *    (new companies get them from SYSTEM_ROLES): Accountant both, Data Entry add.
 *
 * Depends only on tables of 001_init and the roles table (020).
 */
export const migration222 = {
  version: 222,
  name: 'attachments',
  sql: /* sql */ `
CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  voucher_id      INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_id       INTEGER REFERENCES ledgers(id),
  stock_item_id   INTEGER REFERENCES stock_items(id),
  file_name       TEXT NOT NULL,
  ext             TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
  note            TEXT,
  created_at      TEXT NOT NULL,
  created_by      INTEGER,
  created_by_name TEXT,
  CHECK ((voucher_id IS NOT NULL) + (ledger_id IS NOT NULL) + (stock_item_id IS NOT NULL) = 1)
);
CREATE INDEX idx_attachments_voucher ON attachments(voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX idx_attachments_ledger ON attachments(ledger_id) WHERE ledger_id IS NOT NULL;
CREATE INDEX idx_attachments_item ON attachments(stock_item_id) WHERE stock_item_id IS NOT NULL;
CREATE INDEX idx_attachments_sha ON attachments(sha256);

CREATE TABLE attachment_blobs (
  sha256 TEXT NOT NULL,
  ext    TEXT NOT NULL,
  bytes  BLOB NOT NULL,
  PRIMARY KEY (sha256, ext)
);

UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'attachments.add')
 WHERE is_system = 1 AND name IN ('Accountant', 'Data Entry')
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'attachments.add');
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'attachments.remove')
 WHERE is_system = 1 AND name = 'Accountant'
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'attachments.remove');
`,
} as const;
