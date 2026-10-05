/**
 * Page-number model for <Pagination>: [1, 'ellipsis', 4, 5, 6, 'ellipsis', 20].
 * Pure — unit tested in pagination.test.ts.
 */

export type PageItem = number | 'ellipsis-start' | 'ellipsis-end';

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/**
 * Always shows first and last page, `siblings` pages either side of the current page, and an
 * ellipsis only when it hides at least two pages (otherwise the page itself is shown).
 */
export function paginationRange(page: number, pageCount: number, siblings = 1): PageItem[] {
  const count = Math.max(1, Math.floor(pageCount));
  const current = Math.min(Math.max(1, Math.floor(page)), count);
  const totalSlots = siblings * 2 + 5; // first, last, current, 2 ellipses
  if (count <= totalSlots) return Array.from({ length: count }, (_, i) => i + 1);

  const left = Math.max(current - siblings, 1);
  const right = Math.min(current + siblings, count);
  const showLeftEllipsis = left > 3;
  const showRightEllipsis = right < count - 2;

  const items: PageItem[] = [];
  if (!showLeftEllipsis && showRightEllipsis) {
    const leftCount = 3 + 2 * siblings;
    for (let i = 1; i <= leftCount; i++) items.push(i);
    items.push('ellipsis-end', count);
    return items;
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    const rightCount = 3 + 2 * siblings;
    items.push(1, 'ellipsis-start');
    for (let i = count - rightCount + 1; i <= count; i++) items.push(i);
    return items;
  }
  items.push(1, 'ellipsis-start');
  for (let i = left; i <= right; i++) items.push(i);
  items.push('ellipsis-end', count);
  return items;
}

/** 'Showing 51–100 of 1,234' numbers (1-based, inclusive). */
export function pageBounds(page: number, pageSize: number, total: number): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const from = (Math.max(1, page) - 1) * pageSize + 1;
  return { from: Math.min(from, total), to: Math.min(total, from + pageSize - 1) };
}
