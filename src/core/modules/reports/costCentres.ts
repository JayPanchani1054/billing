/**
 * Cost centre reports: category summary → centres (rolled up over sub-centres) → ledger breakup
 * (README §16). Amounts come from cost_allocations (signed like the ledger entry, books filter).
 */
import type { CostCentreLedgerRow, CostCentreRow, CostCentresInput, CostCentresResult } from '../../../shared/types/reports.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { assertPeriod, type ReportEnv } from './engine.ts';

interface CentreRow {
  id: number;
  name: string;
  category_id: number;
  parent_id: number | null;
}

export function costCentreReport(env: ReportEnv, input: CostCentresInput): CostCentresResult {
  assertPeriod(input.from, input.to);
  const cats = env.db.all<{ id: number; name: string }>(
    input.categoryId !== undefined ? 'SELECT id, name FROM cost_categories WHERE id = :id' : 'SELECT id, name FROM cost_categories ORDER BY name COLLATE NOCASE',
    input.categoryId !== undefined ? { id: input.categoryId } : {},
  );
  if (input.categoryId !== undefined && cats.length === 0) {
    throw validation([{ path: 'categoryId', message: 'This cost category does not exist. Pick another category.' }]);
  }
  const centres = env.db.all<CentreRow>('SELECT id, name, category_id, parent_id FROM cost_centres ORDER BY name COLLATE NOCASE');
  const byId = new Map(centres.map((c) => [c.id, c]));
  const sums = new Map<number, { dr: number; cr: number }>();
  for (const r of env.db.all<{ cost_centre_id: number; dr: number; cr: number }>(
    `SELECT cost_centre_id,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS dr,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS cr
       FROM cost_allocations
      WHERE date >= :from AND date <= :to AND ${BOOKS_FILTER()}
      GROUP BY cost_centre_id`,
    { from: input.from, to: input.to, today: env.today },
  )) {
    sums.set(r.cost_centre_id, { dr: r.dr, cr: r.cr });
  }
  // Roll up through parent centres (guarding against a corrupted cycle).
  const rolled = new Map<number, { dr: number; cr: number }>();
  for (const c of centres) rolled.set(c.id, { dr: 0, cr: 0 });
  for (const [id, s] of sums) {
    let cur: number | null = id;
    let guard = 0;
    while (cur !== null && guard++ < 64) {
      const t = rolled.get(cur);
      if (!t) break;
      t.dr += s.dr;
      t.cr += s.cr;
      cur = byId.get(cur)?.parent_id ?? null;
    }
  }
  const children = new Map<number | null, CentreRow[]>();
  for (const c of centres) {
    const key = c.parent_id !== null && byId.has(c.parent_id) ? c.parent_id : null;
    const list = children.get(key);
    if (list) list.push(c);
    else children.set(key, [c]);
  }
  const rows: CostCentreRow[] = [];
  for (const cat of cats) {
    const catKey = `cat:${cat.id}`;
    const catRow: CostCentreRow = { key: catKey, kind: 'category', id: cat.id, name: cat.name, level: 0, parentKey: null, hasChildren: false, debit: 0, credit: 0, net: 0 };
    const at = rows.length;
    rows.push(catRow);
    const emit = (c: CentreRow, level: number, parentKey: string, depth: number): void => {
      if (depth > 64) return;
      const t = rolled.get(c.id) ?? { dr: 0, cr: 0 };
      const key = `cc:${c.id}`;
      const row: CostCentreRow = { key, kind: 'centre', id: c.id, name: c.name, level, parentKey, hasChildren: false, debit: t.dr, credit: t.cr, net: t.dr - t.cr };
      const pos = rows.length;
      rows.push(row);
      for (const ch of children.get(c.id) ?? []) if (ch.category_id === cat.id) emit(ch, level + 1, key, depth + 1);
      row.hasChildren = rows.length > pos + 1;
      if (!row.hasChildren && row.debit === 0 && row.credit === 0) rows.length = pos;
    };
    for (const c of children.get(null) ?? []) {
      if (c.category_id !== cat.id) continue;
      const t = rolled.get(c.id) ?? { dr: 0, cr: 0 };
      catRow.debit += t.dr;
      catRow.credit += t.cr;
      emit(c, 1, catKey, 0);
    }
    catRow.net = catRow.debit - catRow.credit;
    catRow.hasChildren = rows.length > at + 1;
  }

  let centre: CostCentresResult['centre'] = null;
  if (input.costCentreId !== undefined) {
    const c = byId.get(input.costCentreId);
    if (!c) throw validation([{ path: 'costCentreId', message: 'This cost centre does not exist. Pick another cost centre.' }]);
    const ids: number[] = [];
    const walk = (id: number, depth: number): void => {
      if (depth > 64) return;
      ids.push(id);
      for (const ch of children.get(id) ?? []) walk(ch.id, depth + 1);
    };
    walk(c.id, 0);
    const ledgers: CostCentreLedgerRow[] = env.db
      .all<{ ledger_id: number; dr: number; cr: number }>(
        `SELECT ledger_id,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS dr,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS cr
           FROM cost_allocations
          WHERE cost_centre_id IN (SELECT value FROM json_each(:ids)) AND date >= :from AND date <= :to AND ${BOOKS_FILTER()}
          GROUP BY ledger_id`,
        { ids: JSON.stringify(ids), from: input.from, to: input.to, today: env.today },
      )
      .map((r) => {
        const l = env.ledgerById.get(r.ledger_id);
        return {
          ledgerId: r.ledger_id,
          ledgerName: l?.name ?? '',
          groupName: l ? (env.tree.byId.get(l.groupId)?.name ?? '') : '',
          debit: r.dr,
          credit: r.cr,
          net: r.dr - r.cr,
        };
      })
      .sort((a, b) => a.ledgerName.localeCompare(b.ledgerName, 'en', { sensitivity: 'base' }));
    const totals = { debit: 0, credit: 0, net: 0 };
    for (const l of ledgers) {
      totals.debit += l.debit;
      totals.credit += l.credit;
    }
    totals.net = totals.debit - totals.credit;
    centre = { id: c.id, name: c.name, ledgers, totals };
  }
  return { from: input.from, to: input.to, rows, centre };
}
