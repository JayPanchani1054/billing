/**
 * Thin, synchronous wrapper over Node's built-in `node:sqlite` (also available in Electron ≥ 36.7).
 * Zero native dependencies → nothing to rebuild for Electron, identical behaviour in tests.
 *
 *  - Named params use `:name` placeholders with a plain object: db.get('SELECT … WHERE id = :id', { id }).
 *  - Positional params use `?` with an array.
 *  - Booleans bind as 1/0, undefined binds as NULL.
 *  - Rows come back as plain objects (snake_case columns). Services map them to camelCase DTOs.
 *    They are built from SQLite's array rows (`setReturnArrays`), not copied from node:sqlite's
 *    null-prototype row objects: those are dictionary-mode objects (slow to read) and spreading
 *    them cost 40–80 % of a large read. The result is an ordinary `Object.prototype` object with
 *    the columns in select order (last one wins for duplicate names, as in node:sqlite), safe for
 *    JSON and structured clone (IPC).
 *  - transaction() nests via SAVEPOINTs and rolls back on throw.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type BindValue = SqlValue | boolean | undefined;
export type Params = Record<string, BindValue> | BindValue[];
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DbOptions {
  readOnly?: boolean;
  /** Busy timeout in ms (default 5000). */
  timeoutMs?: number;
}

function normalize(value: BindValue): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function bind(params: Params | undefined): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalize);
  const out: Record<string, SqlValue> = {};
  for (const [k, val] of Object.entries(params)) out[k] = normalize(val);
  return [out];
}

/**
 * The two StatementSync methods used for array rows. Declared locally (and probed at runtime) so the
 * wrapper also compiles against @types/node releases that predate them; Node ≥ 22.16 / Electron ≥ 36
 * have both.
 */
interface ArrayRows {
  setReturnArrays?(enabled: boolean): void;
  columns?(): Array<{ name: string }>;
}

/** Plain object rows from array rows and the statement's column names (see the header). */
function toObjects(stmt: StatementSync, rows: readonly unknown[]): Row[] {
  const names = ((stmt as unknown as ArrayRows).columns as () => Array<{ name: string }>).call(stmt).map((c) => c.name);
  const n = names.length;
  const out: Row[] = new Array(rows.length);
  if (names.includes('__proto__')) {
    // A column literally named __proto__ must stay a data property (assignment would set the prototype).
    for (let r = 0; r < rows.length; r++) {
      const a = rows[r] as SqlValue[];
      const o: Row = {};
      for (let i = 0; i < n; i++) Object.defineProperty(o, names[i], { value: a[i], writable: true, enumerable: true, configurable: true });
      out[r] = o;
    }
    return out;
  }
  for (let r = 0; r < rows.length; r++) {
    const a = rows[r] as SqlValue[];
    const o: Row = {};
    for (let i = 0; i < n; i++) o[names[i]] = a[i];
    out[r] = o;
  }
  return out;
}

export class Db {
  readonly path: string;
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  /** Cached statements switched to array rows (reads); `run` uses the plain cache. */
  private readonly readCache = new Map<string, StatementSync>();
  /** node:sqlite supports array rows (probed once per connection). */
  private arrays: boolean | null = null;
  private depth = 0;
  private savepointSeq = 0;

  constructor(path: string, opts: DbOptions = {}) {
    this.path = path;
    this.raw = new DatabaseSync(path, { readOnly: opts.readOnly ?? false, enableForeignKeyConstraints: true });
    this.raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.timeoutMs ?? 5000))}`);
    if (path !== ':memory:' && !opts.readOnly) {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = FULL');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    // Schema objects (triggers, indexes, CHECK/DEFAULT expressions) may call only innocuous SQL
    // functions: a crafted company file cannot reach functions with side effects (see schemaCheck.ts).
    this.raw.exec('PRAGMA trusted_schema = OFF');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** Statement for reads: array rows when the runtime supports them (null when it does not). */
  private readStmt(sql: string): StatementSync | null {
    if (this.arrays === false) return null;
    let s = this.readCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      const a = s as unknown as ArrayRows;
      if (this.arrays === null) this.arrays = typeof a.setReturnArrays === 'function' && typeof a.columns === 'function';
      if (!this.arrays) return null;
      (a.setReturnArrays as (enabled: boolean) => void).call(s, true);
      this.readCache.set(sql, s);
    }
    return s;
  }

  run(sql: string, params?: Params): RunResult {
    const r = this.stmt(sql).run(...(bind(params) as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const rs = this.readStmt(sql);
    if (rs) {
      const row = rs.get(...(bind(params) as never[]));
      return row === undefined ? undefined : (toObjects(rs, [row])[0] as T);
    }
    const row = this.stmt(sql).get(...(bind(params) as never[]));
    return row === undefined ? undefined : ({ ...row } as T);
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const rs = this.readStmt(sql);
    if (rs) return toObjects(rs, rs.all(...(bind(params) as never[]))) as T[];
    return this.stmt(sql)
      .all(...(bind(params) as never[]))
      .map((row) => ({ ...row }) as T);
  }

  /**
   * Rows one at a time (constant memory) for very large reads such as exports. Uses its own prepared
   * statement, so other queries may run on this connection while the iteration is in progress.
   * Finish (or `return()`) the iterator before closing the connection.
   */
  *iterate<T = Row>(sql: string, params?: Params): Generator<T, void, undefined> {
    const stmt = this.raw.prepare(sql);
    for (const row of stmt.iterate(...(bind(params) as never[]))) yield { ...row } as T;
  }

  /** Single scalar value from the first column of the first row. */
  value<T extends SqlValue = SqlValue>(sql: string, params?: Params): T | undefined {
    const rs = this.readStmt(sql);
    if (rs) {
      const row = rs.get(...(bind(params) as never[])) as unknown as SqlValue[] | undefined;
      return row === undefined ? undefined : (row[0] as T);
    }
    const row = this.stmt(sql).get(...(bind(params) as never[]));
    if (row === undefined) return undefined;
    const first = Object.values(row)[0];
    return first as T;
  }

  /** Execute one or more statements without parameters (DDL, PRAGMA). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const out = fn();
        if (out instanceof Promise) throw new Error('Db.transaction callback must be synchronous');
        this.raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        this.depth--;
      }
    }
    const sp = `sp_${++this.savepointSeq}`;
    this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('Db.transaction callback must be synchronous');
      this.raw.exec(`RELEASE ${sp}`);
      return out;
    } catch (err) {
      try {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
      } catch {
        // SQLite already rolled back the whole transaction (e.g. disk full, I/O error): the savepoint
        // is gone. Re-throw the original error rather than masking it with "no such savepoint".
      }
      throw err;
    } finally {
      this.depth--;
    }
  }

  /**
   * ONE transaction around an asynchronous job (e.g. an import that yields to the event loop between
   * chunks to report progress). Only for a DEDICATED connection that nothing else uses meanwhile —
   * anything else run on this Db while `fn` awaits would silently join the transaction. Inside `fn`,
   * transaction() nests as savepoints as usual. Not nestable itself.
   */
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth !== 0) throw new Error('Db.transactionAsync cannot run inside another transaction');
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = await fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** False once close() ran (long jobs on another connection check this to stop early). */
  get isOpen(): boolean {
    return this.raw.isOpen;
  }

  /** Register a deterministic scalar SQL function. */
  defineFunction(name: string, fn: (...args: SqlValue[]) => SqlValue): void {
    this.raw.function(name, { deterministic: true }, fn as never);
  }

  /** Access to the underlying handle for backup/advanced use (data module only). */
  get handle(): DatabaseSync {
    return this.raw;
  }

  close(): void {
    this.cache.clear();
    this.readCache.clear();
    if (this.raw.isOpen) {
      if (this.path !== ':memory:') {
        try {
          this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          /* ignore */
        }
      }
      this.raw.close();
    }
  }
}
