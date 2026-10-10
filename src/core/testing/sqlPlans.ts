/**
 * Test helpers (tests only): record the SQL a piece of code runs on a Db, and check each statement's
 * query plan against the "touch only the rows you need" rule of the voucher hooks and reports.
 *
 * The app never runs ANALYZE, so SQLite's plans depend on the schema alone (not on the data): a plan
 * checked on a small test company is the plan a 60,000-voucher company gets. That makes these checks
 * deterministic perf regression tests, unlike wall-clock budgets on a loaded CI machine.
 */
import type { Db, Params } from '../db/db.ts';

export interface RecordedStatement {
  sql: string;
  params: Params | undefined;
}

export interface SqlRecorder {
  /** Clear the log and start recording. */
  start(): void;
  /** Stop recording; returns (and clears) the statements recorded since start(). */
  stop(): RecordedStatement[];
}

type DbMethod = (sql: string, params?: Params) => unknown;

/** Wrap `db`'s get / all / run / value (this instance only) to record statements while started. */
export function recordSql(db: Db): SqlRecorder {
  const log: RecordedStatement[] = [];
  let on = false;
  const target = db as unknown as Record<'get' | 'all' | 'run' | 'value', DbMethod>;
  for (const m of ['get', 'all', 'run', 'value'] as const) {
    const orig = target[m].bind(db);
    target[m] = (sql, params) => {
      if (on) log.push({ sql, params });
      return orig(sql, params);
    };
  }
  return {
    start() {
      log.length = 0;
      on = true;
    },
    stop() {
      on = false;
      return log.splice(0);
    },
  };
}

/** Tables that grow with the books (vouchers and their derived rows): never scanned on a keyed path. */
export const GROWING_TABLES: ReadonlySet<string> = new Set([
  'vouchers',
  'ledger_entries',
  'bill_allocations',
  'inventory_entries',
  'gst_lines',
  'cost_allocations',
  'tds_lines',
  'gst_advance_lines',
  'gst_stat_lines',
  'gst_bill_of_entry',
  'gst_amendments',
  'gst_3b_changes',
  'gst_rule37_links',
  'gstrecon_decisions',
  'pos_bills',
  'pos_payments',
  'stock_journal_details',
  'stock_journal_lines',
  'stock_journal_costs',
  'cheque_prints',
  'cheque_leaf_marks',
  'document_links',
  'recurring_runs',
  'attachments',
  'audit_log',
]);

const SQL_WORDS = new Set(['ON', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'INDEXED', 'NOT', 'GROUP', 'ORDER', 'USING', 'LIMIT', 'SET', 'VALUES', 'UNION', 'AS']);

/** alias → table for the FROM / JOIN / UPDATE / INTO clauses of a statement. */
function aliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?(\w+)"?(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    out.set(m[1], m[1]);
    if (m[2] && !SQL_WORDS.has(m[2].toUpperCase())) out.set(m[2], m[1]);
  }
  return out;
}

/** The EXPLAIN QUERY PLAN lines of a statement (with its own parameters). */
export function queryPlan(db: Db, s: RecordedStatement): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.sql}`, s.params).map((p) => p.detail);
}

/**
 * What is wrong with a statement's plan ([] when nothing):
 *   - it scans a growing table (an existence probe or "last row" read — `… LIMIT 1` without WHERE,
 *     e.g. the edit log's chain head — may: it stops at the first row);
 *   - it is keyed by `voucher_id = :x` but does not look that voucher up (an index on other columns
 *     reads e.g. every TDS line of a section, or every bill of a party);
 *   - it reads a bank's cheque leaves without the partial cheque index (migration 241);
 *   - it looks up a TDS / TCS payable ledger without the payable index.
 */
export function planProblems(db: Db, s: RecordedStatement): string[] {
  const sql = s.sql.replace(/\s+/g, ' ').trim();
  // INSERT too: an INSERT … SELECT reads like a SELECT, and an upsert's conflict target is looked up.
  // (EXPLAIN QUERY PLAN also lists the foreign-key look-ups of a DELETE: a CASCADE / SET NULL child
  // without an index on its column shows as a SCAN of the child table.)
  if (!/^(SELECT|WITH|UPDATE|DELETE|INSERT|REPLACE)\b/i.test(sql)) return [];
  const plan = queryPlan(db, s);
  const names = aliases(sql);
  const out: string[] = [];
  const probe = /LIMIT 1$/i.test(sql) && !/\bWHERE\b/i.test(sql);
  for (const step of plan) {
    const m = step.match(/^SCAN (\w+)/);
    if (!m || probe) continue;
    const table = names.get(m[1]) ?? m[1];
    if (GROWING_TABLES.has(table)) out.push(`scans ${table}: ${step}`);
  }
  if (/(^|[^.\w])voucher_id\s*=\s*:\w+/i.test(sql) && !plan.some((p) => /\bvoucher_id=\?|\(rowid=\?\)/.test(p))) {
    out.push(`keyed by voucher_id but does not look the voucher up: ${plan.join(' | ')}`);
  }
  if (/instrument_type = 'cheque'/.test(sql) && /ledger_id = :bank/.test(sql) && !plan.some((p) => p.includes('idx_le_cheques'))) {
    out.push(`cheque leaves of a bank without idx_le_cheques: ${plan.join(' | ')}`);
  }
  if (/FROM tds_ledger_details\b.*\bpayable_section\b/.test(sql) && !plan.some((p) => p.includes('idx_tds_ledger_payable'))) {
    out.push(`payable ledger look-up without idx_tds_ledger_payable: ${plan.join(' | ')}`);
  }
  return out;
}

/** planProblems() of every distinct statement, each prefixed with `label` and the statement. */
export function allPlanProblems(db: Db, statements: readonly RecordedStatement[], label: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of statements) {
    if (seen.has(s.sql)) continue;
    seen.add(s.sql);
    for (const p of planProblems(db, s)) out.push(`${label}: ${p}\n    ${s.sql.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  return out;
}
