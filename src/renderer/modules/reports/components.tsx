/**
 * Shared building blocks of the reports screens: report period (global or drilled-down), remembered
 * tree expansion, drill-down navigation, the Trial-Balance style tree table and one side of a
 * horizontal statement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { StatementLine, TbRow } from '../../../shared/types/reports.ts';
import { formatDrCr, useCompany, useNav, usePeriod } from '../../app/index.ts';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { isOverdrawn } from './lib/charts.ts';
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
  /**
   * (2.1) One "Closing" column (Dr/Cr words) instead of Closing Dr | Closing Cr — Cash/Bank and Group
   * Summary. `bar` draws the graph inline under it (D26: short tables); `overdrawn` adds the muted
   * danger word after a cash/bank ledger in credit.
   */
  closing?: { bar?: { value: (row: TbRow) => number | null; slot: 1 | 'polarity' } | null; overdrawn?: boolean };
  /**
   * (2.1.2, additive) Inline bars under Closing Dr | Closing Cr (the Trial Balance, D26): `value` gives a
   * row's signed closing (Dr + / Cr −) or null for rows without a bar; a Dr balance draws in Closing Dr
   * (slot 1), a Cr balance in Closing Cr (slot 2), both columns on one scale.
   */
  closingBars?: { value: (row: TbRow) => number | null } | null;
}

const drPart = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
const crPart = (v: number | null): number | null => (v !== null && v < 0 ? v : null);

/** Particulars | Opening | Debit | Credit | Closing Dr | Closing Cr, with sticky grand totals. */
export function TbTable({ rows, expansion, showOpening, showTransactions, onActivate, loading, empty, autoFocus = true, totalLabel = 'Grand Total', budget = null, closing, closingBars = null, ...rest }: TbTableProps) {
  const single = closing !== undefined;
  const closingBar = closing?.bar ?? undefined;
  const sideBar = closingBars?.value;
  const overdrawn = closing?.overdrawn ?? false;
  const columns = useMemo<Column<TbRow>[]>(
    () => [
      { key: 'name', header: 'Particulars', tree: true, minWidth: 240 },
      { key: 'opening', header: 'Opening', kind: 'drcr', width: 170, hidden: !showOpening },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true, hidden: !showTransactions },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true, hidden: !showTransactions },
      {
        key: 'closingDr',
        header: 'Closing Dr',
        kind: 'amount',
        width: 160,
        blankZero: true,
        hidden: single,
        value: (r) => (r.closing > 0 ? r.closing : 0),
        bar: sideBar && !single ? { value: (r) => drPart(sideBar(r)), slot: 'polarity', scale: 'closing' } : undefined,
      },
      {
        key: 'closingCr',
        header: 'Closing Cr',
        kind: 'amount',
        width: 160,
        blankZero: true,
        hidden: single,
        value: (r) => (r.closing < 0 ? -r.closing : 0),
        bar: sideBar && !single ? { value: (r) => crPart(sideBar(r)), slot: 'polarity', scale: 'closing' } : undefined,
      },
      {
        key: 'closing',
        header: 'Closing',
        kind: 'drcr',
        width: overdrawn ? 210 : 170,
        hidden: !single,
        bar: closingBar,
        render: overdrawn
          ? (r) =>
              isOverdrawn(r) ? (
                <>
                  {formatDrCr(r.closing)} <span className="bx-rep-danger">overdrawn</span>
                </>
              ) : (
                formatDrCr(r.closing)
              )
          : undefined,
      },
      { key: 'budget', header: budget ? `Budget (${budget.name})` : 'Budget', kind: 'drcr', width: 170, hidden: !budget, value: (r) => rowBudget(budget?.byKey, r.key) ?? 0, render: (r) => (rowBudget(budget?.byKey, r.key) === null ? '' : formatDrCr(rowBudget(budget?.byKey, r.key) ?? 0)) },
      { key: 'variance', header: 'Variance', kind: 'drcr', width: 170, hidden: !budget, value: (r) => tbVariance(budget?.byKey, r, budget?.basisByKey) ?? 0, render: (r) => (tbVariance(budget?.byKey, r, budget?.basisByKey) === null ? '' : formatDrCr(tbVariance(budget?.byKey, r, budget?.basisByKey) ?? 0)) },
    ],
    [showOpening, showTransactions, budget, single, closingBar, overdrawn, sideBar],
  );
  const footer = useMemo<FooterRow[]>(() => {
    const t = tbTotals(rows);
    return [{ key: 'total', tone: 'total', cells: { name: totalLabel, debit: t.debit, credit: t.credit, closingDr: t.closingDebit, closingCr: t.closingCredit, closing: formatDrCr(t.closingDebit - t.closingCredit) } }];
  }, [rows, totalLabel]);
  return (
    <DataTable<TbRow>
      aria-label={rest['aria-label']}
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
  /** The side's name ("Expenses", "Assets"): the first column's header and the table's name. */
  title: string;
  /** The block's caption ("Trading Account"), added to the table's name. */
  caption?: string;
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
  /** A later block of the sheet: its column header is read by screen readers, not shown (one header per sheet). */
  continued?: boolean;
  /** (additive) Budget column (overlay.tsx, Alt+B): side-natural like the amounts (`drNatural`: expenses / assets side). */
  budget?: { name: string; byKey: BudgetByKey; drNatural: boolean } | null;
  /** (2.1) Footnotes moved into row tooltips: the name cell's hover text, by row. */
  rowTitle?: (line: StatementLine) => string | undefined;
}

/**
 * One side of one block of a two-sided statement (Expenses / Income, Liabilities / Assets): a tree
 * table on the flat sheet — no box, no title band; bold only on the Total row.
 */
export function StatementSide({ title, caption, lines, total, compareTotal, compareLabel, expansion, onActivate, loading, autoFocus, heightRows, continued = false, budget = null, rowTitle }: StatementSideProps) {
  const columns = useMemo<Column<StatementLine>[]>(
    () => [
      { key: 'name', header: title, tree: true, minWidth: 180, title: rowTitle ? (r) => rowTitle(r) ?? r.name : undefined },
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
    [title, compareLabel, budget, rowTitle],
  );
  const footer: FooterRow[] = [
    { key: 'total', tone: 'total', cells: { name: 'Total', amount: statementAmountText(total), compare: compareTotal === null ? '' : statementAmountText(compareTotal), budget: '' } },
  ];
  return (
    <DataTable<StatementLine>
      aria-label={caption ? `${title}, ${caption}` : title}
      className={continued ? 'bx-rep-cont' : undefined}
      columns={columns}
      rows={lines}
      getRowKey={(r) => r.key}
      getRowLevel={(r) => r.level}
      getRowClassName={(r) => (r.level > 0 ? 'bx-rep-child' : undefined)}
      expandable
      expandedKeys={expansion.expandedKeys}
      onExpandedChange={expansion.onExpandedChange}
      onRowActivate={onActivate}
      footerRows={footer}
      loading={loading}
      virtualize={false}
      height={`calc(var(--row-h) * ${Math.max(heightRows, 3) + (continued ? 1 : 2)} + 2px)`}
      empty={<EmptyState size="sm" icon="book" title="No amounts" />}
      autoFocus={autoFocus}
    />
  );
}
