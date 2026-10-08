/**
 * Exception reports: Negative Stock (items or godowns below zero) and Batch Summary (balances with
 * expiry status, First-Expiry-First-Out order).
 */
import { diffDays } from '../../../shared/dates.ts';
import type {
  BatchRow,
  BatchStatus,
  BatchSummaryInput,
  BatchSummaryResult,
  NegativeGodownRow,
  NegativeStockInput,
  NegativeStockResult,
  NegativeStockRow,
} from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { batchesFor, computeStockValuation, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';
import { booksBegin, EPS, getItemMeta, loadItems, loadTree, mainGodown, roundQty } from './common.ts';

interface Run {
  qty: number;
  since: string | null;
}

/** Running balance per key over dated changes (ascending); `since` = first day of the current negative run. */
function runBalance(changes: Array<{ date: string; qty: number }>): Run {
  let qty = 0;
  let since: string | null = null;
  for (const c of changes) {
    qty = roundQty(qty + c.qty);
    if (qty < -EPS) {
      if (since === null) since = c.date;
    } else {
      since = null;
    }
  }
  return { qty, since };
}

/** 'stock.negative' — items whose stock is below zero as of a date, in total or in any godown. */
export function negativeStock(db: Db, today: string, input: NegativeStockInput): NegativeStockResult {
  const asOf = input.asOf;
  const begin = booksBegin(db);
  // Daily net change per item + godown (opening stock dated at the books beginning).
  const rows = db.all<{ item_id: number; godown_id: number | null; date: string; qty: number }>(
    `SELECT item_id, godown_id, date, SUM(qty) AS qty FROM (
       SELECT item_id, godown_id, :begin AS date, qty FROM stock_openings
       UNION ALL
       SELECT ie.item_id, COALESCE(ie.godown_id, :main) AS godown_id, ie.date, ie.qty
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
     ) GROUP BY item_id, godown_id, date ORDER BY item_id, date`,
    { asOf, today, begin, main: mainGodown(db) },
  );
  const perItem = new Map<number, Array<{ date: string; qty: number }>>();
  const perGodown = new Map<number, Map<number, Array<{ date: string; qty: number }>>>();
  for (const r of rows) {
    const q = Number(r.qty);
    const daily = perItem.get(r.item_id) ?? [];
    const last = daily[daily.length - 1];
    if (last && last.date === r.date) last.qty += q;
    else daily.push({ date: r.date, qty: q });
    perItem.set(r.item_id, daily);
    if (r.godown_id === null) continue;
    const gm = perGodown.get(r.item_id) ?? new Map<number, Array<{ date: string; qty: number }>>();
    const gl = gm.get(r.godown_id) ?? [];
    gl.push({ date: r.date, qty: q });
    gm.set(r.godown_id, gl);
    perGodown.set(r.item_id, gm);
  }

  const items = loadItems(db);
  const groups = loadTree(db, 'group');
  const godownNames = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM godowns').map((g) => [g.id, g.name]));
  const found: NegativeStockRow[] = [];
  for (const [itemId, daily] of perItem) {
    const it = items.get(itemId);
    if (!it || it.isService) continue;
    const total = runBalance(daily);
    const gneg: NegativeGodownRow[] = [];
    for (const [gid, changes] of perGodown.get(itemId) ?? []) {
      const g = runBalance(changes);
      if (g.qty < -EPS) gneg.push({ godownId: gid, godownName: godownNames.get(gid) ?? '', qty: g.qty, negativeSince: g.since });
    }
    if (total.qty >= -EPS && gneg.length === 0) continue;
    gneg.sort((a, b) => a.qty - b.qty || a.godownName.localeCompare(b.godownName));
    found.push({
      itemId,
      name: it.name,
      unit: it.unit,
      groupName: it.groupId === null ? null : (groups.get(it.groupId)?.name ?? null),
      qty: total.qty,
      value: 0,
      negativeSince: total.qty < -EPS ? total.since : null,
      godowns: gneg,
    });
  }
  if (found.length > 0) {
    const val = computeStockValuation(db, { from: asOf, to: asOf, today, itemIds: found.map((f) => f.itemId) });
    const byId = new Map(val.rows.map((r) => [r.itemId, r.closing.value]));
    for (const f of found) f.value = byId.get(f.itemId) ?? 0;
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return { asOf, rows: found };
}

/** 'stock.batches' — batch balances (FEFO) with days to expiry and status. */
export function batchSummary(db: Db, today: string, input: BatchSummaryInput): BatchSummaryResult {
  const window = input.expiringWithinDays ?? 30;
  const items =
    input.itemId !== undefined
      ? [getItemMeta(db, input.itemId)]
      : [...loadItems(db).values()].filter((it) => !it.isService);
  // Items that keep batches, or that carry batch names on openings/entries (feature turned off later).
  const withBatches = new Set(
    db
      .all<{ item_id: number }>(
        `SELECT item_id FROM stock_openings WHERE batch_name IS NOT NULL AND batch_name <> ''
         UNION SELECT item_id FROM inventory_entries WHERE batch_name IS NOT NULL AND batch_name <> ''`,
      )
      .map((r) => r.item_id),
  );
  const rows: BatchRow[] = [];
  for (const it of items) {
    if (!it.maintainBatches && !withBatches.has(it.id)) continue;
    for (const b of batchesFor(db, it.id, null, input.asOf, { today })) {
      const days = b.expiryDate ? diffDays(input.asOf, b.expiryDate) : null;
      const status: BatchStatus = days === null ? 'no_expiry' : days < 0 ? 'expired' : days <= window ? 'expiring' : 'ok';
      if (input.expiringWithinDays !== undefined && status !== 'expired' && status !== 'expiring') continue;
      rows.push({
        key: `b:${it.id}:${b.batchName}`,
        itemId: it.id,
        itemName: it.name,
        unit: it.unit,
        batchName: b.batchName,
        mfgDate: b.mfgDate,
        expiryDate: b.expiryDate,
        qty: b.qty,
        daysToExpiry: days,
        status,
      });
    }
  }
  return { asOf: input.asOf, windowDays: window, rows };
}
