/**
 * Item-wise gross profit and the Physical Stock variance register.
 *
 * Profitability, per item, for a period — cost is matched to what was INVOICED:
 *   sales      = taxable value of item lines on sales invoices in the books (incl. lines that bill a
 *                delivery note), quantity as billed;
 *   returns    = taxable value / quantity of item lines on credit notes in the books;
 *   cost (COGS)= for an invoice line that moved stock itself, its cost at the item's costing method
 *                (inventory engine; a credit note's goods come back at cost and reduce COGS); for a
 *                line that bills a delivery note (or a credit note against a rejection in), the note's
 *                cost per unit × the billed quantity, wherever the note is dated;
 *   gross profit = (sales − returns) − cost; GP % = gross profit ÷ net sales × 100.
 * Delivery notes not yet invoiced, stock journals, physical stock losses and purchase returns are
 * not cost of sales. When an item's only outwards in the period are its own sales invoices (no
 * notes billed, no returns, no other outward), its cost is the engine's period outward value in one
 * run; otherwise each line's cost comes from trace.ts.
 *
 * Physical variance: every line of the physical stock vouchers in the period (optional and
 * cancelled ones excluded): counted quantity (as entered), book quantity at the count (counted −
 * difference), the difference and its value at cost (+ gain, − loss).
 */
import { roundPaise, roundTo } from '../../../shared/money.ts';
import type { PhysicalVarianceInput, PhysicalVarianceResult, PhysicalVarianceRow, ProfitabilityInput, ProfitabilityResult, ProfitabilityRow } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { computeStockValuation } from '../inventory/index.ts';
import { assertPeriod, EPS, itemsInGroup, jsonIds, loadItems, loadMovements, loadTree, mainGodown, roundQty, type MovementRow } from './common.ts';
import { traceMovementValues } from './trace.ts';

export function gpPercent(gp: number, net: number): number | null {
  return net === 0 ? null : roundTo((gp / net) * 100, 2);
}

export function profitability(db: Db, today: string, input: ProfitabilityInput): ProfitabilityResult {
  assertPeriod(input.from, input.to);
  const scope = itemsInGroup(db, input.groupId);
  const items = loadItems(db);
  const groups = loadTree(db, 'group');

  // Invoice lines: sales and credit notes in the books, dated in the period.
  const lines = db.all<{
    id: number;
    item_id: number;
    base_type: string;
    party: number | null;
    tracking_ref: string | null;
    qty: number;
    billed_qty: number | null;
    amount: number;
    affects_stock: number;
    date: string;
  }>(
    `SELECT ie.id, ie.item_id, v.base_type, v.party_ledger_id AS party, ie.tracking_ref, ie.qty, ie.billed_qty, ie.amount,
            ie.affects_stock, ie.date
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.base_type IN ('sales', 'credit_note') AND v.affects_books = 1 AND (v.is_post_dated = 0 OR v.date <= :today)
        AND ie.date >= :from AND ie.date <= :to
        AND (:filter = 0 OR ie.item_id IN (SELECT value FROM json_each(:ids)))
      ORDER BY ie.date, ie.voucher_id, ie.line_no`,
    { today, from: input.from, to: input.to, filter: scope ? 1 : 0, ids: scope ? jsonIds(scope) : '[]' },
  );

  interface Acc {
    salesQty: number;
    salesValue: number;
    returnsQty: number;
    returnsValue: number;
    cost: number;
  }
  const accs = new Map<number, Acc>();
  const acc = (id: number): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = { salesQty: 0, salesValue: 0, returnsQty: 0, returnsValue: 0, cost: 0 };
      accs.set(id, a);
    }
    return a;
  };
  for (const l of lines) {
    const a = acc(l.item_id);
    const qty = Math.abs(Number(l.billed_qty ?? l.qty));
    if (l.base_type === 'sales') {
      a.salesQty += qty;
      a.salesValue += Number(l.amount);
    } else {
      a.returnsQty += qty;
      a.returnsValue += Number(l.amount);
    }
  }

  // Which invoice lines carry their own stock movement, and which bill a note (cost from the note).
  const moving = lines.filter((l) => l.affects_stock === 1 && Number(l.qty) !== 0);
  const tracked = lines.filter((l) => l.affects_stock === 0 && l.tracking_ref !== null && Number(l.qty) !== 0);
  const noteKey = (base: string, party: number | null, ref: string, item: number): string => `${base}|${party ?? 0}|${ref}|${item}`;
  const sources = new Map<string, MovementRow[]>();
  if (tracked.length > 0) {
    const noteRows = db.all<{ id: number; base_type: string; party: number | null; ref: string; item_id: number }>(
      `SELECT ie.id, v.base_type, v.party_ledger_id AS party, ie.tracking_ref AS ref, ie.item_id
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE v.base_type IN ('delivery_note', 'rejection_in') AND ie.tracking_ref IS NOT NULL AND ie.affects_stock = 1
          AND v.is_cancelled = 0 AND v.is_optional = 0 AND ie.item_id IN (SELECT value FROM json_each(:ids))`,
      { ids: jsonIds(new Set(tracked.map((l) => l.item_id))) },
    );
    const wanted = new Set(tracked.map((l) => noteKey(l.base_type === 'sales' ? 'delivery_note' : 'rejection_in', l.party, l.tracking_ref as string, l.item_id)));
    const ids = new Set<number>();
    for (const r of noteRows) if (wanted.has(noteKey(r.base_type, r.party, r.ref, r.item_id))) ids.add(r.id);
    if (ids.size > 0) {
      const byId = new Map(noteRows.map((r) => [r.id, r]));
      // The note's own movements (dated whenever the goods moved, possibly before the period).
      for (const m of loadMovements(db, { to: input.to, today, itemIds: new Set(tracked.map((l) => l.item_id)) })) {
        if (!ids.has(m.id)) continue;
        const r = byId.get(m.id) as (typeof noteRows)[number];
        const key = noteKey(r.base_type, r.party, r.ref, r.item_id);
        const list = sources.get(key) ?? [];
        list.push(m);
        sources.set(key, list);
      }
    }
  }

  // Cost: one engine run for items whose only outwards in the period are their own sales invoices
  // (nothing billed from notes, no returns, no other outward); the rest per movement (trace.ts).
  const periodMoves = scope && scope.size === 0 ? [] : loadMovements(db, { from: input.from, to: input.to, today, itemIds: scope });
  const complex = new Set<number>(tracked.map((l) => l.item_id));
  for (const m of periodMoves) if ((m.qty < 0 && m.baseType !== 'sales') || (m.qty > 0 && m.baseType === 'credit_note')) complex.add(m.itemId);
  const simple = [...new Set(moving.map((l) => l.item_id))].filter((id) => !complex.has(id));
  if (simple.length > 0) {
    const res = computeStockValuation(db, { from: input.from, to: input.to, today, itemIds: simple });
    for (const r of res.rows) acc(r.itemId).cost += r.outward.value;
  }
  const needIds = new Set<number>();
  const needDates = new Set<string>();
  let minDate = input.from;
  for (const l of moving) {
    if (!complex.has(l.item_id)) continue;
    needIds.add(l.id);
    needDates.add(l.date);
  }
  for (const list of sources.values()) {
    for (const m of list) {
      needIds.add(m.id);
      needDates.add(m.date);
      if (m.date < minDate) minDate = m.date;
    }
  }
  if (needIds.size > 0) {
    const tr = traceMovementValues(db, { itemIds: [...complex], from: minDate, to: input.to, today, onlyDates: needDates });
    for (const l of moving) {
      if (!complex.has(l.item_id)) continue;
      const v = tr.values.get(l.id) ?? 0;
      acc(l.item_id).cost += l.base_type === 'sales' ? v : -v;
    }
    for (const l of tracked) {
      const src = sources.get(noteKey(l.base_type === 'sales' ? 'delivery_note' : 'rejection_in', l.party, l.tracking_ref as string, l.item_id)) ?? [];
      let q = 0;
      let v = 0;
      for (const m of src) {
        q += Math.abs(m.qty);
        v += tr.values.get(m.id) ?? 0;
      }
      if (q < EPS) continue;
      const cost = roundPaise((Math.abs(Number(l.qty)) * v) / q);
      acc(l.item_id).cost += l.base_type === 'sales' ? cost : -cost;
    }
  }

  const rows: ProfitabilityRow[] = [];
  const totals = { netSales: 0, cost: 0, grossProfit: 0, gpPercent: null as number | null };
  for (const it of items.values()) {
    const a = accs.get(it.id);
    if (!a) continue;
    const netSales = a.salesValue - a.returnsValue;
    if (a.salesValue === 0 && a.returnsValue === 0 && a.cost === 0 && Math.abs(a.salesQty) < EPS && Math.abs(a.returnsQty) < EPS) continue;
    const gp = netSales - a.cost;
    rows.push({
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      groupId: it.groupId,
      groupName: it.groupId === null ? null : (groups.get(it.groupId)?.name ?? null),
      salesQty: roundQty(a.salesQty),
      salesValue: a.salesValue,
      returnsQty: roundQty(a.returnsQty),
      returnsValue: a.returnsValue,
      netQty: roundQty(a.salesQty - a.returnsQty),
      netSales,
      cost: a.cost,
      grossProfit: gp,
      gpPercent: gpPercent(gp, netSales),
    });
    totals.netSales += netSales;
    totals.cost += a.cost;
    totals.grossProfit += gp;
  }
  totals.gpPercent = gpPercent(totals.grossProfit, totals.netSales);
  rows.sort((x, y) => y.grossProfit - x.grossProfit || x.name.localeCompare(y.name));
  return { from: input.from, to: input.to, groupId: input.groupId ?? null, rows, totals };
}

// ───────────────────────────── Physical variance ─────────────────────────────

function countedQtys(meta: string | null): number[] {
  if (!meta) return [];
  try {
    const parsed = JSON.parse(meta) as { input?: { items?: Array<{ qty?: unknown }> } };
    const list = parsed.input?.items;
    return Array.isArray(list) ? list.map((l) => (typeof l.qty === 'number' ? l.qty : Number.NaN)) : [];
  } catch {
    return [];
  }
}

export function physicalVariance(db: Db, today: string, input: PhysicalVarianceInput): PhysicalVarianceResult {
  assertPeriod(input.from, input.to);
  const lines = db.all<{
    id: number;
    voucher_id: number;
    line_no: number;
    number: string | null;
    date: string;
    meta: string | null;
    item_id: number;
    godown_id: number | null;
    batch_name: string | null;
    qty: number;
    affects_stock: number;
  }>(
    `SELECT ie.id, ie.voucher_id, ie.line_no, v.number, v.date, v.meta, ie.item_id, COALESCE(ie.godown_id, :main) AS godown_id,
            ie.batch_name, ie.qty, ie.affects_stock
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.base_type = 'physical_stock' AND v.is_cancelled = 0 AND v.is_optional = 0
        AND (v.is_post_dated = 0 OR v.date <= :today) AND v.date >= :from AND v.date <= :to
      ORDER BY v.date, v.id, ie.line_no`,
    { today, from: input.from, to: input.to, main: mainGodown(db) },
  );
  const items = loadItems(db);
  const godownNames = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM godowns').map((g) => [g.id, g.name]));
  const moving = lines.filter((l) => l.affects_stock === 1 && Math.abs(Number(l.qty)) > EPS);
  const tr =
    moving.length > 0
      ? traceMovementValues(db, {
          itemIds: [...new Set(moving.map((l) => l.item_id))],
          from: input.from,
          to: input.to,
          today,
          onlyDates: new Set(moving.map((l) => l.date)),
        })
      : null;
  const countsCache = new Map<number, number[]>();
  const rows: PhysicalVarianceRow[] = [];
  const totals = { gainValue: 0, lossValue: 0, netValue: 0 };
  for (const l of lines) {
    let counts = countsCache.get(l.voucher_id);
    if (!counts) {
      counts = countedQtys(l.meta);
      countsCache.set(l.voucher_id, counts);
    }
    const counted = counts[l.line_no - 1];
    const diff = roundQty(Number(l.qty));
    const cost = l.affects_stock === 1 ? (tr?.values.get(l.id) ?? 0) : 0;
    const value = diff < 0 ? -cost : cost;
    const it = items.get(l.item_id);
    const hasCount = typeof counted === 'number' && Number.isFinite(counted);
    rows.push({
      key: `pv:${l.voucher_id}:${l.line_no}`,
      voucherId: l.voucher_id,
      date: l.date,
      number: l.number,
      itemId: l.item_id,
      itemName: it?.name ?? '',
      unit: it?.unit ?? '',
      godownName: l.godown_id === null ? null : (godownNames.get(l.godown_id) ?? null),
      batchName: l.batch_name,
      countedQty: hasCount ? counted : null,
      bookQty: hasCount ? roundQty(counted - diff) : null,
      differenceQty: diff,
      value,
    });
    if (value > 0) totals.gainValue += value;
    else totals.lossValue += -value;
    totals.netValue += value;
  }
  return { from: input.from, to: input.to, rows, totals };
}
