/**
 * Migration 241 (final wave, perf): indexes so a voucher save / delete and the TDS reports touch only
 * the rows they need. A company already at 240 gets them on upgrade, and each answers its look-up.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Db } from './db.ts';
import { getSchemaVersion, migrate } from './migrate.ts';
import { migrations } from './migrations/index.ts';

const ADDED = ['idx_le_cheques', 'idx_gstrecon_decisions_voucher', 'idx_tds_lines_kind_date', 'idx_vouchers_eway'];
const indexes = (db: Db): Set<string> => new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name));
const plan = (db: Db, sql: string): string =>
  db
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .map((r) => r.detail)
    .join(' | ');

describe('migration 241: performance indexes', () => {
  it('a company at 240 gets them on upgrade', () => {
    const db = new Db(':memory:');
    try {
      migrate(db, migrations.filter((m) => m.version <= 240));
      assert.equal(getSchemaVersion(db), 240);
      for (const n of ADDED) assert.ok(!indexes(db).has(n), `${n} absent before`);
      const r = migrate(db);
      assert.ok(r.applied.includes(241));
      for (const n of ADDED) assert.ok(indexes(db).has(n), `${n} added`);
    } finally {
      db.close();
    }
  });

  it('each answers its look-up', () => {
    const db = new Db(':memory:');
    try {
      migrate(db);
      // A bank's cheque leaves (cheques hook): only cheque lines, covering.
      assert.match(
        plan(db, "SELECT voucher_id, instrument_no FROM ledger_entries WHERE ledger_id = 5 AND instrument_type = 'cheque' AND amount < 0"),
        /COVERING INDEX idx_le_cheques \(ledger_id=\?\)/,
      );
      // The ON DELETE CASCADE look-up of a deleted voucher's reconciliation decisions: no scan.
      assert.doesNotMatch(plan(db, 'DELETE FROM vouchers WHERE id = 1'), /SCAN/);
      // TDS / TCS reports: a period of one kind, or of both.
      assert.match(plan(db, "SELECT id FROM tds_lines tl WHERE tl.kind = 'tds' AND tl.date >= '2026-04-01' AND tl.date <= '2026-06-30'"), /idx_tds_lines_kind_date \(kind=\? AND date>\? AND date<\?\)/);
      assert.match(plan(db, "SELECT id FROM tds_lines tl WHERE tl.kind IN ('tds', 'tcs') AND tl.date >= '2026-04-01' AND tl.date <= '2026-06-30'"), /idx_tds_lines_kind_date/);
      // An e-way bill number already on another voucher.
      assert.match(plan(db, "SELECT id FROM vouchers WHERE eway_bill_no = '391000000001' AND id <> 5 LIMIT 1"), /idx_vouchers_eway \(eway_bill_no=\?\)/);
    } finally {
      db.close();
    }
  });
});
