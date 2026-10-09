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

describe('Db read rows (array rows → plain objects)', () => {
  it('returns ordinary Object.prototype rows in select order, safe for JSON and structured clone', () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER, qty REAL, blob BLOB)');
      db.run('INSERT INTO t (name, amount, qty, blob) VALUES (:n, :a, :q, :b)', { n: 'Rice', a: 12_345, q: 1.5, b: new Uint8Array([1, 2]) });
      db.run('INSERT INTO t (name, amount, qty, blob) VALUES (?, ?, ?, ?)', ['Dal', -500, null, null]);
      const rows = db.all<{ id: number; name: string; amount: number; qty: number | null; blob: Uint8Array | null }>('SELECT id, name, amount, qty, blob FROM t ORDER BY id');
      assert.equal(rows.length, 2);
      for (const r of rows) assert.equal(Object.getPrototypeOf(r), Object.prototype);
      assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'amount', 'qty', 'blob']);
      assert.deepEqual({ ...rows[1] }, { id: 2, name: 'Dal', amount: -500, qty: null, blob: null });
      assert.deepEqual([...(rows[0].blob as Uint8Array)], [1, 2]);
      const cloned = structuredClone(rows);
      assert.deepEqual(cloned, rows);
      assert.equal(JSON.stringify(rows[1]), '{"id":2,"name":"Dal","amount":-500,"qty":null,"blob":null}');
      // get / value use the same statements
      assert.deepEqual(db.get('SELECT name, amount FROM t WHERE id = :id', { id: 1 }), { name: 'Rice', amount: 12_345 });
      assert.equal(Object.getPrototypeOf(db.get('SELECT name FROM t WHERE id = 1')), Object.prototype);
      assert.equal(db.get('SELECT name FROM t WHERE id = 99'), undefined);
      assert.equal(db.value('SELECT SUM(amount) FROM t'), 11_845);
      assert.equal(db.value('SELECT amount FROM t WHERE id = 99'), undefined);
      // a mutated row never leaks into the next call (fresh objects every time)
      rows[0].name = 'changed';
      assert.equal(db.get<{ name: string }>('SELECT name FROM t WHERE id = 1')?.name, 'Rice');
    } finally {
      db.close();
    }
  });

  it('duplicate column names: the last one wins (as node:sqlite object rows); a column named __proto__ stays data', () => {
    const db = new Db(':memory:');
    try {
      const dup = db.get('SELECT 1 AS a, 2 AS a, 3 AS b');
      assert.deepEqual(dup, { a: 2, b: 3 });
      const proto = db.get<Record<string, unknown>>('SELECT 7 AS "__proto__", 8 AS x');
      assert.ok(proto);
      assert.equal(Object.getPrototypeOf(proto), Object.prototype, 'the prototype was not replaced');
      assert.equal(Object.getOwnPropertyDescriptor(proto, '__proto__')?.value, 7);
      assert.equal(proto.x, 8);
    } finally {
      db.close();
    }
  });

  it('a cached SELECT * follows a schema change (column names are read per call, not cached)', () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE t (a INTEGER)');
      db.run('INSERT INTO t VALUES (1)');
      assert.deepEqual(db.all('SELECT * FROM t'), [{ a: 1 }]);
      db.exec('ALTER TABLE t ADD COLUMN b TEXT');
      db.run("UPDATE t SET b = 'x'");
      assert.deepEqual(db.all('SELECT * FROM t'), [{ a: 1, b: 'x' }]);
    } finally {
      db.close();
    }
  });
});
