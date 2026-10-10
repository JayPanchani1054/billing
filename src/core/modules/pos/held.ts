/**
 * Held bills: a bill parked at the counter (the customer went to fetch something) and recalled later.
 * No voucher exists until it is billed: nothing is posted, numbered or reserved. Recalling removes the
 * held copy (the counter then owns it). Every hold / recall / discard is audited.
 */
import { randomUUID } from 'node:crypto';
import type { PosDraft, PosHeldBill, PosHeldBillSaveInput } from '../../../shared/types/pos.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { assertPosEnabled, isPosType } from './store.ts';

/** At most this many bills on hold per company (a counter, not a parking lot). */
export const MAX_HELD_BILLS = 100;

interface HeldRow {
  id: number;
  guid: string;
  voucher_type_id: number | null;
  label: string;
  customer_name: string | null;
  line_count: number;
  total: number;
  draft: string;
  created_by_name: string | null;
  created_at: string;
}

function toHeld(r: HeldRow): PosHeldBill {
  let draft: PosDraft;
  try {
    draft = JSON.parse(r.draft) as PosDraft;
  } catch {
    draft = { voucherTypeId: r.voucher_type_id ?? 0, lines: [] };
  }
  return { id: r.id, label: r.label, customerName: r.customer_name, lineCount: r.line_count, total: r.total, createdAt: r.created_at, createdByName: r.created_by_name, draft };
}

export function listHeldBills(db: Db): PosHeldBill[] {
  assertPosEnabled(db);
  return db.all<HeldRow>('SELECT * FROM pos_held_bills ORDER BY created_at, id').map(toHeld);
}

function getRow(db: Db, id: number): HeldRow {
  const r = db.get<HeldRow>('SELECT * FROM pos_held_bills WHERE id = :id', { id });
  if (!r) throw notFound('Held bill', id);
  return r;
}

/** Check the draft's references so a recalled bill never points at something that does not exist. */
function checkDraft(db: Db, d: PosDraft): void {
  const issues: Array<{ path: string; message: string }> = [];
  const vt = db.get<{ base_type: string; config: string }>('SELECT base_type, config FROM voucher_types WHERE id = :id', { id: d.voucherTypeId });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = vt ? (JSON.parse(vt.config) as Record<string, unknown>) : {};
  } catch {
    cfg = {};
  }
  if (!vt || vt.base_type !== 'sales' || !isPosType(cfg)) issues.push({ path: 'draft.voucherTypeId', message: 'A held bill belongs to a POS voucher type.' });
  if (d.partyLedgerId !== undefined && db.value('SELECT 1 FROM ledgers WHERE id = :id', { id: d.partyLedgerId }) === undefined) {
    issues.push({ path: 'draft.partyLedgerId', message: 'The customer no longer exists.' });
  }
  const ids = [...new Set(d.lines.map((l) => l.itemId))];
  if (ids.length > 0) {
    const found = new Set(db.all<{ id: number }>('SELECT id FROM stock_items WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(ids) }).map((r) => r.id));
    d.lines.forEach((l, i) => {
      if (!found.has(l.itemId)) issues.push({ path: `draft.lines[${i}].itemId`, message: 'This stock item no longer exists.' });
    });
  }
  if (issues.length > 0) throw validation(issues);
}

export function holdBill(ctx: CompanyCtx, input: PosHeldBillSaveInput): PosHeldBill {
  const { db } = ctx;
  assertPosEnabled(db);
  const d = input.draft;
  if (d.lines.length === 0) throw rule('There is nothing to hold: the bill has no items.');
  checkDraft(db, d);
  const existing = input.id !== undefined ? getRow(db, input.id) : null;
  if (!existing) {
    const count = db.value<number>('SELECT COUNT(*) FROM pos_held_bills') ?? 0;
    if (count >= MAX_HELD_BILLS) throw rule(`${MAX_HELD_BILLS} bills are already on hold. Bill or discard some of them first.`);
  }
  const now = ctx.clock.now().toISOString();
  const customer = (d.customerName ?? '').trim() || null;
  const items = d.lines.length;
  const label = (input.label ?? '').trim() || `${customer ?? 'Walk-in'} · ${items} item${items === 1 ? '' : 's'}`;
  const user = ctx.session.displayName || ctx.session.username || null;
  const params = { vt: d.voucherTypeId, label, customer, lines: items, total: input.total, draft: JSON.stringify(d), now };
  let id: number;
  if (existing) {
    id = existing.id;
    db.run(
      `UPDATE pos_held_bills SET voucher_type_id = :vt, label = :label, customer_name = :customer, line_count = :lines, total = :total, draft = :draft, updated_at = :now WHERE id = :id`,
      { ...params, id },
    );
  } else {
    id = db.run(
      `INSERT INTO pos_held_bills (guid, voucher_type_id, label, customer_name, line_count, total, draft, created_by, created_by_name, created_at, updated_at)
       VALUES (:guid, :vt, :label, :customer, :lines, :total, :draft, :by, :byName, :now, :now)`,
      { ...params, guid: randomUUID(), by: ctx.session.userId, byName: user },
    ).lastInsertRowid;
  }
  const row = getRow(db, id);
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'pos_held_bill',
    entityId: id,
    entityGuid: row.guid,
    entityLabel: `Held bill: ${label}`,
    before: existing ? { label: existing.label, lines: existing.line_count, total: existing.total } : undefined,
    after: { label, customer, lines: items, total: input.total },
  });
  return toHeld(row);
}

/** Recall: hand the bill back to the counter and remove it from the hold list. */
export function recallHeldBill(ctx: CompanyCtx, id: number): PosHeldBill {
  const { db } = ctx;
  assertPosEnabled(db);
  const row = getRow(db, id);
  db.run('DELETE FROM pos_held_bills WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'pos_held_bill', entityId: id, entityGuid: row.guid, entityLabel: `Held bill: ${row.label} (recalled)`, before: { label: row.label, lines: row.line_count, total: row.total } });
  return toHeld(row);
}

export function discardHeldBill(ctx: CompanyCtx, id: number): { id: number } {
  const { db } = ctx;
  assertPosEnabled(db);
  const row = getRow(db, id);
  db.run('DELETE FROM pos_held_bills WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'pos_held_bill', entityId: id, entityGuid: row.guid, entityLabel: `Held bill: ${row.label} (discarded)`, before: { label: row.label, lines: row.line_count, total: row.total } });
  return { id };
}
