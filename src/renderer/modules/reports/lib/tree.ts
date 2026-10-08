/**
 * Pure helpers for tree reports (rows in pre-order with `key`, `level`, `parentKey`, `hasChildren`)
 * and for remembering which rows a user expanded, per screen.
 */

export interface TreeRowLike {
  key: string;
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
}

/** Keys of every row that has children. */
export function parentKeys(rows: readonly TreeRowLike[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.hasChildren) out.add(r.key);
  return out;
}

/** Parent rows whose level is below `maxLevel` (0 → none expanded, 1 → top level open, …). */
export function keysUpToLevel(rows: readonly TreeRowLike[], maxLevel: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.hasChildren && r.level < maxLevel) out.add(r.key);
  return out;
}

/** Rows whose every ancestor is expanded (what the user sees), in order. */
export function visibleRows<T extends TreeRowLike>(rows: readonly T[], expanded: ReadonlySet<string>): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(r.key, r);
  const shown = new Map<string, boolean>();
  const out: T[] = [];
  for (const r of rows) {
    let visible = true;
    if (r.parentKey !== null) {
      const parentShown = shown.get(r.parentKey) ?? (byKey.has(r.parentKey) ? false : true);
      visible = parentShown && expanded.has(r.parentKey);
    }
    shown.set(r.key, visible);
    if (visible) out.push(r);
  }
  return out;
}

/** Text indented for exports/print (non-breaking spaces survive HTML whitespace collapsing). */
export function indentLabel(name: string, level: number): string {
  return `${'   '.repeat(Math.max(0, level))}${name}`;
}

// ───────────────────────────── Remembered expansion ─────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memory = new Map<string, string[]>();
const PREFIX = 'bahi.reports.expanded.';
/** Never remember more than this many keys per screen (a huge tree should not bloat storage). */
const MAX_KEYS = 2_000;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Expanded keys remembered for a screen (this session first, then the browser storage), or null. */
export function loadExpansion(screenKey: string, storage: StorageLike | null = defaultStorage()): Set<string> | null {
  const hit = memory.get(screenKey);
  if (hit) return new Set(hit);
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFIX + screenKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const keys = parsed.filter((k): k is string => typeof k === 'string');
    memory.set(screenKey, keys);
    return new Set(keys);
  } catch {
    return null;
  }
}

/** Remember the expanded keys of a screen (best effort; storage errors are ignored). */
export function saveExpansion(screenKey: string, keys: ReadonlySet<string>, storage: StorageLike | null = defaultStorage()): void {
  const list = [...keys].slice(0, MAX_KEYS);
  memory.set(screenKey, list);
  if (!storage) return;
  try {
    storage.setItem(PREFIX + screenKey, JSON.stringify(list));
  } catch {
    // quota / private mode: the in-memory copy still works for this session
  }
}

/** Test helper: forget the in-memory copies. */
export function clearExpansionMemory(): void {
  memory.clear();
}
