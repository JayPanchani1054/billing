/**
 * Budgets (Accounts Info › Budgets) and the Budget Variance report.
 *
 * A budget covers a period; each line targets one group, ledger or cost centre and is either
 *  - on NET TRANSACTIONS: what should move in the period (an expense or income budget), or
 *  - on CLOSING BALANCE: where the balance should stand at the end of the period (a debtors or
 *    cash target).
 * Amounts are Dr + / Cr − (an expense budget of ₹50,000 is +50,00,000 paise; a sales budget Cr).
 *
 * Reporting a period other than the budget's own: a net-transactions budget is pro-rated by days of
 * overlap (budget × overlap days ÷ budget days, rounded to the paisa); a closing-balance budget is a
 * target for the end of the budget period and is shown as it is. (conventional accounting software shows budgets for the period
 * they were defined for; pro-rating is our documented choice so monthly reviews of an annual budget
 * work.)
 *
 * Actuals (books filter; with a scenario, the scenario's vouchers — reports/scenario.ts):
 *  - ledger net: nominal (income/expense) ledgers as in the P&L (period movement, + opening balance
 *    when the period contains the books beginning); other ledgers Dr − Cr of the period;
 *  - ledger closing: the Trial-Balance closing at `to` (nominal ledgers year to date);
 *  - group: the same over every ledger under it (the reserved Profit & Loss A/c excluded; closing
 *    stock is not a ledger balance and is not included);
 *  - cost centre (with its sub-centres): Σ cost allocations of the period / up to `to` (with a scenario:
 *    its excluded types out, its provisional vouchers in — reports/scenario.ts scenarioCostCentreAdjust).
 */
import { randomUUID } from 'node:crypto';
import { diffDays, formatDate } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BudgetBasis,
  BudgetColumnsResult,
  BudgetDetail,
  BudgetLineInput,
  BudgetLineKind,
  BudgetLineView,
  BudgetRow,
  BudgetSaveInput,
  BudgetVarianceInput,
  BudgetVarianceResult,
  BudgetVarianceRow,
} from '../../../shared/types/documents.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';
import { BOOKS_FILTER, loadGroupTree } from '../accounts/books.ts';
import { assertPeriod, buildSnapshot, loadReportEnv, nominalMovement } from '../reports/engine.ts';
import { scenarioCostCentreAdjust } from '../reports/scenario.ts';
import { fieldIssue, nowIso, requirePermission, txt } from './common.ts';

interface BudgetDbRow {
  id: number;
  guid: string;
  name: string;
  from_date: string;
  to_date: string;
  notes: string | null;
  line_count: number;
}

interface LineDbRow {
  id: number;
  group_id: number | null;
  ledger_id: number | null;
  cost_centre_id: number | null;
  basis: 'net_transactions' | 'closing_balance';
  amount: number;
  name: string;
  under: string | null;
}

const toRow = (r: BudgetDbRow): BudgetRow => ({ id: r.id, name: r.name, from: r.from_date, to: r.to_date, notes: r.notes, lineCount: r.line_count });

const BUDGET_SELECT = `SELECT b.*, (SELECT COUNT(*) FROM budget_lines bl WHERE bl.budget_id = b.id) AS line_count FROM budgets b`;

export function listBudgets(db: Db): BudgetRow[] {
  return db.all<BudgetDbRow>(`${BUDGET_SELECT} ORDER BY b.from_date DESC, b.name COLLATE NOCASE`).map(toRow);
}

function loadBudget(db: Db, id: number): BudgetDbRow {
  const r = db.get<BudgetDbRow>(`${BUDGET_SELECT} WHERE b.id = :id`, { id });
  if (!r) throw notFound('Budget', id);
  return r;
}

function loadLines(db: Db, budgetId: number): LineDbRow[] {
  return db.all<LineDbRow>(
    `SELECT bl.id, bl.group_id, bl.ledger_id, bl.cost_centre_id, bl.basis, bl.amount,
            COALESCE(g.name, l.name, cc.name) AS name,
            COALESCE(pg.name, lg.name, cat.name) AS under
       FROM budget_lines bl
       LEFT JOIN groups g ON g.id = bl.group_id
       LEFT JOIN groups pg ON pg.id = g.parent_id
       LEFT JOIN ledgers l ON l.id = bl.ledger_id
       LEFT JOIN groups lg ON lg.id = l.group_id
       LEFT JOIN cost_centres cc ON cc.id = bl.cost_centre_id
       LEFT JOIN cost_categories cat ON cat.id = cc.category_id
      WHERE bl.budget_id = :id
      ORDER BY CASE WHEN bl.group_id IS NOT NULL THEN 0 WHEN bl.ledger_id IS NOT NULL THEN 1 ELSE 2 END, name COLLATE NOCASE`,
    { id: budgetId },
  );
}

const kindOf = (l: Pick<LineDbRow, 'group_id' | 'ledger_id'>): BudgetLineKind => (l.group_id !== null ? 'group' : l.ledger_id !== null ? 'ledger' : 'cost_centre');
const refOf = (l: Pick<LineDbRow, 'group_id' | 'ledger_id' | 'cost_centre_id'>): number => (l.group_id ?? l.ledger_id ?? l.cost_centre_id) as number;

export function getBudget(db: Db, id: number): BudgetDetail {
  const b = loadBudget(db, id);
  const lines: BudgetLineView[] = loadLines(db, id).map((l) => ({ kind: kindOf(l), refId: refOf(l), basis: l.basis, amount: l.amount, name: l.name, under: l.under }));
  return { ...toRow(b), lines };
}

const TABLE: Record<BudgetLineKind, { table: string; label: string }> = {
  group: { table: 'groups', label: 'group' },
  ledger: { table: 'ledgers', label: 'ledger' },
  cost_centre: { table: 'cost_centres', label: 'cost centre' },
};

export function saveBudget(ctx: CompanyCtx, input: BudgetSaveInput): BudgetDetail {
  const { db } = ctx;
  requirePermission(ctx, input.id === undefined ? 'masters.create' : 'masters.alter', input.id === undefined ? 'create budgets' : 'alter budgets');
  const name = txt(input.name);
  if (!name) throw fieldIssue('name', 'Give the budget a name (e.g. "FY 2026-27 – Expenses").');
  if (input.from > input.to) throw fieldIssue('to', 'The budget period ends before it starts. Choose a later end date.');
  const before = input.id !== undefined ? getBudget(db, input.id) : null;
  if (db.value<number>('SELECT id FROM budgets WHERE name = :name AND id <> :id', { name, id: input.id ?? 0 }) !== undefined) {
    throw fieldIssue('name', `A budget named "${name}" already exists. Choose another name.`);
  }
  const seen = new Set<string>();
  input.lines.forEach((l: BudgetLineInput, i) => {
    const t = TABLE[l.kind];
    // Table name comes from a fixed map (never from input).
    const exists = db.value<number>(`SELECT 1 FROM ${t.table} WHERE id = :id`, { id: l.refId });
    if (exists === undefined) throw fieldIssue(`lines[${i}].refId`, `This ${t.label} no longer exists. Remove the line or pick another ${t.label}.`);
    const key = `${l.kind}:${l.refId}`;
    if (seen.has(key)) throw fieldIssue(`lines[${i}].refId`, `This ${t.label} is already budgeted on another line. Keep one line per ${t.label}.`);
    seen.add(key);
    if (!Number.isSafeInteger(l.amount)) throw fieldIssue(`lines[${i}].amount`, 'Enter the amount in rupees and paise.');
  });
  const now = nowIso(ctx);
  let id: number;
  let guid: string;
  if (before) {
    id = before.id;
    guid = db.value<string>('SELECT guid FROM budgets WHERE id = :id', { id }) ?? '';
    db.run('UPDATE budgets SET name = :name, from_date = :from, to_date = :to, notes = :notes, updated_at = :now WHERE id = :id', {
      name,
      from: input.from,
      to: input.to,
      notes: txt(input.notes) ?? null,
      now,
      id,
    });
    db.run('DELETE FROM budget_lines WHERE budget_id = :id', { id });
  } else {
    guid = randomUUID();
    id = db.run('INSERT INTO budgets (guid, name, from_date, to_date, notes, created_at, updated_at) VALUES (:guid, :name, :from, :to, :notes, :now, :now)', {
      guid,
      name,
      from: input.from,
      to: input.to,
      notes: txt(input.notes) ?? null,
      now,
    }).lastInsertRowid;
  }
  for (const l of input.lines) {
    db.run(
      `INSERT INTO budget_lines (budget_id, group_id, ledger_id, cost_centre_id, basis, amount) VALUES (:b, :g, :l, :c, :basis, :amount)`,
      {
        b: id,
        g: l.kind === 'group' ? l.refId : null,
        l: l.kind === 'ledger' ? l.refId : null,
        c: l.kind === 'cost_centre' ? l.refId : null,
        basis: l.basis,
        amount: l.amount,
      },
    );
  }
  const after = getBudget(db, id);
  const compact = (b: BudgetDetail): unknown => ({ name: b.name, from: b.from, to: b.to, lines: b.lines.map((l) => [l.kind, l.refId, l.basis, l.amount]) });
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'budget',
    entityId: id,
    entityGuid: guid,
    entityLabel: `Budget ${name} (${formatDate(input.from)} to ${formatDate(input.to)})`,
    before: before ? compact(before) : undefined,
    after: compact(after),
  });
  return after;
}

export function deleteBudget(ctx: CompanyCtx, id: number): { id: number } {
  requirePermission(ctx, 'masters.delete', 'delete budgets');
  const b = getBudget(ctx.db, id);
  const guid = ctx.db.value<string>('SELECT guid FROM budgets WHERE id = :id', { id });
  ctx.db.run('DELETE FROM budgets WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'budget', entityId: id, entityGuid: guid, entityLabel: `Budget ${b.name}`, before: { name: b.name, from: b.from, to: b.to, lines: b.lines.length } });
  return { id };
}

// ───────────────────────────── Figures ─────────────────────────────

/** Share of the budget period covered by [from, to] (0–1). */
export function proRataShare(budget: { from: string; to: string }, from: string, to: string): number {
  const s = from > budget.from ? from : budget.from;
  const e = to < budget.to ? to : budget.to;
  if (s > e) return 0;
  return (diffDays(s, e) + 1) / (diffDays(budget.from, budget.to) + 1);
}

/** Budget amount for the report period (net-transactions lines pro-rated; closing-balance lines as they are). */
export function periodBudget(amount: Paise, basis: 'net_transactions' | 'closing_balance', share: number): Paise {
  if (basis === 'closing_balance') return amount;
  return share === 1 ? amount : Math.round(amount * share);
}

/** 'documents.budget.variance' — Budget vs Actual for every line of a budget. */
export function budgetVariance(ctx: CompanyCtx, input: BudgetVarianceInput): BudgetVarianceResult {
  const { db } = ctx;
  const b = loadBudget(db, input.budgetId);
  const from = input.from ?? b.from_date;
  const to = input.to ?? b.to_date;
  assertPeriod(from, to);
  const env = loadReportEnv(db, ctx.clock.today(), input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {});
  const share = proRataShare({ from: b.from_date, to: b.to_date }, from, to);
  const lines = loadLines(db, b.id);
  const needsLedgers = lines.some((l) => l.cost_centre_id === null);
  const snap = needsLedgers ? buildSnapshot(env, { from, to }) : null;
  const nominal = needsLedgers ? nominalMovement(env, from, to) : new Map<number, Paise>();
  const ledgerNet = (id: number): Paise => {
    const meta = env.ledgerById.get(id);
    if (meta?.isNominal) return nominal.get(id) ?? 0;
    const s = snap?.ledgers.get(id);
    return s ? s.debit - s.credit : 0;
  };
  const tree = env.tree;
  const groupNet = (gid: number): Paise => {
    let sum = 0;
    for (const l of env.ledgers) {
      if (l.id === env.plLedgerId) continue;
      const g = tree.byId.get(l.groupId);
      if (g && g.chainIds.includes(gid)) sum += ledgerNet(l.id);
    }
    return sum;
  };
  const centreFigures = (cid: number): { net: Paise; closing: Paise } => {
    const r = db.get<{ net: number | null; closing: number | null }>(
      `WITH RECURSIVE tree(id) AS (SELECT :cid UNION ALL SELECT c.id FROM cost_centres c JOIN tree t ON c.parent_id = t.id)
       SELECT SUM(CASE WHEN ca.date >= :from THEN ca.amount ELSE 0 END) AS net, SUM(ca.amount) AS closing
         FROM cost_allocations ca
        WHERE ca.cost_centre_id IN (SELECT id FROM tree) AND ca.date <= :to AND ${BOOKS_FILTER('ca')}`,
      { cid, from, to, today: ctx.clock.today() },
    );
    const books = { net: r?.net ?? 0, closing: r?.closing ?? 0 };
    if (!env.scenario) return books;
    // A scenario changes the cost-centre actuals the same way as the account actuals (reports/scenario.ts).
    const ids = db
      .all<{ id: number }>(`WITH RECURSIVE tree(id) AS (SELECT :cid UNION ALL SELECT c.id FROM cost_centres c JOIN tree t ON c.parent_id = t.id) SELECT id FROM tree`, { cid })
      .map((x) => x.id);
    const adj = scenarioCostCentreAdjust(db, env.scenario, { centreIds: ids, from, to, today: ctx.clock.today() });
    return adj.dropBooks ? { net: adj.net, closing: adj.closing } : { net: books.net + adj.net, closing: books.closing + adj.closing };
  };

  // A line inside another line's figure is shown but not added to the totals again (each amount once).
  const budgetedGroups = new Set(lines.filter((l) => l.group_id !== null).map((l) => l.group_id as number));
  const budgetedCentres = new Set(lines.filter((l) => l.cost_centre_id !== null).map((l) => l.cost_centre_id as number));
  const hasAccountLines = lines.some((l) => l.cost_centre_id === null);
  const centreParent = new Map<number, number | null>(
    budgetedCentres.size > 0 ? db.all<{ id: number; parent_id: number | null }>('SELECT id, parent_id FROM cost_centres').map((c) => [c.id, c.parent_id]) : [],
  );
  const underBudgetedCentre = (cid: number): boolean => {
    const seen = new Set<number>();
    for (let p = centreParent.get(cid) ?? null; p !== null && !seen.has(p); p = centreParent.get(p) ?? null) {
      if (budgetedCentres.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  const inTotal = (l: LineDbRow): boolean => {
    if (l.cost_centre_id !== null) return !hasAccountLines && !underBudgetedCentre(l.cost_centre_id);
    const groupId = l.group_id ?? env.ledgerById.get(l.ledger_id as number)?.groupId;
    const chain = groupId !== undefined ? (tree.byId.get(groupId)?.chainIds ?? []) : [];
    return !chain.some((gid) => budgetedGroups.has(gid) && gid !== l.group_id);
  };

  const rows: BudgetVarianceRow[] = [];
  const totals = { budget: 0, actual: 0, variance: 0 };
  for (const l of lines) {
    const kind = kindOf(l);
    const refId = refOf(l);
    let actual: Paise;
    if (kind === 'ledger') actual = l.basis === 'net_transactions' ? ledgerNet(refId) : (snap?.ledgers.get(refId)?.closing ?? 0);
    else if (kind === 'group') actual = l.basis === 'net_transactions' ? groupNet(refId) : (snap?.groups.get(refId)?.closing ?? 0);
    else {
      const f = centreFigures(refId);
      actual = l.basis === 'net_transactions' ? f.net : f.closing;
    }
    const budget = periodBudget(l.amount, l.basis, share);
    const variance = actual - budget;
    rows.push({
      key: `${kind}:${refId}`,
      kind,
      refId,
      name: l.name,
      under: l.under,
      basis: l.basis,
      budget,
      actual,
      variance,
      variancePct: budget !== 0 ? Math.round((variance / Math.abs(budget)) * 10_000) / 100 : null,
      overBudget: budget !== 0 && Math.sign(actual) === Math.sign(budget) && Math.abs(actual) > Math.abs(budget),
      inTotal: inTotal(l),
    });
    if (!inTotal(l)) continue;
    totals.budget += budget;
    totals.actual += actual;
    totals.variance += variance;
  }
  return { budget: toRow(b), from, to, proRata: Math.round(share * 10_000) / 10_000, rows, totals };
}

/**
 * 'documents.budget.columns' — budget per report row key for the Trial Balance / P&L / Balance Sheet
 * budget column: 'l:<id>' for budgeted ledgers, 'g:<id>' for budgeted groups. A group without a line of
 * its own shows the sum of the budgets below it (its ledgers and sub-groups). Cost-centre lines have no
 * row in these reports and are left out.
 */
export function budgetColumns(ctx: CompanyCtx, input: { budgetId: number; from: string; to: string }): BudgetColumnsResult {
  const { db } = ctx;
  const b = loadBudget(db, input.budgetId);
  assertPeriod(input.from, input.to);
  const share = proRataShare({ from: b.from_date, to: b.to_date }, input.from, input.to);
  const lines = loadLines(db, b.id);
  const byKey: Record<string, Paise> = {};
  const basisByKey: Record<string, BudgetBasis | 'mixed'> = {};
  const ledgerBudget = new Map<number, Paise>();
  const ledgerBasis = new Map<number, BudgetBasis>();
  const groupExplicit = new Map<number, { v: Paise; basis: BudgetBasis }>();
  for (const l of lines) {
    const v = periodBudget(l.amount, l.basis, share);
    if (l.ledger_id !== null) {
      ledgerBudget.set(l.ledger_id, v);
      ledgerBasis.set(l.ledger_id, l.basis);
      byKey[`l:${l.ledger_id}`] = v;
      basisByKey[`l:${l.ledger_id}`] = l.basis;
    } else if (l.group_id !== null) groupExplicit.set(l.group_id, { v, basis: l.basis });
  }
  const merge = (a: BudgetBasis | 'mixed' | undefined, b: BudgetBasis | 'mixed'): BudgetBasis | 'mixed' => (a === undefined || a === b ? b : 'mixed');
  const tree = loadGroupTree(db);
  const direct = new Map<number, { v: Paise; basis: BudgetBasis | 'mixed' }>();
  for (const r of db.all<{ id: number; group_id: number }>('SELECT id, group_id FROM ledgers')) {
    const v = ledgerBudget.get(r.id);
    if (v === undefined) continue;
    const d = direct.get(r.group_id);
    direct.set(r.group_id, { v: (d?.v ?? 0) + v, basis: merge(d?.basis, ledgerBasis.get(r.id) as BudgetBasis) });
  }
  const value = (gid: number): { v: Paise; basis: BudgetBasis | 'mixed' } | undefined => {
    const own = groupExplicit.get(gid);
    if (own !== undefined) return own;
    const node = tree.byId.get(gid);
    let sum = direct.get(gid);
    for (const c of node?.childIds ?? []) {
      const cv = value(c);
      if (cv !== undefined) sum = { v: (sum?.v ?? 0) + cv.v, basis: merge(sum?.basis, cv.basis) };
    }
    return sum;
  };
  for (const id of tree.order) {
    const v = value(id);
    if (v === undefined) continue;
    byKey[`g:${id}`] = v.v;
    basisByKey[`g:${id}`] = v.basis;
  }
  return { budgetId: b.id, name: b.name, byKey, basisByKey, proRata: Math.round(share * 10_000) / 10_000 };
}
