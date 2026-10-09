import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Db } from './db.ts';
import { migrate } from './migrate.ts';
import { ensureAuditTriggers, schemaProblems, readSchema, triggerAllowlist, validateCompanySchema } from './schemaCheck.ts';

const fresh = (): Db => {
  const db = new Db(':memory:');
  migrate(db);
  return db;
};

describe('untrusted company schema validation', () => {
  it('a database made by our migrations is accepted; the allowlist holds our triggers', () => {
    const db = fresh();
    try {
      assert.deepEqual(validateCompanySchema(db), []);
      const allow = triggerAllowlist();
      for (const name of ['audit_log_no_update', 'audit_log_no_delete', 'users_password_history']) assert.ok(allow.has(name), name);
      assert.equal(db.value('PRAGMA trusted_schema'), 0);
    } finally {
      db.close();
    }
  });

  it('refuses a view shadowing a core table (the endless recursive-CTE probe) without querying it', () => {
    const db = fresh();
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('DROP TABLE ledgers');
      db.exec('CREATE VIEW ledgers AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS id FROM c');
      const started = Date.now();
      const problems = validateCompanySchema(db);
      assert.ok(Date.now() - started < 2000, 'validation never touches the view');
      assert.ok(problems.includes('view "ledgers"'));
      assert.ok(problems.includes('missing table "ledgers"'));
    } finally {
      db.close();
    }
  });

  it('refuses foreign triggers and modified copies of ours; accepts nothing it does not know', () => {
    const db = fresh();
    try {
      db.exec(`CREATE TRIGGER skim AFTER INSERT ON ledger_entries BEGIN UPDATE ledger_entries SET amount = amount - 1 WHERE id = NEW.id; END`);
      db.exec('DROP TRIGGER audit_log_no_delete');
      db.exec(`CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT 1; END`);
      const problems = validateCompanySchema(db);
      assert.ok(problems.includes('trigger "skim"'));
      assert.ok(problems.includes('trigger "audit_log_no_delete"'));
    } finally {
      db.close();
    }
    // Whitespace differences in our own triggers do not matter; virtual tables are refused.
    const listing = readSchema(fresh()).map((o) => (o.type === 'trigger' ? { ...o, sql: (o.sql ?? '').replace(/\s+/g, '  ') } : o));
    assert.deepEqual(schemaProblems(listing), []);
    assert.deepEqual(schemaProblems([...listing, { type: 'table', name: 'x', tbl_name: 'x', sql: 'CREATE VIRTUAL TABLE x USING fts5(a)' }]), ['virtual table "x"']);
  });

  it('missing audit_log triggers are re-created (never silently accepted as append-only)', () => {
    const db = fresh();
    try {
      db.exec('DROP TRIGGER audit_log_no_update');
      db.exec('DROP TRIGGER audit_log_no_delete');
      assert.deepEqual(ensureAuditTriggers(db).sort(), ['audit_log_no_delete', 'audit_log_no_update']);
      assert.deepEqual(validateCompanySchema(db), [], 'the re-created SQL matches the migration exactly');
      db.run(`INSERT INTO audit_log (ts, action, prev_hash, hash) VALUES ('t', 'x', 'p', 'h')`);
      assert.throws(() => db.run('DELETE FROM audit_log'), /append-only/);
      assert.deepEqual(ensureAuditTriggers(db), []);
    } finally {
      db.close();
    }
  });
});
