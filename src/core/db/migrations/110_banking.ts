/**
 * Module-owned migration for 'banking' (additive only).
 *
 *  - bank_statement_lines gains:
 *      line_hash    SHA-256 of date|amount|reference|normalised description|running balance|occurrence, used to skip
 *                   lines already imported for the same bank ledger (unique per ledger);
 *      seq          chronological position inside its import batch (statements that list newest first are reversed);
 *      source_row   1-based row of the line in the imported file (shown when a line needs checking);
 *      match_method auto | manual | created (voucher created from the line), with matched_at / matched_by.
 *  - bank_statement_presets: the column mapping last used to import a statement for each bank ledger, so next
 *    month's file from the same bank is read without asking again.
 *  - Import batches use the generic import_batches table (kind 'bank_statement', ledger id in meta JSON).
 */
export const migration110 = {
  version: 110,
  name: 'banking',
  sql: /* sql */ `
ALTER TABLE bank_statement_lines ADD COLUMN line_hash TEXT;
ALTER TABLE bank_statement_lines ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_statement_lines ADD COLUMN source_row INTEGER;
ALTER TABLE bank_statement_lines ADD COLUMN match_method TEXT;
ALTER TABLE bank_statement_lines ADD COLUMN matched_at TEXT;
ALTER TABLE bank_statement_lines ADD COLUMN matched_by INTEGER;

CREATE UNIQUE INDEX idx_bsl_hash ON bank_statement_lines(ledger_id, line_hash) WHERE line_hash IS NOT NULL;
CREATE INDEX idx_bsl_batch ON bank_statement_lines(batch_id, seq);
CREATE INDEX idx_bsl_entry ON bank_statement_lines(matched_entry_id) WHERE matched_entry_id IS NOT NULL;

CREATE TABLE bank_statement_presets (
  ledger_id  INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
  mapping    TEXT NOT NULL,      -- JSON SavedStatementMapping (column roles by header name)
  updated_at TEXT NOT NULL
);
`,
} as const;
