/**
 * Migration 150 drops indexes that duplicate another one; the remaining index must still answer
 * every look-up the dropped one served (ledger balances, GST date ranges, the ON DELETE SET NULL
 * look-ups of bank statement lines / portal documents).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Db } from './db.ts';
import { getSchemaVersion, migrate } from './migrate.ts';
import { migrations } from './migrations/index.ts';

const DROPPED = ['idx_le_ledger_date', 'idx_gst_date', 'idx_bsl_matched_entry', 'idx_portal_matched_voucher'];
const KEPT = ['idx_le_books', 'idx_gst_lines_books', 'idx_bsl_entry', 'idx_portal_docs_voucher'];

const indexes = (db: Db): Set<string> => new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name));
const plan = (db: Db, sql: string): string =>
  db
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .map((r) => r.detail)
    .join(' | ');

describe('migration 150: duplicate indexes', () => {
  it('a company already at 140 (every existing company) loses the duplicates on upgrade', () => {
    const db = new Db(':memory:');
    try {
      migrate(db, migrations.filter((m) => m.version <= 140));
      assert.equal(getSchemaVersion(db), 140);
      for (const n of DROPPED) assert.ok(indexes(db).has(n), `${n} exists before`);
      const r = migrate(db);
      assert.deepEqual(r.applied, [150]);
      const after = indexes(db);
      for (const n of DROPPED) assert.ok(!after.has(n), `${n} dropped`);
      for (const n of KEPT) assert.ok(after.has(n), `${n} kept`);
    } finally {
      db.close();
    }
  });

  it('the kept indexes answer the look-ups (and the FK SET NULL look-ups) the dropped ones served', () => {
    const db = new Db(':memory:');
    try {
      migrate(db);
      for (const n of DROPPED) assert.ok(!indexes(db).has(n));
      assert.match(plan(db, "SELECT voucher_id, amount FROM ledger_entries WHERE ledger_id = 5 AND date <= '2026-03-31'"), /idx_le_books \(ledger_id=\? AND date<\?\)/);
      assert.match(plan(db, "SELECT voucher_id FROM gst_lines WHERE date >= '2026-04-01' AND date <= '2026-04-30'"), /idx_gst_lines_books \(date>\? AND date<\?\)/);
      assert.match(plan(db, 'SELECT id FROM bank_statement_lines WHERE matched_entry_id = 7'), /idx_bsl_entry \(matched_entry_id=\?\)/);
      assert.match(plan(db, 'SELECT id FROM gst_portal_docs WHERE matched_voucher_id = 7'), /idx_portal_docs_voucher \(matched_voucher_id=\?\)/);
    } finally {
      db.close();
    }
  });
});
