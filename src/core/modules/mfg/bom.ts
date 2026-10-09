/**
 * Bill of Materials master: several named BOMs per finished item (one default), components,
 * by-products and scrap per the BOM's output quantity, alteration history (a JSON snapshot of every
 * saved revision in bom_revisions, plus the edit log) and a cost estimate at current costs.
 */
import { randomUUID } from 'node:crypto';
import { explodeBom } from '../../../shared/mfg/bom.ts';
import { roundPaise, roundTo } from '../../../shared/money.ts';
import type {
  BomCostLine,
  BomCostResult,
  BomDetail,
  BomLineInput,
  BomLineView,
  BomListInput,
  BomListRow,
  BomRevisionRow,
  BomSaveInput,
} from '../../../shared/types/mfg.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { conflict, notFound, rule, validation } from '../../lib/errors.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import { estimateIssueCosts } from '../inventory/valuation.ts';
import { cleanText, likePattern, paging, requirePermission, requireSavePermission, toBool } from '../inventory/common.ts';

const MAX_QTY = 1e12;

interface BomRow {
  id: number;
  guid: string;
  item_id: number;
  item_name: string;
  unit: string;
  unit_decimals: number;
  name: string;
  output_qty: number;
  is_default: number;
  is_active: number;
  revision: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BOM = /* sql */ `
  SELECT b.*, i.name AS item_name, u.symbol AS unit, u.decimal_places AS unit_decimals
    FROM boms b JOIN stock_items i ON i.id = b.item_id JOIN units u ON u.id = i.unit_id`;

function lineViews(db: Db, bomId: number): BomLineView[] {
  return db
    .all<{
      line_no: number;
      kind: BomLineView['kind'];
      item_id: number;
      item_name: string;
      unit: string;
      unit_decimals: number;
      qty: number;
      godown_id: number | null;
      godown_name: string | null;
      value_basis: BomLineView['valueBasis'];
      value_rate: number | null;
      value_pct: number | null;
      notes: string | null;
    }>(
      `SELECT l.line_no, l.kind, l.item_id, i.name AS item_name, u.symbol AS unit, u.decimal_places AS unit_decimals, l.qty,
              l.godown_id, g.name AS godown_name, l.value_basis, l.value_rate, l.value_pct, l.notes
         FROM bom_lines l JOIN stock_items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id
         LEFT JOIN godowns g ON g.id = l.godown_id
        WHERE l.bom_id = :bomId ORDER BY l.line_no`,
      { bomId },
    )
    .map((r) => ({
      lineNo: r.line_no,
      kind: r.kind,
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      unitDecimals: r.unit_decimals,
      qty: r.qty,
      godownId: r.godown_id,
      godownName: r.godown_name,
      valueBasis: r.value_basis,
      valueRate: r.value_rate,
      valuePct: r.value_pct,
      notes: r.notes,
    }));
}

function toDetail(db: Db, r: BomRow): BomDetail {
  return {
    id: r.id,
    guid: r.guid,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    unitDecimals: r.unit_decimals,
    name: r.name,
    outputQty: r.output_qty,
    isDefault: toBool(r.is_default),
    isActive: toBool(r.is_active),
    revision: r.revision,
    notes: r.notes,
    lines: lineViews(db, r.id),
    usedInVouchers: Number(db.value('SELECT COUNT(*) FROM stock_journal_details WHERE bom_id = :id', { id: r.id }) ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getBom(db: Db, id: number): BomDetail {
  const r = db.get<BomRow>(`${SELECT_BOM} WHERE b.id = :id`, { id });
  if (!r) throw notFound('Bill of materials', id);
  return toDetail(db, r);
}

/** The item's default active BOM (else its only active one), or null. */
export function defaultBomId(db: Db, itemId: number): number | null {
  return (
    db.value<number>('SELECT id FROM boms WHERE item_id = :itemId AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1', { itemId }) ?? null
  );
}

export function listBoms(db: Db, input: BomListInput = {}): { rows: BomListRow[]; total: number } {
  const { limit, offset } = paging(input, 500, 5000);
  const like = likePattern(input.search);
  // Constant condition fragments chosen by which filters are present; every value is bound.
  const conds: string[] = [];
  const params: Record<string, string | number> = {};
  if (input.itemId !== undefined) {
    conds.push('b.item_id = :itemId');
    params.itemId = input.itemId;
  }
  if (like !== null) {
    conds.push(`(b.name LIKE :like ESCAPE '\\' OR i.name LIKE :like ESCAPE '\\')`);
    params.like = like;
  }
  if (input.includeInactive !== true) conds.push('b.is_active = 1');
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const total = Number(db.value(`SELECT COUNT(*) FROM boms b JOIN stock_items i ON i.id = b.item_id ${where}`, params) ?? 0);
  const rows = db
    .all<BomRow & { components: number; by_products: number }>(
      `SELECT b.*, i.name AS item_name, u.symbol AS unit, u.decimal_places AS unit_decimals,
              (SELECT COUNT(*) FROM bom_lines l WHERE l.bom_id = b.id AND l.kind = 'component') AS components,
              (SELECT COUNT(*) FROM bom_lines l WHERE l.bom_id = b.id AND l.kind <> 'component') AS by_products
         FROM boms b JOIN stock_items i ON i.id = b.item_id JOIN units u ON u.id = i.unit_id
        ${where}
        ORDER BY i.name COLLATE NOCASE, b.is_default DESC, b.name COLLATE NOCASE
        LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset },
    )
    .map((r) => ({
      id: r.id,
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      name: r.name,
      outputQty: r.output_qty,
      isDefault: toBool(r.is_default),
      isActive: toBool(r.is_active),
      revision: r.revision,
      components: Number(r.components),
      byProducts: Number(r.by_products),
      updatedAt: r.updated_at,
    }));
  return { rows, total };
}

export function bomRevisions(db: Db, id: number): BomRevisionRow[] {
  if (db.value('SELECT 1 FROM boms WHERE id = :id', { id }) === undefined) throw notFound('Bill of materials', id);
  return db
    .all<{ revision: number; changed_at: string; changed_by_name: string | null; snapshot: string }>(
      'SELECT revision, changed_at, changed_by_name, snapshot FROM bom_revisions WHERE bom_id = :id ORDER BY revision DESC',
      { id },
    )
    .map((r) => ({ revision: r.revision, changedAt: r.changed_at, changedByName: r.changed_by_name, snapshot: JSON.parse(r.snapshot) as BomDetail }));
}

// ───────────────────────────── Save ─────────────────────────────

interface ItemInfo {
  id: number;
  name: string;
  is_service: number;
}

/** Items reachable from `start` through the components of their BOMs (any BOM, active or not). */
function componentClosure(db: Db, start: readonly number[]): Set<number> {
  const seen = new Set<number>(start);
  let frontier = [...start];
  while (frontier.length > 0) {
    const next = db.all<{ item_id: number }>(
      `SELECT DISTINCT l.item_id FROM bom_lines l JOIN boms b ON b.id = l.bom_id
        WHERE l.kind = 'component' AND b.item_id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify(frontier) },
    );
    frontier = [];
    for (const r of next) {
      if (!seen.has(r.item_id)) {
        seen.add(r.item_id);
        frontier.push(r.item_id);
      }
    }
  }
  return seen;
}

function checkLines(db: Db, itemId: number, lines: readonly BomLineInput[], issues: FieldIssue[]): void {
  if (!lines.some((l) => l.kind === 'component')) issues.push({ path: 'lines', message: 'Enter at least one component (the material consumed to make the item).' });
  const seen = new Set<string>();
  let pctTotal = 0;
  lines.forEach((l, i) => {
    const p = `lines[${i}]`;
    const it = db.get<ItemInfo>('SELECT id, name, is_service FROM stock_items WHERE id = :id', { id: l.itemId });
    if (!it) {
      issues.push({ path: `${p}.itemId`, message: 'This stock item no longer exists. Select it again.' });
      return;
    }
    if (it.is_service === 1) issues.push({ path: `${p}.itemId`, message: `${it.name} is a service item; a bill of materials lists goods only.` });
    if (l.itemId === itemId) issues.push({ path: `${p}.itemId`, message: `${it.name} is the item being made; it cannot also be a ${l.kind.replace('_', '-')} of itself.` });
    if (!(l.qty > 0) || l.qty > MAX_QTY) issues.push({ path: `${p}.qty`, message: `Enter a quantity of ${it.name} greater than zero.` });
    if (l.godownId !== undefined && l.godownId !== null && db.value('SELECT 1 FROM godowns WHERE id = :id', { id: l.godownId }) === undefined) {
      issues.push({ path: `${p}.godownId`, message: 'The selected godown no longer exists.' });
    }
    const key = `${l.kind}|${l.itemId}|${l.godownId ?? ''}`;
    if (seen.has(key)) issues.push({ path: `${p}.itemId`, message: `${it.name} is listed twice as a ${l.kind.replace('_', '-')}; combine the quantities in one line.` });
    seen.add(key);
    if (l.kind === 'component') {
      if (l.valueBasis && l.valueBasis !== 'nil') issues.push({ path: `${p}.valueBasis`, message: 'Components are valued at their cost; a value applies to by-products and scrap only.' });
      return;
    }
    const basis = l.valueBasis ?? 'nil';
    if (basis === 'rate' && !(typeof l.valueRate === 'number' && l.valueRate >= 0)) {
      issues.push({ path: `${p}.valueRate`, message: `Enter the rate per unit at which ${it.name} is valued.` });
    }
    if (basis === 'percent') {
      if (!(typeof l.valuePct === 'number' && l.valuePct > 0 && l.valuePct <= 100)) {
        issues.push({ path: `${p}.valuePct`, message: `Enter the share of the production cost (above 0% and up to 100%) carried by ${it.name}.` });
      } else pctTotal += l.valuePct;
    }
  });
  if (pctTotal > 100) issues.push({ path: 'lines', message: `By-products and scrap take ${roundTo(pctTotal, 2)}% of the production cost; the total cannot exceed 100%.` });
  if (issues.length > 0) return;
  // A component that is itself made (directly or further down) from this item would be circular.
  const components = lines.filter((l) => l.kind === 'component').map((l) => l.itemId);
  if (componentClosure(db, components).has(itemId)) {
    issues.push({ path: 'lines', message: 'One of the components is itself made from this item (directly or through its own BOM). Remove the circular component.' });
  }
}

function snapshotFor(detail: BomDetail): BomDetail {
  return { ...detail, usedInVouchers: 0 };
}

export function saveBom(ctx: CompanyCtx, input: BomSaveInput): BomDetail {
  requireSavePermission(ctx, input.id, 'bills of materials');
  const { db } = ctx;
  const before = input.id !== undefined ? getBom(db, input.id) : null;
  if (before && input.expectedUpdatedAt && input.expectedUpdatedAt !== before.updatedAt) {
    throw conflict('This bill of materials was changed by someone else after you opened it. Reopen it to see the latest version.');
  }
  const issues: FieldIssue[] = [];
  const item = db.get<ItemInfo>('SELECT id, name, is_service FROM stock_items WHERE id = :id', { id: input.itemId });
  if (!item) issues.push({ path: 'itemId', message: 'Select the item this bill of materials makes.' });
  else if (item.is_service === 1) issues.push({ path: 'itemId', message: `${item.name} is a service item; only goods can have a bill of materials.` });
  if (before && before.itemId !== input.itemId) issues.push({ path: 'itemId', message: 'The item of a saved bill of materials cannot be changed. Create a new one for the other item.' });
  const name = (cleanText(input.name) ?? '').slice(0, 100);
  if (!name) issues.push({ path: 'name', message: 'Enter a name for the bill of materials (e.g. Standard).' });
  if (!(input.outputQty > 0) || input.outputQty > MAX_QTY) issues.push({ path: 'outputQty', message: 'Enter the quantity of the item these components make (greater than zero).' });
  if (name && item) {
    const clash = db.value<number>('SELECT id FROM boms WHERE item_id = :itemId AND name = :name COLLATE NOCASE AND id IS NOT :id', {
      itemId: input.itemId,
      name,
      id: input.id ?? null,
    });
    if (clash !== undefined) issues.push({ path: 'name', message: `${item.name} already has a bill of materials named '${name}'. Choose a different name.` });
  }
  if (item) checkLines(db, input.itemId, input.lines, issues);
  if (issues.length > 0) throw validation(issues);

  const ts = ctx.clock.now().toISOString();
  const isActive = input.isActive ?? before?.isActive ?? true;
  const firstOfItem = Number(db.value('SELECT COUNT(*) FROM boms WHERE item_id = :itemId AND id IS NOT :id AND is_active = 1', { itemId: input.itemId, id: input.id ?? null }) ?? 0) === 0;
  const isDefault = isActive && (input.isDefault ?? before?.isDefault ?? firstOfItem);
  const notes = cleanText(input.notes) ?? null;
  let id: number;
  if (before) {
    id = before.id;
    db.run(
      `UPDATE boms SET name = :name, output_qty = :outputQty, is_default = :isDefault, is_active = :isActive, notes = :notes,
              revision = revision + 1, updated_at = :ts WHERE id = :id`,
      { id, name, outputQty: input.outputQty, isDefault, isActive, notes, ts },
    );
    db.run('DELETE FROM bom_lines WHERE bom_id = :id', { id });
  } else {
    id = db.run(
      `INSERT INTO boms (guid, item_id, name, output_qty, is_default, is_active, revision, notes, created_at, updated_at)
       VALUES (:guid, :itemId, :name, :outputQty, :isDefault, :isActive, 1, :notes, :ts, :ts)`,
      { guid: randomUUID(), itemId: input.itemId, name, outputQty: input.outputQty, isDefault, isActive, notes, ts },
    ).lastInsertRowid;
  }
  if (isDefault) db.run('UPDATE boms SET is_default = 0 WHERE item_id = :itemId AND id <> :id', { itemId: input.itemId, id });
  input.lines.forEach((l, i) => {
    const byProduct = l.kind !== 'component';
    const basis = byProduct ? (l.valueBasis ?? 'nil') : null;
    db.run(
      `INSERT INTO bom_lines (bom_id, line_no, kind, item_id, qty, godown_id, value_basis, value_rate, value_pct, notes)
       VALUES (:id, :lineNo, :kind, :itemId, :qty, :godownId, :basis, :rate, :pct, :notes)`,
      {
        id,
        lineNo: i + 1,
        kind: l.kind,
        itemId: l.itemId,
        qty: l.qty,
        godownId: l.godownId ?? null,
        basis,
        rate: basis === 'rate' ? (l.valueRate ?? 0) : null,
        pct: basis === 'percent' ? (l.valuePct ?? 0) : null,
        notes: cleanText(l.notes) ?? null,
      },
    );
  });
  const after = getBom(db, id);
  db.run(
    `INSERT INTO bom_revisions (bom_id, revision, snapshot, changed_at, changed_by, changed_by_name)
     VALUES (:id, :revision, :snapshot, :ts, :userId, :userName)`,
    {
      id,
      revision: after.revision,
      snapshot: JSON.stringify(snapshotFor(after)),
      ts,
      userId: ctx.session.userId,
      userName: ctx.session.displayName || ctx.session.username || null,
    },
  );
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'bom',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: `${after.itemName} — ${after.name}`,
    before: before ? snapshotFor(before) : undefined,
    after: snapshotFor(after),
  });
  return after;
}

export function deleteBom(ctx: CompanyCtx, id: number): { id: number; deleted: true } {
  requirePermission(ctx, 'masters.delete', 'delete bills of materials');
  const { db } = ctx;
  const before = getBom(db, id);
  const orders = Number(db.value('SELECT COUNT(*) FROM job_work_orders WHERE bom_id = :id', { id }) ?? 0);
  if (before.usedInVouchers > 0 || orders > 0) {
    const parts = [
      before.usedInVouchers > 0 ? `${before.usedInVouchers} voucher(s)` : '',
      orders > 0 ? `${orders} job work order(s)` : '',
    ].filter(Boolean);
    throw rule(`Bill of materials '${before.name}' of ${before.itemName} is used in ${parts.join(' and ')}. Mark it inactive instead (Alter → Active: No).`);
  }
  db.run('DELETE FROM boms WHERE id = :id', { id });
  if (before.isDefault) {
    const next = defaultBomId(db, before.itemId);
    if (next !== null) db.run('UPDATE boms SET is_default = 1 WHERE id = :id', { id: next });
  }
  ctx.audit({ action: 'delete', entityType: 'bom', entityId: id, entityGuid: before.guid, entityLabel: `${before.itemName} — ${before.name}`, before: snapshotFor(before) });
  return { id, deleted: true };
}

// ───────────────────────────── Cost estimate ─────────────────────────────

/**
 * What making `qty` (default: the BOM's output quantity) would cost as at the end of `asOf`: each
 * component issued at its item's costing method (FIFO layers, average …) from the stock at that point,
 * minus by-products / scrap at their value basis — the same rule the Manufacturing Journal uses.
 */
export function bomCost(db: Db, today: string, input: { id: number; qty?: number; asOf: string }): BomCostResult {
  const bom = getBom(db, input.id);
  const qty = input.qty && input.qty > 0 ? input.qty : bom.outputQty;
  const exploded = explodeBom(bom.lines, bom.outputQty, qty);
  const comps = exploded.filter((e) => e.line.kind === 'component');
  const costs = estimateIssueCosts(db, { asOf: input.asOf, today, lines: comps.map((e) => ({ itemId: e.line.itemId, qty: e.qty, godownId: e.line.godownId })) });
  const componentCost = costs.reduce((s, c) => s + c, 0);
  const lines: BomCostLine[] = [];
  let byProductValue = 0;
  let k = 0;
  for (const e of exploded) {
    const l = e.line;
    let value: number;
    if (l.kind === 'component') value = costs[k++];
    else if (l.valueBasis === 'rate') value = roundPaise(e.qty * (l.valueRate ?? 0) * 100);
    else if (l.valueBasis === 'percent') value = roundPaise((componentCost * (l.valuePct ?? 0)) / 100);
    else value = 0;
    if (l.kind !== 'component') byProductValue += value;
    lines.push({ lineNo: l.lineNo, kind: l.kind, itemId: l.itemId, itemName: l.itemName, unit: l.unit, qty: e.qty, rate: e.qty > 0 ? roundTo(value / e.qty / 100, 4) : 0, value });
  }
  const estimatedCost = Math.max(0, componentCost - byProductValue);
  const std = db.value<number | null>('SELECT standard_cost FROM stock_items WHERE id = :id', { id: bom.itemId }) ?? null;
  return {
    bomId: bom.id,
    itemId: bom.itemId,
    qty,
    asOf: input.asOf,
    lines,
    componentCost,
    byProductValue,
    estimatedCost,
    unitCost: qty > 0 ? roundTo(estimatedCost / qty / 100, 4) : 0,
    standardCost: std === null ? null : roundTo(Number(std) / 100, 4),
  };
}
