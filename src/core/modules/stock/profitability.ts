/**
 * Item-wise gross profit and the Physical Stock variance register.
 *
 * Profitability, per item, for a period — cost is matched to what was INVOICED:
 *   sales      = taxable value of item lines on sales invoices in the books (incl. lines that bill a
 *                delivery note), quantity as billed; plus the item lines of debit notes to customers
 *                (upward price revisions: value only, no quantity, no cost), so net sales agree with
 *                the Sales Accounts of the P&L;
 *   returns    = taxable value / quantity of item lines on credit notes in the books;
 *   cost (COGS)= for an invoice line that moved stock itself, its cost at the item's costing method
 *                (inventory engine; a credit note's goods come back at cost and reduce COGS); for a
 *                line that bills a delivery note (or a credit note against a rejection in), the note's
 *                cost per unit × the billed quantity, wherever the note is dated;
 *   gross profit = (sales − returns) − cost; GP % = gross profit ÷ net sales × 100.
 * Delivery notes not yet invoiced, stock journals, physical stock losses and purchase returns are
 * not cost of sales. Each line's cost comes from trace.ts (one replay of the items' movements,
 * proven against the inventory engine's figures for the period).
 *
 * Physical variance: every count of the physical stock vouchers in the period (optional and
 * cancelled ones excluded; lines of one voucher counting the same item / godown / batch added up):
 * counted quantity (as entered), book quantity at the count (counted − difference), the difference
 * and its value at cost (+ gain, − loss).
 */
import { roundPaise, roundTo } from '../../../shared/money.ts';
import type { PhysicalVarianceInput, PhysicalVarianceResult, PhysicalVarianceRow, ProfitabilityInput, ProfitabilityResult, ProfitabilityRow } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { outwardDebitNoteLineSql } from '../vouchers/direction.ts';
import { assertPeriod, EPS, itemsInGroup, jsonIds, loadItems, loadTree, mainGodown, roundQty } from './common.ts';
import { traceMovementValues } from './trace.ts';

export function gpPercent(gp: number, net: number): number | null {
  return net === 0 ? null : roundTo((gp / net) * 100, 2);
}

export function profitability(db: Db, today: string, input: ProfitabilityInput): ProfitabilityResult {
  assertPeriod(input.from, input.to);
  const scope = itemsInGroup(db, input.groupId);
  const items = loadItems(db);
  const groups = loadTree(db, 'group');

  // Invoice lines: sales, credit notes and debit notes to customers (price revisions) in the books,
  // dated in the period.
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
      WHERE (v.base_type IN ('sales', 'credit_note') OR ${outwardDebitNoteLineSql('v', 'ie')}) AND ${BOOKS_FILTER('v')}
        AND ie.date >= :from AND ie.date <= :to
        ${scope ? 'AND ie.item_id IN (SELECT value FROM json_each(:ids))' : ''}
      ORDER BY ie.date, ie.voucher_id, ie.line_no`,
    scope ? { today, from: input.from, to: input.to, ids: jsonIds(scope) } : { today, from: input.from, to: input.to },
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
    } else if (l.base_type === 'debit_note') {
      // Upward price revision of goods already invoiced: sales value, no quantity and no cost.
      a.salesValue += Number(l.amount);
    } else {
      a.returnsQty += qty;
      a.returnsValue += Number(l.amount);
    }
  }

  // Which invoice lines carry their own stock movement, and which bill a note (cost from the note).
  // (A debit note's lines are value-only: never a movement, never billing a note.)
  const invoices = lines.filter((l) => l.base_type !== 'debit_note');
  const moving = invoices.filter((l) => l.affects_stock === 1 && Number(l.qty) !== 0);
  const tracked = invoices.filter((l) => l.affects_stock === 0 && l.tracking_ref !== null && Number(l.qty) !== 0);
  const noteKey = (base: string, party: number | null, ref: string, item: number): string => `${base}|${party ?? 0}|${ref}|${item}`;
  const noteIds = new Map<number, string>();
  let traceFrom = input.from;
  let traceTo = input.to;
  if (tracked.length > 0) {
    const wanted = new Set(tracked.map((l) => noteKey(l.base_type === 'sales' ? 'delivery_note' : 'rejection_in', l.party, l.tracking_ref as string, l.item_id)));
    for (const r of db.all<{ id: number; base_type: string; party: number | null; ref: string; item_id: number; date: string }>(
      `SELECT ie.id, v.base_type, v.party_ledger_id AS party, ie.tracking_ref AS ref, ie.item_id, ie.date
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE v.base_type IN ('delivery_note', 'rejection_in') AND ie.tracking_ref IS NOT NULL AND ie.affects_stock = 1 AND ie.qty <> 0
          AND v.is_cancelled = 0 AND v.is_optional = 0 AND ie.item_id IN (SELECT value FROM json_each(:ids))`,
      { ids: jsonIds(new Set(tracked.map((l) => l.item_id))) },
    )) {
      const key = noteKey(r.base_type, r.party, r.ref, r.item_id);
      if (!wanted.has(key)) continue;
      noteIds.set(r.id, key);
      if (r.date < traceFrom) traceFrom = r.date;
      if (r.date > traceTo) traceTo = r.date;
    }
  }

  // Cost of every moving invoice line and of every billed note's lines, at the item's costing
  // method (trace.ts: one replay proven against the inventory engine).
  const itemIds = new Set<number>(moving.map((l) => l.item_id));
  if (noteIds.size > 0) for (const l of tracked) itemIds.add(l.item_id);
  const tr = itemIds.size > 0 ? traceMovementValues(db, { itemIds: [...itemIds], from: traceFrom, to: traceTo, today }) : null;
  const sources = new Map<string, { qty: number; value: number }>();
  if (tr) {
    for (const m of tr.movements) {
      const key = noteIds.get(m.id);
      if (key === undefined) continue;
      const s = sources.get(key) ?? { qty: 0, value: 0 };
      s.qty += Math.abs(m.qty);
      s.value += tr.values.get(m.id) ?? 0;
      sources.set(key, s);
    }
    for (const l of moving) {
      const v = tr.values.get(l.id) ?? 0;
      acc(l.item_id).cost += l.base_type === 'sales' ? v : -v;
    }
  }
  for (const l of tracked) {
    const src = sources.get(noteKey(l.base_type === 'sales' ? 'delivery_note' : 'rejection_in', l.party, l.tracking_ref as string, l.item_id));
    if (!src || src.qty < EPS) continue;
    const cost = roundPaise((Math.abs(Number(l.qty)) * src.value) / src.qty);
    acc(l.item_id).cost += l.base_type === 'sales' ? cost : -cost;
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
  const merged = new Map<string, PhysicalVarianceRow>();
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
    const hasCount = typeof counted === 'number' && Number.isFinite(counted);
    // Lines of one voucher counting the same item / godown / batch (two racks) were posted as one
    // difference (the first line carries counted − book, later ones their count): show them as one
    // row, so "as per books" is the real book quantity.
    const groupKey = `${l.voucher_id}|${l.item_id}|${l.godown_id ?? ''}|${l.batch_name ?? ''}`;
    const prev = merged.get(groupKey);
    if (prev) {
      prev.countedQty = prev.countedQty !== null && hasCount ? roundQty(prev.countedQty + counted) : null;
      prev.differenceQty = roundQty(prev.differenceQty + diff);
      prev.bookQty = prev.countedQty !== null ? roundQty(prev.countedQty - prev.differenceQty) : null;
      prev.value += value;
    } else {
      const it = items.get(l.item_id);
      const row: PhysicalVarianceRow = {
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
      };
      merged.set(groupKey, row);
      rows.push(row);
    }
  }
  for (const r of rows) {
    if (r.value > 0) totals.gainValue += r.value;
    else totals.lossValue += -r.value;
    totals.netValue += r.value;
  }
  return { from: input.from, to: input.to, rows, totals };
}
