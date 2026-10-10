/**
 * Profit & Loss A/c and Balance Sheet (conventional horizontal layout + Schedule III-style vertical P&L).
 * See README §5–§6 for the layout rules and the proof that the Balance Sheet balances.
 */
import { addDays, addMonths, daysInMonth, endOfMonth, parts } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BalanceSheetInput,
  BalanceSheetResult,
  CompareWith,
  ProfitFigures,
  ProfitLossInput,
  ProfitLossResult,
  ProfitTrendInput,
  ProfitTrendMonth,
  ProfitTrendResult,
  StatementBlock,
  StatementLine,
  VerticalLine,
} from '../../../shared/types/reports.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import {
  assertPeriod,
  buildSnapshot,
  daysIn,
  ledgersByGroup,
  monthSlices,
  nominalMovement,
  prepareStock,
  stockAt,
  stockAtEnd,
  yearStartOf,
  type ReportEnv,
} from './engine.ts';

// ───────────────────────────── Generic statement tree ─────────────────────────────

/** A value line that is not a ledger (closing stock) placed inside a group; Dr-signed. */
export interface ExtraValue {
  groupId: number;
  key: string;
  name: string;
  kind: StatementLine['kind'];
  cur: Paise;
  cmp: Paise | null;
}

interface TreeInput {
  /** Dr-signed value per ledger (missing = 0). */
  cur: ReadonlyMap<number, Paise>;
  cmp: ReadonlyMap<number, Paise> | null;
  /** +1: Dr is natural (expenses, assets) · −1: Cr is natural (income, liabilities). */
  sign: 1 | -1;
  skipLedger?: (ledgerId: number) => boolean;
  extras?: readonly ExtraValue[];
}

export interface StatementTree {
  lines: StatementLine[];
  /** Side-natural group totals (current, compare) by group id. */
  groupTotal: (groupId: number) => [Paise, Paise | null];
}

/**
 * Lines for the given root groups (pre-order: group, sub-groups, ledgers, extras). A line is shown
 * when its amount or comparative amount is non-zero, or when any line below it is shown.
 */
export function statementTree(env: ReportEnv, rootIds: readonly number[], t: TreeInput): StatementTree {
  const curG = new Map<number, Paise>();
  const cmpG = new Map<number, Paise>();
  const addUp = (groupId: number, c: Paise, p: Paise): void => {
    const g = env.tree.byId.get(groupId);
    if (!g) return;
    for (const gid of g.chainIds) {
      curG.set(gid, (curG.get(gid) ?? 0) + c);
      cmpG.set(gid, (cmpG.get(gid) ?? 0) + p);
    }
  };
  const byGroup = ledgersByGroup(env);
  for (const l of env.ledgers) {
    if (t.skipLedger?.(l.id)) continue;
    addUp(l.groupId, t.cur.get(l.id) ?? 0, t.cmp?.get(l.id) ?? 0);
  }
  for (const x of t.extras ?? []) addUp(x.groupId, x.cur, x.cmp ?? 0);
  const hasCmp = t.cmp !== null;
  const nat = (v: Paise): Paise => (t.sign === 1 ? v : neg(v));
  const lines: StatementLine[] = [];
  const emit = (groupId: number, level: number, parentKey: string | null): void => {
    const g = env.tree.byId.get(groupId);
    if (!g) return;
    const key = `g:${groupId}`;
    const row: StatementLine = {
      key,
      kind: 'group',
      id: groupId,
      name: g.name,
      level,
      parentKey,
      hasChildren: false,
      amount: nat(curG.get(groupId) ?? 0),
      compare: hasCmp ? nat(cmpG.get(groupId) ?? 0) : null,
    };
    const at = lines.length;
    lines.push(row);
    for (const c of g.childIds) emit(c, level + 1, key);
    for (const l of byGroup.get(groupId) ?? []) {
      if (t.skipLedger?.(l.id)) continue;
      const c = t.cur.get(l.id) ?? 0;
      const p = t.cmp?.get(l.id) ?? 0;
      if (c === 0 && p === 0) continue;
      lines.push({ key: `l:${l.id}`, kind: 'ledger', id: l.id, name: l.name, level: level + 1, parentKey: key, hasChildren: false, amount: nat(c), compare: hasCmp ? nat(p) : null });
    }
    for (const x of t.extras ?? []) {
      if (x.groupId !== groupId) continue;
      if (x.cur === 0 && (x.cmp ?? 0) === 0) continue;
      lines.push({ key: x.key, kind: x.kind, id: null, name: x.name, level: level + 1, parentKey: key, hasChildren: false, amount: nat(x.cur), compare: hasCmp ? nat(x.cmp ?? 0) : null });
    }
    row.hasChildren = lines.length > at + 1;
    if (!row.hasChildren && row.amount === 0 && (row.compare ?? 0) === 0) lines.length = at;
  };
  for (const id of rootIds) emit(id, 0, null);
  return {
    lines,
    groupTotal: (groupId) => [nat(curG.get(groupId) ?? 0), hasCmp ? nat(cmpG.get(groupId) ?? 0) : null],
  };
}

/** −v without producing −0. */
export const neg = (v: Paise): Paise => (v === 0 ? 0 : -v);

const line = (key: string, kind: StatementLine['kind'], name: string, amount: Paise, compare: Paise | null, id: number | null = null): StatementLine => ({
  key,
  kind,
  id,
  name,
  level: 0,
  parentKey: null,
  hasChildren: false,
  amount,
  compare,
});

const sumTop = (lines: readonly StatementLine[], pickCompare: boolean): Paise =>
  lines.reduce((s, l) => (l.level === 0 ? s + (pickCompare ? (l.compare ?? 0) : l.amount) : s), 0);

/** Keep a fixed line when it (or its comparative figure) is non-zero. */
const keepIf = (l: StatementLine, always = false): StatementLine[] => (always || l.amount !== 0 || (l.compare ?? 0) !== 0 ? [l] : []);

// ───────────────────────────── Comparative periods ─────────────────────────────

const isMonthStart = (d: string): boolean => d.endsWith('-01');
const isMonthEnd = (d: string): boolean => d === endOfMonth(d);

/** Same date one year earlier (29-Feb → 28-Feb). */
export function minusYear(d: string): string {
  const { y, m, d: day } = parts(d);
  const dim = daysInMonth(y - 1, m);
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}

/**
 * Comparative period: 'previous_year' = the same dates a year earlier (a period ending on a month
 * end compares with that month end); 'previous_period' = the period of the same length just before
 * `from` (whole months shift by months: Oct 2026 → Sep 2026, Q2 → Q1).
 */
export function comparePeriod(from: string, to: string, how: CompareWith): { from: string; to: string } {
  if (how === 'previous_year') {
    const pt = isMonthEnd(to) ? endOfMonth(minusYear(to)) : minusYear(to);
    return { from: minusYear(from), to: pt };
  }
  const prevTo = addDays(from, -1);
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = (parts(to).y - parts(from).y) * 12 + (parts(to).m - parts(from).m) + 1;
    return { from: addMonths(from, -months), to: prevTo };
  }
  return { from: addDays(from, -daysIn(from, to)), to: prevTo };
}

// ───────────────────────────── Profit & Loss ─────────────────────────────

interface PlParts {
  values: Map<number, Paise>;
  openingStock: Paise;
  closingStock: Paise;
}

function plParts(env: ReportEnv, from: string, to: string): PlParts {
  prepareStock(env, { opening: [from], closing: [to] });
  return { values: nominalMovement(env, from, to), openingStock: stockAt(env, from), closingStock: stockAtEnd(env, to) };
}

interface PrimarySets {
  tradingExp: number[];
  tradingInc: number[];
  plExp: number[];
  plInc: number[];
}

function primarySets(env: ReportEnv): PrimarySets {
  const s: PrimarySets = { tradingExp: [], tradingInc: [], plExp: [], plInc: [] };
  for (const id of env.tree.rootIds) {
    const g = env.tree.byId.get(id);
    if (!g) continue;
    if (g.nature === 'expenses') (g.affectsGrossProfit ? s.tradingExp : s.plExp).push(id);
    else if (g.nature === 'income') (g.affectsGrossProfit ? s.tradingInc : s.plInc).push(id);
  }
  return s;
}

/** Side-natural total of some primary groups for a P&L value map. */
function groupsTotal(env: ReportEnv, ids: readonly number[], values: ReadonlyMap<number, Paise>, sign: 1 | -1): Paise {
  const set = new Set(ids);
  let s = 0;
  for (const l of env.ledgers) {
    const g = env.tree.byId.get(l.groupId);
    if (!g || !set.has(g.primaryId)) continue;
    s += values.get(l.id) ?? 0;
  }
  return sign === 1 ? s : neg(s);
}

/** Headline figures of a P&L (see README §5 for the formulas). */
export function profitFigures(env: ReportEnv, p: PlParts): ProfitFigures {
  const sets = primarySets(env);
  const salesId = env.groupByCode.get('SALES_ACCOUNTS');
  const purchaseId = env.groupByCode.get('PURCHASE_ACCOUNTS');
  const sales = salesId !== undefined ? groupsTotal(env, [salesId], p.values, -1) : 0;
  const purchases = purchaseId !== undefined ? groupsTotal(env, [purchaseId], p.values, 1) : 0;
  const directIncomes = groupsTotal(env, sets.tradingInc.filter((id) => id !== salesId), p.values, -1);
  const directExpenses = groupsTotal(env, sets.tradingExp.filter((id) => id !== purchaseId), p.values, 1);
  const indirectIncomes = groupsTotal(env, sets.plInc, p.values, -1);
  const indirectExpenses = groupsTotal(env, sets.plExp, p.values, 1);
  const grossProfit = sales + directIncomes + p.closingStock - p.openingStock - purchases - directExpenses;
  const netProfit = grossProfit + indirectIncomes - indirectExpenses;
  return {
    openingStock: p.openingStock,
    closingStock: p.closingStock,
    sales,
    purchases,
    directIncomes,
    directExpenses,
    indirectIncomes,
    indirectExpenses,
    grossProfit,
    netProfit,
  };
}

/** Net profit (positive) or loss (negative) for [from, to]. */
export function netProfitFor(env: ReportEnv, from: string, to: string): Paise {
  return profitFigures(env, plParts(env, from, to)).netProfit;
}

export function profitLoss(env: ReportEnv, input: ProfitLossInput): ProfitLossResult {
  assertPeriod(input.from, input.to);
  const mode = input.mode ?? 'condensed';
  const cmpPeriod = input.compareWith ? comparePeriod(input.from, input.to, input.compareWith) : null;
  // Every stock figure of both periods from one valuation replay.
  prepareStock(env, { opening: [input.from, ...(cmpPeriod ? [cmpPeriod.from] : [])], closing: [input.to, ...(cmpPeriod ? [cmpPeriod.to] : [])] });
  const cur = plParts(env, input.from, input.to);
  const cmp = cmpPeriod ? plParts(env, cmpPeriod.from, cmpPeriod.to) : null;
  const f = profitFigures(env, cur);
  const cf = cmp ? profitFigures(env, cmp) : null;
  const sets = primarySets(env);
  const showStock = env.integrated || cur.openingStock !== 0 || cur.closingStock !== 0;
  const c = (v: Paise | undefined): Paise | null => (cf ? (v ?? 0) : null);

  const tree = (ids: readonly number[], sign: 1 | -1): StatementLine[] => statementTree(env, ids, { cur: cur.values, cmp: cmp?.values ?? null, sign }).lines;

  // Trading account
  const gp = f.grossProfit;
  const cgp = cf?.grossProfit;
  const tLeft: StatementLine[] = [
    ...(showStock ? keepIf(line('stock:opening', 'stock', 'Opening Stock', f.openingStock, c(cf?.openingStock)), true) : []),
    ...tree(sets.tradingExp, 1),
    ...keepIf(line('gp:co', 'gross', 'Gross Profit c/o', Math.max(gp, 0), cf ? Math.max(cgp ?? 0, 0) : null)),
  ];
  const tRight: StatementLine[] = [
    ...tree(sets.tradingInc, -1),
    ...(showStock ? keepIf(line('stock:closing', 'stock', 'Closing Stock', f.closingStock, c(cf?.closingStock)), true) : []),
    ...keepIf(line('gl:co', 'gross', 'Gross Loss c/o', Math.max(-gp, 0), cf ? Math.max(-(cgp ?? 0), 0) : null)),
  ];
  // Profit & Loss account
  const np = f.netProfit;
  const cnp = cf?.netProfit;
  const pLeft: StatementLine[] = [
    ...keepIf(line('gl:bf', 'gross', 'Gross Loss b/f', Math.max(-gp, 0), cf ? Math.max(-(cgp ?? 0), 0) : null)),
    ...tree(sets.plExp, 1),
    ...keepIf(line('np', 'net', 'Net Profit', Math.max(np, 0), cf ? Math.max(cnp ?? 0, 0) : null)),
  ];
  const pRight: StatementLine[] = [
    ...keepIf(line('gp:bf', 'gross', 'Gross Profit b/f', Math.max(gp, 0), cf ? Math.max(cgp ?? 0, 0) : null)),
    ...tree(sets.plInc, -1),
    ...keepIf(line('nl', 'net', 'Net Loss', Math.max(-np, 0), cf ? Math.max(-(cnp ?? 0), 0) : null)),
  ];
  const block = (left: StatementLine[], right: StatementLine[]): StatementBlock => ({
    left,
    right,
    total: Math.max(sumTop(left, false), sumTop(right, false)),
    compareTotal: cf ? Math.max(sumTop(left, true), sumTop(right, true)) : null,
  });

  const salesId = env.groupByCode.get('SALES_ACCOUNTS') ?? null;
  const purchaseId = env.groupByCode.get('PURCHASE_ACCOUNTS') ?? null;
  const v = (key: string, label: string, amount: Paise, compare: Paise | null, level: number, emphasis: boolean, groupId: number | null = null): VerticalLine => ({
    key,
    label,
    amount,
    compare,
    level,
    emphasis,
    groupId,
  });
  const rev = f.sales + f.directIncomes;
  const crev = cf ? cf.sales + cf.directIncomes : null;
  const totalIncome = rev + f.indirectIncomes;
  const cTotalIncome = cf ? (crev ?? 0) + cf.indirectIncomes : null;
  const change = f.openingStock - f.closingStock;
  const cChange = cf ? cf.openingStock - cf.closingStock : null;
  const totalExp = f.purchases + change + f.directExpenses + f.indirectExpenses;
  const cTotalExp = cf ? cf.purchases + (cChange ?? 0) + cf.directExpenses + cf.indirectExpenses : null;
  const vertical: VerticalLine[] = [
    v('rev', 'I. Revenue from operations', rev, crev, 0, false, salesId),
    v('rev.sales', 'Sales', f.sales, c(cf?.sales), 1, false, salesId),
    v('rev.direct', 'Direct incomes', f.directIncomes, c(cf?.directIncomes), 1, false, env.groupByCode.get('DIRECT_INCOMES') ?? null),
    v('other', 'II. Other income', f.indirectIncomes, c(cf?.indirectIncomes), 0, false, env.groupByCode.get('INDIRECT_INCOMES') ?? null),
    v('income', 'III. Total income (I + II)', totalIncome, cTotalIncome, 0, true),
    v('exp', 'IV. Expenses', totalExp, cTotalExp, 0, false),
    v('exp.purchases', 'Purchases of stock-in-trade', f.purchases, c(cf?.purchases), 1, false, purchaseId),
    v('exp.inventory', 'Changes in inventories (opening − closing)', change, cChange, 1, false),
    v('exp.direct', 'Direct expenses', f.directExpenses, c(cf?.directExpenses), 1, false, env.groupByCode.get('DIRECT_EXPENSES') ?? null),
    v('exp.other', 'Other expenses', f.indirectExpenses, c(cf?.indirectExpenses), 1, false, env.groupByCode.get('INDIRECT_EXPENSES') ?? null),
    v('expTotal', 'Total expenses (IV)', totalExp, cTotalExp, 0, true),
    v('pbt', 'V. Profit / (loss) before tax (III − IV)', f.netProfit, c(cf?.netProfit), 0, true),
  ];

  return {
    from: input.from,
    to: input.to,
    mode,
    compare: cmpPeriod,
    inventoryIntegrated: env.integrated,
    trading: block(tLeft, tRight),
    profitLoss: block(pLeft, pRight),
    figures: f,
    compareFigures: cf,
    vertical,
  };
}

// ───────────────────────────── Profit trend (month by month) ─────────────────────────────

/** Movement of the given ledgers per calendar month of [from, to] (books filter; a range of idx_le_books per ledger). */
const MONTHLY_MOVEMENT_SQL = `SELECT ledger_id, substr(date, 1, 7) AS m, SUM(amount) AS amt
     FROM ledger_entries INDEXED BY idx_le_books
    WHERE ledger_id IN (SELECT value FROM json_each(:ids)) AND date >= :from AND date <= :to AND ${BOOKS_FILTER()}
    GROUP BY ledger_id, m`;

const SCENARIO_MONTH_COLUMNS = `SELECT le.ledger_id, substr(le.date, 1, 7) AS m, SUM(le.amount) AS amt`;
/** Scenario, per ledger and month of [from, to]: regular vouchers of the excluded types (scenario.ts EXCLUDED_SQL). */
const SCENARIO_EXCLUDED_MONTHLY_SQL = `${SCENARIO_MONTH_COLUMNS}, NULL AS upto
     FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id
    WHERE v.voucher_type_id IN (SELECT value FROM json_each(:types)) AND le.date >= :from AND le.date <= :to AND ${BOOKS_FILTER('le')}
    GROUP BY le.ledger_id, m`;
/**
 * Scenario, per ledger, month and lapse date: provisional vouchers of the included types (scenario.ts
 * PROVISIONAL_SQL without its `applicable_upto >= :to` cut, which depends on the cut date and is applied
 * per month in monthlyNominal). `upto` is NULL when the voucher counts whatever the cut: a memorandum,
 * an optional voucher, a reversing journal without an "applicable up to" date.
 */
const SCENARIO_PROVISIONAL_MONTHLY_SQL = `${SCENARIO_MONTH_COLUMNS},
          CASE WHEN v.base_type = 'memorandum' OR v.is_optional = 1 THEN NULL ELSE v.applicable_upto END AS upto
     FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id
    WHERE v.voucher_type_id IN (SELECT value FROM json_each(:types)) AND v.is_cancelled = 0 AND le.affects_books = 0
      AND le.date >= :from AND le.date <= :to AND (le.is_post_dated = 0 OR le.date <= :today)
      AND (v.base_type IN ('memorandum', 'reversing_journal') OR v.is_optional = 1)
    GROUP BY le.ledger_id, m, upto`;

/**
 * P&L value (Dr-signed) of every nominal ledger for each month slice of [from, to], from a fixed number
 * of aggregate queries (one, plus at most two with a scenario — never one per month). Σ over the slices
 * = nominalMovement(env, from, to) exactly:
 *  - books movement: each entry falls in exactly one slice;
 *  - nominal opening balances: in the slice that contains the books beginning (only when the period does);
 *  - a scenario: month k is the scenario adjustment for [from, end of k] − the one for [from, end of k−1]
 *    (cumulative), because a reversing journal counts only while the report's `to` is on or before its
 *    "applicable up to" date: it shows in its own month (if it has not lapsed by that month's end) and
 *    reverses in the first month whose end is past that date. The last cumulative figure is exactly the
 *    P&L's (`profitTrend.test.ts` checks every month against the cumulative scenario P&L).
 */
function monthlyNominal(env: ReportEnv, from: string, to: string, slices: ReadonlyArray<{ month: string; from: string; to: string }>): Map<number, Paise>[] {
  const out = slices.map(() => new Map<number, Paise>());
  const at = new Map(slices.map((s, i) => [s.month, i]));
  const nominal = env.ledgers.filter((l) => l.isNominal);
  const isNominal = new Set(nominal.map((l) => l.id));
  const add = (i: number, ledgerId: number, v: Paise): void => {
    if (v !== 0) out[i].set(ledgerId, (out[i].get(ledgerId) ?? 0) + v);
  };
  const scenario = env.scenario ?? null;
  if (!scenario || scenario.includeActuals) {
    for (const r of env.db.all<{ ledger_id: number; m: string; amt: number | null }>(MONTHLY_MOVEMENT_SQL, {
      ids: JSON.stringify(nominal.map((l) => l.id)),
      from,
      to,
      today: env.today,
    })) {
      const i = at.get(r.m);
      if (i !== undefined) add(i, r.ledger_id, r.amt ?? 0);
    }
  }
  if (from <= env.booksFrom && env.booksFrom <= to) {
    const i = slices.findIndex((s) => s.from <= env.booksFrom && env.booksFrom <= s.to);
    for (const l of nominal) add(i, l.id, l.openingBalance);
  }
  if (scenario) {
    type Row = { ledger_id: number; m: string; amt: number | null; upto: string | null };
    const apply = (sign: 1 | -1, rows: Row[]): void => {
      for (const r of rows) {
        const i = at.get(r.m);
        if (i === undefined || !isNominal.has(r.ledger_id)) continue;
        const v = sign * (r.amt ?? 0);
        const upto = r.upto;
        if (upto === null) {
          add(i, r.ledger_id, v);
          continue;
        }
        // Counted in every cumulative cut from its month's end up to (not past) `upto`.
        if (upto < slices[i].to) continue;
        add(i, r.ledger_id, v);
        const lapse = slices.findIndex((s, k) => k > i && s.to > upto);
        if (lapse !== -1) add(lapse, r.ledger_id, -v);
      }
    };
    const params = { from, to, today: env.today };
    if (scenario.includeActuals && scenario.excludeTypeIds.length > 0) {
      apply(-1, env.db.all<Row>(SCENARIO_EXCLUDED_MONTHLY_SQL, { ...params, types: JSON.stringify(scenario.excludeTypeIds) }));
    }
    if (scenario.includeTypeIds.length > 0) {
      apply(1, env.db.all<Row>(SCENARIO_PROVISIONAL_MONTHLY_SQL, { ...params, types: JSON.stringify(scenario.includeTypeIds) }));
    }
  }
  return out;
}

/**
 * `reports.profitTrend`: the P&L figures of each calendar month of [from, to] (README §5a). One stock
 * valuation pass gives every month end; a month's opening stock is the previous month's closing (the
 * same as stockAt(month start) — except a standard-cost item at the books beginning, README §5a), so
 * the stock changes telescope and Σ months (net profit, purchases, sales, gross profit) equals the P&L
 * of the whole period exactly.
 */
export function profitTrend(env: ReportEnv, input: ProfitTrendInput): ProfitTrendResult {
  assertPeriod(input.from, input.to);
  const slices = monthSlices(input.from, input.to);
  prepareStock(env, { opening: [input.from], closing: slices.map((s) => s.to) });
  const values = monthlyNominal(env, input.from, input.to, slices);
  let openingStock = stockAt(env, input.from);
  let netProfit = 0;
  const months = slices.map((s, i): ProfitTrendMonth => {
    const closingStock = stockAtEnd(env, s.to);
    const f = profitFigures(env, { values: values[i], openingStock, closingStock });
    openingStock = closingStock;
    netProfit += f.netProfit;
    return { month: s.month, from: s.from, to: s.to, sales: f.sales, purchases: f.purchases, grossProfit: f.grossProfit, netProfit: f.netProfit };
  });
  return { from: input.from, to: input.to, inventoryIntegrated: env.integrated, months, netProfit };
}

// ───────────────────────────── Balance Sheet ─────────────────────────────

/** Stock values a Balance Sheet as at each date needs: the year-start opening and the closing. */
export function bsStockPoints(env: ReportEnv, dates: readonly string[]): { opening: string[]; closing: string[] } {
  return { opening: dates.map((d) => yearStartOf(env, d)), closing: [...dates] };
}

export interface BsParts {
  closings: Map<number, Paise>;
  closingStock: Paise;
  plOpening: Paise;
  plTransferred: Paise;
  currentProfit: Paise;
  yearStart: string;
}

/** Real-ledger closings and P&L A/c parts as at the end of `asOf` (README §6). */
export function bsParts(env: ReportEnv, asOf: string): BsParts {
  const yearStart = yearStartOf(env, asOf);
  prepareStock(env, bsStockPoints(env, [asOf]));
  if (asOf < env.booksFrom) {
    // Before the books begin only the opening balances exist.
    // Opening balances of income/expense ledgers (books started mid-year) are year-to-date results.
    const closings = new Map<number, Paise>();
    let nominal = 0;
    for (const l of env.ledgers) {
      if (l.isNominal) nominal += l.openingBalance;
      else closings.set(l.id, l.openingBalance);
    }
    const own = env.plLedgerId !== null ? (env.ledgerById.get(env.plLedgerId)?.openingBalance ?? 0) : 0;
    return { closings, closingStock: stockAt(env, env.booksFrom), plOpening: neg(own), plTransferred: 0, currentProfit: neg(nominal), yearStart: env.booksFrom };
  }
  const snap = buildSnapshot(env, { from: yearStart, to: asOf, yearStart });
  const closings = new Map<number, Paise>();
  let nominal = 0;
  for (const l of env.ledgers) {
    const b = snap.ledgers.get(l.id);
    if (!b) continue;
    if (l.isNominal) nominal += b.closing;
    else closings.set(l.id, b.closing);
  }
  const closingStock = stockAtEnd(env, asOf);
  const currentProfit = -nominal + closingStock - snap.openingStock;
  const plb = env.plLedgerId !== null ? snap.ledgers.get(env.plLedgerId) : undefined;
  return {
    closings,
    closingStock,
    plOpening: plb ? neg(plb.opening) : 0,
    plTransferred: plb ? plb.credit - plb.debit : 0,
    currentProfit,
    yearStart,
  };
}

export function balanceSheet(env: ReportEnv, input: BalanceSheetInput): BalanceSheetResult {
  const mode = input.mode ?? 'condensed';
  if (input.compareAsOf && input.compareAsOf === input.asOf) {
    throw validation([{ path: 'compareAsOf', message: 'Choose a different date to compare with.' }]);
  }
  // Every stock figure of both dates from one valuation replay.
  prepareStock(env, bsStockPoints(env, input.compareAsOf ? [input.asOf, input.compareAsOf] : [input.asOf]));
  const cur = bsParts(env, input.asOf);
  const cmp = input.compareAsOf ? bsParts(env, input.compareAsOf) : null;
  const plId = env.plLedgerId;
  const skipLedger = (id: number): boolean => id === plId;
  const stockGroupId = env.groupByCode.get('STOCK_IN_HAND');
  const extras =
    stockGroupId !== undefined && (env.integrated || cur.closingStock !== 0)
      ? [{ groupId: stockGroupId, key: 'stock:closing', name: 'Closing Stock', kind: 'stock' as const, cur: cur.closingStock, cmp: cmp ? cmp.closingStock : null }]
      : [];
  const liabRoots: number[] = [];
  const assetRoots: number[] = [];
  for (const id of env.tree.rootIds) {
    const g = env.tree.byId.get(id);
    if (!g) continue;
    if (g.nature === 'liabilities') liabRoots.push(id);
    else if (g.nature === 'assets') assetRoots.push(id);
  }
  const liabilities = statementTree(env, liabRoots, { cur: cur.closings, cmp: cmp?.closings ?? null, sign: -1, skipLedger }).lines;
  const assets = statementTree(env, assetRoots, { cur: cur.closings, cmp: cmp?.closings ?? null, sign: 1, skipLedger, extras }).lines;

  // Profit & Loss A/c (credit = profit side). A debit total (accumulated loss) goes to the assets side.
  const total = cur.plOpening + cur.plTransferred + cur.currentProfit;
  const ctotal = cmp ? cmp.plOpening + cmp.plTransferred + cmp.currentProfit : null;
  const onAssets = total < 0 && (ctotal === null || ctotal <= 0);
  const s = onAssets ? -1 : 1;
  const plLines: StatementLine[] = [];
  if (total !== 0 || (ctotal ?? 0) !== 0) {
    plLines.push({ ...line('pl', 'profit_loss', 'Profit & Loss A/c', s === 1 ? total : neg(total), ctotal === null ? null : s === 1 ? ctotal : neg(ctotal), plId), hasChildren: true });
    const part = (key: string, name: string, a: Paise, b: Paise | null): void => {
      if (a === 0 && (b ?? 0) === 0) return;
      plLines.push({ key, kind: 'pl_part', id: null, name, level: 1, parentKey: 'pl', hasChildren: false, amount: s === 1 ? a : neg(a), compare: b === null ? null : s === 1 ? b : neg(b) });
    };
    part('pl:opening', 'Opening Balance', cur.plOpening, cmp ? cmp.plOpening : null);
    part('pl:transferred', 'Transferred during the year', cur.plTransferred, cmp ? cmp.plTransferred : null);
    part('pl:current', 'Current Period', cur.currentProfit, cmp ? cmp.currentProfit : null);
  }
  if (onAssets) assets.push(...plLines);
  else liabilities.push(...plLines);

  // Difference in opening balances: a debit difference sits with the assets, a credit one with the liabilities.
  const diff = 0 - sumOpenings(env);
  if (diff > 0) assets.push(line('diff', 'difference', 'Difference in opening balances', diff, cmp ? diff : null));
  else if (diff < 0) liabilities.push(line('diff', 'difference', 'Difference in opening balances', -diff, cmp ? -diff : null));

  const liabilitiesTotal = sumTop(liabilities, false);
  const assetsTotal = sumTop(assets, false);
  return {
    asOf: input.asOf,
    mode,
    compareAsOf: input.compareAsOf ?? null,
    yearStart: cur.yearStart,
    inventoryIntegrated: env.integrated,
    liabilities,
    assets,
    liabilitiesTotal,
    assetsTotal,
    compareLiabilitiesTotal: cmp ? sumTop(liabilities, true) : null,
    compareAssetsTotal: cmp ? sumTop(assets, true) : null,
    difference: assetsTotal - liabilitiesTotal,
    balanced: assetsTotal === liabilitiesTotal,
    closingStock: cur.closingStock,
    profitLoss: { openingBalance: cur.plOpening + cur.plTransferred, currentPeriod: cur.currentProfit, total },
    openingDifference: diff,
  };
}

/** Σ ledger opening balances + opening stock at the books beginning. */
function sumOpenings(env: ReportEnv): Paise {
  let s = 0;
  for (const l of env.ledgers) s += l.openingBalance;
  return s + stockAt(env, env.booksFrom);
}
