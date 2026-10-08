/**
 * Per-movement cost values for the stock reports (item ledger, profitability, physical variance).
 *
 * The inventory module exports period totals only (`computeStockValuation`), not the cost of each
 * voucher line. This file derives the per-line values ON TOP of that engine:
 *
 *   1. Replay (fast path). One pass over the movements of the requested items (plus the inputs of
 *      the stock journals that make them), in the engine's replay order, with cost states that
 *      follow the engine's documented contract (inventory README › Valuation methods) line for line
 *      — same order of operations, same rounding — giving the exact cost of every line and the
 *      closing at the end of every day.
 *   2. Proof. The engine itself values the same items for the same period once. For every item the
 *      replay's inward / outward quantity and value and its closing quantity and value must equal
 *      the engine's to the paisa; otherwise that item falls back to (3). So every figure these
 *      reports show is the engine's figure, even if the engine's costing rules change later.
 *   3. Fallback (slow path, per item that failed the proof): one engine run per day that has
 *      movements (`from = to = day`) gives exact day totals; an inward the engine takes at its own
 *      amount gets that amount; the rest of the day's inward value and the day's outward value are
 *      split over the day's lines by quantity (largest remainder). Day totals and closings are exact;
 *      when one item has several outwards on the same day a single line can differ by a paisa.
 *
 * *Helper missing in the inventory module:* a `traceStockMovements` export from the engine would
 * make (1) and (2) unnecessary; the replay below can be moved there unchanged.
 *
 * Performance: (1) + (2) are two linear passes — a year of 22,000 vouchers on 2,000 items takes
 * well under two seconds — where (3) costs one full engine run per day.
 */
import { allocate, lineAmount, roundPaise } from '../../../shared/money.ts';
import type { Db } from '../../db/db.ts';
import { computeStockValuation, STOCK_MOVEMENT_FILTER } from '../inventory/index.ts';
import { jsonIds, loadMovements, mainGodown, roundQty, type MovementRow } from './common.ts';

const EPS = 1e-9;

/** Inwards that the engine re-enters at current cost (inventory README › Inward values). */
const AT_COST_INWARD = new Set(['credit_note', 'rejection_in', 'physical_stock', 'sales', 'delivery_note', 'debit_note', 'rejection_out']);

/** Own value of an inward line as the engine takes it: the taxable amount, else qty × rate less discount, else 0. */
function ownAmount(m: MovementRow): number {
  const amt = Math.abs(m.amount);
  if (amt > 0) return amt;
  if (m.rate > 0) return Math.abs(lineAmount(m.qty, m.rate, m.discountPct));
  return 0;
}

/** True when the engine values this inward at its own amount (not at current cost / consumption share). */
function isPricedInward(m: MovementRow): boolean {
  if (m.baseType === 'stock_journal') return ownAmount(m) > 0;
  return !AT_COST_INWARD.has(m.baseType);
}

export interface DayClose {
  qty: number;
  value: number;
}

export interface TraceResult {
  /** Movements of the requested items in the period (only the traced days when `onlyDates`). */
  movements: MovementRow[];
  /** Cost value (paise, unsigned) by inventory_entries id. */
  values: Map<number, number>;
  /** Closing per item at the end of each day in [from, to] that has one of its movements (in the godown scope when one was given). */
  closing: Map<number, Map<string, DayClose>>;
  /** Items valued by the per-day fallback (the replay did not match the engine). Empty normally. */
  fallbackItems: number[];
}

export interface TraceOptions {
  itemIds: readonly number[];
  from: string;
  to: string;
  today: string;
  /** Value only the movements of these days (all movements of the period otherwise). */
  onlyDates?: ReadonlySet<string>;
  /** Godown scope (with its sub-godowns): only its movements; closing at the item's overall unit cost. */
  godownId?: number | null;
  /** Godown ids of that scope (from godownScope). */
  godowns?: ReadonlySet<number> | null;
  /** Tests only: skip the replay and value every item by the per-day fallback. */
  forceFallback?: boolean;
}

/** Cost value of every movement of `itemIds` in [from, to] — see the top of this file. */
export function traceMovementValues(db: Db, opts: TraceOptions): TraceResult {
  const values = new Map<number, number>();
  const closing = new Map<number, Map<string, DayClose>>();
  const itemIds = [...new Set(opts.itemIds)];
  if (itemIds.length === 0) return { movements: [], values, closing, fallbackItems: [] };
  const godowns = opts.godowns ?? null;
  const inScope = (m: MovementRow): boolean => m.date >= opts.from && (godowns === null || (m.godownId !== null && godowns.has(m.godownId)));

  let failed: number[] = itemIds;
  let movements: MovementRow[] = [];
  if (!opts.forceFallback) {
    const rep = replay(db, { itemIds, from: opts.from, to: opts.to, today: opts.today, godowns });
    movements = rep.movements.filter((m) => m.qty !== 0 && rep.requested.has(m.itemId) && inScope(m));
    failed = verify(db, opts, itemIds, rep, movements);
    const bad = new Set(failed);
    for (const m of movements) if (!bad.has(m.itemId)) values.set(m.id, rep.values.get(m.id) ?? 0);
    for (const id of itemIds) {
      const days = rep.closing.get(id);
      if (days && !bad.has(id)) closing.set(id, days);
    }
    movements = movements.filter((m) => !bad.has(m.itemId));
  }
  if (failed.length > 0) {
    const fb = traceByDays(db, { ...opts, itemIds: failed });
    for (const [k, v] of fb.values) values.set(k, v);
    for (const [k, v] of fb.closing) closing.set(k, v);
    movements = [...movements, ...fb.movements].sort(byReplayOrder);
  }
  if (opts.onlyDates) {
    const only = opts.onlyDates;
    movements = movements.filter((m) => only.has(m.date));
  }
  return { movements, values, closing, fallbackItems: failed };
}

function byReplayOrder(a: MovementRow, b: MovementRow): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.voucherId - b.voucherId || a.lineNo - b.lineNo || a.id - b.id;
}

// ───────────────────────────── (1) Replay ─────────────────────────────

interface CostState {
  qty: number;
  receive(qty: number, value: number, priced: boolean): void;
  issue(qty: number): number;
  currentCost(): number;
  value(): number;
}

// The four cost states follow inventory/valuation.ts operation for operation (so the floating-point
// results are identical); `verify` proves it on every run.

class AvgCostState implements CostState {
  qty = 0;
  private v = 0;
  private last: number;
  constructor(fallback: number) {
    this.last = fallback;
  }
  receive(q: number, val: number): void {
    if (!(q > EPS)) return;
    const rate = val / q;
    if (this.qty <= EPS) {
      this.qty += q;
      if (Math.abs(this.qty) < EPS) this.qty = 0;
      this.v = this.qty === 0 ? 0 : roundPaise(this.qty * rate);
      this.last = rate;
      return;
    }
    this.qty += q;
    this.v += val;
    this.last = this.v / this.qty;
  }
  issue(q: number): number {
    if (!(q > EPS)) return 0;
    if (this.qty > EPS) {
      const rate = this.v / this.qty;
      this.last = rate;
      if (q >= this.qty - EPS) {
        const extra = q - this.qty;
        const out = this.v + (extra > EPS ? roundPaise(extra * rate) : 0);
        this.qty = extra > EPS ? -extra : 0;
        this.v = this.qty === 0 ? 0 : this.v - out;
        return out;
      }
      const out = roundPaise(q * rate);
      this.qty -= q;
      this.v -= out;
      return out;
    }
    const out = roundPaise(q * this.last);
    this.qty -= q;
    this.v -= out;
    return out;
  }
  currentCost(): number {
    return this.qty > EPS ? this.v / this.qty : this.last;
  }
  value(): number {
    return this.v;
  }
}

class LayerState implements CostState {
  qty = 0;
  private layers: Array<{ q: number; v: number }> = [];
  private head = 0;
  private short = 0;
  private last: number;
  private readonly lifo: boolean;
  constructor(fallback: number, lifo: boolean) {
    this.last = fallback;
    this.lifo = lifo;
  }
  private get count(): number {
    return this.layers.length - this.head;
  }
  receive(q: number, val: number): void {
    if (!(q > EPS)) return;
    const rate = val / q;
    this.last = rate;
    this.qty += q;
    let rq = q;
    let rv = val;
    if (this.short > EPS) {
      const cover = Math.min(rq, this.short);
      this.short -= cover;
      if (this.short < EPS) this.short = 0;
      if (cover >= rq - EPS) {
        rq = 0;
        rv = 0;
      } else {
        rv -= roundPaise(cover * rate);
        rq -= cover;
      }
    }
    if (rq > EPS) this.layers.push({ q: rq, v: rv });
    if (Math.abs(this.qty) < EPS) this.qty = 0;
  }
  issue(q: number): number {
    if (!(q > EPS)) return 0;
    let need = q;
    let out = 0;
    while (need > EPS && this.count > 0) {
      const idx = this.lifo ? this.layers.length - 1 : this.head;
      const layer = this.layers[idx];
      this.last = layer.v / layer.q;
      if (need >= layer.q - EPS) {
        out += layer.v;
        need -= layer.q;
        if (this.lifo) this.layers.pop();
        else this.head++;
      } else {
        const part = roundPaise(need * this.last);
        layer.v -= part;
        layer.q -= need;
        out += part;
        need = 0;
      }
    }
    if (this.head > 64 && this.head * 2 > this.layers.length) {
      this.layers = this.layers.slice(this.head);
      this.head = 0;
    }
    if (need > EPS) {
      out += roundPaise(need * this.last);
      this.short += need;
    }
    this.qty -= q;
    if (Math.abs(this.qty) < EPS) this.qty = 0;
    return out;
  }
  currentCost(): number {
    if (this.count === 0) return this.last;
    const layer = this.lifo ? this.layers[this.layers.length - 1] : this.layers[this.head];
    return layer.v / layer.q;
  }
  value(): number {
    let v = 0;
    for (let i = this.head; i < this.layers.length; i++) v += this.layers[i].v;
    return this.short > EPS ? v - roundPaise(this.short * this.last) : v;
  }
}

class LastPurchaseState implements CostState {
  qty = 0;
  private rate: number | null = null;
  private readonly fallback: number;
  constructor(fallback: number) {
    this.fallback = fallback;
  }
  receive(q: number, val: number, priced: boolean): void {
    if (!(q > EPS)) return;
    this.qty += q;
    if (priced && val > 0) this.rate = val / q;
  }
  issue(q: number): number {
    if (!(q > EPS)) return 0;
    this.qty -= q;
    return roundPaise(q * this.currentCost());
  }
  currentCost(): number {
    return this.rate ?? this.fallback;
  }
  value(): number {
    return roundPaise(this.qty * this.currentCost());
  }
}

class StdCostState implements CostState {
  qty = 0;
  private readonly std: number;
  constructor(std: number) {
    this.std = std;
  }
  receive(q: number): void {
    if (q > EPS) this.qty += q;
  }
  issue(q: number): number {
    if (!(q > EPS)) return 0;
    this.qty -= q;
    return roundPaise(q * this.std);
  }
  currentCost(): number {
    return this.std;
  }
  value(): number {
    return roundPaise(this.qty * this.std);
  }
}

interface ItemCostRow {
  id: number;
  costing_method: string;
  standard_cost: number | null;
  purchase_price: number | null;
}

function newState(item: ItemCostRow): CostState {
  const fallback = Number(item.standard_cost ?? item.purchase_price ?? 0);
  switch (item.costing_method) {
    case 'fifo':
      return new LayerState(fallback, false);
    case 'lifo':
      return new LayerState(fallback, true);
    case 'last_purchase':
      return new LastPurchaseState(fallback);
    case 'std_cost':
      return new StdCostState(Number(item.standard_cost ?? 0));
    default:
      return new AvgCostState(fallback);
  }
}

/** Items whose cost the requested items depend on (consumed in stock journals producing them), transitively. */
function dependencyClosure(db: Db, itemIds: readonly number[], to: string): Set<number> {
  const set = new Set(itemIds);
  let frontier = [...set];
  while (frontier.length > 0) {
    const rows = db.all<{ item_id: number }>(
      `SELECT DISTINCT c.item_id FROM inventory_entries p
         JOIN vouchers v ON v.id = p.voucher_id
         JOIN inventory_entries c ON c.voucher_id = p.voucher_id
        WHERE v.base_type = 'stock_journal' AND p.qty > 0 AND c.qty < 0 AND p.date <= :to
          AND p.item_id IN (SELECT value FROM json_each(:ids))`,
      { ids: jsonIds(frontier), to },
    );
    frontier = [];
    for (const r of rows) {
      if (!set.has(r.item_id)) {
        set.add(r.item_id);
        frontier.push(r.item_id);
      }
    }
  }
  return set;
}

interface ReplayResult {
  requested: Set<number>;
  /** Every replayed movement (requested items, their inputs, and all lines of their stock journals). */
  movements: MovementRow[];
  values: Map<number, number>;
  closing: Map<number, Map<string, DayClose>>;
  /** Closing per requested item at `to` (godown scope when given). */
  final: Map<number, DayClose>;
}

function replay(db: Db, q: { itemIds: readonly number[]; from: string; to: string; today: string; godowns: ReadonlySet<number> | null }): ReplayResult {
  const requested = new Set(q.itemIds);
  const closure = dependencyClosure(db, q.itemIds, q.to);
  const ids = jsonIds(closure);
  const states = new Map<number, CostState>();
  for (const it of db.all<ItemCostRow>(
    `SELECT id, costing_method, standard_cost, purchase_price FROM stock_items WHERE id IN (SELECT value FROM json_each(:ids))`,
    { ids },
  )) {
    states.set(it.id, newState(it));
  }
  const godowns = q.godowns;
  const gQty = new Map<number, number>();
  const inGodown = (g: number | null): boolean => godowns !== null && g !== null && godowns.has(g);
  const addG = (itemId: number, g: number | null, qty: number): void => {
    if (inGodown(g)) gQty.set(itemId, (gQty.get(itemId) ?? 0) + qty);
  };

  // Opening stock: FIFO / LIFO take each row as a layer, the other methods the rows together.
  const pooled = new Map<number, { qty: number; value: number }>();
  for (const o of db.all<{ item_id: number; godown_id: number; qty: number; value: number; method: string }>(
    `SELECT o.item_id, o.godown_id, o.qty, o.value, i.costing_method AS method FROM stock_openings o JOIN stock_items i ON i.id = o.item_id
      WHERE o.item_id IN (SELECT value FROM json_each(:ids)) ORDER BY o.item_id, o.id`,
    { ids },
  )) {
    const st = states.get(o.item_id);
    if (!st) continue;
    addG(o.item_id, o.godown_id, o.qty);
    if (o.method === 'fifo' || o.method === 'lifo') {
      if (o.qty > 0) st.receive(o.qty, Number(o.value), true);
      else if (o.qty < 0) st.issue(-o.qty);
    } else {
      const p = pooled.get(o.item_id) ?? { qty: 0, value: 0 };
      p.qty += o.qty;
      p.value += Number(o.value);
      pooled.set(o.item_id, p);
    }
  }
  for (const [itemId, p] of pooled) {
    const st = states.get(itemId) as CostState;
    if (p.qty > EPS) st.receive(p.qty, p.value, true);
    else if (p.qty < -EPS) st.issue(-p.qty);
  }

  const movements = db
    .all<{
      id: number;
      voucher_id: number;
      line_no: number;
      item_id: number;
      godown_id: number | null;
      batch_name: string | null;
      qty: number;
      amount: number;
      rate: number;
      discount_pct: number;
      date: string;
      base_type: string;
    }>(
      `SELECT ie.id, ie.voucher_id, ie.line_no, ie.item_id, COALESCE(ie.godown_id, :main) AS godown_id, ie.batch_name, ie.qty, ie.amount,
              ie.rate, ie.discount_pct, ie.date, v.base_type
         FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
        WHERE ie.date <= :to AND ${STOCK_MOVEMENT_FILTER}
          AND (ie.item_id IN (SELECT value FROM json_each(:ids))
               OR (v.base_type = 'stock_journal' AND ie.voucher_id IN
                   (SELECT voucher_id FROM inventory_entries WHERE item_id IN (SELECT value FROM json_each(:ids)))))
        ORDER BY ie.date, ie.voucher_id, ie.line_no, ie.id`,
      { to: q.to, today: q.today, main: mainGodown(db), ids },
    )
    .map(
      (r): MovementRow => ({
        id: r.id,
        voucherId: r.voucher_id,
        lineNo: r.line_no,
        itemId: r.item_id,
        godownId: r.godown_id,
        batchName: r.batch_name,
        qty: Number(r.qty),
        amount: Number(r.amount),
        rate: Number(r.rate),
        discountPct: Number(r.discount_pct ?? 0),
        date: r.date,
        baseType: r.base_type,
      }),
    );

  const values = new Map<number, number>();
  const closing = new Map<number, Map<string, DayClose>>();
  const touched = new Set<number>();
  const snapshot = (itemId: number): DayClose => {
    const st = states.get(itemId) as CostState;
    if (godowns === null) return { qty: roundQty(st.qty), value: st.value() };
    const g = gQty.get(itemId) ?? 0;
    const unit = st.qty > EPS ? st.value() / st.qty : st.currentCost();
    return { qty: roundQty(g), value: roundPaise(g * unit) };
  };
  const closeDay = (date: string): void => {
    if (date < q.from) {
      touched.clear();
      return;
    }
    for (const itemId of touched) {
      let days = closing.get(itemId);
      if (!days) {
        days = new Map();
        closing.set(itemId, days);
      }
      days.set(date, snapshot(itemId));
    }
    touched.clear();
  };

  const apply = (m: MovementRow, value: number | null): void => {
    const st = states.get(m.itemId);
    if (!st) return;
    let v: number;
    if (m.qty < 0) {
      v = st.issue(-m.qty);
    } else {
      const priced = value !== null;
      v = value ?? roundPaise(m.qty * st.currentCost());
      st.receive(m.qty, v, priced);
    }
    addG(m.itemId, m.godownId, m.qty);
    values.set(m.id, v);
    if (requested.has(m.itemId)) touched.add(m.itemId);
  };

  let i = 0;
  while (i < movements.length) {
    const first = movements[i];
    let j = i;
    while (j < movements.length && movements[j].voucherId === first.voucherId) j++;
    const lines = movements.slice(i, j);
    i = j;

    if (first.baseType === 'stock_journal') {
      const consumption = lines.filter((m) => m.qty < 0);
      const production = lines.filter((m) => m.qty > 0);
      let consumed = 0;
      for (const m of consumption) {
        const st = states.get(m.itemId);
        if (!st) continue;
        const cost = st.issue(-m.qty);
        consumed += cost;
        addG(m.itemId, m.godownId, m.qty);
        values.set(m.id, cost);
        if (requested.has(m.itemId)) touched.add(m.itemId);
      }
      const explicit = production.filter((m) => ownAmount(m) > 0);
      const implicit = production.filter((m) => ownAmount(m) <= 0);
      const pool = Math.max(0, consumed - explicit.reduce((s, m) => s + ownAmount(m), 0));
      const shares = consumption.length > 0 ? allocate(pool, implicit.map((m) => m.qty)) : null;
      for (const m of explicit) apply(m, ownAmount(m));
      implicit.forEach((m, k) => apply(m, shares ? shares[k] : null));
    } else {
      for (const m of lines) {
        if (m.qty === 0) continue;
        if (m.qty < 0 || AT_COST_INWARD.has(m.baseType)) apply(m, null);
        else apply(m, ownAmount(m));
      }
    }
    if (i >= movements.length || movements[i].date !== first.date) closeDay(first.date);
  }

  const final = new Map<number, DayClose>();
  for (const id of requested) if (states.has(id)) final.set(id, snapshot(id));
  return { requested, movements, values, closing, final };
}

// ───────────────────────────── (2) Proof against the engine ─────────────────────────────

/** Items whose replayed figures for [from, to] differ from the engine's (normally none). */
function verify(db: Db, opts: TraceOptions, itemIds: readonly number[], rep: ReplayResult, inScope: readonly MovementRow[]): number[] {
  const engine = computeStockValuation(db, {
    from: opts.from,
    to: opts.to,
    today: opts.today,
    itemIds,
    godownId: opts.godownId ?? null,
    includeSubGodowns: true,
  });
  const sums = new Map<number, { inQ: number; inV: number; outQ: number; outV: number }>();
  for (const m of inScope) {
    const s = sums.get(m.itemId) ?? { inQ: 0, inV: 0, outQ: 0, outV: 0 };
    const v = rep.values.get(m.id) ?? 0;
    if (m.qty > 0) {
      s.inQ += m.qty;
      s.inV += v;
    } else {
      s.outQ += -m.qty;
      s.outV += v;
    }
    sums.set(m.itemId, s);
  }
  const failed: number[] = [];
  const rows = new Map(engine.rows.map((r) => [r.itemId, r]));
  for (const id of itemIds) {
    const r = rows.get(id);
    const s = sums.get(id) ?? { inQ: 0, inV: 0, outQ: 0, outV: 0 };
    const f = rep.final.get(id);
    const ok =
      r !== undefined &&
      f !== undefined &&
      roundQty(s.inQ) === r.inward.qty &&
      s.inV === r.inward.value &&
      roundQty(s.outQ) === r.outward.qty &&
      s.outV === r.outward.value &&
      f.qty === r.closing.qty &&
      f.value === r.closing.value;
    if (!ok) failed.push(id);
  }
  return failed;
}

// ───────────────────────────── (3) Fallback: one engine run per day ─────────────────────────────

function traceByDays(db: Db, opts: TraceOptions): { movements: MovementRow[]; values: Map<number, number>; closing: Map<number, Map<string, DayClose>> } {
  const values = new Map<number, number>();
  const closing = new Map<number, Map<string, DayClose>>();
  const godowns = opts.godowns ?? null;
  let movements = loadMovements(db, { from: opts.from, to: opts.to, today: opts.today, itemIds: opts.itemIds });
  if (godowns) movements = movements.filter((m) => m.godownId !== null && godowns.has(m.godownId));
  if (opts.onlyDates) {
    const only = opts.onlyDates;
    movements = movements.filter((m) => only.has(m.date));
  }

  // Movements per day, then per item (replay order kept).
  const byDay = new Map<string, Map<number, MovementRow[]>>();
  for (const m of movements) {
    let day = byDay.get(m.date);
    if (!day) {
      day = new Map();
      byDay.set(m.date, day);
    }
    const list = day.get(m.itemId) ?? [];
    list.push(m);
    day.set(m.itemId, list);
  }

  for (const [date, perItem] of byDay) {
    const res = computeStockValuation(db, {
      from: date,
      to: date,
      today: opts.today,
      itemIds: [...perItem.keys()],
      godownId: opts.godownId ?? null,
      includeSubGodowns: true,
    });
    const rowByItem = new Map(res.rows.map((r) => [r.itemId, r]));
    for (const [itemId, lines] of perItem) {
      const row = rowByItem.get(itemId);
      if (!row) continue;
      let closes = closing.get(itemId);
      if (!closes) {
        closes = new Map();
        closing.set(itemId, closes);
      }
      closes.set(date, { qty: row.closing.qty, value: row.closing.value });

      const outs = lines.filter((m) => m.qty < 0);
      const ins = lines.filter((m) => m.qty > 0);
      if (outs.length > 0) {
        const parts = allocate(row.outward.value, outs.map((m) => -m.qty));
        outs.forEach((m, k) => values.set(m.id, parts[k]));
      }
      if (ins.length > 0) {
        const priced = ins.filter(isPricedInward);
        const atCost = ins.filter((m) => !isPricedInward(m));
        let pricedSum = 0;
        for (const m of priced) {
          const v = ownAmount(m);
          values.set(m.id, v);
          pricedSum += v;
        }
        if (atCost.length > 0) {
          const parts = allocate(row.inward.value - pricedSum, atCost.map((m) => m.qty));
          atCost.forEach((m, k) => values.set(m.id, parts[k]));
        }
      }
    }
  }
  return { movements, values, closing };
}
