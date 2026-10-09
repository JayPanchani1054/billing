/**
 * Scenarios (Tally "Scenario Management") for the balance engine. A scenario changes which vouchers a
 * report counts — the books stay as they are:
 *
 *   counted = (includeActuals ? books − actual vouchers of the EXCLUDED types : nothing)
 *           + provisional vouchers of the INCLUDED types, i.e. vouchers that never post to the books:
 *               memorandum vouchers;
 *               reversing journals while the report date `to` is on or before their "applicable up
 *                 to" date (none = no limit) — so a provision entered on 31-Mar "applicable up to
 *                 30-Apr" shows in a Balance Sheet as on 31-Mar or 15-Apr but not as on 1-May;
 *               optional vouchers.
 *   Cancelled vouchers never count; a post-dated voucher counts once its date is on or before the
 *   working date (the books filter's rule).
 *
 * The scenario is defined in the documents module (scenarios / scenario_voucher_types, migration 193);
 * `loadScenario` reads it and `scenarioAdjust` returns per-ledger deltas in the shape of ledgerSums
 * (engine.ts), which adds them. Stock values are not affected (memorandum / reversing journals and
 * optional vouchers move no stock).
 */
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';

export interface ScenarioDef {
  id: number;
  name: string;
  includeActuals: boolean;
  includeTypeIds: number[];
  excludeTypeIds: number[];
}

/** The scenario, or a VALIDATION error on `scenarioId` when it does not exist. */
export function loadScenario(db: Db, id: number): ScenarioDef {
  const s = db.get<{ id: number; name: string; include_actuals: number }>('SELECT id, name, include_actuals FROM scenarios WHERE id = :id', { id });
  if (!s) throw validation([{ path: 'scenarioId', message: 'This scenario does not exist any more. Pick another one, or run the report without a scenario.' }]);
  const types = db.all<{ voucher_type_id: number; role: string }>('SELECT voucher_type_id, role FROM scenario_voucher_types WHERE scenario_id = :id', { id });
  return {
    id: s.id,
    name: s.name,
    includeActuals: s.include_actuals === 1,
    includeTypeIds: types.filter((t) => t.role === 'include').map((t) => t.voucher_type_id),
    excludeTypeIds: types.filter((t) => t.role === 'exclude').map((t) => t.voucher_type_id),
  };
}

export interface SumsDelta {
  pre: number;
  before: number;
  dr: number;
  cr: number;
}

const COLUMNS = `SELECT le.ledger_id,
          SUM(CASE WHEN le.date < :cf THEN le.amount ELSE 0 END) AS pre,
          SUM(CASE WHEN le.date >= :cf AND le.date < :from THEN le.amount ELSE 0 END) AS before,
          SUM(CASE WHEN le.date >= :from AND le.amount > 0 THEN le.amount ELSE 0 END) AS dr,
          SUM(CASE WHEN le.date >= :from AND le.amount < 0 THEN -le.amount ELSE 0 END) AS cr
     FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id`;

/** Regular vouchers of the excluded types. */
const EXCLUDED_SQL = (some: boolean): string => `${COLUMNS}
    WHERE v.voucher_type_id IN (SELECT value FROM json_each(:types)) AND le.date <= :to AND ${BOOKS_FILTER('le')}
      ${some ? 'AND le.ledger_id IN (SELECT value FROM json_each(:ids))' : ''}
    GROUP BY le.ledger_id`;

/** Provisional vouchers of the included types (see the header). */
const PROVISIONAL_SQL = (some: boolean): string => `${COLUMNS}
    WHERE v.voucher_type_id IN (SELECT value FROM json_each(:types)) AND v.is_cancelled = 0 AND le.affects_books = 0
      AND le.date <= :to AND (le.is_post_dated = 0 OR le.date <= :today)
      AND (v.base_type = 'memorandum' OR v.is_optional = 1
           OR (v.base_type = 'reversing_journal' AND (v.applicable_upto IS NULL OR v.applicable_upto >= :to)))
      ${some ? 'AND le.ledger_id IN (SELECT value FROM json_each(:ids))' : ''}
    GROUP BY le.ledger_id`;

/**
 * Per-ledger amounts to ADD to the books sums of [cf, from, to] (pre / before / dr / cr as in
 * engine.ts ledgerSums) for the scenario. `dropBooks` is true when actuals are not included: the
 * caller then ignores the books sums altogether.
 */
export function scenarioAdjust(
  db: Db,
  s: ScenarioDef,
  q: { cf: string; from: string; to: string; today: string; ledgerIds?: readonly number[] },
): { dropBooks: boolean; delta: Map<number, SumsDelta> } {
  const delta = new Map<number, SumsDelta>();
  const some = q.ledgerIds !== undefined;
  const base = { cf: q.cf, from: q.from, to: q.to, today: q.today, ...(some ? { ids: JSON.stringify(q.ledgerIds) } : {}) };
  const add = (sign: 1 | -1, rows: Array<{ ledger_id: number; pre: number | null; before: number | null; dr: number | null; cr: number | null }>): void => {
    for (const r of rows) {
      const d = delta.get(r.ledger_id) ?? { pre: 0, before: 0, dr: 0, cr: 0 };
      d.pre += sign * (r.pre ?? 0);
      d.before += sign * (r.before ?? 0);
      d.dr += sign * (r.dr ?? 0);
      d.cr += sign * (r.cr ?? 0);
      delta.set(r.ledger_id, d);
    }
  };
  if (s.includeActuals && s.excludeTypeIds.length > 0) add(-1, db.all(EXCLUDED_SQL(some), { ...base, types: JSON.stringify(s.excludeTypeIds) }));
  if (s.includeTypeIds.length > 0) add(1, db.all(PROVISIONAL_SQL(some), { ...base, types: JSON.stringify(s.includeTypeIds) }));
  return { dropBooks: !s.includeActuals, delta };
}
