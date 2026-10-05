import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../lib/errors.ts';
import { Db } from './db.ts';
import { getSchemaVersion, migrate, SCHEMA_VERSION } from './migrate.ts';
import { migrations, type Migration } from './migrations/index.ts';

const tables = (db: Db): string[] =>
  db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);

describe('migrate', () => {
  it('applies every registered migration to a fresh database', () => {
    const db = new Db(':memory:');
    const r = migrate(db);
    assert.equal(r.from, 0);
    assert.equal(r.to, SCHEMA_VERSION);
    assert.deepEqual(r.applied, [...migrations].map((m) => m.version).sort((a, b) => a - b));
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    assert.ok(tables(db).includes('company'));
    assert.ok(tables(db).includes('audit_log'));
    db.close();
  });

  it('is idempotent', () => {
    const db = new Db(':memory:');
    migrate(db);
    const again = migrate(db);
    assert.deepEqual(again.applied, []);
    assert.equal(again.from, SCHEMA_VERSION);
    assert.equal(again.to, SCHEMA_VERSION);
    db.close();
  });

  it('SCHEMA_VERSION is the highest registered version', () => {
    assert.equal(SCHEMA_VERSION, Math.max(...migrations.map((m) => m.version)));
  });

  it('advances the version for empty-SQL migrations and sorts the list', () => {
    const db = new Db(':memory:');
    const list: Migration[] = [
      { version: 3, name: 'three', sql: '' },
      { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' },
      { version: 2, name: 'two', sql: '   ' },
    ];
    const r = migrate(db, list);
    assert.deepEqual(r.applied, [1, 2, 3]);
    assert.equal(getSchemaVersion(db), 3);
    db.close();
  });

  it('only applies migrations newer than the stored version (upgrade path)', () => {
    const db = new Db(':memory:');
    migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' }]);
    const r = migrate(db, [
      { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' },
      { version: 5, name: 'five', sql: 'CREATE TABLE b (y INTEGER)' },
    ]);
    assert.deepEqual(r.applied, [5]);
    assert.deepEqual(tables(db), ['a', 'b']);
    db.close();
  });

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = new Db(':memory:');
    const list: Migration[] = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (x INTEGER)' },
      { version: 2, name: 'bad', sql: 'CREATE TABLE b (y INTEGER); CREATE TABLE a (dup INTEGER);' },
    ];
    assert.throws(() => migrate(db, list));
    assert.equal(getSchemaVersion(db), 1);
    assert.deepEqual(tables(db), ['a'], 'table b from the failed migration must be rolled back');
    db.close();
  });

  it('refuses a database created by a newer version', () => {
    const db = new Db(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(
      () => migrate(db),
      (err: unknown) => err instanceof AppError && err.code === 'CONFLICT' && /newer version/.test(err.message),
    );
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION + 1, 'version untouched');
    db.close();
  });

  it('supports table rebuilds of referenced tables and restores FK enforcement (regression)', () => {
    const db = new Db(':memory:');
    migrate(db, [
      {
        version: 1,
        name: 'base',
        sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
              CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
              INSERT INTO parent VALUES (1, 'p'); INSERT INTO child VALUES (10, 1);`,
      },
    ]);
    // The 12-step rebuild: with FKs on, DROP TABLE parent would cascade-delete the child rows.
    const r = migrate(db, [
      { version: 1, name: 'base', sql: '' },
      {
        version: 2,
        name: 'rebuild parent',
        sql: `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', code TEXT);
              INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
              DROP TABLE parent;
              ALTER TABLE parent_new RENAME TO parent;`,
      },
    ]);
    assert.deepEqual(r.applied, [2]);
    assert.equal(db.value('SELECT COUNT(*) FROM child'), 1, 'children survive the rebuild');
    assert.equal(db.value('PRAGMA foreign_keys'), 1, 'enforcement restored');
    assert.throws(() => db.run('INSERT INTO child VALUES (11, 99)'), /FOREIGN KEY/);
    db.close();
  });

  it('rolls back a migration that leaves dangling foreign keys', () => {
    const db = new Db(':memory:');
    const base: Migration = {
      version: 1,
      name: 'base',
      sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
            INSERT INTO parent VALUES (1); INSERT INTO child VALUES (10, 1);`,
    };
    migrate(db, [base]);
    assert.throws(() => migrate(db, [base, { version: 2, name: 'orphan', sql: 'DELETE FROM parent' }]), /broken foreign key.*child → parent/);
    assert.equal(getSchemaVersion(db), 1);
    assert.equal(db.value('SELECT COUNT(*) FROM parent'), 1, 'rolled back');
    assert.equal(db.value('PRAGMA foreign_keys'), 1);
    db.close();
  });

  it('rejects duplicate or invalid versions', () => {
    const db = new Db(':memory:');
    assert.throws(() => migrate(db, [
      { version: 1, name: 'a', sql: '' },
      { version: 1, name: 'b', sql: '' },
    ]), /Duplicate migration version/);
    assert.throws(() => migrate(db, [{ version: 0, name: 'zero', sql: '' }]), /Invalid migration version/);
    db.close();
  });
});
