/**
 * Documents group, part 2: recurring vouchers (src/core/modules/documents/recurring.ts).
 *
 *  - recurring_templates  a VoucherInput without id / number / date (JSON) + its schedule:
 *      frequency     monthly | quarterly | half_yearly | yearly | every_n_days
 *      interval_days every_n_days only (1–366)
 *      day_of_month  month-based frequencies: 1–31, or 0 = last day of the month; a day past the end
 *                    of a short month falls on its last day (31 → 30-Apr, 28/29-Feb)
 *      start_date / end_date (inclusive; end NULL = no end), is_active 0 = paused.
 *    Deleting the voucher type deletes its templates (CASCADE); the source voucher is informational.
 *  - recurring_runs       one row per occurrence that was dealt with: status posted (voucher_id) or
 *    skipped. UNIQUE (template_id, period_key) is what makes posting idempotent — an occurrence can
 *    never be posted twice. period_key = 'YYYY-MM' of the occurrence for month-based frequencies (so
 *    changing the day of the month never re-opens a month), 'YYYY-MM-DD' for every-N-days. Deleting the
 *    posted voucher deletes its run row (CASCADE): the occurrence is due again.
 */
export const migration191 = {
  version: 191,
  name: 'recurring',
  sql: /* sql */ `
CREATE TABLE recurring_templates (
  id                INTEGER PRIMARY KEY,
  guid              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  voucher_type_id   INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
  input             TEXT NOT NULL,
  frequency         TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'half_yearly', 'yearly', 'every_n_days')),
  interval_days     INTEGER CHECK (interval_days IS NULL OR (interval_days BETWEEN 1 AND 366)),
  day_of_month      INTEGER CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 0 AND 31)),
  start_date        TEXT NOT NULL,
  end_date          TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  source_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_recurring_templates_type ON recurring_templates(voucher_type_id);
CREATE INDEX idx_recurring_templates_source ON recurring_templates(source_voucher_id) WHERE source_voucher_id IS NOT NULL;

CREATE TABLE recurring_runs (
  id             INTEGER PRIMARY KEY,
  template_id    INTEGER NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE,
  period_key     TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('posted', 'skipped')),
  voucher_id     INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  created_by     INTEGER,
  UNIQUE (template_id, period_key),
  CHECK ((status = 'posted') = (voucher_id IS NOT NULL))
);
CREATE INDEX idx_recurring_runs_voucher ON recurring_runs(voucher_id) WHERE voucher_id IS NOT NULL;
`,
} as const;
