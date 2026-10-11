/**
 * Columns empty on every row (2.1, SPEC-21 D22, DataTable `hideEmptyColumns`). A column whose every
 * cell would render blank is noise — a GSTIN column on a list of cash ledgers, an "Alias" nobody uses.
 * Pure: DataTable passes its columns and rows; exports never use this (they keep every column).
 */

/** The parts of a DataTable column this rule reads (structurally compatible with `Column<T>`). */
export interface EmptyColumnLike<T> {
  key: string;
  value?: (row: T) => unknown;
  kind?: string;
  blankZero?: boolean;
  tree?: boolean;
  /** Never hidden, even when blank on every row. */
  keepEmpty?: boolean;
  /** Custom cell content: a render-only column (no `value`, key not on the row) is never judged blank. */
  render?: unknown;
}

/**
 * Whether a raw cell value renders blank for its column kind: null/undefined/blank text always; 0 only
 * where the kit draws zero as blank (Dr/Cr amounts, or amounts with `blankZero`).
 */
export function isBlankCell(kind: string | undefined, blankZero: boolean | undefined, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return v === 0 && (kind === 'drcr' || (kind === 'amount' && blankZero === true));
  return false;
}

/**
 * A column whose cells are drawn by `render` from other fields (no `value`, and its key is not a field of
 * the row — an actions or status column): its raw value says nothing about what is drawn, so it is never
 * reported blank.
 */
function renderOnly<T>(col: EmptyColumnLike<T>, rows: readonly T[]): boolean {
  if (!col.render || col.value) return false;
  return !rows.some((row) => row !== null && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, col.key));
}

function cellOf<T>(col: EmptyColumnLike<T>, row: T): unknown {
  if (col.value) return col.value(row);
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[col.key];
  return undefined;
}

/**
 * Keys of the columns that are blank on every row. Never hidden: the label column (the first column,
 * or the tree column), columns with `keepEmpty`, render-only columns (see `renderOnly`), and anything
 * at all while there are no rows (an empty table keeps its headers so it still reads as a table).
 */
export function emptyColumnIds<T>(columns: readonly EmptyColumnLike<T>[], rows: readonly T[]): string[] {
  if (rows.length === 0 || columns.length === 0) return [];
  const treeIdx = columns.findIndex((c) => c.tree);
  const labelIdx = treeIdx >= 0 ? treeIdx : 0;
  const out: string[] = [];
  columns.forEach((col, i) => {
    if (i === labelIdx || col.keepEmpty || renderOnly(col, rows)) return;
    for (const row of rows) if (!isBlankCell(col.kind, col.blankZero, cellOf(col, row))) return;
    out.push(col.key);
  });
  return out;
}
