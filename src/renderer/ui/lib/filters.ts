/**
 * The "Filters ▾" button's count (2.1, SPEC-21 §1.2, ui/FiltersPopover.tsx): a screen with more than one
 * filter keeps one quiet button whose label says how many filters are active. Pure (filters.test.ts).
 */

/** One filter's state: its current value and the value meaning "no filter" (default: empty). */
export interface FilterState {
  value: unknown;
  /** The "all"/"off" value; omit when empty (null, '', [], false) means "no filter". */
  defaultValue?: unknown;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return false;
}

/** Whether one filter narrows the data (its value is neither empty nor its default). */
export function isActive(f: FilterState): boolean {
  if ('defaultValue' in f && f.defaultValue !== undefined) return !same(f.value, f.defaultValue) && !(isEmpty(f.value) && isEmpty(f.defaultValue));
  return !isEmpty(f.value);
}

/** How many filters are active. */
export function activeCount(filters: readonly FilterState[]): number {
  let n = 0;
  for (const f of filters) if (isActive(f)) n++;
  return n;
}

/** Visible label and accessible name: "Filters" / "Filters (2)" and "Filters" / "Filters, 2 active". */
export function filtersLabel(count: number): { text: string; name: string } {
  if (count <= 0) return { text: 'Filters', name: 'Filters' };
  return { text: `Filters (${count})`, name: `Filters, ${count} active` };
}
