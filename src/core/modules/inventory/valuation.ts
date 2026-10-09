/**
 * Stock valuation engine (Stock Summary, closing stock for P&L / Balance Sheet).
 *
 * Movements are replayed in chronological order — date, then voucher id (entry order), then line —
 * starting from the opening stock (stock_openings), using the stock filter of stock.ts. Each item
 * keeps a cost state for its costing method:
 *
 *   avg_cost       running weighted average: inward → Q += q, V += value; outward → value = q × V/Q
 *                  (the whole V when the stock is emptied). Outwards are valued at the average at
 *                  their time ("Average Cost").
 *   fifo / lifo    cost layers: each inward adds a layer; outwards consume the oldest (FIFO) or the
 *                  newest (LIFO) layers.
 *   last_purchase  every value = qty × the rate of the last inward valued at its own amount
 *                  (purchase, receipt note, production with an amount, opening stock) dated on or
 *                  before that point; zero-value inwards do not set the rate.
 *   std_cost       every value = qty × stock_items.standard_cost.
 *
 * Inward values: purchases / receipt notes (and any unlisted voucher type) use the entry amount
 * (taxable value, excl. GST). Credit notes (sales returns), rejections in, physical stock gains and
 * any other "reversal" inward re-enter at the CURRENT COST (avg: V/Q; fifo: oldest layer's rate;
 * lifo: newest layer's rate). Stock journal: consumption (source) lines are issued at cost first;
 * a production (destination) line is valued at its amount when > 0, otherwise it gets a share of
 * (consumed cost − Σ production amounts given), split by quantity (largest remainder); with no
 * consumption in the voucher it enters at current cost. Outwards are always valued at cost.
 *
 * Negative stock: an outward beyond the quantity on hand is valued at the last known cost (last
 * average / last layer / last inward rate; before any inward: standard cost, else purchase price,
 * else 0). For avg_cost a later inward into negative stock restarts the average at that inward's
 * rate; for layers it first fills the shortfall. Values are integer paise and never NaN.
 *
 * Opening stock: FIFO/LIFO take each stock_openings row as a layer; the other methods take the rows
 * together (Last Purchase starts from the weighted opening rate). For a period starting on or before
 * the books beginning the opening VALUE is the opening stock as entered in the masters (Σ value), so
 * the Balance Sheet's opening stock matches them whatever the costing method; later periods open
 * with the previous day's closing value.
 *
 * Godown filter: quantities and in/out movements are those of that godown (exact, or with all its
 * sub-godowns when includeSubGodowns), while values of opening/closing use the item's overall unit
 * cost (value ÷ qty of the item across godowns).
 *
 * Manufacturing / job work (mfg module): a stock journal with rows in stock_journal_lines values its
 * production lines by their basis (shared/mfg/costing.ts — finished goods = consumption + additional
 * costs − by-products/scrap; transfers keep their own cost). Godowns holding a PRINCIPAL's stock for
 * job work (godowns.third_party_kind = 'party_with_us') are not ours: their movements and opening
 * rows never touch the cost states, values or the whole-company figures (Balance Sheet / P&L closing
 * stock); with a godown filter on such a godown its quantities are shown at value 0.
 */
import { addDays } from '../../../shared/dates.ts';
import { costJournal, type AdditionalCostTerm, type ProductionTerm } from '../../../shared/mfg/costing.ts';
import { allocate, roundPaise, roundTo, lineAmount } from '../../../shared/money.ts';
import type { CostingMethod, StockValuationResult, StockValuationRow } from '../../../shared/types/inventory.ts';
import type { Db } from '../../db/db.ts';
import { jsonIds } from './common.ts';
import { godownSet, roundQty, STOCK_MOVEMENT_FILTER } from './stock.ts';

const EPS = 1e-9;

// ───────────────────────────── Cost states ─────────────────────────────

interface CostState {
  /** Quantity on hand (may be negative). */
  qty: number;
  /** Add `qty` (> 0) worth `value` paise. `priced`: the value is the inward's own amount (not a cost re-entry). */
  receive(qty: number, value: number, priced: boolean): void;
  /** Remove `qty` (> 0); returns its cost in paise. */
  issue(qty: number): number;
  /** Current cost per unit (paise) used for re-entries at cost. */
  currentCost(): number;
  /** Value on hand in paise. */
  value(): number;
}

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
      // Empty or negative stock: the average restarts at this inward's rate (shortfall re-priced).
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

interface ItemInfo {
  id: number;
  name: string;
  unit: string;
  group_id: number | null;
  costing_method: string;
  standard_cost: number | null;
  purchase_price: number | null;
  is_service: number;
}

const METHODS: readonly CostingMethod[] = ['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'];

function methodOf(item: ItemInfo): CostingMethod {
  return (METHODS as readonly string[]).includes(item.costing_method) ? (item.costing_method as CostingMethod) : 'avg_cost';
}

function newState(item: ItemInfo): CostState {
  const fallback = Number(item.standard_cost ?? item.purchase_price ?? 0);
  switch (methodOf(item)) {
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

// ───────────────────────────── Movements ─────────────────────────────

interface Movement {
  /** inventory_entries.id */
  id: number;
  voucher_id: number;
  line_no: number;
  item_id: number;
  godown_id: number | null;
  /** Only selected when tracing. */
  batch_name?: string | null;
  qty: number;
  amount: number;
  rate: number;
  discount_pct: number;
  date: string;
  base_type: string;
}

/** Inwards on these voucher types re-enter at current cost (returns, rejections, physical gains, reversals). */
const AT_COST_INWARD = new Set([
  'credit_note',
  'rejection_in',
  'physical_stock',
  'sales',
  'delivery_note',
  'debit_note',
  'rejection_out',
]);

/** Own value of an inward line: the taxable amount, else qty × rate (less discount), else 0. */
function ownAmount(m: Movement): number {
  const amt = Math.abs(Number(m.amount));
  if (amt > 0) return amt;
  if (m.rate > 0) return Math.abs(lineAmount(m.qty, m.rate, m.discount_pct ?? 0));
  return 0;
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

// ───────────────────────────── Manufacturing / job work (mfg module) ─────────────────────────────

/** Godowns holding a principal's stock with us (never valued as ours). */
function thirdPartyGodowns(db: Db): Set<number> {
  return new Set(db.all<{ id: number }>(`SELECT id FROM godowns WHERE third_party_kind = 'party_with_us'`).map((r) => r.id));
}

interface JournalTerms {
  lines: Map<number, ProductionTerm>;
  additional: AdditionalCostTerm[];
}

const TERMS_LINES_ALL = `SELECT voucher_id, line_no, basis, pct, source_line_no FROM stock_journal_lines WHERE basis IS NOT NULL`;
const TERMS_LINES_SOME = `SELECT voucher_id, line_no, basis, pct, source_line_no FROM stock_journal_lines
  WHERE voucher_id IN (SELECT value FROM json_each(:vids)) AND basis IS NOT NULL`;
const TERMS_COSTS_ALL = `SELECT voucher_id, basis, value FROM stock_journal_costs ORDER BY voucher_id, line_no`;
const TERMS_COSTS_SOME = `SELECT voucher_id, basis, value FROM stock_journal_costs
  WHERE voucher_id IN (SELECT value FROM json_each(:vids)) ORDER BY voucher_id, line_no`;

/** Costing terms of the classed stock journals among `voucherIds` (mfg module), by voucher id. */
function loadJournalTerms(db: Db, voucherIds: readonly number[]): Map<number, JournalTerms> {
  const out = new Map<number, JournalTerms>();
  if (voucherIds.length === 0 || db.value('SELECT 1 FROM stock_journal_lines LIMIT 1') === undefined) return out;
  const some = voucherIds.length <= 2000;
  const params = some ? { vids: jsonIds([...voucherIds]) } : {};
  const lines = db.all<{ voucher_id: number; line_no: number; basis: ProductionTerm['basis']; pct: number | null; source_line_no: number | null }>(
    some ? TERMS_LINES_SOME : TERMS_LINES_ALL,
    params,
  );
  for (const l of lines) {
    let t = out.get(l.voucher_id);
    if (!t) {
      t = { lines: new Map(), additional: [] };
      out.set(l.voucher_id, t);
    }
    t.lines.set(l.line_no, { basis: l.basis, pct: l.pct, sourceLineNo: l.source_line_no });
  }
  for (const c of db.all<{ voucher_id: number; basis: AdditionalCostTerm['basis']; value: number }>(some ? TERMS_COSTS_SOME : TERMS_COSTS_ALL, params)) {
    const t = out.get(c.voucher_id);
    if (t) t.additional.push({ basis: c.basis, value: Number(c.value) });
  }
  return out;
}

// SQL. Every statement is a constant chosen by shape — no catch-all `(:filter = 0 OR …)` flag, which
// would hide the item index from the planner (and turn into a skip-scan over every item id once
// ANALYZE statistics exist). Shapes:
//   - whole company: ONE sequential scan of inventory_entries (NOT INDEXED, CROSS JOIN keeps it the
//     outer loop whatever the statistics say), vouchers by primary key, one sort;
//   - a few items: the item index (INDEXED BY pins it — the statement fails loudly if it is ever
//     dropped) for the items' own lines, plus the other lines of the stock journals they appear in
//     (a journal's production lines share its consumption cost, so all of them are needed).
const MOVEMENT_COLUMNS = `ie.id AS id, ie.voucher_id AS voucher_id, ie.line_no AS line_no, ie.item_id AS item_id,
       COALESCE(ie.godown_id, :main) AS godown_id, ie.qty AS qty, ie.amount AS amount, ie.rate AS rate,
       ie.discount_pct AS discount_pct, ie.date AS date, v.base_type AS base_type`;

function movementSql(filtered: boolean, withBatch: boolean): string {
  const cols = withBatch ? `${MOVEMENT_COLUMNS}, ie.batch_name AS batch_name` : MOVEMENT_COLUMNS;
  if (!filtered) {
    return `SELECT ${cols}
       FROM inventory_entries ie NOT INDEXED CROSS JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.date <= :to AND ${STOCK_MOVEMENT_FILTER}
      ORDER BY ie.date, ie.voucher_id, ie.line_no, ie.id`;
  }
  return `SELECT ${cols}
       FROM inventory_entries ie INDEXED BY idx_ie_item_date CROSS JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.item_id IN (SELECT value FROM json_each(:ids)) AND ie.date <= :to AND ${STOCK_MOVEMENT_FILTER}
     UNION ALL
     SELECT ${cols}
       FROM inventory_entries ie CROSS JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.voucher_id IN (SELECT x.voucher_id FROM inventory_entries x INDEXED BY idx_ie_item_date
                               WHERE x.item_id IN (SELECT value FROM json_each(:ids)))
        AND v.base_type = 'stock_journal' AND ie.item_id NOT IN (SELECT value FROM json_each(:ids))
        AND ie.date <= :to AND ${STOCK_MOVEMENT_FILTER}
      ORDER BY date, voucher_id, line_no, id`;
}

/** The two movement statements, exported for the query-plan regression tests (engine.test.ts). */
export const VALUATION_MOVEMENT_SQL = { all: movementSql(false, false), items: movementSql(true, false) } as const;

const ITEM_COLUMNS = `SELECT i.id, i.name, u.symbol AS unit, i.group_id, i.costing_method, i.standard_cost, i.purchase_price, i.is_service
       FROM stock_items i JOIN units u ON u.id = i.unit_id`;
const ITEMS_ALL_SQL = `${ITEM_COLUMNS} ORDER BY i.name COLLATE NOCASE`;
const ITEMS_SOME_SQL = `${ITEM_COLUMNS} WHERE i.id IN (SELECT value FROM json_each(:ids)) ORDER BY i.name COLLATE NOCASE`;
const OPENINGS_ALL_SQL = 'SELECT item_id, godown_id, qty, value FROM stock_openings ORDER BY item_id, id';
const OPENINGS_SOME_SQL = 'SELECT item_id, godown_id, qty, value FROM stock_openings WHERE item_id IN (SELECT value FROM json_each(:ids)) ORDER BY item_id, id';

/**
 * Up to this share of the company's items (1 in INDEXED_SHARE), a filtered valuation reads the
 * items' lines through the item index; beyond it one sequential scan is cheaper than that many
 * index look-ups, and lines of other items are skipped in the replay (same result: an item's cost
 * only depends on the items in its dependency closure, which all have a cost state).
 */
const INDEXED_SHARE = 4;

export interface StockValuationOptions {
  from: string;
  to: string;
  /** Only these items (their stock-journal inputs are valued too, internally). */
  itemIds?: readonly number[];
  /** Quantities and movements of this godown only. */
  godownId?: number | null;
  /** With godownId: include its sub-godowns (Tally's godown summary of a parent location). Default false (exact). */
  includeSubGodowns?: boolean;
  /** Working date for the post-dated rule. */
  today: string;
}

interface Acc {
  openQty: number;
  openValue: number;
  inQty: number;
  inValue: number;
  outQty: number;
  outValue: number;
  /** Quantity in the filter godown (godown mode). */
  gQty: number;
  /** Quantity of a principal's stock (job work, 'party_with_us' godowns) in the filter godown — never valued. */
  gQty3: number;
  /** Σ value of the opening stock rows as entered in the item master (paise). */
  enteredValue: number;
  /** A voucher movement of this item has been replayed. */
  moved: boolean;
}

/** A whole-company stock value point taken during a replay: at the START ('open') or END ('close') of `date`. */
interface Cut {
  kind: 'open' | 'close';
  date: string;
}

/** Closing of one item at the end of a day (godown scope: the godown quantity at the item's overall unit cost). */
export interface DayClose {
  qty: number;
  value: number;
}

/** One traced movement (a stock-moving inventory_entries line), in replay order. */
export interface TracedMovement {
  id: number;
  voucherId: number;
  lineNo: number;
  itemId: number;
  /** Main Location when the entry has none. */
  godownId: number | null;
  batchName: string | null;
  qty: number;
  amount: number;
  rate: number;
  discountPct: number;
  date: string;
  baseType: string;
}

interface TraceSink {
  items: ReadonlySet<number>;
  from: string;
  movements: TracedMovement[];
  values: Map<number, number>;
  closing: Map<number, Map<string, DayClose>>;
}

interface ReplayOptions extends StockValuationOptions {
  /** Whole-company value points (no item / godown filter). */
  cuts?: readonly Cut[];
  trace?: TraceSink;
  /** Leave this voucher out (the voucher being altered, for entry-time cost estimates). */
  excludeVoucherId?: number | null;
}

/** Number of engine replays run in this process — a test probe for "one replay per request". */
let replays = 0;
export function stockReplayCount(): number {
  return replays;
}

// ───────────────────────────── Memo ─────────────────────────────
//
// Reports ask for the same stock values again and again (Balance Sheet → P&L → Balance Sheet; the
// Gateway's gross profit). Results are kept per open database while its data has not changed —
// keyed on Db.dataRevision() (rows written through this connection or commits by any other one; any
// write, even one rolled back, invalidates) and never filled inside a transaction. Value points are
// numbers; full results are deep-frozen (callers read them, never mutate a shared copy).

interface Memo {
  rev: string;
  points: Map<string, number>;
  results: Array<{ key: string; value: StockValuationResult }>;
}
const MEMO = new WeakMap<Db, Memo>();
const MEMO_RESULTS = 4;
const MEMO_POINTS = 512;

function memoOf(db: Db): Memo | null {
  const rev = db.dataRevision();
  if (rev === null) return null;
  let m = MEMO.get(db);
  if (!m || m.rev !== rev) {
    m = { rev, points: new Map(), results: [] };
    MEMO.set(db, m);
  }
  return m;
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/**
 * Stock summary for a period: per item opening / inward / outward / closing quantity and value,
 * using each item's costing method (see the top of this file), plus value totals. The result is
 * shared (memo) and frozen — copy before changing it.
 */
export function computeStockValuation(db: Db, opts: StockValuationOptions): StockValuationResult {
  const memo = memoOf(db);
  const key = JSON.stringify([
    opts.from,
    opts.to,
    opts.today,
    opts.godownId ?? null,
    opts.includeSubGodowns === true,
    opts.itemIds ? [...new Set(opts.itemIds)].sort((a, b) => a - b) : null,
  ]);
  const hit = memo?.results.find((e) => e.key === key);
  if (hit) return hit.value;
  const value = deepFreeze(replay(db, opts).result);
  if (memo) memo.results = [{ key, value }, ...memo.results].slice(0, MEMO_RESULTS);
  return value;
}

function replay(db: Db, opts: ReplayOptions): { result: StockValuationResult; states: Map<number, CostState>; cuts: Map<string, number> } {
  replays++;
  const { from, to, today } = opts;
  const godownId = opts.godownId ?? null;
  const requested = opts.itemIds ? [...new Set(opts.itemIds)] : null;
  const closure = requested ? dependencyClosure(db, requested, to) : null;
  const ids = closure ? jsonIds([...closure]) : '[]';
  const main = db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? null;
  const booksBegin = db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? '';
  const godowns = godownId === null ? null : godownSet(db, godownId, opts.includeSubGodowns === true);
  const inGodown = (g: number | null): boolean => godowns !== null && g !== null && godowns.has(g);
  const indexed = closure !== null && closure.size * INDEXED_SHARE <= (db.value<number>('SELECT COUNT(*) FROM stock_items') ?? 0);
  const thirdParty = thirdPartyGodowns(db);
  const isThird = (g: number | null): boolean => thirdParty.size > 0 && g !== null && thirdParty.has(g);

  const items = closure ? db.all<ItemInfo>(ITEMS_SOME_SQL, { ids }) : db.all<ItemInfo>(ITEMS_ALL_SQL);
  const states = new Map<number, CostState>();
  const accs = new Map<number, Acc>();
  const layered = new Set<number>();
  for (const it of items) {
    states.set(it.id, newState(it));
    accs.set(it.id, { openQty: 0, openValue: 0, inQty: 0, inValue: 0, outQty: 0, outValue: 0, gQty: 0, gQty3: 0, enteredValue: 0, moved: false });
    const m = methodOf(it);
    if (m === 'fifo' || m === 'lifo') layered.add(it.id);
  }

  // Opening stock: each row is a separate layer (FIFO/LIFO, in entry order); for the other methods
  // the rows are taken together, so Last Purchase starts from the weighted opening rate rather than
  // whichever row happens to be last.
  const openings = closure
    ? db.all<{ item_id: number; godown_id: number; qty: number; value: number }>(OPENINGS_SOME_SQL, { ids })
    : db.all<{ item_id: number; godown_id: number; qty: number; value: number }>(OPENINGS_ALL_SQL);
  const pooled = new Map<number, { qty: number; value: number }>();
  for (const o of openings) {
    const st = states.get(o.item_id);
    if (!st) continue;
    const acc = accs.get(o.item_id) as Acc;
    if (isThird(o.godown_id)) {
      // A principal's goods with us: quantity only, never our value.
      if (inGodown(o.godown_id)) acc.gQty3 += o.qty;
      continue;
    }
    acc.enteredValue += Number(o.value);
    if (inGodown(o.godown_id)) acc.gQty += o.qty;
    if (layered.has(o.item_id)) {
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

  const trace = opts.trace ?? null;
  const read = db.all<Movement>(movementSql(indexed, trace !== null), indexed ? { to, today, main, ids } : { to, today, main });
  const exclude = opts.excludeVoucherId ?? null;
  const movements = exclude === null ? read : read.filter((m) => m.voucher_id !== exclude);
  const journalIds: number[] = [];
  for (let k = 0; k < movements.length; k++) {
    const m = movements[k];
    if (m.base_type === 'stock_journal' && (k === 0 || movements[k - 1].voucher_id !== m.voucher_id)) journalIds.push(m.voucher_id);
  }
  const journalTerms = loadJournalTerms(db, journalIds);

  let openingTaken = false;
  const takeOpening = (): void => {
    openingTaken = true;
    for (const it of items) {
      const st = states.get(it.id) as CostState;
      const acc = accs.get(it.id) as Acc;
      if (godownId === null) {
        acc.openQty = st.qty;
        // At the books beginning the opening stock is worth what was entered in the item masters,
        // whatever the costing method (Last Purchase / Standard Cost would otherwise re-price it
        // and the Balance Sheet's opening stock would not match the masters).
        acc.openValue = from <= booksBegin && !acc.moved ? acc.enteredValue : st.value();
      } else {
        acc.openQty = acc.gQty + acc.gQty3;
        acc.openValue = roundPaise(acc.gQty * unitValue(st));
      }
    }
  };

  // Whole-company value points, in date order ('open d' before 'close d'). The value of each is what
  // computeStockValuation({ from: d, to: d }) reports as the opening / closing total.
  const cuts = [...(opts.cuts ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'open' ? -1 : 1));
  const cutValues = new Map<string, number>();
  let nextCut = 0;
  /** Take every pending cut that lies before a voucher dated `date` (null: the end of the replay). */
  const takeCuts = (date: string | null): void => {
    while (nextCut < cuts.length) {
      const c = cuts[nextCut];
      if (date !== null && (c.kind === 'open' ? date < c.date : date <= c.date)) return;
      let sum = 0;
      for (const it of items) {
        if (it.is_service === 1) continue;
        const st = states.get(it.id) as CostState;
        const acc = accs.get(it.id) as Acc;
        sum += c.kind === 'open' && c.date <= booksBegin && !acc.moved ? acc.enteredValue : st.value();
      }
      cutValues.set(`${c.kind}:${c.date}`, sum);
      nextCut++;
    }
  };

  // Trace: cost of every movement of the traced items and their closing at the end of each day.
  const touched = new Set<number>();
  const traceValue = (m: Movement, value: number): void => {
    if (trace === null || !trace.items.has(m.item_id)) return;
    trace.values.set(m.id, value);
    touched.add(m.item_id);
  };
  const closeDay = (date: string): void => {
    if (trace === null) return;
    if (date >= trace.from) {
      for (const itemId of touched) {
        const st = states.get(itemId) as CostState;
        const acc = accs.get(itemId) as Acc;
        let days = trace.closing.get(itemId);
        if (!days) {
          days = new Map();
          trace.closing.set(itemId, days);
        }
        days.set(
          date,
          godownId === null
            ? { qty: roundQty(st.qty), value: st.value() }
            : { qty: roundQty(acc.gQty + acc.gQty3), value: roundPaise(acc.gQty * unitValue(st)) },
        );
      }
    }
    touched.clear();
  };

  const record = (m: Movement, value: number): void => {
    if (m.date < from) return;
    if (godownId !== null && !inGodown(m.godown_id)) return;
    const acc = accs.get(m.item_id) as Acc;
    if (m.qty > 0) {
      acc.inQty += m.qty;
      acc.inValue += value;
    } else {
      acc.outQty += -m.qty;
      acc.outValue += value;
    }
  };

  const apply = (m: Movement, value: number | null): void => {
    const st = states.get(m.item_id);
    if (!st) return;
    let v: number;
    if (m.qty < 0) {
      v = st.issue(-m.qty);
    } else {
      const priced = value !== null;
      v = value ?? roundPaise(m.qty * st.currentCost());
      st.receive(m.qty, v, priced);
    }
    const acc = accs.get(m.item_id) as Acc;
    acc.moved = true;
    if (inGodown(m.godown_id)) acc.gQty += m.qty;
    record(m, v);
    traceValue(m, v);
  };

  /** A movement in a principal's godown (job work): quantity in godown mode only, at value 0. */
  const applyThird = (m: Movement): void => {
    if (!states.has(m.item_id) || m.qty === 0 || godownId === null || !inGodown(m.godown_id)) return;
    (accs.get(m.item_id) as Acc).gQty3 += m.qty;
    record(m, 0);
    traceValue(m, 0);
  };

  let i = 0;
  while (i < movements.length) {
    const first = movements[i];
    let j = i;
    while (j < movements.length && movements[j].voucher_id === first.voucher_id) j++;
    let lines = movements.slice(i, j);
    i = j;
    if (nextCut < cuts.length) takeCuts(first.date);
    if (!openingTaken && first.date >= from) takeOpening();
    if (thirdParty.size > 0) {
      const own: Movement[] = [];
      for (const m of lines) {
        if (isThird(m.godown_id)) applyThird(m);
        else own.push(m);
      }
      lines = own;
    }

    if (first.base_type === 'stock_journal') {
      const consumption = lines.filter((m) => m.qty < 0);
      const production = lines.filter((m) => m.qty > 0);
      let consumed = 0;
      const issued: Array<{ lineNo: number; qty: number; cost: number }> = [];
      for (const m of consumption) {
        const st = states.get(m.item_id);
        if (!st) continue;
        const cost = st.issue(-m.qty);
        consumed += cost;
        issued.push({ lineNo: m.line_no, qty: -m.qty, cost });
        const acc = accs.get(m.item_id) as Acc;
        acc.moved = true;
        if (inGodown(m.godown_id)) acc.gQty += m.qty;
        record(m, cost);
        traceValue(m, cost);
      }
      const terms = journalTerms.get(first.voucher_id);
      if (terms) {
        // Manufacturing / job work journal: the costing rule of shared/mfg/costing.ts.
        const res = costJournal({
          consumption: issued,
          production: production.map((m) => ({ lineNo: m.line_no, qty: m.qty, amount: ownAmount(m) })),
          terms: terms.lines,
          additional: terms.additional,
        });
        for (const m of production) apply(m, res.values.get(m.line_no) ?? null);
      } else {
        const explicit = production.filter((m) => ownAmount(m) > 0);
        const implicit = production.filter((m) => ownAmount(m) <= 0);
        const pool = Math.max(0, consumed - explicit.reduce((s, m) => s + ownAmount(m), 0));
        const shares = consumption.length > 0 ? allocate(pool, implicit.map((m) => m.qty)) : null;
        for (const m of explicit) apply(m, ownAmount(m));
        implicit.forEach((m, k) => apply(m, shares ? shares[k] : null));
      }
    } else {
      for (const m of lines) {
        if (m.qty === 0) continue;
        if (m.qty < 0 || AT_COST_INWARD.has(m.base_type)) apply(m, null);
        else apply(m, ownAmount(m));
      }
    }
    if (trace !== null && (i >= movements.length || movements[i].date !== first.date)) closeDay(first.date);
  }
  takeCuts(null);
  if (!openingTaken) takeOpening();

  if (trace !== null) {
    for (const m of movements) {
      if (m.qty === 0 || m.date < trace.from || !trace.items.has(m.item_id) || !states.has(m.item_id)) continue;
      if (godowns !== null && !inGodown(m.godown_id)) continue;
      // A principal's goods with us are not our stock: listed only for that godown (at value 0).
      if (godowns === null && isThird(m.godown_id)) continue;
      trace.movements.push({
        id: m.id,
        voucherId: m.voucher_id,
        lineNo: m.line_no,
        itemId: m.item_id,
        godownId: m.godown_id,
        batchName: m.batch_name ?? null,
        qty: Number(m.qty),
        amount: Number(m.amount),
        rate: Number(m.rate),
        discountPct: Number(m.discount_pct ?? 0),
        date: m.date,
        baseType: m.base_type,
      });
    }
  }

  const wanted = requested ? new Set(requested) : null;
  const rows: StockValuationRow[] = [];
  const totals = { openingValue: 0, inwardValue: 0, outwardValue: 0, closingValue: 0 };
  for (const it of items) {
    if (wanted ? !wanted.has(it.id) : it.is_service === 1) continue;
    const st = states.get(it.id) as CostState;
    const acc = accs.get(it.id) as Acc;
    const closeQty = godownId === null ? st.qty : acc.gQty + acc.gQty3;
    const closeValue = godownId === null ? st.value() : roundPaise(acc.gQty * unitValue(st));
    const row: StockValuationRow = {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      groupId: it.group_id,
      costingMethod: methodOf(it),
      opening: { qty: roundQty(acc.openQty), value: acc.openValue },
      inward: { qty: roundQty(acc.inQty), value: acc.inValue },
      outward: { qty: roundQty(acc.outQty), value: acc.outValue },
      closing: {
        qty: roundQty(closeQty),
        value: closeValue,
        rate: Math.abs(closeQty) > EPS ? roundTo(closeValue / closeQty / 100, 4) : 0,
      },
    };
    const allZero =
      row.opening.qty === 0 &&
      row.opening.value === 0 &&
      row.inward.qty === 0 &&
      row.inward.value === 0 &&
      row.outward.qty === 0 &&
      row.outward.value === 0 &&
      row.closing.qty === 0 &&
      row.closing.value === 0;
    if (allZero && !wanted) continue;
    rows.push(row);
    totals.openingValue += row.opening.value;
    totals.inwardValue += row.inward.value;
    totals.outwardValue += row.outward.value;
    totals.closingValue += row.closing.value;
  }
  return { result: { from, to, godownId, rows, totals }, states, cuts: cutValues };
}

/** Value per unit of what is on hand (paise): V/Q when Q > 0, otherwise the current cost. */
function unitValue(st: CostState): number {
  return st.qty > EPS ? st.value() / st.qty : st.currentCost();
}

// ───────────────────────────── Whole-company value points ─────────────────────────────

export interface StockValuePoints {
  /** Value of all stock at the START of each requested date (= openingStockValue). */
  opening: Map<string, number>;
  /** Value of all stock at the END of each requested date (= closingStockValue). */
  closing: Map<string, number>;
}

/**
 * Whole-company stock values at several dates from ONE replay (P&L: opening at `from` and closing at
 * `to`; Balance Sheet: year-start opening and closing at `asOf`; the books-beginning opening) —
 * each figure equal to openingStockValue / closingStockValue for that date. Memoised per database
 * revision, so moving between reports does not replay again.
 */
export function stockValuesAt(db: Db, q: { opening?: readonly string[]; closing?: readonly string[]; today: string }): StockValuePoints {
  const out: StockValuePoints = { opening: new Map(), closing: new Map() };
  const memo = memoOf(db);
  const missing: Cut[] = [];
  const want = (kind: 'open' | 'close', date: string): void => {
    const hit = memo?.points.get(`${q.today}|${kind}:${date}`);
    if (hit !== undefined) (kind === 'open' ? out.opening : out.closing).set(date, hit);
    else if (!missing.some((c) => c.kind === kind && c.date === date)) missing.push({ kind, date });
  };
  for (const d of q.opening ?? []) want('open', d);
  for (const d of q.closing ?? []) want('close', d);
  if (missing.length === 0) return out;
  // Replay only as far as the latest point needs: an opening at d needs the movements before d.
  let to = '';
  for (const c of missing) {
    const need = c.kind === 'open' ? addDays(c.date, -1) : c.date;
    if (need > to) to = need;
  }
  const { cuts } = replay(db, { from: to, to, today: q.today, cuts: missing });
  if (memo && memo.points.size + missing.length > MEMO_POINTS) memo.points.clear();
  for (const c of missing) {
    const v = cuts.get(`${c.kind}:${c.date}`) ?? 0;
    (c.kind === 'open' ? out.opening : out.closing).set(c.date, v);
    memo?.points.set(`${q.today}|${c.kind}:${c.date}`, v);
  }
  return out;
}

/** Closing stock value (paise) of all items as at the end of `asOf` — for P&L / Balance Sheet. */
export function closingStockValue(
  db: Db,
  opts: { asOf: string; today: string; godownId?: number | null; includeSubGodowns?: boolean },
): number {
  if (opts.godownId === undefined || opts.godownId === null) return stockValuesAt(db, { closing: [opts.asOf], today: opts.today }).closing.get(opts.asOf) ?? 0;
  return computeStockValuation(db, { ...opts, from: opts.asOf, to: opts.asOf }).totals.closingValue;
}

/**
 * Opening stock value (paise) at the start of `from` (opening stock + movements before `from`).
 * On or before the books beginning this is the opening stock as entered in the item masters.
 */
export function openingStockValue(
  db: Db,
  opts: { from: string; today: string; godownId?: number | null; includeSubGodowns?: boolean },
): number {
  if (opts.godownId === undefined || opts.godownId === null) return stockValuesAt(db, { opening: [opts.from], today: opts.today }).opening.get(opts.from) ?? 0;
  return computeStockValuation(db, { ...opts, to: opts.from }).totals.openingValue;
}

/**
 * Current cost per base unit of one item (rupees) as at the end of `asOf` — what an outward or a
 * return would be valued at. Useful for stock journals and physical stock entry screens.
 */
export function currentUnitCost(db: Db, opts: { itemId: number; asOf: string; today: string }): number {
  const { states } = replay(db, { from: opts.asOf, to: opts.asOf, today: opts.today, itemIds: [opts.itemId] });
  const st = states.get(opts.itemId);
  return st ? roundTo(st.currentCost() / 100, 4) : 0;
}

/**
 * Entry-time estimate (mfg module): the cost at which each line would be issued as at the end of
 * `asOf` — the item's costing method applied to its stock at that point, lines of the same item taken
 * one after another, the voucher being altered left out. Lines in a principal's godown cost 0.
 */
export function estimateIssueCosts(
  db: Db,
  opts: { asOf: string; today: string; excludeVoucherId?: number | null; lines: ReadonlyArray<{ itemId: number; qty: number; godownId?: number | null }> },
): number[] {
  if (opts.lines.length === 0) return [];
  const itemIds = [...new Set(opts.lines.map((l) => l.itemId))];
  const { states } = replay(db, { from: opts.asOf, to: opts.asOf, today: opts.today, itemIds, excludeVoucherId: opts.excludeVoucherId ?? null });
  const third = thirdPartyGodowns(db);
  return opts.lines.map((l) => {
    if (l.godownId !== undefined && l.godownId !== null && third.has(l.godownId)) return 0;
    const st = states.get(l.itemId);
    return st && l.qty > 0 ? st.issue(l.qty) : 0;
  });
}

// ───────────────────────────── Per-movement trace ─────────────────────────────

export interface StockTraceOptions extends StockValuationOptions {
  /** Items whose movements are traced (they must be valued: within `itemIds` when that is given). */
  traceItemIds: readonly number[];
  /** Movements and day closings from this date (default `from`). */
  traceFrom?: string;
}

export interface StockTraceResult {
  /** The valuation for the options (as computeStockValuation). */
  valuation: StockValuationResult;
  /** Stock-moving lines of the traced items in [traceFrom, to] (godown scope when given), replay order. */
  movements: TracedMovement[];
  /** Cost value (paise, unsigned) of each traced line, by inventory_entries id — the engine's own figure. */
  values: Map<number, number>;
  /** Closing per traced item at the end of each day in [traceFrom, to] with one of its movements. */
  closing: Map<number, Map<string, DayClose>>;
}

/**
 * The valuation AND the cost of every movement of the traced items from the same single replay
 * (item ledger, profitability, FIFO ageing, physical variance). Per-line values are exactly what
 * the engine applied, so they add up to the valuation's inward / outward values by construction.
 */
export function traceStockMovements(db: Db, opts: StockTraceOptions): StockTraceResult {
  const sink: TraceSink = { items: new Set(opts.traceItemIds), from: opts.traceFrom ?? opts.from, movements: [], values: new Map(), closing: new Map() };
  const { result } = replay(db, { ...opts, trace: sink });
  return { valuation: result, movements: sink.movements, values: sink.values, closing: sink.closing };
}
