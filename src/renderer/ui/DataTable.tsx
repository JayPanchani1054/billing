import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';
import { EmptyState } from './EmptyState.tsx';
import { Icon } from './Icon.tsx';
import { Skeleton } from './Skeleton.tsx';
import { useControllableState } from './hooks/useControllableState.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';
import { readPxVar } from './lib/dom.ts';
import { findByPrefix, nextListIndex } from './lib/listNav.ts';
import type { ListNavKey } from './lib/listNav.ts';
import { computeTreeInfo, visibleTreeIndices } from './lib/tree.ts';
import { computeVirtualWindow, pageSize, scrollTopToReveal } from './lib/virtual.ts';
import type { Align, Density } from './types.ts';
import { formatDrCr, formatIndianNumber, formatMoney, formatQty } from '../../shared/format.ts';
import { formatDate } from '../../shared/dates.ts';

export type ColumnKind = 'text' | 'amount' | 'drcr' | 'qty' | 'date' | 'number';

export interface CellContext {
  index: number;
  level: number;
  /** Raw value from `value()` / row[key]. */
  value: unknown;
  /** Text the kit would render for this cell (formatted by kind). */
  formatted: string;
}

export interface Column<T> {
  /** Unique column id; also the default accessor (row[key]) for plain-object rows. */
  key: string;
  header: ReactNode;
  /** Plain-text header for screen readers when `header` is not a string. */
  headerLabel?: string;
  /** px number or CSS length ('20%', '12rem'). Omit for a flexible column. */
  width?: number | string;
  /** Minimum width for flexible columns (px, default 120). */
  minWidth?: number;
  /** Default: right for amount/drcr/qty/number, left otherwise. */
  align?: Align;
  /** Formatting: amount → formatMoney(paise) · drcr → formatDrCr(paise) · qty → formatQty · date → formatDate · number. */
  kind?: ColumnKind;
  /** Raw value accessor (default row[key]). Used for formatting, sorting, totals and type-to-jump. */
  value?: (row: T) => unknown;
  /** Custom cell content (overrides kind formatting). */
  render?: (row: T, ctx: CellContext) => ReactNode;
  /** Footer cell content (or a function of all rows). */
  footer?: ReactNode | ((rows: readonly T[]) => ReactNode);
  /** Footer total: true sums value() over top-level rows (tree) or non-group rows; or provide a function. */
  total?: boolean | ((rows: readonly T[]) => number);
  sortable?: boolean;
  sortValue?: (row: T) => string | number | null | undefined;
  /** Decimals for qty/number kinds. */
  decimals?: number;
  /** Unit suffix for qty kind. */
  unit?: string | ((row: T) => string | undefined);
  /** Blank instead of 0.00 for amount kind (drcr zero is always blank). */
  blankZero?: boolean;
  /** Carries tree indentation + expander (default: the first column). */
  tree?: boolean;
  hidden?: boolean;
  className?: string;
  cellClassName?: (row: T) => string | undefined;
  /** Hover title for truncated cells (default: formatted text). */
  title?: (row: T) => string | undefined;
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface FooterRow {
  key: string;
  /** Cells by column key (missing → empty). Numbers are formatted by the column kind. */
  cells: Readonly<Record<string, ReactNode | number>>;
  /** 'total' (bold, top rule) or 'subtle'. */
  tone?: 'total' | 'subtle';
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  getRowKey: (row: T, index: number) => string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Enter / double-click → drill-down. */
  onRowActivate?: (row: T, index: number) => void;
  /** Highlighted (cursor) row — controlled. */
  selectedKey?: string | null;
  defaultSelectedKey?: string | null;
  onSelect?: (key: string | null, row: T | null) => void;
  /** Tree reports: indentation level per row (0 = top). Rows must be in display (pre-order) order. */
  getRowLevel?: (row: T) => number;
  /** Bold group rows ("group" lines). */
  isGroupRow?: (row: T) => boolean;
  /** Allow collapsing rows that have children (→/← or +/−). Requires getRowLevel. */
  expandable?: boolean;
  /** Controlled: keys of expanded parent rows (e.g. Alt+F5 "Detailed" = all parent keys via keysUpToLevel). */
  expandedKeys?: ReadonlySet<string>;
  /** Uncontrolled policy: 'all' (default), 'none', or expand rows whose level < N. User toggles are kept on top. */
  defaultExpanded?: 'all' | 'none' | number;
  /** Receives the full set of expanded parent keys after a toggle. */
  onExpandedChange?: (keys: ReadonlySet<string>) => void;
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Rows are already sorted by the caller (server-side); header clicks only report. */
  manualSort?: boolean;
  loading?: boolean;
  skeletonRows?: number;
  /** Empty state content (default: "Nothing to show"). */
  empty?: ReactNode;
  /** Height of the scroll area (default 100% of the parent). */
  height?: number | string;
  /** 'auto' (default) windows when > 200 visible rows. */
  virtualize?: boolean | 'auto';
  /** Fixed row height override (px). Default: --row-h for the density. */
  rowHeight?: number;
  density?: Density;
  zebra?: boolean;
  /** Footer rows (Opening / Current Total / Closing). Replaces the column-footer row. */
  footerRows?: readonly FooterRow[];
  /** Jump to the row whose label starts with typed letters (default true). A function supplies the label. */
  typeToJump?: boolean | ((row: T) => string);
  getRowClassName?: (row: T, index: number) => string | undefined;
  /** Extra keys while the grid has focus (runs first; preventDefault to stop default handling). */
  onRowKeyDown?: (e: ReactKeyboardEvent<HTMLTableElement>, row: T | null) => void;
  autoFocus?: boolean;
  className?: string;
  /** Ref to the focusable <table role="grid">. */
  gridRef?: Ref<HTMLTableElement>;
  ref?: Ref<HTMLDivElement>;
}

const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set<ColumnKind>(['amount', 'drcr', 'qty', 'number']);
const VIRTUAL_THRESHOLD = 200;
const collator = new Intl.Collator('en-IN', { numeric: true, sensitivity: 'base' });

function rawValue<T>(col: Column<T>, row: T): unknown {
  if (col.value) return col.value(row);
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[col.key];
  return undefined;
}

function alignOf<T>(col: Column<T>): Align {
  return col.align ?? (col.kind && NUMERIC_KINDS.has(col.kind) ? 'right' : 'left');
}

interface Formatted {
  text: string;
  node: ReactNode;
}

function formatByKind<T>(col: Column<T>, v: unknown, row: T | null): Formatted {
  if (v === null || v === undefined || v === '') return { text: '', node: null };
  switch (col.kind) {
    case 'amount': {
      if (typeof v !== 'number') break;
      if (v === 0 && col.blankZero) return { text: '', node: null };
      const t = formatMoney(v);
      return { text: t, node: t };
    }
    case 'drcr': {
      if (typeof v !== 'number') break;
      if (v === 0) return { text: '', node: null };
      const t = formatDrCr(v);
      return {
        text: t,
        node: (
          <>
            <span className="bx-amt">{formatMoney(v, { absolute: true })}</span>
            <span className={cx('bx-drcr', v > 0 ? 'bx-drcr--dr' : 'bx-drcr--cr')}>{v > 0 ? 'Dr' : 'Cr'}</span>
          </>
        ),
      };
    }
    case 'qty': {
      if (typeof v !== 'number') break;
      const unit = typeof col.unit === 'function' ? (row === null ? undefined : col.unit(row)) : col.unit;
      const t = formatQty(v, col.decimals ?? 0, unit);
      return { text: t, node: t };
    }
    case 'number': {
      if (typeof v !== 'number') break;
      const t = formatIndianNumber(v, col.decimals ?? 0);
      return { text: t, node: t };
    }
    case 'date': {
      if (typeof v !== 'string') break;
      const t = formatDate(v);
      return { text: t, node: t };
    }
    default:
      break;
  }
  const t = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '';
  return { text: t, node: t };
}

function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // empty last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

// ── Row ────────────────────────────────────────────────────────────────────────────────────────

interface BodyRowProps<T> {
  row: T;
  rowIndex: number;
  pos: number;
  columns: readonly Column<T>[];
  treeCol: number;
  level: number;
  hasChildren: boolean;
  expanded: boolean;
  expandable: boolean;
  group: boolean;
  active: boolean;
  id: string;
  treegrid: boolean;
  className?: string;
}

function BodyRowImpl<T>({ row, rowIndex, pos, columns, treeCol, level, hasChildren, expanded, expandable, group, active, id, treegrid, className }: BodyRowProps<T>) {
  return (
    <tr
      id={id}
      data-pos={pos}
      aria-rowindex={pos + 2}
      aria-selected={active}
      aria-level={treegrid ? level + 1 : undefined}
      aria-expanded={treegrid && hasChildren && expandable ? expanded : undefined}
      className={cx('bx-tr', active && 'is-active', group && 'is-group', className)}
    >
      {columns.map((col, ci) => {
        const v = rawValue(col, row);
        const f = formatByKind(col, v, row);
        const content = col.render ? col.render(row, { index: rowIndex, level, value: v, formatted: f.text }) : f.node;
        const isTree = ci === treeCol;
        const title = col.title ? col.title(row) : f.text || undefined;
        return (
          <td
            key={col.key}
            role="gridcell"
            className={cx('bx-td', `bx-td--${alignOf(col)}`, col.kind && `bx-td--${col.kind}`, isTree && level > 0 && 'bx-td--indented', col.className, col.cellClassName?.(row))}
            style={isTree && level > 0 ? ({ '--level': level } as CSSProperties) : undefined}
            title={title}
          >
            {isTree && expandable ? (
              hasChildren ? (
                <span className="bx-expander" data-expander="" aria-hidden="true">
                  <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
                </span>
              ) : (
                <span className="bx-expander bx-expander--leaf" aria-hidden="true" />
              )
            ) : null}
            {isTree ? <span className="bx-td__text">{content}</span> : content}
          </td>
        );
      })}
    </tr>
  );
}

const BodyRow = memo(BodyRowImpl) as unknown as typeof BodyRowImpl;

// ── Table ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Report/list grid. One Tab stop; ↑/↓/PgUp/PgDn/Home/End move the highlighted row, Enter or
 * double-click activates (drill-down), →/← or +/− expand/collapse tree rows, letters jump to a row.
 * Sticky header and totals footer; windowed rendering for large row counts (fixed row height).
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns: allColumns,
    rows,
    getRowKey,
    onRowActivate,
    selectedKey,
    defaultSelectedKey = null,
    onSelect,
    getRowLevel,
    isGroupRow,
    expandable = false,
    expandedKeys,
    defaultExpanded = 'all',
    onExpandedChange,
    sort: sortProp,
    defaultSort = null,
    onSortChange,
    manualSort = false,
    loading = false,
    skeletonRows = 8,
    empty,
    height,
    virtualize = 'auto',
    rowHeight: rowHeightProp,
    density,
    zebra = false,
    footerRows,
    typeToJump = true,
    getRowClassName,
    onRowKeyDown,
    autoFocus,
    className,
    gridRef,
    ref,
  } = props;

  const baseId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const theadRef = useRef<HTMLTableSectionElement | null>(null);
  const tfootRef = useRef<HTMLTableSectionElement | null>(null);
  const mergedTableRef = useMergedRefs(tableRef, gridRef);
  const revealRef = useRef(false);
  const typed = useRef({ buffer: '', at: 0 });

  const columns = useMemo(() => allColumns.filter((c) => !c.hidden), [allColumns]);
  const treeCol = Math.max(0, columns.findIndex((c) => c.tree));
  const tree = !!getRowLevel;
  const canExpand = tree && expandable;

  // Getters are read when `rows` changes (inline arrow functions must not recompute 10k-row maps per render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => rows.map((r, i) => getRowKey(r, i)), [rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const levels = useMemo(() => (getRowLevel ? rows.map(getRowLevel) : null), [rows, !!getRowLevel]);
  const treeInfo = useMemo(() => (levels ? computeTreeInfo(levels) : null), [levels]);
  const indexByKey = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys]);

  // ── Expansion ──
  // Uncontrolled: the `defaultExpanded` policy XOR the keys the user toggled (works when rows arrive
  // after mount). Controlled: `expandedKeys` is the full set of expanded parent keys.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set<string>());
  const defaultOpen = useCallback(
    (level: number) => (defaultExpanded === 'all' ? true : defaultExpanded === 'none' ? false : level < defaultExpanded),
    [defaultExpanded],
  );
  const isExpandedIdx = useCallback(
    (i: number): boolean => {
      const key = keys[i];
      if (expandedKeys) return expandedKeys.has(key);
      return defaultOpen(levels ? levels[i] : 0) !== toggled.has(key);
    },
    [keys, levels, expandedKeys, toggled, defaultOpen],
  );
  const toggleRow = useCallback(
    (key: string, open?: boolean) => {
      const i = indexByKey.get(key);
      if (i === undefined) return;
      const isOpen = isExpandedIdx(i);
      const want = open ?? !isOpen;
      if (want === isOpen) return;
      let nextToggled = toggled;
      if (!expandedKeys) {
        const t = new Set(toggled);
        if (t.has(key)) t.delete(key);
        else t.add(key);
        nextToggled = t;
        setToggled(t);
      }
      if (onExpandedChange) {
        const full = new Set<string>(expandedKeys ?? []);
        if (expandedKeys) {
          if (want) full.add(key);
          else full.delete(key);
        } else if (treeInfo) {
          treeInfo.hasChildren.forEach((has, idx) => {
            if (has && defaultOpen(levels ? levels[idx] : 0) !== nextToggled.has(keys[idx])) full.add(keys[idx]);
          });
        }
        onExpandedChange(full);
      }
    },
    [indexByKey, isExpandedIdx, toggled, expandedKeys, onExpandedChange, treeInfo, defaultOpen, levels, keys],
  );

  // ── Sorting ──
  const [sort, setSort] = useControllableState<SortState | null>({ value: sortProp, defaultValue: defaultSort, onChange: onSortChange });

  // ── Visible rows (tree visibility → sort) ──
  const visible = useMemo(() => {
    let idx: number[];
    if (levels && treeInfo && canExpand) idx = visibleTreeIndices(levels, treeInfo.hasChildren, isExpandedIdx);
    else idx = rows.map((_, i) => i);
    if (sort && !manualSort && !tree) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const val = (i: number) => (col.sortValue ? col.sortValue(rows[i]) : rawValue(col, rows[i]));
        const dir = sort.direction === 'asc' ? 1 : -1;
        idx = [...idx].sort((a, b) => {
          const va = val(a);
          const vb = val(b);
          const emptyA = va === null || va === undefined || va === '';
          const emptyB = vb === null || vb === undefined || vb === '';
          if (emptyA || emptyB) return compareValues(va, vb) || a - b; // empties last in both directions
          return dir * compareValues(va, vb) || a - b;
        });
      }
    }
    return idx;
  }, [levels, treeInfo, canExpand, isExpandedIdx, rows, sort, manualSort, tree, columns]);

  const posByKey = useMemo(() => new Map(visible.map((ri, p) => [keys[ri], p])), [visible, keys]);

  // ── Active row ──
  const [activeKey, setActiveKey] = useControllableState<string | null>({
    value: selectedKey,
    defaultValue: defaultSelectedKey,
    onChange: (k) => {
      if (!onSelect) return;
      const i = k === null ? undefined : indexByKey.get(k);
      onSelect(k, i === undefined ? null : rows[i]);
    },
  });
  const activePos = activeKey === null ? -1 : posByKey.get(activeKey) ?? -1;
  const activeRowIndex = activePos >= 0 ? visible[activePos] : -1;

  // ── Measurement ──
  const [metrics, setMetrics] = useState({ viewport: 0, header: 0, footer: 0, row: rowHeightProp ?? 32 });
  const [scrollTop, setScrollTop] = useState(0);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const firstRow = scroller.querySelector<HTMLElement>('tbody tr.bx-tr');
    const varH = readPxVar(scroller, '--row-h');
    const measured = firstRow ? firstRow.getBoundingClientRect().height : Number.NaN;
    const row = rowHeightProp ?? (measured > 0 ? measured : varH > 0 ? varH : 32);
    const next = {
      viewport: scroller.clientHeight,
      header: theadRef.current?.offsetHeight ?? 0,
      footer: tfootRef.current?.offsetHeight ?? 0,
      row,
    };
    setMetrics((m) =>
      Math.abs(m.viewport - next.viewport) < 0.5 && Math.abs(m.header - next.header) < 0.5 && Math.abs(m.footer - next.footer) < 0.5 && Math.abs(m.row - next.row) < 0.5
        ? m
        : next,
    );
  }, [rowHeightProp]);

  useLayoutEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [measure]);

  // Re-measure when the row/footers change shape (first render with data, density switch).
  useLayoutEffect(() => {
    measure();
  }, [measure, visible.length > 0, loading, density, footerRows?.length]);

  useLayoutEffect(() => {
    if (autoFocus) tableRef.current?.focus({ preventScroll: true });
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const virtual = virtualize === true || (virtualize === 'auto' && visible.length > VIRTUAL_THRESHOLD);
  const win = virtual
    ? computeVirtualWindow({ count: visible.length, rowHeight: metrics.row, scrollTop, viewportHeight: metrics.viewport, overscan: 10 })
    : { start: 0, end: visible.length, padTop: 0, padBottom: 0 };

  // Bring the active row into view after keyboard moves.
  useLayoutEffect(() => {
    if (!revealRef.current) return;
    revealRef.current = false;
    const scroller = scrollRef.current;
    if (!scroller || activePos < 0) return;
    const next = scrollTopToReveal({
      index: activePos,
      rowHeight: metrics.row,
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      headerHeight: metrics.header,
      footerHeight: metrics.footer,
    });
    if (next !== null) {
      scroller.scrollTop = next;
      setScrollTop(next);
    }
  });

  // ── Interaction ──
  const moveTo = useCallback(
    (pos: number) => {
      if (pos < 0 || pos >= visible.length) return;
      revealRef.current = true;
      setActiveKey(keys[visible[pos]]);
    },
    [visible, keys, setActiveKey],
  );

  const labelOf = useCallback(
    (pos: number): string => {
      const row = rows[visible[pos]];
      if (typeof typeToJump === 'function') return typeToJump(row);
      const col = columns[treeCol] ?? columns[0];
      if (!col) return '';
      const f = formatByKind(col, rawValue(col, row), row);
      return f.text;
    },
    [rows, visible, typeToJump, columns, treeCol],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTableElement>) => {
    const activeRow = activeRowIndex >= 0 ? rows[activeRowIndex] : null;
    onRowKeyDown?.(e, activeRow);
    if (e.defaultPrevented) return;
    if (e.target !== tableRef.current) return; // keys inside interactive cell content
    if (e.altKey || e.metaKey) return;
    const count = visible.length;
    const navKeys: readonly string[] = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
    if (navKeys.includes(e.key) && (!e.ctrlKey || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const page = pageSize(metrics.viewport, metrics.row, metrics.header + metrics.footer);
      moveTo(nextListIndex(activePos, e.key as ListNavKey, { count, pageSize: page }));
      return;
    }
    if (e.ctrlKey) return;
    if (e.key === 'Enter') {
      if (activeRow !== null && onRowActivate) {
        e.preventDefault();
        onRowActivate(activeRow, activeRowIndex);
      }
      return;
    }
    if (canExpand && treeInfo && activeRowIndex >= 0) {
      const key = keys[activeRowIndex];
      const hasKids = treeInfo.hasChildren[activeRowIndex];
      const isOpen = isExpandedIdx(activeRowIndex);
      if (e.key === 'ArrowRight' || e.key === '+') {
        e.preventDefault();
        if (hasKids && !isOpen) toggleRow(key, true);
        else if (hasKids && e.key === 'ArrowRight') moveTo(activePos + 1);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === '-') {
        e.preventDefault();
        if (hasKids && isOpen) toggleRow(key, false);
        else if (e.key === 'ArrowLeft') {
          const parent = treeInfo.parentIndex[activeRowIndex];
          if (parent >= 0) moveTo(posByKey.get(keys[parent]) ?? -1);
        }
        return;
      }
    }
    if (typeToJump && e.key.length === 1 && e.key !== ' ' && count > 0) {
      const now = Date.now();
      const t = typed.current;
      t.buffer = now - t.at > 700 ? e.key : t.buffer + e.key;
      t.at = now;
      const hit = findByPrefix(labelOf, count, activePos, t.buffer);
      if (hit >= 0) {
        e.preventDefault();
        moveTo(hit);
      }
    }
  };

  const rowFromEvent = (e: ReactMouseEvent<HTMLElement>): number => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-pos]');
    if (!tr) return -1;
    return Number(tr.getAttribute('data-pos'));
  };

  const onBodyClick = (e: ReactMouseEvent<HTMLTableSectionElement>) => {
    const pos = rowFromEvent(e);
    if (pos < 0) return;
    const target = e.target as HTMLElement;
    const ri = visible[pos];
    if (target.closest('[data-expander]')) {
      toggleRow(keys[ri]);
    }
    setActiveKey(keys[ri]);
    if (!target.closest('a,button:not([data-expander]),input,select,textarea,[contenteditable="true"]')) tableRef.current?.focus({ preventScroll: true });
  };

  const onBodyDoubleClick = (e: ReactMouseEvent<HTMLTableSectionElement>) => {
    const pos = rowFromEvent(e);
    if (pos < 0 || !onRowActivate) return;
    if ((e.target as HTMLElement).closest('[data-expander]')) return;
    const ri = visible[pos];
    onRowActivate(rows[ri], ri);
  };

  const toggleSort = (col: Column<T>) => {
    setSort((cur) => {
      if (!cur || cur.key !== col.key) return { key: col.key, direction: NUMERIC_KINDS.has(col.kind ?? 'text') ? 'desc' : 'asc' };
      if (cur.direction === (NUMERIC_KINDS.has(col.kind ?? 'text') ? 'desc' : 'asc')) return { key: col.key, direction: cur.direction === 'asc' ? 'desc' : 'asc' };
      return null;
    });
  };

  // ── Footer ──
  const footer = useMemo((): FooterRow[] | null => {
    if (footerRows) return [...footerRows];
    if (!columns.some((c) => c.footer !== undefined || c.total)) return null;
    const cells: Record<string, ReactNode | number> = {};
    for (const c of columns) {
      if (c.total) {
        if (typeof c.total === 'function') cells[c.key] = c.total(rows);
        else {
          let sum = 0;
          rows.forEach((r, i) => {
            if (levels ? levels[i] !== 0 : isGroupRow?.(r)) return;
            const v = rawValue(c, r);
            if (typeof v === 'number') sum += v;
          });
          cells[c.key] = sum;
        }
      } else if (c.footer !== undefined) {
        cells[c.key] = typeof c.footer === 'function' ? c.footer(rows) : c.footer;
      }
    }
    return [{ key: '__total__', cells, tone: 'total' }];
  }, [footerRows, columns, rows, levels, isGroupRow]);

  // ── Widths ──
  const minTableWidth = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : c.minWidth ?? 120), 0);
  const treegrid = canExpand;
  const showEmpty = !loading && visible.length === 0;
  const activeInWindow = activePos >= win.start && activePos < win.end;

  return (
    <div
      ref={ref}
      className={cx('bx-table', zebra && 'bx-table--zebra', tree && 'bx-table--tree', className)}
      data-density={density}
      style={{ height, ...(rowHeightProp ? ({ '--row-h': `${rowHeightProp}px` } as CSSProperties) : {}) }}
    >
      <div
        ref={scrollRef}
        className="bx-table__scroll"
        onScroll={(e) => {
          if (virtual) setScrollTop(e.currentTarget.scrollTop);
        }}
      >
        <table
          ref={mergedTableRef}
          role={treegrid ? 'treegrid' : 'grid'}
          tabIndex={0}
          className="bx-table__grid"
          style={{ minWidth: minTableWidth }}
          aria-label={props['aria-label']}
          aria-labelledby={props['aria-labelledby']}
          aria-rowcount={visible.length + 1 + (footer?.length ?? 0)}
          aria-colcount={columns.length}
          aria-busy={loading || undefined}
          aria-readonly="true"
          aria-multiselectable="false"
          aria-activedescendant={activeInWindow && activeRowIndex >= 0 ? `${baseId}-r${activeRowIndex}` : undefined}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // There is always a cursor line: focusing the grid highlights the first row.
            if (e.target === tableRef.current && activePos < 0 && visible.length > 0) setActiveKey(keys[visible[0]]);
          }}
        >
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width !== undefined ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead ref={theadRef} className="bx-thead">
            <tr className="bx-tr bx-tr--head" aria-rowindex={1}>
              {columns.map((c) => {
                const isSorted = sort && sort.key === c.key;
                const ariaSort = c.sortable ? (isSorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    role="columnheader"
                    aria-sort={ariaSort}
                    aria-label={c.headerLabel}
                    className={cx('bx-th', `bx-th--${alignOf(c)}`, c.className)}
                  >
                    {c.sortable && !tree ? (
                      <button type="button" className="bx-th__sort" onClick={() => toggleSort(c)}>
                        <span className="bx-th__label">{c.header}</span>
                        <Icon name={isSorted ? (sort.direction === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort'} size="xs" className={cx('bx-th__sort-icon', isSorted && 'is-sorted')} />
                      </button>
                    ) : (
                      <span className="bx-th__label">{c.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="bx-tbody" onClick={onBodyClick} onDoubleClick={onBodyDoubleClick}>
            {loading && visible.length === 0
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={`sk${i}`} className="bx-tr bx-tr--skeleton" aria-hidden="true">
                    {columns.map((c, ci) => (
                      <td key={c.key} className={cx('bx-td', `bx-td--${alignOf(c)}`)}>
                        <Skeleton width={ci === 0 ? `${55 + ((i * 17) % 35)}%` : '60%'} />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {showEmpty ? (
              <tr className="bx-tr bx-tr--empty">
                <td colSpan={columns.length} className="bx-td bx-td--empty">
                  {empty ?? <EmptyState size="sm" icon="search" title="Nothing to show" body="There are no entries for this selection." />}
                </td>
              </tr>
            ) : null}
            {win.padTop > 0 ? (
              <tr className="bx-tr bx-tr--spacer" aria-hidden="true" style={{ height: win.padTop }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
            {visible.slice(win.start, win.end).map((ri, k) => {
              const pos = win.start + k;
              const row = rows[ri];
              const key = keys[ri];
              return (
                <BodyRow<T>
                  key={key}
                  row={row}
                  rowIndex={ri}
                  pos={pos}
                  columns={columns}
                  treeCol={treeCol}
                  level={levels ? levels[ri] : 0}
                  hasChildren={treeInfo ? treeInfo.hasChildren[ri] : false}
                  expanded={canExpand ? isExpandedIdx(ri) : true}
                  expandable={canExpand}
                  group={isGroupRow ? isGroupRow(row) : false}
                  active={pos === activePos}
                  id={`${baseId}-r${ri}`}
                  treegrid={treegrid}
                  className={cx(zebra && pos % 2 === 1 && 'is-odd', getRowClassName?.(row, ri))}
                />
              );
            })}
            {win.padBottom > 0 ? (
              <tr className="bx-tr bx-tr--spacer" aria-hidden="true" style={{ height: win.padBottom }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
          </tbody>
          {footer && !showEmpty ? (
            <tfoot ref={tfootRef} className="bx-tfoot">
              {footer.map((fr, fi) => (
                <tr key={fr.key} className={cx('bx-tr', 'bx-tr--foot', fr.tone === 'subtle' ? 'is-subtle' : 'is-total')} aria-rowindex={visible.length + 2 + fi}>
                  {columns.map((c) => {
                    const cell = fr.cells[c.key];
                    const content = typeof cell === 'number' ? formatByKind(c, cell, null).node : cell;
                    return (
                      <td
                        key={c.key}
                        role="gridcell"
                        className={cx('bx-td', `bx-td--${alignOf(c)}`, c.kind && `bx-td--${c.kind}`)}
                        style={{ bottom: (footer.length - 1 - fi) * metrics.row }}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
