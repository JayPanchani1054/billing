/**
 * Field-level diff of two JSON values (edit log "before" vs "after"). Pure.
 *
 *  - Objects: compared key by key (keys of `before` in their order, then keys only in `after`).
 *  - Arrays: compared by index ('lines[2].amount'); extra elements are added/removed.
 *  - Leaves are reported individually: an added or removed object/array is expanded into its leaf
 *    fields, so a created record lists every field it was created with. Empty objects/arrays are leaves.
 *  - When the shape changes (object ↔ array ↔ scalar) one 'changed' entry carries both whole values.
 *  - Keys named updated_at / updatedAt are ignored at any depth (every save touches them).
 *  - Paths: 'a.b[2].c'; keys that are not plain identifiers are quoted: 'a["GST %"]'.
 *  - At most `limit` entries are produced (truncated = true when more existed).
 */
import type { AuditFieldChange, JsonValue } from '../../../shared/types/security.ts';

export const DIFF_IGNORED_KEYS: ReadonlySet<string> = new Set(['updated_at', 'updatedAt']);
export const DEFAULT_DIFF_LIMIT = 5000;
const MAX_DEPTH = 64;

export interface DiffResult {
  changes: AuditFieldChange[];
  truncated: boolean;
}

type Obj = { [key: string]: JsonValue };

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const shapeOf = (v: unknown): 'object' | 'array' | 'scalar' => (Array.isArray(v) ? 'array' : isObject(v) ? 'object' : 'scalar');
const isEmptyContainer = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const keyPath = (base: string, key: string): string => (IDENT.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`);
const indexPath = (base: string, i: number): string => `${base}[${i}]`;
const ROOT = '(value)';

/** Coerce anything (e.g. `undefined`, a Date) into a JSON value. */
function toJson(v: unknown): JsonValue {
  if (v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  try {
    return JSON.parse(JSON.stringify(v)) as JsonValue;
  } catch {
    return String(v);
  }
}

class Collector {
  readonly changes: AuditFieldChange[] = [];
  readonly limit: number;
  truncated = false;
  constructor(limit: number) {
    this.limit = limit;
  }

  push(path: string, kind: AuditFieldChange['kind'], before: JsonValue | null, after: JsonValue | null): boolean {
    if (this.changes.length >= this.limit) {
      this.truncated = true;
      return false;
    }
    this.changes.push({ path: path || ROOT, kind, before, after });
    return true;
  }

  get full(): boolean {
    return this.truncated;
  }
}

/** Emit every leaf of `value` as added (side 'after') or removed (side 'before'). */
function expand(c: Collector, path: string, value: JsonValue, kind: 'added' | 'removed', depth: number): void {
  if (c.full) return;
  if (depth < MAX_DEPTH && !isEmptyContainer(value)) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => expand(c, indexPath(path, i), v, kind, depth + 1));
      return;
    }
    if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) if (!DIFF_IGNORED_KEYS.has(k)) expand(c, keyPath(path, k), v, kind, depth + 1);
      return;
    }
  }
  if (kind === 'added') c.push(path, 'added', null, value);
  else c.push(path, 'removed', value, null);
}

function scalarEqual(a: JsonValue, b: JsonValue): boolean {
  return a === b;
}

function walk(c: Collector, path: string, a: JsonValue, b: JsonValue, depth: number): void {
  if (c.full) return;
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  if (sa !== sb || depth >= MAX_DEPTH) {
    if (sa === 'scalar' && sb === 'scalar') {
      if (!scalarEqual(a, b)) c.push(path, 'changed', a, b);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) c.push(path, 'changed', a, b);
    return;
  }
  if (sa === 'scalar') {
    if (!scalarEqual(a, b)) c.push(path, 'changed', a, b);
    return;
  }
  if (sa === 'array') {
    const x = a as JsonValue[];
    const y = b as JsonValue[];
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n && !c.full; i++) {
      if (i >= x.length) expand(c, indexPath(path, i), y[i], 'added', depth + 1);
      else if (i >= y.length) expand(c, indexPath(path, i), x[i], 'removed', depth + 1);
      else walk(c, indexPath(path, i), x[i], y[i], depth + 1);
    }
    return;
  }
  const x = a as Obj;
  const y = b as Obj;
  for (const k of Object.keys(x)) {
    if (c.full) return;
    if (DIFF_IGNORED_KEYS.has(k)) continue;
    if (!Object.hasOwn(y, k)) expand(c, keyPath(path, k), x[k], 'removed', depth + 1);
    else walk(c, keyPath(path, k), x[k], y[k], depth + 1);
  }
  for (const k of Object.keys(y)) {
    if (c.full) return;
    if (DIFF_IGNORED_KEYS.has(k) || Object.hasOwn(x, k)) continue;
    expand(c, keyPath(path, k), y[k], 'added', depth + 1);
  }
}

/**
 * Diff `before` → `after`. `undefined`/null on one side of a record (a create or a delete) lists every
 * field of the other side as added/removed.
 */
export function diffJson(before: unknown, after: unknown, limit = DEFAULT_DIFF_LIMIT): DiffResult {
  const c = new Collector(Math.max(0, limit));
  const a = toJson(before);
  const b = toJson(after);
  if (a === null && b !== null && shapeOf(b) !== 'scalar') expand(c, '', b, 'added', 0);
  else if (b === null && a !== null && shapeOf(a) !== 'scalar') expand(c, '', a, 'removed', 0);
  else walk(c, '', a, b, 0);
  return { changes: c.changes, truncated: c.truncated };
}
