/**
 * Module-owned migration for 'accounts' (additive indexes only).
 *
 *  - idx_le_books: covering index for balance queries (ledger balances, trial balance, pickers):
 *    the aggregate over ledger_entries grouped by ledger_id with the books filter is answered from
 *    the index alone, without touching the table.
 *  - idx_ledgers_alias: alias look-ups (uniqueness checks, type-ahead by alias).
 *  - idx_cost_centres_tree / idx_voucher_types_parent: tree navigation and "has children" checks.
 */
export const migration030 = {
  version: 30,
  name: 'accounts',
  sql: /* sql */ `
CREATE INDEX IF NOT EXISTS idx_le_books ON ledger_entries(ledger_id, date, affects_books, is_post_dated, amount);
CREATE INDEX IF NOT EXISTS idx_ledgers_alias ON ledgers(alias COLLATE NOCASE) WHERE alias IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_centres_tree ON cost_centres(category_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_cost_centres_parent ON cost_centres(parent_id);
CREATE INDEX IF NOT EXISTS idx_voucher_types_parent ON voucher_types(parent_id);
`,
} as const;
