/**
 * Job Work Orders — planning documents (no stock, no books), like Tally's Job Work Out / In Orders.
 *   out  we give work to a job worker: the product to be made, the material to send, the due date;
 *   in   a principal gives work to us.
 * Material Out / In vouchers link to an order (`stockJournal.jobWorkOrderId`); the order shows what
 * has been sent / received and what is pending. Numbers run per direction (JWO-1, JWI-1 …) unless typed.
 */
import { randomUUID } from 'node:crypto';
import type { FieldIssue } from '../../../shared/api.ts';
import { explodeBom } from '../../../shared/mfg/bom.ts';
import { roundQty } from '../inventory/stock.ts';
import type {
  JobWorkDirection,
  JobWorkOrderDetail,
  JobWorkOrderLineView,
  JobWorkOrderListInput,
  JobWorkOrderListRow,
  JobWorkOrderSaveInput,
} from '../../../shared/types/mfg.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { conflict, forbidden, notFound, rule, validation } from '../../lib/errors.ts';
import { cleanText, likePattern, paging } from '../inventory/common.ts';
import { getBom } from './bom.ts';

const PREFIX: Readonly<Record<JobWorkDirection, string>> = { out: 'JWO-', in: 'JWI-' };

const can = (ctx: CompanyCtx, p: 'vouchers.create' | 'vouchers.alter' | 'vouchers.delete'): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

interface OrderRow {
  id: number;
  guid: string;
  direction: JobWorkDirection;
  number: string;
  number_seq: number | null;
  date: string;
  party_ledger_id: number;
  party_name: string;
  godown_id: number | null;
  godown_name: string | null;
  item_id: number | null;
  item_name: string | null;
  unit: string | null;
  qty: number | null;
  bom_id: number | null;
  bom_name: string | null;
  due_date: string | null;
  process: string | null;
  rate: number | null;
  status: 'open' | 'closed';
  narration: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ORDER = /* sql */ `
  SELECT o.*, l.name AS party_name, g.name AS godown_name, i.name AS item_name, u.symbol AS unit, b.name AS bom_name
    FROM job_work_orders o
    JOIN ledgers l ON l.id = o.party_ledger_id
    LEFT JOIN godowns g ON g.id = o.godown_id
    LEFT JOIN stock_items i ON i.id = o.item_id
    LEFT JOIN units u ON u.id = i.unit_id
    LEFT JOIN boms b ON b.id = o.bom_id`;

/** Linked vouchers that count (regular, not cancelled). */
const LINKED = `JOIN vouchers v ON v.id = d.voucher_id AND v.is_cancelled = 0 AND v.is_optional = 0`;

/**
 * Progress of orders by line role: `sent` = material reaching the job worker's / our third-party godown
 * (Material Out transfers, or principal's goods received), `back` = material consumed or returned there,
 * `done` = the product received (out) or sent back processed (in).
 */
function progress(db: Db, orderIds: readonly number[]): Map<number, { sent: Map<number, number>; back: Map<number, number>; done: number }> {
  const out = new Map<number, { sent: Map<number, number>; back: Map<number, number>; done: number }>();
  if (orderIds.length === 0) return out;
  for (const id of orderIds) out.set(id, { sent: new Map(), back: new Map(), done: 0 });
  const rows = db.all<{ order_id: number; cls: string; role: string; item_id: number; qty: number; product_item: number | null }>(
    `SELECT d.job_work_order_id AS order_id, d.class AS cls, l.role, ie.item_id, ABS(ie.qty) AS qty, o.item_id AS product_item
       FROM stock_journal_details d ${LINKED}
       JOIN job_work_orders o ON o.id = d.job_work_order_id
       JOIN stock_journal_lines l ON l.voucher_id = d.voucher_id
       JOIN inventory_entries ie ON ie.voucher_id = l.voucher_id AND ie.line_no = l.line_no
      WHERE d.job_work_order_id IN (SELECT value FROM json_each(:ids))`,
    { ids: JSON.stringify(orderIds) },
  );
  const add = (m: Map<number, number>, k: number, q: number): void => {
    m.set(k, roundQty((m.get(k) ?? 0) + q));
  };
  for (const r of rows) {
    const p = out.get(r.order_id);
    if (!p) continue;
    // Principal: Material Out sends (transfer into the job worker's godown); Material In consumes the
    // components / takes material back and receives the product.
    if (r.cls === 'material_out' && r.role === 'transfer_in') add(p.sent, r.item_id, r.qty);
    if (r.cls === 'material_in' && (r.role === 'component' || r.role === 'transfer_out')) add(p.back, r.item_id, r.qty);
    if (r.cls === 'material_in' && r.role === 'product') p.done = roundQty(p.done + r.qty);
    // Job worker: Material In receives the principal's goods; Material Out sends them back (processed).
    if (r.cls === 'material_in' && r.role === 'receipt') add(p.sent, r.item_id, r.qty);
    if (r.cls === 'material_out' && r.role === 'issue') {
      add(p.back, r.item_id, r.qty);
      if (r.item_id === r.product_item) p.done = roundQty(p.done + r.qty);
    }
  }
  return out;
}

export function getJobWorkOrder(db: Db, id: number): JobWorkOrderDetail {
  const r = db.get<OrderRow>(`${SELECT_ORDER} WHERE o.id = :id`, { id });
  if (!r) throw notFound('Job work order', id);
  const pr = progress(db, [id]).get(id) ?? { sent: new Map(), back: new Map(), done: 0 };
  const lines: JobWorkOrderLineView[] = db
    .all<{ line_no: number; item_id: number; item_name: string; unit: string; qty: number; goods_type: JobWorkOrderLineView['goodsType'] }>(
      `SELECT l.line_no, l.item_id, i.name AS item_name, u.symbol AS unit, l.qty, l.goods_type
         FROM job_work_order_lines l JOIN stock_items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id
        WHERE l.order_id = :id ORDER BY l.line_no`,
      { id },
    )
    .map((l) => ({
      lineNo: l.line_no,
      itemId: l.item_id,
      itemName: l.item_name,
      unit: l.unit,
      qty: l.qty,
      goodsType: l.goods_type,
      sentQty: pr.sent.get(l.item_id) ?? 0,
      returnedQty: pr.back.get(l.item_id) ?? 0,
    }));
  const vouchers = db.all<{ id: number; date: string; number: string | null; type_name: string }>(
    `SELECT v.id, v.date, v.number, vt.name AS type_name
       FROM stock_journal_details d ${LINKED} JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE d.job_work_order_id = :id ORDER BY v.date, v.id`,
    { id },
  );
  return {
    id: r.id,
    guid: r.guid,
    direction: r.direction,
    number: r.number,
    date: r.date,
    partyLedgerId: r.party_ledger_id,
    partyName: r.party_name,
    godownId: r.godown_id,
    godownName: r.godown_name,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    qty: r.qty,
    bomId: r.bom_id,
    bomName: r.bom_name,
    dueDate: r.due_date,
    process: r.process,
    rate: r.rate,
    status: r.status,
    narration: r.narration,
    lines,
    productDoneQty: pr.done,
    vouchers: vouchers.map((v) => ({ id: v.id, date: v.date, number: v.number, typeName: v.type_name })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listJobWorkOrders(db: Db, today: string, input: JobWorkOrderListInput = {}): { rows: JobWorkOrderListRow[]; total: number } {
  const { limit, offset } = paging(input, 200, 2000);
  const conds: string[] = [];
  const params: Record<string, string | number> = {};
  if (input.direction) {
    conds.push('o.direction = :direction');
    params.direction = input.direction;
  }
  if (input.partyLedgerId !== undefined) {
    conds.push('o.party_ledger_id = :party');
    params.party = input.partyLedgerId;
  }
  const status = input.status ?? 'open';
  if (status !== 'all') {
    conds.push('o.status = :status');
    params.status = status;
  }
  const like = likePattern(input.search);
  if (like !== null) {
    conds.push(`(o.number LIKE :like ESCAPE '\\' OR l.name LIKE :like ESCAPE '\\' OR i.name LIKE :like ESCAPE '\\')`);
    params.like = like;
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = Number(
    db.value(`SELECT COUNT(*) FROM job_work_orders o JOIN ledgers l ON l.id = o.party_ledger_id LEFT JOIN stock_items i ON i.id = o.item_id ${where}`, params) ?? 0,
  );
  const rows = db.all<OrderRow>(`${SELECT_ORDER} ${where} ORDER BY o.date DESC, o.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  const pr = progress(db, rows.map((r) => r.id));
  return {
    total,
    rows: rows.map((r) => {
      const done = pr.get(r.id)?.done ?? 0;
      const pending = r.qty === null ? null : roundQty(Math.max(0, r.qty - done));
      return {
        id: r.id,
        direction: r.direction,
        number: r.number,
        date: r.date,
        partyName: r.party_name,
        itemName: r.item_name,
        unit: r.unit,
        qty: r.qty,
        productDoneQty: done,
        pendingQty: pending,
        dueDate: r.due_date,
        status: r.status,
        overdue: r.status === 'open' && r.due_date !== null && r.due_date < today && (pending === null || pending > 0),
      };
    }),
  };
}

export function nextJobWorkOrderNumber(db: Db, direction: JobWorkDirection): string {
  const seq = Number(db.value('SELECT COALESCE(MAX(number_seq), 0) FROM job_work_orders WHERE direction = :direction', { direction }) ?? 0) + 1;
  return `${PREFIX[direction]}${seq}`;
}

export function saveJobWorkOrder(ctx: CompanyCtx, input: JobWorkOrderSaveInput): JobWorkOrderDetail {
  const { db } = ctx;
  const before = input.id !== undefined ? getJobWorkOrder(db, input.id) : null;
  if (before ? !can(ctx, 'vouchers.alter') : !can(ctx, 'vouchers.create')) {
    throw forbidden(`You do not have permission to ${before ? 'alter' : 'create'} job work orders.`);
  }
  if (before && input.expectedUpdatedAt && input.expectedUpdatedAt !== before.updatedAt) {
    throw conflict('This job work order was changed by someone else after you opened it. Reopen it to see the latest version.');
  }
  if (before && before.direction !== input.direction) throw validation([{ path: 'direction', message: 'The kind of a saved job work order cannot change.' }]);
  const issues: FieldIssue[] = [];
  const party = db.get<{ name: string }>('SELECT name FROM ledgers WHERE id = :id', { id: input.partyLedgerId });
  if (!party) issues.push({ path: 'partyLedgerId', message: `Select the ${input.direction === 'out' ? 'job worker' : 'principal'}.` });
  const godownId = input.godownId ?? null;
  if (godownId !== null) {
    const g = db.get<{ name: string; kind: string }>('SELECT name, third_party_kind AS kind FROM godowns WHERE id = :id', { id: godownId });
    const want = input.direction === 'out' ? 'ours_with_party' : 'party_with_us';
    if (!g) issues.push({ path: 'godownId', message: 'The selected godown no longer exists.' });
    else if (g.kind !== want) {
      issues.push({
        path: 'godownId',
        message: `${g.name} is not marked "${input.direction === 'out' ? 'Our stock with third party' : 'Third-party stock with us'}". Choose the ${input.direction === 'out' ? "job worker's" : "principal's"} godown, or change it in the godown master.`,
      });
    }
  }
  const itemId = input.itemId ?? null;
  const qty = input.qty ?? null;
  if (itemId !== null && db.value('SELECT 1 FROM stock_items WHERE id = :id', { id: itemId }) === undefined) issues.push({ path: 'itemId', message: 'The selected item no longer exists.' });
  if (itemId !== null && !(qty !== null && qty > 0)) issues.push({ path: 'qty', message: 'Enter the quantity to be made.' });
  const bomId = input.bomId ?? null;
  let bom: ReturnType<typeof getBom> | null = null;
  if (bomId !== null) {
    bom = db.value('SELECT 1 FROM boms WHERE id = :id', { id: bomId }) === undefined ? null : getBom(db, bomId);
    if (!bom) issues.push({ path: 'bomId', message: 'The selected bill of materials no longer exists.' });
    else if (bom.itemId !== itemId) issues.push({ path: 'bomId', message: `Bill of materials '${bom.name}' is for ${bom.itemName}, not the item ordered.` });
  }
  if (input.dueDate && input.dueDate < input.date) issues.push({ path: 'dueDate', message: 'The due date is before the order date.' });
  input.lines.forEach((l, i) => {
    if (db.value('SELECT 1 FROM stock_items WHERE id = :id', { id: l.itemId }) === undefined) issues.push({ path: `lines[${i}].itemId`, message: 'This item no longer exists.' });
    if (!(l.qty > 0)) issues.push({ path: `lines[${i}].qty`, message: 'Enter the quantity.' });
  });
  let number = cleanText(input.number) ?? null;
  if (number !== null) {
    const clash = db.value('SELECT 1 FROM job_work_orders WHERE direction = :direction AND number = :number COLLATE NOCASE AND id IS NOT :id', {
      direction: input.direction,
      number,
      id: input.id ?? null,
    });
    if (clash !== undefined) issues.push({ path: 'number', message: `Job work order ${number} already exists. Leave the number blank for the next one.` });
  }
  if (issues.length > 0) throw validation(issues);

  // Material to send: as entered, else the BOM's components for the quantity ordered.
  let lines = input.lines;
  if (lines.length === 0 && bom && qty !== null) {
    lines = explodeBom(bom.lines.filter((l) => l.kind === 'component'), bom.outputQty, qty).map((e) => ({ itemId: e.line.itemId, qty: e.qty, goodsType: 'inputs' as const }));
  }
  if (lines.length === 0 && itemId === null) throw validation([{ path: 'lines', message: 'Enter the product to be made or the material to be sent.' }]);

  const ts = ctx.clock.now().toISOString();
  let seq: number | null = before ? Number(db.value<number | null>('SELECT number_seq FROM job_work_orders WHERE id = :id', { id: before.id }) ?? null) || null : null;
  if (number === null) {
    if (before) number = before.number;
    else {
      number = nextJobWorkOrderNumber(db, input.direction);
      seq = Number(number.slice(PREFIX[input.direction].length));
    }
  } else if (!before || number !== before.number) {
    const m = new RegExp(`^${PREFIX[input.direction]}(\\d+)$`, 'i').exec(number);
    seq = m ? Number(m[1]) : null;
  }
  const params = {
    direction: input.direction,
    number,
    seq,
    date: input.date,
    party: input.partyLedgerId,
    godownId,
    itemId,
    qty,
    bomId,
    due: input.dueDate ?? null,
    process: cleanText(input.process) ?? null,
    rate: input.rate ?? null,
    status: input.status ?? before?.status ?? 'open',
    narration: cleanText(input.narration) ?? null,
    ts,
  };
  let id: number;
  if (before) {
    id = before.id;
    db.run(
      `UPDATE job_work_orders SET number = :number, number_seq = :seq, date = :date, party_ledger_id = :party, godown_id = :godownId,
              item_id = :itemId, qty = :qty, bom_id = :bomId, due_date = :due, process = :process, rate = :rate, status = :status,
              narration = :narration, updated_at = :ts WHERE id = :id`,
      { ...params, id },
    );
    db.run('DELETE FROM job_work_order_lines WHERE order_id = :id', { id });
  } else {
    id = db.run(
      `INSERT INTO job_work_orders (guid, direction, number, number_seq, date, party_ledger_id, godown_id, item_id, qty, bom_id, due_date,
              process, rate, status, narration, created_by, created_at, updated_at)
       VALUES (:guid, :direction, :number, :seq, :date, :party, :godownId, :itemId, :qty, :bomId, :due, :process, :rate, :status,
              :narration, :userId, :ts, :ts)`,
      { ...params, guid: randomUUID(), userId: ctx.session.userId },
    ).lastInsertRowid;
  }
  lines.forEach((l, i) => {
    db.run('INSERT INTO job_work_order_lines (order_id, line_no, item_id, qty, goods_type) VALUES (:id, :lineNo, :itemId, :qty, :goods)', {
      id,
      lineNo: i + 1,
      itemId: l.itemId,
      qty: l.qty,
      goods: l.goodsType ?? 'inputs',
    });
  });
  const after = getJobWorkOrder(db, id);
  const label = `Job Work ${after.direction === 'out' ? 'Out' : 'In'} Order ${after.number}`;
  const snap = (d: JobWorkOrderDetail): Record<string, unknown> => ({ ...d, vouchers: undefined, productDoneQty: undefined });
  ctx.audit({ action: before ? 'alter' : 'create', entityType: 'job_work_order', entityId: id, entityGuid: after.guid, entityLabel: label, before: before ? snap(before) : undefined, after: snap(after) });
  return after;
}

export function deleteJobWorkOrder(ctx: CompanyCtx, id: number): { id: number; deleted: true } {
  if (!can(ctx, 'vouchers.delete')) throw forbidden('You do not have permission to delete job work orders.');
  const { db } = ctx;
  const before = getJobWorkOrder(db, id);
  const linked = Number(db.value('SELECT COUNT(*) FROM stock_journal_details WHERE job_work_order_id = :id', { id }) ?? 0);
  if (linked > 0) throw rule(`Job work order ${before.number} is linked to ${linked} Material In / Out voucher(s). Close it instead, or remove the link from those vouchers first.`);
  db.run('DELETE FROM job_work_orders WHERE id = :id', { id });
  ctx.audit({
    action: 'delete',
    entityType: 'job_work_order',
    entityId: id,
    entityGuid: before.guid,
    entityLabel: `Job Work ${before.direction === 'out' ? 'Out' : 'In'} Order ${before.number}`,
    before: { ...before, vouchers: undefined },
  });
  return { id, deleted: true };
}
