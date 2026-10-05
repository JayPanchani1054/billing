/**
 * Flat pre-order tree helpers for tree reports (Trial Balance, Balance Sheet, Stock Summary …):
 * rows arrive in display order with a `level` (0 = top). Pure — unit tested in tree.test.ts.
 */

export interface TreeInfo {
  /** Index of the nearest ancestor (row with smaller level above it), -1 for top-level rows. */
  parentIndex: number[];
  /** True when the next row is deeper — i.e. this row can expand/collapse. */
  hasChildren: boolean[];
}

export function computeTreeInfo(levels: readonly number[]): TreeInfo {
  const parentIndex: number[] = new Array<number>(levels.length).fill(-1);
  const hasChildren: boolean[] = new Array<boolean>(levels.length).fill(false);
  const stack: number[] = [];
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    while (stack.length > 0 && levels[stack[stack.length - 1]] >= lv) stack.pop();
    parentIndex[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (i + 1 < levels.length && levels[i + 1] > lv) hasChildren[i] = true;
    stack.push(i);
  }
  return { parentIndex, hasChildren };
}

/** Indexes of rows visible given which parent rows are expanded. */
export function visibleTreeIndices(levels: readonly number[], hasChildren: readonly boolean[], isExpanded: (index: number) => boolean): number[] {
  const out: number[] = [];
  let hiddenDeeperThan = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv > hiddenDeeperThan) continue;
    hiddenDeeperThan = Number.POSITIVE_INFINITY;
    out.push(i);
    if (hasChildren[i] && !isExpanded(i)) hiddenDeeperThan = lv;
  }
  return out;
}

/** Indexes of all rows that have children (for "expand all"). */
export function parentIndices(levels: readonly number[]): number[] {
  const { hasChildren } = computeTreeInfo(levels);
  const out: number[] = [];
  for (let i = 0; i < hasChildren.length; i++) if (hasChildren[i]) out.push(i);
  return out;
}

/** Keys of parent rows whose level is below `depth` (expand "up to level N"). */
export function keysUpToLevel<T>(rows: readonly T[], getKey: (row: T, i: number) => string, getLevel: (row: T) => number, depth: number): Set<string> {
  const levels = rows.map(getLevel);
  const { hasChildren } = computeTreeInfo(levels);
  const out = new Set<string>();
  for (let i = 0; i < rows.length; i++) if (hasChildren[i] && levels[i] < depth) out.add(getKey(rows[i], i));
  return out;
}
