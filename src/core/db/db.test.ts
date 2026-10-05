import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Db } from './db.ts';

describe('Db.transaction', () => {
  it('commits, nests via savepoints and rolls back only the failing level', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)');
      assert.throws(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (2)');
          throw new Error('inner');
        }),
      );
      db.run('INSERT INTO t VALUES (3)');
    });
    assert.deepEqual(db.all('SELECT x FROM t ORDER BY x').map((r) => r.x), [1, 3]);
    assert.equal(db.inTransaction, false);
    db.close();
  });

  it('re-throws the root cause when SQLite has already rolled back the whole transaction (regression)', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    assert.throws(
      () =>
        db.transaction(() =>
          db.transaction(() => {
            db.run('INSERT INTO t VALUES (1)');
            db.exec('ROLLBACK'); // what SQLite does by itself on SQLITE_FULL / SQLITE_IOERR
            throw new Error('disk full (root cause)');
          }),
        ),
      /disk full \(root cause\)/,
    );
    assert.equal(db.inTransaction, false);
    db.transaction(() => db.run('INSERT INTO t VALUES (2)'));
    assert.equal(db.value('SELECT COUNT(*) FROM t'), 1, 'connection still usable');
    db.close();
  });

  it('refuses async callbacks', () => {
    const db = new Db(':memory:');
    assert.throws(() => db.transaction(async () => 1), /synchronous/);
    assert.equal(db.inTransaction, false);
    db.close();
  });
});
