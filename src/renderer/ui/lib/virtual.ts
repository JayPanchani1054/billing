/**
 * Fixed-row-height windowing math for DataTable and Combobox. Pure — unit tested in virtual.test.ts.
 *
 * Content coordinates: rows start at `headerHeight` (a sticky header occludes exactly that much of
 * the viewport top) and a sticky footer occludes `footerHeight` at the bottom.
 */

export interface VirtualWindow {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive). */
  end: number;
  /** Spacer height before the first rendered row (px). */
  padTop: number;
  /** Spacer height after the last rendered row (px). */
  padBottom: number;
}

export interface WindowInput {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}

export function computeVirtualWindow({ count, rowHeight, scrollTop, viewportHeight, overscan = 8 }: WindowInput): VirtualWindow {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (!(rowHeight > 0) || !(viewportHeight > 0)) {
    // Not measured yet: render a first screenful rather than everything.
    const end = Math.min(count, 50);
    return { start: 0, end, padTop: 0, padBottom: (count - end) * Math.max(rowHeight, 0) };
  }
  const top = Math.max(0, scrollTop);
  const first = Math.min(count - 1, Math.floor(top / rowHeight));
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

export interface RevealInput {
  index: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  headerHeight?: number;
  footerHeight?: number;
}

/**
 * New scrollTop that brings row `index` fully into the unoccluded viewport with minimal movement,
 * or `null` when it is already visible.
 */
export function scrollTopToReveal({ index, rowHeight, scrollTop, viewportHeight, headerHeight = 0, footerHeight = 0 }: RevealInput): number | null {
  if (index < 0 || !(rowHeight > 0)) return null;
  const rowTop = headerHeight + index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const visibleTop = scrollTop + headerHeight;
  const visibleBottom = scrollTop + viewportHeight - footerHeight;
  if (rowTop < visibleTop) return Math.max(0, rowTop - headerHeight);
  if (rowBottom > visibleBottom) return Math.max(0, rowBottom - viewportHeight + footerHeight);
  return null;
}

/** Rows that fit in one page of the viewport (for PageUp/PageDown). */
export function pageSize(viewportHeight: number, rowHeight: number, occluded = 0): number {
  if (!(rowHeight > 0)) return 10;
  return Math.max(1, Math.floor((viewportHeight - occluded) / rowHeight) - 1);
}
