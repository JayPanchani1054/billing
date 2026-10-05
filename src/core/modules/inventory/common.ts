/**
 * Small helpers shared by the inventory services: permission checks, text normalisation, paging,
 * LIKE patterns, name uniqueness and tree (parent/child) integrity for groups, categories, godowns.
 *
 * Table names passed to these helpers are compile-time constants (TreeTable / NamedTable), never
 * user input, so interpolating them into SQL is safe; every value is bound as a parameter.
 */
import type { Permission } from '../../../shared/constants.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { forbidden, rule, validation } from '../../lib/errors.ts';

export type TreeTable = 'stock_groups' | 'stock_categories' | 'godowns';
export type NamedTable = TreeTable | 'stock_items' | 'units' | 'price_levels';

export const nowIso = (ctx: CompanyCtx): string => ctx.clock.now().toISOString();

/** Throw FORBIDDEN unless the session holds `perm` (Owner holds all). */
export function requirePermission(ctx: CompanyCtx, perm: Permission, what: string): void {
  if (ctx.session.isOwner || ctx.session.permissions.has(perm)) return;
  throw forbidden(`You do not have permission to ${what}. Ask the administrator for the '${perm}' permission.`);
}

/** Permission needed to save: create without id, alter with id. */
export function requireSavePermission(ctx: CompanyCtx, id: number | undefined, noun: string): void {
  if (id === undefined) requirePermission(ctx, 'masters.create', `create ${noun}`);
  else requirePermission(ctx, 'masters.alter', `alter ${noun}`);
}

/** Trim; empty → null. undefined stays undefined (patch semantics). */
export function cleanText(s: string | null | undefined): string | null | undefined {
  if (s === undefined) return undefined;
  if (s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** Pick the patched value: undefined keeps `current`. */
export function patch<T>(next: T | undefined, current: T): T {
  return next === undefined ? current : next;
}

export const toBool = (n: unknown): boolean => n === 1 || n === 1n || n === true;

export interface Paging {
  limit: number;
  offset: number;
}

export function paging(input: { limit?: number; offset?: number }, defaultLimit = 500, maxLimit = 5000): Paging {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? defaultLimit)), maxLimit);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  return { limit, offset };
}

/** LIKE pattern for a "contains" search; use with `ESCAPE '\'`. null when search is blank. */
export function likePattern(search: string | undefined): string | null {
  const s = (search ?? '').trim();
  if (!s) return null;
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** JSON text for `IN (SELECT value FROM json_each(:ids))` — a safe, bound list parameter. */
export const jsonIds = (ids: readonly number[]): string => JSON.stringify(ids.map((n) => Math.trunc(n)));

/**
 * Throw CONFLICT-style validation when `name` is already used as a name or alias by another row
 * of `table` (case-insensitive). `field` is the input path reported to the form.
 */
export function assertNameFree(
  db: Db,
  table: NamedTable,
  name: string,
  excludeId: number | null,
  field: string,
  noun: string,
  checkAlias = true,
): void {
  const aliasClause = checkAlias ? ' OR alias = :name COLLATE NOCASE' : '';
  const row = db.get<{ id: number; name: string }>(
    `SELECT id, name FROM ${table} WHERE (name = :name COLLATE NOCASE${aliasClause}) AND id IS NOT :exclude LIMIT 1`,
    { name, exclude: excludeId },
  );
  if (row) {
    const how = row.name.toLowerCase() === name.toLowerCase() ? 'name' : 'alias';
    throw validation([
      {
        path: field,
        message: `${noun} '${name}' already exists (it is the ${how} of '${row.name}'). Choose a different ${field === 'alias' ? 'alias' : 'name'}.`,
      },
    ]);
  }
}

export function rowExists(db: Db, table: NamedTable, id: number): boolean {
  return db.value(`SELECT 1 FROM ${table} WHERE id = :id`, { id }) !== undefined;
}

/** Ancestor chain of `id` (nearest first), excluding `id` itself. Stops on a cycle. */
export function ancestors(db: Db, table: TreeTable, id: number): Array<{ id: number; name: string }> {
  const out: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>([id]);
  let cur = db.value<number | null>(`SELECT parent_id FROM ${table} WHERE id = :id`, { id }) ?? null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const row = db.get<{ id: number; name: string; parent_id: number | null }>(`SELECT id, name, parent_id FROM ${table} WHERE id = :id`, {
      id: cur,
    });
    if (!row) break;
    out.push({ id: row.id, name: row.name });
    cur = row.parent_id;
  }
  return out;
}

/** `id` and all its descendants. */
export function subtreeIds(db: Db, table: TreeTable, id: number): number[] {
  return db
    .all<{ id: number }>(
      `WITH RECURSIVE t(id) AS (SELECT :id UNION SELECT c.id FROM ${table} c JOIN t ON c.parent_id = t.id) SELECT id FROM t`,
      { id },
    )
    .map((r) => r.id);
}

/**
 * Validate a new parent for `id` (null for a new row): the parent must exist and must not be the row
 * itself or one of its descendants.
 */
export function assertValidParent(db: Db, table: TreeTable, id: number | null, parentId: number | null, noun: string): void {
  if (parentId === null) return;
  const parentName = db.value<string>(`SELECT name FROM ${table} WHERE id = :id`, { id: parentId });
  if (parentName === undefined) throw validation([{ path: 'parentId', message: `The selected parent ${noun} does not exist. Choose another one.` }]);
  if (id === null) return;
  if (parentId === id) throw validation([{ path: 'parentId', message: `A ${noun} cannot be placed under itself. Choose a different parent.` }]);
  if (subtreeIds(db, table, id).includes(parentId))
    throw validation([
      {
        path: 'parentId',
        message: `'${parentName}' is inside this ${noun}, so it cannot be its parent (that would create a loop). Choose a different parent.`,
      },
    ]);
}

/** Throw BUSINESS_RULE listing what still uses a master. */
export function assertUnused(noun: string, name: string, uses: Array<[count: number, what: string]>): void {
  const parts = uses.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  if (parts.length) throw rule(`Cannot delete ${noun} '${name}': it is used by ${parts.join(', ')}. Move or delete those first.`);
}

export const countOf = (db: Db, sql: string, params: Record<string, number | string | null>): number => Number(db.value(sql, params) ?? 0);
