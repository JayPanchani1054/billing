/**
 * Scenario masters (Tally: Accounts Info › Scenarios). How a scenario changes the reports:
 * reports/scenario.ts. Masters permissions; every change audited.
 */
import { randomUUID } from 'node:crypto';
import type { ScenarioRow, ScenarioSaveInput } from '../../../shared/types/documents.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';
import { fieldIssue, nowIso, requirePermission, txt } from './common.ts';

/** Base types whose vouchers can never enter a scenario (no ledger entries at all). */
const NO_LEDGER_BASES = ['sales_order', 'purchase_order', 'delivery_note', 'receipt_note', 'rejection_in', 'rejection_out', 'stock_journal', 'physical_stock', 'quotation', 'proforma'];

export function listScenarios(db: Db): ScenarioRow[] {
  const types = db.all<{ scenario_id: number; voucher_type_id: number; role: string; name: string }>(
    `SELECT st.scenario_id, st.voucher_type_id, st.role, vt.name FROM scenario_voucher_types st JOIN voucher_types vt ON vt.id = st.voucher_type_id ORDER BY vt.name COLLATE NOCASE`,
  );
  return db.all<{ id: number; name: string; include_actuals: number }>('SELECT id, name, include_actuals FROM scenarios ORDER BY name COLLATE NOCASE').map((s) => {
    const own = types.filter((t) => t.scenario_id === s.id);
    const inc = own.filter((t) => t.role === 'include');
    const exc = own.filter((t) => t.role === 'exclude');
    return {
      id: s.id,
      name: s.name,
      includeActuals: s.include_actuals === 1,
      includeTypeIds: inc.map((t) => t.voucher_type_id),
      excludeTypeIds: exc.map((t) => t.voucher_type_id),
      includeTypes: inc.map((t) => t.name),
      excludeTypes: exc.map((t) => t.name),
    };
  });
}

export function getScenario(db: Db, id: number): ScenarioRow {
  const s = listScenarios(db).find((x) => x.id === id);
  if (!s) throw notFound('Scenario', id);
  return s;
}

export function saveScenario(ctx: CompanyCtx, input: ScenarioSaveInput): ScenarioRow {
  const { db } = ctx;
  requirePermission(ctx, input.id === undefined ? 'masters.create' : 'masters.alter', input.id === undefined ? 'create scenarios' : 'alter scenarios');
  const name = txt(input.name);
  if (!name) throw fieldIssue('name', 'Give the scenario a name (e.g. "Provisional – with provisions").');
  const before = input.id !== undefined ? getScenario(db, input.id) : null;
  if (db.value<number>('SELECT id FROM scenarios WHERE name = :name AND id <> :id', { name, id: input.id ?? 0 }) !== undefined) {
    throw fieldIssue('name', `A scenario named "${name}" already exists. Choose another name.`);
  }
  const inc = [...new Set(input.includeTypeIds)];
  const exc = [...new Set(input.excludeTypeIds)];
  const both = inc.find((id) => exc.includes(id));
  if (both !== undefined) throw fieldIssue('excludeTypeIds', 'A voucher type cannot be both included and excluded. Remove it from one of the lists.');
  if (!input.includeActuals && exc.length > 0) throw fieldIssue('excludeTypeIds', 'Excluding voucher types only matters when actuals are included. Clear the list, or include actuals.');
  if (!input.includeActuals && inc.length === 0) throw fieldIssue('includeTypeIds', 'Without actuals and without included voucher types the scenario would show nothing. Include a voucher type.');
  const check = (ids: number[], path: string): void => {
    ids.forEach((id, i) => {
      const t = db.get<{ name: string; base_type: string }>('SELECT name, base_type FROM voucher_types WHERE id = :id', { id });
      if (!t) throw fieldIssue(`${path}[${i}]`, 'This voucher type no longer exists. Remove it.');
      if (NO_LEDGER_BASES.includes(t.base_type)) throw fieldIssue(`${path}[${i}]`, `${t.name} vouchers post no ledger entries, so they cannot change a report. Remove it.`);
    });
  };
  check(inc, 'includeTypeIds');
  check(exc, 'excludeTypeIds');
  const now = nowIso(ctx);
  let id: number;
  let guid: string;
  if (before) {
    id = before.id;
    guid = db.value<string>('SELECT guid FROM scenarios WHERE id = :id', { id }) ?? '';
    db.run('UPDATE scenarios SET name = :name, include_actuals = :a, updated_at = :now WHERE id = :id', { name, a: input.includeActuals ? 1 : 0, now, id });
    db.run('DELETE FROM scenario_voucher_types WHERE scenario_id = :id', { id });
  } else {
    guid = randomUUID();
    id = db.run('INSERT INTO scenarios (guid, name, include_actuals, created_at, updated_at) VALUES (:guid, :name, :a, :now, :now)', {
      guid,
      name,
      a: input.includeActuals ? 1 : 0,
      now,
    }).lastInsertRowid;
  }
  for (const t of inc) db.run(`INSERT INTO scenario_voucher_types (scenario_id, voucher_type_id, role) VALUES (:id, :t, 'include')`, { id, t });
  for (const t of exc) db.run(`INSERT INTO scenario_voucher_types (scenario_id, voucher_type_id, role) VALUES (:id, :t, 'exclude')`, { id, t });
  const after = getScenario(db, id);
  ctx.audit({ action: before ? 'alter' : 'create', entityType: 'scenario', entityId: id, entityGuid: guid, entityLabel: `Scenario ${name}`, before: before ?? undefined, after });
  return after;
}

export function deleteScenario(ctx: CompanyCtx, id: number): { id: number } {
  requirePermission(ctx, 'masters.delete', 'delete scenarios');
  const before = getScenario(ctx.db, id);
  const guid = ctx.db.value<string>('SELECT guid FROM scenarios WHERE id = :id', { id });
  ctx.db.run('DELETE FROM scenarios WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'scenario', entityId: id, entityGuid: guid, entityLabel: `Scenario ${before.name}`, before });
  return { id };
}
