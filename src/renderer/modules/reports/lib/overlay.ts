/**
 * Scenario and budget overlay of the Trial Balance, Profit & Loss and Balance Sheet (pure helpers;
 * the hook is ../overlay.tsx). Scenarios and budgets are masters of the documents module
 * ('documents.scenario.list', 'documents.budget.list', 'documents.budget.columns'); the reports routes
 * take `scenarioId` (core reports/scenario.ts).
 *
 * Budget figures come per report row key ('g:<groupId>', 'l:<ledgerId>'), signed Dr + / Cr −. A group
 * without a budget line of its own shows the sum of the budgets below it. Net-transaction budgets are
 * pro-rated by days to the report period; closing-balance budgets are shown as they are.
 */
import type { TbRow } from '../../../../shared/types/reports.ts';
import type { DrillTarget, ExportTable } from './model.ts';

export type BudgetByKey = Readonly<Record<string, number>>;

/** Signed budget of a row (Dr + / Cr −), null when the row has none. */
export function rowBudget(byKey: BudgetByKey | null | undefined, key: string): number | null {
  if (!byKey) return null;
  const v = byKey[key];
  return v === undefined ? null : v;
}

/**
 * Budget for a line of a two-sided statement, side-natural like the amounts there: the expenses side
 * of a P&L and the assets side of a Balance Sheet are Dr-natural, the other sides Cr-natural.
 */
export function sideBudget(byKey: BudgetByKey | null | undefined, key: string, drNatural: boolean): number | null {
  const v = rowBudget(byKey, key);
  return v === null ? null : drNatural ? v : -v;
}

/** Basis of each budget key ('net_transactions' | 'closing_balance' | 'mixed'), from 'documents.budget.columns'. */
export type BudgetBasisByKey = Readonly<Record<string, string>>;

/**
 * Trial Balance variance of a row (Dr + / Cr −), compared like with like: a nett-transactions budget with
 * the period's transactions (Debit − Credit), a closing-balance budget with the closing balance. Null
 * without a budget, or for a group that rolls up budgets of both bases (no single figure to compare).
 * Without `basisByKey` (older data) the closing balance is used.
 */
export function tbVariance(byKey: BudgetByKey | null | undefined, row: Pick<TbRow, 'key' | 'closing' | 'debit' | 'credit'>, basisByKey?: BudgetBasisByKey | null): number | null {
  const b = rowBudget(byKey, row.key);
  if (b === null) return null;
  const basis = basisByKey?.[row.key];
  if (basis === 'mixed') return null;
  return (basis === 'net_transactions' ? row.debit - row.credit : row.closing) - b;
}

/** Add Budget and Variance columns to a Trial-Balance export whose rows are `rows` (same order). */
export function withTbBudget(
  table: ExportTable,
  rows: readonly Pick<TbRow, 'key' | 'closing' | 'debit' | 'credit'>[],
  byKey: BudgetByKey | null | undefined,
  budgetName: string,
  basisByKey?: BudgetBasisByKey | null,
): ExportTable {
  if (!byKey) return table;
  return {
    ...table,
    columns: [...table.columns, { header: `Budget (${budgetName})`, kind: 'drcr', width: 18 }, { header: 'Variance', kind: 'drcr', width: 18 }],
    rows: table.rows.map((r, i) => [...r, rowBudget(byKey, rows[i]?.key ?? ''), rows[i] ? tbVariance(byKey, rows[i], basisByKey) : null]),
    ...(table.totals ? { totals: [...table.totals, null, null] } : {}),
    landscape: true,
  };
}

/**
 * Carry the scenario into a drill-down that supports it (Group Summary); ledgers and vouchers always
 * show the books. Returns the target unchanged without a scenario.
 */
export function withScenario(target: DrillTarget | null, scenarioId: number | null): DrillTarget | null {
  if (!target || scenarioId === null || target.screen !== 'reports.groupSummary') return target;
  return { ...target, params: { ...target.params, scenarioId } };
}

/** "Scenario: Provisional · Budget: FY 2026-27 (nett budgets × 50.00%)" — null when neither is chosen. */
export function overlayText(scenarioName: string | null, budget: { name: string; proRata: number } | null): string | null {
  const parts: string[] = [];
  if (scenarioName) parts.push(`Scenario: ${scenarioName}`);
  if (budget) parts.push(`Budget: ${budget.name}${budget.proRata !== 1 ? ` (nett budgets × ${(budget.proRata * 100).toFixed(2)}%)` : ''}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
