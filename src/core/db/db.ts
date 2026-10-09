/**
 * Thin, synchronous wrapper over Node's built-in `node:sqlite` (also available in Electron ≥ 36.7).
 * Zero native dependencies → nothing to rebuild for Electron, identical behaviour in tests.
 *
 *  - Named params use `:name` placeholders with a plain object: db.get('SELECT … WHERE id = :id', { id }).
 *  - Positional params use `?` with an array.
 *  - Booleans bind as 1/0, undefined binds as NULL.
 *  - Rows come back as plain objects (snake_case columns). Services map them to camelCase DTOs.
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

export class Db {
  readonly path: string;
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
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

  run(sql: string, params?: Params): RunResult {
    const r = this.stmt(sql).run(...(bind(params) as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const row = this.stmt(sql).get(...(bind(params) as never[]));
    return row === undefined ? undefined : ({ ...row } as T);
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return this.stmt(sql)
      .all(...(bind(params) as never[]))
      .map((row) => ({ ...row }) as T);
  }

  /** Single scalar value from the first column of the first row. */
  value<T extends SqlValue = SqlValue>(sql: string, params?: Params): T | undefined {
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
