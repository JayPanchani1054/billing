/**
 * Shared building blocks of the reports screens: report period (global or drilled-down), remembered
 * tree expansion, drill-down navigation, the Trial-Balance style tree table and one side of a Tally
 * horizontal statement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { StatementLine, TbRow } from '../../../shared/types/reports.ts';
import { formatDrCr, useCompany, useNav, usePeriod } from '../../app/index.ts';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { paramsPeriod, statementAmountText, tbTotals } from './lib/model.ts';
import { rowBudget, sideBudget, tbVariance } from './lib/overlay.ts';
import type { BudgetBasisByKey, BudgetByKey } from './lib/overlay.ts';
import type { DrillTarget, Range } from './lib/model.ts';
import { expansionKey, keysUpToLevel, loadExpansion, parentKeys, saveExpansion } from './lib/tree.ts';

// ───────────────────────────── Period ─────────────────────────────

export interface ReportPeriod {
  from: string;
  to: string;
  /** The drilled-down period from params (until the user changes the global period with Alt+F2). */
  override: Range | null;
  period: Range;
}

/**
 * A report's period: `params.from/to` when the screen was opened by a drill-down, otherwise the
 * global period (Alt+F2). Changing the global period afterwards applies to this screen too.
 */
export function useReportPeriod(params: { from?: unknown; to?: unknown } | undefined): ReportPeriod {
  const g = usePeriod();
  const [override, setOverride] = useState<Range | null>(() => paramsPeriod(params));
  const seen = useRef(`${g.from}|${g.to}`);
  useEffect(() => {
    const k = `${g.from}|${g.to}`;
    if (k !== seen.current) {
      seen.current = k;
      setOverride(null);
    }
  }, [g.from, g.to]);
  const period = override ?? { from: g.from, to: g.to };
  return { from: period.from, to: period.to, override, period };
}

// ───────────────────────────── Expansion ─────────────────────────────

export interface TreeExpansion {
  expandedKeys: ReadonlySet<string>;
  onExpandedChange: (keys: ReadonlySet<string>) => void;
  expandAll: () => void;
  collapseAll: () => void;
  /** Every parent row is open. */
  allOpen: boolean;
}

/**
 * Controlled expansion for a tree DataTable, remembered per company and `key` (e.g. 'tb:detailed'):
 * the first visit opens rows up to `defaultLevel`; later visits restore what the user left open.
 * Row keys hold group/ledger ids, so another company never inherits them.
 */
export function useTreeExpansion(key: string, rows: readonly { key: string; level: number; parentKey: string | null; hasChildren: boolean }[], defaultLevel: number): TreeExpansion {
  const company = useCompany();
  const screenKey = expansionKey(company.id, key);
  const [state, setState] = useState<{ key: string; keys: Set<string> | null }>(() => ({ key: screenKey, keys: loadExpansion(screenKey) }));
  const stored = state.key === screenKey ? state.keys : loadExpansion(screenKey);
  useEffect(() => {
    if (state.key !== screenKey) setState({ key: screenKey, keys: loadExpansion(screenKey) });
  }, [screenKey, state.key]);
  const expandedKeys = useMemo(() => stored ?? keysUpToLevel(rows, defaultLevel), [stored, rows, defaultLevel]);
  const onExpandedChange = useCallback(
    (keys: ReadonlySet<string>) => {
      const s = new Set(keys);
      setState({ key: screenKey, keys: s });
      saveExpansion(screenKey, s);
    },
    [screenKey],
  );
  const parents = useMemo(() => parentKeys(rows), [rows]);
  const allOpen = parents.size > 0 && [...parents].every((k) => expandedKeys.has(k));
  return {
    expandedKeys,
    onExpandedChange,
    expandAll: () => onExpandedChange(parents),
    collapseAll: () => onExpandedChange(new Set()),
    allOpen,
  };
}

// ───────────────────────────── Drill-down ─────────────────────────────

/** Push a drill-down target (no-op for rows without one). */
export function useDrill(): (target: DrillTarget | null) => void {
  const nav = useNav();
  return useCallback(
    (target: DrillTarget | null) => {
      if (target) nav.push(target.screen, target.params);
    },
    [nav],
  );
}

// ───────────────────────────── Trial-Balance style table ─────────────────────────────

export interface TbTableProps {
  'aria-label': string;
  rows: readonly TbRow[];
  expansion: TreeExpansion;
  showOpening: boolean;
  showTransactions: boolean;
  onActivate: (row: TbRow) => void;
  loading?: boolean;
  empty?: ReactNode;
  autoFocus?: boolean;
  /** Label of the totals row (default 'Grand Total'). */
  totalLabel?: string;
  /** (additive) Budget column: budget per row key, Dr + / Cr − (overlay.tsx, Alt+B). */
  budget?: { name: string; byKey: BudgetByKey; basisByKey?: BudgetBasisByKey } | null;
}

/** Particulars | Opening | Debit | Credit | Closing Dr | Closing Cr, with sticky grand totals. */
export function TbTable({ rows, expansion, showOpening, showTransactions, onActivate, loading, empty, autoFocus = true, totalLabel = 'Grand Total', budget = null, ...rest }: TbTableProps) {
  const columns = useMemo<Column<TbRow>[]>(
    () => [
      { key: 'name', header: 'Particulars', tree: true, minWidth: 240 },
      { key: 'opening', header: 'Opening', kind: 'drcr', width: 170, hidden: !showOpening },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true, hidden: !showTransactions },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true, hidden: !showTransactions },
      { key: 'closingDr', header: 'Closing Dr', kind: 'amount', width: 160, blankZero: true, value: (r) => (r.closing > 0 ? r.closing : 0) },
      { key: 'closingCr', header: 'Closing Cr', kind: 'amount', width: 160, blankZero: true, value: (r) => (r.closing < 0 ? -r.closing : 0) },
      { key: 'budget', header: budget ? `Budget (${budget.name})` : 'Budget', kind: 'drcr', width: 170, hidden: !budget, value: (r) => rowBudget(budget?.byKey, r.key) ?? 0, render: (r) => (rowBudget(budget?.byKey, r.key) === null ? '' : formatDrCr(rowBudget(budget?.byKey, r.key) ?? 0)) },
      { key: 'variance', header: 'Variance', kind: 'drcr', width: 170, hidden: !budget, value: (r) => tbVariance(budget?.byKey, r, budget?.basisByKey) ?? 0, render: (r) => (tbVariance(budget?.byKey, r, budget?.basisByKey) === null ? '' : formatDrCr(tbVariance(budget?.byKey, r, budget?.basisByKey) ?? 0)) },
    ],
    [showOpening, showTransactions, budget],
  );
  const footer = useMemo<FooterRow[]>(() => {
    const t = tbTotals(rows);
    return [{ key: 'total', tone: 'total', cells: { name: totalLabel, debit: t.debit, credit: t.credit, closingDr: t.closingDebit, closingCr: t.closingCredit } }];
  }, [rows, totalLabel]);
  return (
    <DataTable<TbRow>
      aria-label={rest['aria-label']}
      className="bx-rep-fill"
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.key}
      getRowLevel={(r) => r.level}
      isGroupRow={(r) => r.hasChildren || r.kind === 'stock' || r.kind === 'difference'}
      expandable
      expandedKeys={expansion.expandedKeys}
      onExpandedChange={expansion.onExpandedChange}
      onRowActivate={onActivate}
      footerRows={rows.length > 0 ? footer : undefined}
      loading={loading}
      empty={empty ?? <EmptyState icon="book" title="Nothing to show for this period" body="Change the period with Alt+F2, or press Alt+Z to include zero balances." />}
      autoFocus={autoFocus}
    />
  );
}

// ───────────────────────────── Statement side ─────────────────────────────

export interface StatementSideProps {
  title: string;
  lines: readonly StatementLine[];
  total: number;
  compareTotal: number | null;
  compareLabel: string | null;
  expansion: TreeExpansion;
  onActivate: (line: StatementLine) => void;
  loading?: boolean;
  autoFocus?: boolean;
  /** Visible row count to size both sides alike (header + rows + footer). */
  heightRows: number;
  /** (additive) Budget column (overlay.tsx, Alt+B): side-natural like the amounts (`drNatural`: expenses / assets side). */
  budget?: { name: string; byKey: BudgetByKey; drNatural: boolean } | null;
}

const KEY_LINES = new Set(['gross', 'net', 'stock', 'profit_loss', 'difference']);

/** One side of a Tally horizontal statement (Expenses / Income, Liabilities / Assets). */
export function StatementSide({ title, lines, total, compareTotal, compareLabel, expansion, onActivate, loading, autoFocus, heightRows, budget = null }: StatementSideProps) {
  const columns = useMemo<Column<StatementLine>[]>(
    () => [
      { key: 'name', header: 'Particulars', tree: true, minWidth: 180 },
      {
        key: 'amount',
        header: 'Amount',
        kind: 'amount',
        width: 150,
        render: (r) => statementAmountText(r.amount),
        title: (r) => statementAmountText(r.amount),
      },
      {
        key: 'compare',
        header: compareLabel ?? 'Compare',
        kind: 'amount',
        width: 150,
        hidden: compareLabel === null,
        render: (r) => statementAmountText(r.compare),
      },
      {
        key: 'budget',
        header: budget ? `Budget (${budget.name})` : 'Budget',
        kind: 'amount',
        width: 150,
        hidden: !budget,
        render: (r) => statementAmountText(sideBudget(budget?.byKey, r.key, budget?.drNatural ?? true)),
      },
    ],
    [compareLabel, budget],
  );
  const footer: FooterRow[] = [
    { key: 'total', tone: 'total', cells: { name: 'Total', amount: statementAmountText(total), compare: compareTotal === null ? '' : statementAmountText(compareTotal), budget: '' } },
  ];
  return (
    <section className="bx-rep-side" aria-label={title}>
      <div className="bx-rep-side__title">{title}</div>
      <DataTable<StatementLine>
        aria-label={title}
        columns={columns}
        rows={lines}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.level === 0}
        getRowClassName={(r) => (r.level > 0 ? 'bx-rep-child' : KEY_LINES.has(r.kind) ? 'bx-rep-key-line' : undefined)}
        expandable
        expandedKeys={expansion.expandedKeys}
        onExpandedChange={expansion.onExpandedChange}
        onRowActivate={onActivate}
        footerRows={footer}
        loading={loading}
        virtualize={false}
        height={`calc(var(--row-h) * ${Math.max(heightRows, 3) + 2} + 2px)`}
        empty={<EmptyState size="sm" icon="book" title="No amounts" />}
        autoFocus={autoFocus}
      />
    </section>
  );
}
