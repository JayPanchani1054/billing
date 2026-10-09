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

describe('Db.iterate', () => {
  it('yields plain rows one at a time with named params, and other queries can run meanwhile', () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      for (let i = 1; i <= 5; i++) db.run('INSERT INTO t (v) VALUES (:v)', { v: `r${i}` });
      const seen: string[] = [];
      for (const row of db.iterate<{ id: number; v: string }>('SELECT id, v FROM t WHERE id >= :min ORDER BY id', { min: 2 })) {
        assert.equal(Object.getPrototypeOf(row), Object.prototype);
        seen.push(row.v);
        // The cached statement API is still usable inside the loop (iterate prepares its own statement).
        assert.equal(db.value('SELECT COUNT(*) FROM t'), 5);
      }
      assert.deepEqual(seen, ['r2', 'r3', 'r4', 'r5']);
      const it = db.iterate('SELECT id FROM t');
      assert.equal(it.next().done, false);
      it.return(undefined); // stopping early releases the statement
      assert.deepEqual([...db.iterate('SELECT id FROM t WHERE id = ?', [3])], [{ id: 3 }]);
    } finally {
      db.close();
    }
  });
});
