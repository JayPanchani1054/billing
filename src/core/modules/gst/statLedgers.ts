/**
 * System ledgers of the GST plus features (GST on advances, electronic cash ledger, customs IGST payable,
 * interest / late fee / penalty, composition tax, ITC reversed). They are created on demand — the first
 * time a voucher or a set-off needs one — like the GST tax ledgers are created when GST is turned on, and
 * carry a reserved_code so they are found again whatever the user renames them to (and cannot be deleted).
 */
import { randomUUID } from 'node:crypto';
import { GST_PLUS_LEDGERS, type GstPlusLedgerCode } from '../../../shared/types/gst-plus.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';

/** Ledger id of a GST plus system ledger, or undefined when it has not been created yet. */
export function statLedgerId(db: Db, code: GstPlusLedgerCode): number | undefined {
  return db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :code', { code });
}

/**
 * Create the ledger when missing (idempotent). Must run inside a write transaction. `audit` (the request's
 * ctx.audit) records the creation — or the adoption of a same-named ledger — in the audit trail.
 */
export function ensureStatLedger(db: Db, code: GstPlusLedgerCode, ts: string, audit?: CompanyCtx['audit']): number {
  const existing = statLedgerId(db, code);
  if (existing !== undefined) return existing;
  const spec = GST_PLUS_LEDGERS[code];
  const groupId = db.value<number>('SELECT id FROM groups WHERE reserved_code = :g', { g: spec.group });
  if (groupId === undefined) throw new AppError('INTERNAL', `Group ${spec.group} is missing`);
  const same = db.get<{ id: number; group_id: number; reserved_code: string | null }>('SELECT id, group_id, reserved_code FROM ledgers WHERE name = :name', {
    name: spec.name,
  });
  if (same && same.group_id === groupId && same.reserved_code === null) {
    db.run('UPDATE ledgers SET reserved_code = :code, is_predefined = 1, updated_at = :ts WHERE id = :id', { code, ts, id: same.id });
    audit?.({ action: 'alter', entityType: 'ledger', entityId: same.id, entityLabel: spec.name, after: { reservedCode: code, by: 'gst' } });
    return same.id;
  }
  let name: string = spec.name;
  for (let i = 1; same && i < 1000; i++) {
    const candidate = i === 1 ? `${spec.name} (System)` : `${spec.name} (System ${i})`;
    if (db.value('SELECT 1 FROM ledgers WHERE name = :name', { name: candidate }) === undefined) {
      name = candidate;
      break;
    }
  }
  const guid = randomUUID();
  const id = db.run(
    `INSERT INTO ledgers (guid, name, group_id, reserved_code, is_predefined, gst_applicable, created_at, updated_at)
     VALUES (:guid, :name, :groupId, :code, 1, 'not_applicable', :ts, :ts)`,
    { guid, name, groupId, code, ts },
  ).lastInsertRowid;
  audit?.({ action: 'create', entityType: 'ledger', entityId: id, entityGuid: guid, entityLabel: name, after: { name, group: spec.group, reservedCode: code, createdBy: 'gst' } });
  return id;
}

/** Ids of the GST duty ledgers by direction and head (reserved codes OUTPUT_* / INPUT_* / RCM_*). */
export interface DutyLedgers {
  output: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', number>>;
  input: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', number>>;
  rcm: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', number>>;
}

export function dutyLedgers(db: Db): DutyLedgers {
  const out: DutyLedgers = { output: {}, input: {}, rcm: {} };
  for (const r of db.all<{ id: number; code: string }>(
    `SELECT id, reserved_code AS code FROM ledgers WHERE reserved_code LIKE 'OUTPUT\\_%' ESCAPE '\\' OR reserved_code LIKE 'INPUT\\_%' ESCAPE '\\' OR reserved_code LIKE 'RCM\\_%' ESCAPE '\\'`,
  )) {
    const [dir, head] = r.code.split('_');
    const h = head.toLowerCase() as 'igst' | 'cgst' | 'sgst' | 'cess';
    if (dir === 'OUTPUT') out.output[h] = r.id;
    else if (dir === 'INPUT') out.input[h] = r.id;
    else if (dir === 'RCM') out.rcm[h] = r.id;
  }
  return out;
}
