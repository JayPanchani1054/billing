/**
 * Balance engine shared by every report in this module.
 *
 *  - `loadReportEnv(db, today)`  company essentials, the group tree and every ledger (one query each)
 *  - `yearStartOf(env, date)`    start of the financial year containing `date` (never before the books)
 *  - `ledgerSums(env, q)`        ONE aggregate query over ledger_entries (books filter) per ledger
 *  - `buildSnapshot(env, q)`     Trial-Balance style per-ledger / per-group opening, Dr, Cr, closing with
 *                                the conventional year-end treatment of nominal ledgers (see README §1)
 *  - `stockAt(env, date)`        value of stock at the START of `date` (integrated inventory only)
 *  - `prepareStock(env, q)`      fetch several stock values with ONE valuation replay (call it first
 *                                when a report needs more than one; the inventory module also keeps
 *                                them across requests until the books change)
 *
 * Money: integer paise, Dr + / Cr −; `debit` / `credit` are unsigned period totals.
 */
import type { GroupCode } from '../../../shared/constants.ts';
import { addDays, financialYear } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER, loadGroupTree, type GroupTree, type GroupTreeNode } from '../accounts/books.ts';
import { getFeatures } from '../company/service.ts';
import { stockValuesAt } from '../inventory/index.ts';
import { loadScenario, scenarioAdjust, type ScenarioDef } from './scenario.ts';

export interface LedgerMeta {
  id: number;
  name: string;
  alias: string | null;
  groupId: number;
  reservedCode: string | null;
  openingBalance: Paise;
  isActive: boolean;
  /** Ledger sits under an income / expense group: its balance closes into the P&L A/c every year. */
  isNominal: boolean;
}

export interface ReportEnv {
  db: Db;
  today: string;
  booksFrom: string;
  fyStartMonth: number;
  /** F11 inventory + "integrate accounts with inventory": closing stock comes from the stock valuation. */
  integrated: boolean;
  tree: GroupTree;
  ledgers: LedgerMeta[];
  ledgerById: Map<number, LedgerMeta>;
  /** Reserved 'Profit & Loss A/c' ledger (null if it was somehow removed). */
  plLedgerId: number | null;
  groupByCode: Map<GroupCode, number>;
  /** Memo of stock values by date (valuation replays are not cheap). */
  stockMemo: Map<string, Paise>;
  /** Scenario the report runs under (scenario.ts): changes which vouchers ledgerSums counts. */
  scenario?: ScenarioDef | null;
}

interface LedgerDbRow {
  id: number;
  name: string;
  alias: string | null;
  group_id: number;
  reserved_code: string | null;
  opening_balance: number;
  is_active: number;
}

/** Load everything a report needs about the company's masters (a handful of small queries). */
export function loadReportEnv(db: Db, today: string, opts: { scenarioId?: number } = {}): ReportEnv {
  const company = db.get<{ books_from: string; fy_start_month: number }>('SELECT books_from, fy_start_month FROM company WHERE id = 1');
  const booksFrom = company?.books_from ?? today;
  const fyStartMonth = company?.fy_start_month ?? 4;
  const features = getFeatures(db);
  const tree = loadGroupTree(db);
  const ledgers: LedgerMeta[] = [];
  const ledgerById = new Map<number, LedgerMeta>();
  let plLedgerId: number | null = null;
  for (const r of db.all<LedgerDbRow>('SELECT id, name, alias, group_id, reserved_code, opening_balance, is_active FROM ledgers ORDER BY name COLLATE NOCASE, id')) {
    const g = tree.byId.get(r.group_id);
    const meta: LedgerMeta = {
      id: r.id,
      name: r.name,
      alias: r.alias,
      groupId: r.group_id,
      reservedCode: r.reserved_code,
      openingBalance: r.opening_balance,
      isActive: r.is_active === 1,
      isNominal: g ? g.cls.isIncome || g.cls.isExpense : false,
    };
    ledgers.push(meta);
    ledgerById.set(r.id, meta);
    if (r.reserved_code === 'PROFIT_LOSS') plLedgerId = r.id;
  }
  const groupByCode = new Map<GroupCode, number>();
  for (const g of tree.byId.values()) if (g.reservedCode) groupByCode.set(g.reservedCode, g.id);
  return {
    db,
    today,
    booksFrom,
    fyStartMonth,
    integrated: features.inventory && features.integrateInventory,
    tree,
    ledgers,
    ledgerById,
    plLedgerId,
    groupByCode,
    stockMemo: new Map(),
    scenario: opts.scenarioId !== undefined ? loadScenario(db, opts.scenarioId) : null,
  };
}

/** VALIDATION when the period is reversed. */
export function assertPeriod(from: string, to: string, path = 'to'): void {
  if (from > to) throw validation([{ path, message: 'The period ends before it starts. Choose an end date on or after the start date.' }]);
}

/** Start of the financial year containing `date`, never before the books beginning. */
export function yearStartOf(env: ReportEnv, date: string): string {
  const fy = financialYear(date, env.fyStartMonth).start;
  return fy < env.booksFrom ? env.booksFrom : fy;
}

/**
 * Make the stock values at the START of each `opening` date and at the END of each `closing` date
 * available to stockAt / stockAtEnd, computing every missing one in ONE valuation replay. The opening
 * stock at the books beginning (Difference in opening balances, profit brought forward) always comes
 * along — it costs nothing extra in the same pass. No-op when inventory is not integrated.
 */
export function prepareStock(env: ReportEnv, q: { opening?: readonly string[]; closing?: readonly string[] }): void {
  if (!env.integrated) return;
  const opening = [...new Set([env.booksFrom, ...(q.opening ?? [])])].filter((d) => !env.stockMemo.has(`o:${d}`));
  const closing = [...new Set(q.closing ?? [])].filter((d) => !env.stockMemo.has(`c:${d}`));
  if (opening.length === 0 && closing.length === 0) return;
  const v = stockValuesAt(env.db, { opening, closing, today: env.today });
  for (const [d, x] of v.opening) env.stockMemo.set(`o:${d}`, x);
  for (const [d, x] of v.closing) env.stockMemo.set(`c:${d}`, x);
}

/** Value of stock at the START of `date` (= closing value of the previous day); 0 when not integrated. */
export function stockAt(env: ReportEnv, date: string): Paise {
  if (!env.integrated) return 0;
  prepareStock(env, { opening: [date] });
  return env.stockMemo.get(`o:${date}`) ?? 0;
}

/** Value of stock at the END of `date`; 0 when not integrated. */
export function stockAtEnd(env: ReportEnv, date: string): Paise {
  if (!env.integrated) return 0;
  prepareStock(env, { closing: [date] });
  return env.stockMemo.get(`c:${date}`) ?? 0;
}

/** Opening stock at the books beginning (S0 in the README). */
export function openingStockAtBooks(env: ReportEnv): Paise {
  return stockAt(env, env.booksFrom);
}

export interface LedgerSums {
  /** Σ entries dated before `cf`. */
  pre: Paise;
  /** Σ entries dated in [cf, from). */
  before: Paise;
  /** Σ debits in [from, to]. */
  dr: Paise;
  /** Σ |credits| in [from, to]. */
  cr: Paise;
}

const ZERO_SUMS: LedgerSums = { pre: 0, before: 0, dr: 0, cr: 0 };

const LEDGER_SUMS_COLUMNS = `SELECT ledger_id,
            SUM(CASE WHEN date < :cf THEN amount ELSE 0 END) AS pre,
            SUM(CASE WHEN date >= :cf AND date < :from THEN amount ELSE 0 END) AS before,
            SUM(CASE WHEN date >= :from AND amount > 0 THEN amount ELSE 0 END) AS dr,
            SUM(CASE WHEN date >= :from AND amount < 0 THEN -amount ELSE 0 END) AS cr
       FROM ledger_entries`;
/** Every ledger: one pass over the books-filter covering index. */
const LEDGER_SUMS_ALL_SQL = `${LEDGER_SUMS_COLUMNS} WHERE date <= :to AND ${BOOKS_FILTER()} GROUP BY ledger_id`;
/** Some ledgers: a range of the (ledger_id, date, …) covering index per ledger — milliseconds for a drill-down. */
const LEDGER_SUMS_SOME_SQL = `${LEDGER_SUMS_COLUMNS} INDEXED BY idx_le_books
      WHERE ledger_id IN (SELECT value FROM json_each(:ids)) AND date <= :to AND ${BOOKS_FILTER()} GROUP BY ledger_id`;

/**
 * One aggregate query over ledger_entries (books filter, `date <= to`), grouped by ledger — every
 * ledger, or only `ledgerIds`. Requires cf ≤ from ≤ to. Ledgers without entries are absent from the map.
 */
export function ledgerSums(env: ReportEnv, q: { cf: string; from: string; to: string; ledgerIds?: readonly number[] }): Map<number, LedgerSums> {
  const out = new Map<number, LedgerSums>();
  const params = { cf: q.cf, from: q.from, to: q.to, today: env.today };
  // A scenario adds provisional vouchers / removes excluded types, or replaces the books (scenario.ts).
  const adj = env.scenario ? scenarioAdjust(env.db, env.scenario, { ...q, today: env.today }) : null;
  if (adj) {
    for (const [id, d] of adj.delta) out.set(id, { ...d });
    if (adj.dropBooks) return out;
  }
  for (const r of env.db.all<{ ledger_id: number; pre: number | null; before: number | null; dr: number | null; cr: number | null }>(
    q.ledgerIds ? LEDGER_SUMS_SOME_SQL : LEDGER_SUMS_ALL_SQL,
    q.ledgerIds ? { ...params, ids: JSON.stringify(q.ledgerIds.filter((n) => Number.isSafeInteger(n))) } : params,
  )) {
    const d = out.get(r.ledger_id);
    out.set(r.ledger_id, { pre: (r.pre ?? 0) + (d?.pre ?? 0), before: (r.before ?? 0) + (d?.before ?? 0), dr: (r.dr ?? 0) + (d?.dr ?? 0), cr: (r.cr ?? 0) + (d?.cr ?? 0) });
  }
  return out;
}

export interface Balance {
  opening: Paise;
  debit: Paise;
  credit: Paise;
  closing: Paise;
}

export interface GroupBalance extends Balance {
  ledgerCount: number;
}

/**
 * Trial-Balance balances. The stock-dependent parts — `retained`, `openingStock`,
 * `openingDifference` and the Profit & Loss A/c ledger's opening / closing (which carry `retained`)
 * — are computed on first read, so a report that never looks at them (a ledger or a group drill-down)
 * never pays for a stock valuation.
 */
export interface Snapshot {
  readonly from: string;
  readonly to: string;
  /** Carry-forward date: nominal ledgers start here; their earlier results are in the P&L A/c. */
  readonly yearStart: string;
  /** Every ledger (or only the requested `ledgerIds`). */
  readonly ledgers: Map<number, Balance>;
  /** Rolled up over sub-groups (the reserved Profit & Loss A/c ledger is left out of every group). With `ledgerIds`, only those ledgers are summed. */
  readonly groups: Map<number, GroupBalance>;
  /** Profit of the years before `yearStart` (Cr-signed: negative = profit), added to the P&L A/c ledger. */
  readonly retained: Paise;
  /** Stock value at the start of `yearStart` (the Trial Balance's Opening Stock). */
  readonly openingStock: Paise;
  /** −(Σ ledger openings + opening stock at the books beginning). */
  readonly openingDifference: Paise;
}

const zeroBalance = (): GroupBalance => ({ opening: 0, debit: 0, credit: 0, closing: 0, ledgerCount: 0 });

/** −(Σ ledger opening balances + opening stock at the books beginning): the "Difference in opening balances". */
export function openingDifference(env: ReportEnv): Paise {
  let sum = 0;
  for (const l of env.ledgers) sum += l.openingBalance;
  // `0 - x` (not `-x`) so a balanced company reports 0, never -0.
  return 0 - (sum + openingStockAtBooks(env));
}

/**
 * Trial-Balance balances for [from, to] with the conventional year-end treatment:
 *  - real (asset/liability) ledgers: opening = opening balance + every entry before `from`;
 *  - nominal (income/expense) ledgers start again at the financial year containing `from`
 *    (`yearStart`): opening = entries in [yearStart, from) (+ their opening balance in the first year);
 *  - everything a nominal ledger accumulated before `yearStart`, less the stock movement over those
 *    years, is the profit brought forward — added to the opening/closing of the 'Profit & Loss A/c'.
 * `yearStart` may be forced (Balance Sheet uses the year of `asOf`).
 */
export function buildSnapshot(env: ReportEnv, q: { from: string; to: string; yearStart?: string; ledgerIds?: readonly number[] }): Snapshot {
  assertPeriod(q.from, q.to);
  const cf = q.yearStart ?? yearStartOf(env, q.from);
  const from = q.from < cf ? cf : q.from;
  // The P&L A/c carries the results of every earlier year (all nominal ledgers): a subset that
  // includes it is computed in full.
  const only = q.ledgerIds && !(env.plLedgerId !== null && q.ledgerIds.includes(env.plLedgerId)) ? new Set(q.ledgerIds) : null;
  const sums = ledgerSums(env, only ? { cf, from, to: q.to, ledgerIds: [...only] } : { cf, from, to: q.to });
  const firstYear = cf <= env.booksFrom;
  const ledgers = new Map<number, Balance>();
  let retainedNominal = 0;
  for (const l of env.ledgers) {
    if (only && !only.has(l.id)) continue;
    const s = sums.get(l.id) ?? ZERO_SUMS;
    let opening: number;
    if (l.isNominal) {
      opening = (firstYear ? l.openingBalance : 0) + s.before;
      retainedNominal += (firstYear ? 0 : l.openingBalance) + s.pre;
    } else {
      opening = l.openingBalance + s.pre + s.before;
    }
    ledgers.set(l.id, { opening, debit: s.dr, credit: s.cr, closing: opening + s.dr - s.cr });
  }
  // Stock-dependent parts, on first read (one valuation replay gives the year-start and the
  // books-beginning stock together).
  let stock: { openingStock: Paise; retained: Paise } | null = null;
  const stockParts = (): { openingStock: Paise; retained: Paise } => {
    if (!stock) {
      prepareStock(env, { opening: [cf] });
      const openingStock = stockAt(env, cf);
      stock = { openingStock, retained: firstYear ? 0 : retainedNominal - (openingStock - openingStockAtBooks(env)) };
    }
    return stock;
  };
  const plBase = env.plLedgerId !== null && !only ? ledgers.get(env.plLedgerId) : undefined;
  if (env.plLedgerId !== null && plBase) {
    const base = plBase;
    // Profit brought forward (needs the year-start stock only after the first year).
    const retained = (): Paise => (firstYear ? 0 : stockParts().retained);
    ledgers.set(env.plLedgerId, {
      get opening() {
        return base.opening + retained();
      },
      debit: base.debit,
      credit: base.credit,
      get closing() {
        return base.closing + retained();
      },
    });
  }
  const groups = new Map<number, GroupBalance>();
  for (const id of env.tree.order) groups.set(id, zeroBalance());
  for (const l of env.ledgers) {
    // The reserved Profit & Loss A/c is a primary line of its own (as accountants expect): it never rolls into the
    // group it is stored under (Capital Account), so a group's figures match its Balance Sheet line.
    if (l.id === env.plLedgerId) continue;
    const b = ledgers.get(l.id);
    const g = env.tree.byId.get(l.groupId);
    if (!b || !g) continue;
    for (const gid of g.chainIds) {
      const t = groups.get(gid) as GroupBalance;
      t.opening += b.opening;
      t.debit += b.debit;
      t.credit += b.credit;
      t.closing += b.closing;
      t.ledgerCount += 1;
    }
  }
  return {
    from,
    to: q.to,
    yearStart: cf,
    ledgers,
    groups,
    get retained() {
      return firstYear ? 0 : stockParts().retained;
    },
    get openingStock() {
      return stockParts().openingStock;
    },
    get openingDifference() {
      return openingDifference(env);
    },
  };
}

/**
 * P&L value (Dr-signed) of every nominal ledger for [from, to]: the period's movement, plus the
 * ledger's opening balance when the period contains the books beginning (a company that started its
 * books mid-year enters the year-to-date figures as opening balances; they belong to the first P&L).
 */
export function nominalMovement(env: ReportEnv, from: string, to: string): Map<number, Paise> {
  assertPeriod(from, to);
  const sums = ledgerSums(env, { cf: from, from, to });
  // Only the period that contains the books beginning gets the opening balances: a comparative
  // period wholly before the books (or a later one) must not count them a second time.
  const includeOb = from <= env.booksFrom && env.booksFrom <= to;
  const out = new Map<number, Paise>();
  for (const l of env.ledgers) {
    if (!l.isNominal) continue;
    const s = sums.get(l.id) ?? ZERO_SUMS;
    out.set(l.id, (includeOb ? l.openingBalance : 0) + s.dr - s.cr);
  }
  return out;
}

/** Roll Dr-signed per-ledger values up the group tree (every group, including empty ones). */
export function rollUp(env: ReportEnv, values: ReadonlyMap<number, Paise>): Map<number, Paise> {
  const out = new Map<number, Paise>();
  for (const id of env.tree.order) out.set(id, 0);
  for (const [ledgerId, v] of values) {
    if (v === 0) continue;
    const l = env.ledgerById.get(ledgerId);
    const g = l ? env.tree.byId.get(l.groupId) : undefined;
    if (!g) continue;
    for (const gid of g.chainIds) out.set(gid, (out.get(gid) ?? 0) + v);
  }
  return out;
}

/** Ids of every ledger under any of the groups (sub-groups included), the reserved Profit & Loss A/c excepted. */
export function ledgersUnder(env: ReportEnv, groupIds: readonly number[]): number[] {
  const out: number[] = [];
  for (const l of env.ledgers) {
    if (l.id === env.plLedgerId) continue;
    const g = env.tree.byId.get(l.groupId);
    if (g && groupIds.some((id) => g.chainIds.includes(id))) out.push(l.id);
  }
  return out;
}

/** Ledgers placed directly in each group, in name order (the reserved Profit & Loss A/c is not listed). */
export function ledgersByGroup(env: ReportEnv): Map<number, LedgerMeta[]> {
  const out = new Map<number, LedgerMeta[]>();
  for (const l of env.ledgers) {
    if (l.id === env.plLedgerId) continue;
    const list = out.get(l.groupId);
    if (list) list.push(l);
    else out.set(l.groupId, [l]);
  }
  return out;
}

/** Group node or a VALIDATION/NOT_FOUND style error for a report input. */
export function groupNode(env: ReportEnv, groupId: number): GroupTreeNode {
  const g = env.tree.byId.get(groupId);
  if (!g) throw validation([{ path: 'groupId', message: 'This group does not exist. It may have been deleted — pick another group.' }]);
  return g;
}

export function ledgerMeta(env: ReportEnv, ledgerId: number): LedgerMeta {
  const l = env.ledgerById.get(ledgerId);
  if (!l) throw validation([{ path: 'ledgerId', message: 'This ledger does not exist. It may have been deleted — pick another ledger.' }]);
  return l;
}

/** Month slices of [from, to]: { month: 'YYYY-MM', from, to } clipped to the period. */
export function monthSlices(from: string, to: string): Array<{ month: string; from: string; to: string }> {
  const out: Array<{ month: string; from: string; to: string }> = [];
  let cur = from;
  while (cur <= to) {
    const y = Number(cur.slice(0, 4));
    const m = Number(cur.slice(5, 7));
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = addDays(next, -1);
    out.push({ month: cur.slice(0, 7), from: cur, to: end < to ? end : to });
    cur = next;
  }
  return out;
}

/** Number of days in [from, to] inclusive. */
export function daysIn(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
