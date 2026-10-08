/**
 * Shared pieces of the stock report screens: report period / as-on date (global, or drilled-down
 * from params), tree expansion, drill-down navigation and column builders for quantity / value.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNav, usePeriod } from '../../app/index.ts';
import type { Period } from '../../app/index.ts';
import { EmptyState } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { keysUpToLevel, paramsPeriod, parentKeys, qtyText, rateText, signedAmountText } from './lib/model.ts';
import type { DrillTarget, Range, TreeRowLike } from './lib/model.ts';

// ───────────────────────────── Period ─────────────────────────────

export interface StockPeriod extends Range {
  /** Pass to ReportScreen `period` (the drilled-down range, or the global one). */
  period: Period;
  /** True while showing a drilled-down range (Alt+F2 then switches back to the global period). */
  drilled: boolean;
}

/**
 * The report period: `params.from/to` when opened by a drill-down, otherwise the global period
 * (Alt+F2). Changing the global period afterwards applies to this screen too.
 */
export function useStockPeriod(params: { from?: unknown; to?: unknown } | undefined): StockPeriod {
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
  const range = override ?? { from: g.from, to: g.to };
  const period = useMemo<Period>(() => (override ? { ...g.period, from: override.from, to: override.to } : g.period), [override, g.period]);
  return { from: range.from, to: range.to, period, drilled: override !== null };
}

// ───────────────────────────── Expansion ─────────────────────────────

export interface Expansion {
  expandedKeys: ReadonlySet<string>;
  onExpandedChange: (keys: ReadonlySet<string>) => void;
  allOpen: boolean;
  toggleAll: () => void;
}

/** Controlled tree expansion: opens rows up to `defaultLevel` until the user changes it. */
export function useExpansion(rows: readonly TreeRowLike[], defaultLevel: number): Expansion {
  const [keys, setKeys] = useState<ReadonlySet<string> | null>(null);
  const parents = useMemo(() => parentKeys(rows), [rows]);
  const expandedKeys = useMemo(() => keys ?? keysUpToLevel(rows, defaultLevel), [keys, rows, defaultLevel]);
  const allOpen = parents.size > 0 && [...parents].every((k) => expandedKeys.has(k));
  const toggleAll = useCallback(() => setKeys(allOpen ? new Set() : new Set(parents)), [allOpen, parents]);
  return { expandedKeys, onExpandedChange: setKeys, allOpen, toggleAll };
}

// ───────────────────────────── Drill-down ─────────────────────────────

export function useDrill(): (target: DrillTarget | null) => void {
  const nav = useNav();
  return useCallback(
    (target: DrillTarget | null) => {
      if (target) nav.push(target.screen, target.params);
    },
    [nav],
  );
}

// ───────────────────────────── Columns ─────────────────────────────

/** Right-aligned quantity with its unit ('12.5 Kg'); blank for null / zero when blankZero. */
export function qtyColumn<T>(key: string, header: string, get: (r: T) => number | null | undefined, unit: (r: T) => string | null | undefined, opts: { width?: number; blankZero?: boolean; hidden?: boolean } = {}): Column<T> {
  return {
    key,
    header,
    kind: 'qty',
    width: opts.width ?? 130,
    hidden: opts.hidden,
    value: (r) => get(r) ?? null,
    render: (r) => qtyText(get(r), unit(r), { blankZero: opts.blankZero }),
    title: (r) => qtyText(get(r), unit(r)),
  };
}

/**
 * Right-aligned paise. Negatives (negative stock, losses) show in parentheses — never a bare minus
 * (UI kit rule); `value` stays signed for sorting and export. Zero is blank unless blankZero: false.
 */
export function amountColumn<T>(key: string, header: string, get: (r: T) => number | null | undefined, opts: { width?: number; blankZero?: boolean; hidden?: boolean; total?: boolean; cellClassName?: (r: T) => string | undefined } = {}): Column<T> {
  const blankZero = opts.blankZero ?? true;
  return {
    key,
    header,
    kind: 'amount',
    width: opts.width ?? 150,
    blankZero,
    hidden: opts.hidden,
    total: opts.total,
    value: (r) => get(r) ?? null,
    render: (r) => signedAmountText(get(r), blankZero),
    title: (r) => signedAmountText(get(r), blankZero) || undefined,
    cellClassName: opts.cellClassName ?? ((r) => ((get(r) ?? 0) < 0 ? 'bx-stock-loss' : undefined)),
  };
}

export function rateColumn<T>(key: string, header: string, get: (r: T) => number | null | undefined, opts: { width?: number; hidden?: boolean } = {}): Column<T> {
  return { key, header, kind: 'number', width: opts.width ?? 110, hidden: opts.hidden, value: (r) => get(r) ?? null, render: (r) => rateText(get(r)) };
}

/** Empty state with what to do next. */
export function NothingHere({ title, body, icon = 'box' }: { title: string; body: ReactNode; icon?: 'box' | 'warehouse' | 'chart' | 'clock' | 'cart' | 'check-circle' }) {
  return <EmptyState icon={icon} title={title} body={body} />;
}
