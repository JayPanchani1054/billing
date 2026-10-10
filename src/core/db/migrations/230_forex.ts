/**
 * forex group (block 230–239): multi-currency vouchers, bills and revaluation
 * (src/core/modules/forex, README there).
 *
 * Books stay in the base currency (INR paise; Σ ledger_entries.amount = 0 per voucher). A ledger whose
 * `currency_id` is a foreign currency is ALSO tracked in that currency:
 *
 *  - ledger_entries: `forex_amount` / `exchange_rate` (both already in 001_init, never written before)
 *    plus `currency_id` here. forex_amount is SIGNED like `amount` (Dr +, Cr −) in the currency's
 *    major unit (e.g. 1250.5 = $1,250.50), rounded to the currency's decimal places; `amount` is the
 *    INR posted (= forex × rate, rounded to the paisa — or the INR value of the bills it settles when
 *    it settles bills booked at another rate). A forex-ledger entry with forex_amount = 0 is an
 *    INR-only exchange adjustment (revaluation / gain-loss correction).
 *  - bill_allocations.forex_amount / currency_id: the bill in both currencies (signed like `amount`).
 *  - opening_bills.forex_amount and ledgers.opening_forex_amount: opening balances in the currency.
 *  - vouchers.currency_id / exchange_rate / forex_amount: the document currency of a foreign-currency
 *    invoice (export / import) and its value in that currency (unsigned, like total_amount).
 *  - forex_revaluations: one row per "Forex adjustment" journal posted by the revaluation helper
 *    (as-of date, rate basis) so a period is not revalued twice by accident; the row goes with the
 *    voucher (CASCADE).
 *
 * All rows are written by the forex voucher hook (vouchers/hooks.ts) inside the voucher's own save
 * transaction, from the same plan as ledger_entries / bill_allocations, so they share their books
 * filter (affects_books, is_post_dated) automatically.
 *
 * Additive only (ADD COLUMN / new table / indexes). Depends only on tables of 001_init.
 */
export const migration230 = {
  version: 230,
  name: 'forex',
  sql: /* sql */ `
ALTER TABLE ledger_entries ADD COLUMN currency_id INTEGER REFERENCES currencies(id);
ALTER TABLE bill_allocations ADD COLUMN forex_amount REAL;
ALTER TABLE bill_allocations ADD COLUMN currency_id INTEGER REFERENCES currencies(id);
ALTER TABLE opening_bills ADD COLUMN forex_amount REAL;
ALTER TABLE ledgers ADD COLUMN opening_forex_amount REAL;
ALTER TABLE vouchers ADD COLUMN currency_id INTEGER REFERENCES currencies(id);
ALTER TABLE vouchers ADD COLUMN exchange_rate REAL;
ALTER TABLE vouchers ADD COLUMN forex_amount REAL;

CREATE INDEX idx_le_currency ON ledger_entries(currency_id, ledger_id, date) WHERE currency_id IS NOT NULL;

CREATE TABLE forex_revaluations (
  id          INTEGER PRIMARY KEY,
  voucher_id  INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
  as_of       TEXT NOT NULL,
  rate_type   TEXT NOT NULL CHECK (rate_type IN ('standard','selling','buying')),
  rates       TEXT NOT NULL,             -- JSON [{currencyId, rate}] used
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_forex_reval_asof ON forex_revaluations(as_of);
`,
} as const;
