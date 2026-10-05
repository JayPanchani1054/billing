/**
 * Index arithmetic for keyboard list navigation (Up/Down/PageUp/PageDown/Home/End) that skips
 * disabled entries. Pure — unit tested in listNav.test.ts.
 */

export type ListNavKey = 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Home' | 'End';

export const LIST_NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];

export function isListNavKey(key: string): key is ListNavKey {
  return LIST_NAV_KEYS.includes(key);
}

export interface ListNavOptions {
  count: number;
  pageSize?: number;
  /** Wrap from last→first / first→last with arrows (not with paging keys). */
  loop?: boolean;
  isDisabled?: (index: number) => boolean;
}

function firstEnabled(from: number, step: 1 | -1, count: number, isDisabled?: (i: number) => boolean): number {
  for (let i = from; i >= 0 && i < count; i += step) if (!isDisabled?.(i)) return i;
  return -1;
}

/** Next active index for a navigation key. -1 when nothing is selectable. */
export function nextListIndex(current: number, key: ListNavKey, opts: ListNavOptions): number {
  const { count, loop = false, isDisabled } = opts;
  const page = Math.max(1, opts.pageSize ?? 10);
  if (count <= 0) return -1;
  const first = firstEnabled(0, 1, count, isDisabled);
  if (first < 0) return -1;
  const last = firstEnabled(count - 1, -1, count, isDisabled);
  switch (key) {
    case 'Home':
      return first;
    case 'End':
      return last;
    case 'ArrowDown': {
      if (current < 0 || current >= count) return first;
      const n = firstEnabled(current + 1, 1, count, isDisabled);
      if (n >= 0) return n;
      return loop ? first : current;
    }
    case 'ArrowUp': {
      if (current < 0 || current >= count) return last;
      const n = firstEnabled(current - 1, -1, count, isDisabled);
      if (n >= 0) return n;
      return loop ? last : current;
    }
    case 'PageDown': {
      const target = Math.min(count - 1, Math.max(current, -1) + page);
      const n = firstEnabled(target, 1, count, isDisabled);
      return n >= 0 ? n : firstEnabled(target, -1, count, isDisabled);
    }
    case 'PageUp': {
      const target = Math.max(0, (current < 0 ? count : current) - page);
      const n = firstEnabled(target, -1, count, isDisabled);
      return n >= 0 ? n : firstEnabled(target, 1, count, isDisabled);
    }
    default:
      return current;
  }
}

/**
 * Type-to-jump: next index (after `current`, wrapping) whose label starts with `prefix`
 * (case-insensitive). When `prefix` is a single repeated letter ('aaa') it cycles matches of 'a'.
 */
export function findByPrefix(labels: (index: number) => string, count: number, current: number, prefix: string): number {
  if (!prefix || count <= 0) return -1;
  const p = prefix.toLowerCase();
  const allSame = p.split('').every((c) => c === p[0]);
  const needle = allSame && p.length > 1 ? p[0] : p;
  // Multi-char prefixes keep matching the current row if it still matches; single chars move on.
  const startOffset = needle.length > 1 ? 0 : 1;
  for (let k = 0; k < count; k++) {
    const i = (Math.max(current, -1) + startOffset + k + count) % count;
    if (labels(i).toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}
