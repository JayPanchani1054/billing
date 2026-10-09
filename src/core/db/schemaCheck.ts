/**
 * Schema validation for UNTRUSTED company databases (restored backups, files copied into the data
 * folder) — run BEFORE any other query on such a file.
 *
 * Threat: SQLite runs whatever the file's schema says. A crafted file can
 *   - shadow a table with a VIEW (`CREATE VIEW ledgers AS WITH RECURSIVE …`) so a plain
 *     `SELECT COUNT(*) FROM ledgers` never returns and freezes the process;
 *   - carry extra TRIGGERs (e.g. AFTER INSERT ON ledger_entries silently changing amounts) or a
 *     modified copy of ours (an audit_log "append-only" trigger that does nothing), which would keep
 *     running in the installed company;
 *   - declare virtual tables backed by modules with side effects.
 * Only views and triggers can contain queries (CHECK / DEFAULT / generated columns / index
 * expressions cannot contain sub-queries), so the rule is:
 *   - no VIEWs and no virtual tables at all (this schema has none);
 *   - every TRIGGER must be one that some version of our migrations creates — same name AND same SQL
 *     (whitespace-normalised). The allowlist is generated from the migrations themselves (each step),
 *     so it can never drift from the code;
 *   - the core tables exist as tables.
 * Missing audit_log triggers are re-created on open (ensureAuditTriggers), never silently accepted.
 * Every connection also runs with `PRAGMA trusted_schema = OFF` (Db constructor) so schema objects
 * can only call innocuous SQL functions.
 */
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { migrations, type Migration } from './migrations/index.ts';
import { Db } from './db.ts';

export interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Tables every Bahi company database has had since the first schema version. */
export const CORE_TABLES = ['company', 'settings', 'roles', 'users', 'audit_log', 'ledgers', 'vouchers', 'stock_items'] as const;

/** The append-only triggers of the edit log (001_init.ts). */
export const AUDIT_TRIGGERS_SQL: Readonly<Record<string, string>> = {
  audit_log_no_update: `CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
  audit_log_no_delete: `CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
};

const norm = (sql: string | null): string => (sql ?? '').replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();

let cachedAllowlist: Map<string, Set<string>> | null = null;

/**
 * name → set of normalised CREATE TRIGGER statements produced by the migrations, collected after every
 * migration step (so a trigger that a later version changes or drops is still recognised in an older
 * backup). Built once per process in an in-memory database.
 */
export function triggerAllowlist(list: readonly Migration[] = migrations): Map<string, Set<string>> {
  if (list === migrations && cachedAllowlist) return cachedAllowlist;
  const out = new Map<string, Set<string>>();
  const ordered = [...list].sort((a, b) => a.version - b.version);
  const db = new Db(':memory:');
  try {
    for (let i = 0; i < ordered.length; i++) {
      migrate(db, ordered.slice(0, i + 1));
      for (const t of db.all<SchemaObject>(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'`)) {
        const set = out.get(t.name) ?? new Set<string>();
        set.add(norm(t.sql));
        out.set(t.name, set);
      }
    }
  } finally {
    db.close();
  }
  if (list === migrations) cachedAllowlist = out;
  return out;
}

/**
 * Problems with a schema listing (empty array = acceptable). Pure apart from the cached allowlist.
 * Messages are short and name the offending object.
 */
export function schemaProblems(objects: readonly SchemaObject[], allow: Map<string, Set<string>> = triggerAllowlist()): string[] {
  const problems: string[] = [];
  const tables = new Set<string>();
  for (const o of objects) {
    const type = String(o.type).toLowerCase();
    if (type === 'view') problems.push(`view "${o.name}"`);
    else if (type === 'table') {
      if (/^\s*create\s+virtual\s+table/i.test(o.sql ?? '')) problems.push(`virtual table "${o.name}"`);
      else tables.add(String(o.name).toLowerCase());
    } else if (type === 'trigger') {
      const known = allow.get(o.name);
      if (!known || !known.has(norm(o.sql))) problems.push(`trigger "${o.name}"`);
    } else if (type !== 'index') {
      problems.push(`${type} "${o.name}"`);
    }
  }
  for (const t of CORE_TABLES) if (!tables.has(t)) problems.push(`missing table "${t}"`);
  return problems;
}

/** Raw schema listing (sqlite_master itself cannot be shadowed). Works on Db or a raw DatabaseSync. */
export function readSchema(db: Db | DatabaseSync): SchemaObject[] {
  const sql = 'SELECT type, name, tbl_name, sql FROM sqlite_master';
  if (db instanceof Db) return db.all<SchemaObject>(sql);
  return db.prepare(sql).all() as unknown as SchemaObject[];
}

export const UNEXPECTED_OBJECTS_MESSAGE = 'This file contains unexpected database objects, so it was not opened. It was not made by Bahi ERP or it has been tampered with.';

/** Problems with an untrusted database's schema ([] = safe to query). Also switches trusted_schema off. */
export function validateCompanySchema(db: Db | DatabaseSync): string[] {
  const raw = db instanceof Db ? db.handle : db;
  raw.exec('PRAGMA trusted_schema = OFF');
  return schemaProblems(readSchema(db));
}

/**
 * Re-create the edit log's append-only triggers if they are missing (e.g. dropped in a tampered copy).
 * Returns the names re-created. Call on a writable connection after migrate().
 */
export function ensureAuditTriggers(db: Db): string[] {
  const have = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'`).map((r) => r.name));
  const created: string[] = [];
  for (const [name, sql] of Object.entries(AUDIT_TRIGGERS_SQL)) {
    if (have.has(name)) continue;
    db.exec(sql);
    created.push(name);
  }
  return created;
}
