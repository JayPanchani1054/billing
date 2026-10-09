/**
 * Documents group, part 4: Scenarios and Budgets (src/core/modules/documents/{scenarios,budgets}.ts).
 *
 *  - scenarios / scenario_voucher_types  Tally Scenario: include actuals (yes/no), voucher types whose
 *    provisional vouchers (memorandum, reversing journal within its "applicable up to", optional) are
 *    INCLUDED, and voucher types whose actual vouchers are EXCLUDED. Read by the reports engine
 *    (reports/scenario.ts) when a Balance Sheet / P&L / Trial Balance / Group Summary is run with a
 *    scenarioId.
 *  - budgets / budget_lines  a budget for a period; each line targets exactly one group, ledger or cost
 *    centre, on net transactions of the period or on the closing balance, amount in paise Dr + / Cr −.
 *    Masters referenced by a line delete the line with them (CASCADE).
 */
export const migration193 = {
  version: 193,
  name: 'budgets',
  sql: /* sql */ `
CREATE TABLE scenarios (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  include_actuals INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE scenario_voucher_types (
  scenario_id     INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('include', 'exclude')),
  PRIMARY KEY (scenario_id, voucher_type_id)
);
CREATE INDEX idx_scenario_types_type ON scenario_voucher_types(voucher_type_id);

CREATE TABLE budgets (
  id         INTEGER PRIMARY KEY,
  guid       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_date <= to_date)
);

CREATE TABLE budget_lines (
  id             INTEGER PRIMARY KEY,
  budget_id      INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  group_id       INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  ledger_id      INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,
  cost_centre_id INTEGER REFERENCES cost_centres(id) ON DELETE CASCADE,
  basis          TEXT NOT NULL CHECK (basis IN ('net_transactions', 'closing_balance')),
  amount         INTEGER NOT NULL,
  CHECK ((group_id IS NOT NULL) + (ledger_id IS NOT NULL) + (cost_centre_id IS NOT NULL) = 1)
);
CREATE INDEX idx_budget_lines_budget ON budget_lines(budget_id);
CREATE UNIQUE INDEX idx_budget_lines_group ON budget_lines(group_id, budget_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX idx_budget_lines_ledger ON budget_lines(ledger_id, budget_id) WHERE ledger_id IS NOT NULL;
CREATE UNIQUE INDEX idx_budget_lines_centre ON budget_lines(cost_centre_id, budget_id) WHERE cost_centre_id IS NOT NULL;
`,
} as const;
