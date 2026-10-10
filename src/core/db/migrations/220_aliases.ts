/**
 * dataplus group (block 220–229), part 1: multiple aliases for ledgers and stock items (TallyPrime
 * allows any number of aliases per master — local-language names, supplier codes, old codes).
 *
 *  - The existing `ledgers.alias` / `stock_items.alias` column stays the FIRST alias (every report,
 *    print and picker already shows it); these tables hold the ADDITIONAL aliases, in order.
 *  - Uniqueness within the entity kind is enforced by the services across names, the first alias and
 *    these rows (case-insensitively); the UNIQUE index here is the last line of defence for the extra
 *    aliases themselves.
 *  - The rows go with their master (ON DELETE CASCADE on the child table, so a later rebuild of
 *    `ledgers` / `stock_items` cannot lose the clean-up the way a trigger on them could).
 *
 * Version 220 is the first of the dataplus block; it depends only on tables of 001_init.
 */
export const migration220 = {
  version: 220,
  name: 'aliases',
  sql: /* sql */ `
CREATE TABLE ledger_aliases (
  id        INTEGER PRIMARY KEY,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL COLLATE NOCASE,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_ledger_aliases_alias ON ledger_aliases(alias COLLATE NOCASE);
CREATE INDEX idx_ledger_aliases_ledger ON ledger_aliases(ledger_id, position);

CREATE TABLE stock_item_aliases (
  id       INTEGER PRIMARY KEY,
  item_id  INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  alias    TEXT NOT NULL COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_stock_item_aliases_alias ON stock_item_aliases(alias COLLATE NOCASE);
CREATE INDEX idx_stock_item_aliases_item ON stock_item_aliases(item_id, position);
`,
} as const;
