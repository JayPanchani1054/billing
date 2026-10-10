/**
 * Multiple aliases for ledgers and stock items (dataplus; migration 220).
 *
 * Storage: the master's own `alias` column is the FIRST alias (shown everywhere it always was); the
 * ADDITIONAL aliases live in `ledger_aliases` / `stock_item_aliases` in order (`position`). A complete
 * alias list is therefore `[alias, ...extras]`.
 *
 * Rules (enforced by the ledger / stock item services through these helpers):
 *  - a name or alias is unique within its entity kind across names, first aliases and extra aliases,
 *    case-insensitively (ledgers additionally share one name space with groups — checked by the
 *    ledger rules);
 *  - aliases are trimmed, blanks / duplicates / the master's own name are dropped silently;
 *  - at most MAX_ALIASES aliases per master, each at most ALIAS_MAX_LENGTH characters.
 *
 * Table and column names here are constants chosen by `kind`, never user input.
 */
import type { FieldIssue } from '../../shared/api.ts';
import type { Db } from '../db/db.ts';

export type AliasKind = 'ledger' | 'stock_item';

interface KindSpec {
  table: 'ledger_aliases' | 'stock_item_aliases';
  fk: 'ledger_id' | 'item_id';
  master: 'ledgers' | 'stock_items';
  noun: string;
}

const SPECS: Readonly<Record<AliasKind, KindSpec>> = {
  ledger: { table: 'ledger_aliases', fk: 'ledger_id', master: 'ledgers', noun: 'ledger' },
  stock_item: { table: 'stock_item_aliases', fk: 'item_id', master: 'stock_items', noun: 'stock item' },
};

/** Most aliases one master may have (first alias included). */
export const MAX_ALIASES = 20;
export const ALIAS_MAX_LENGTH = 200;

/** Collapse inner whitespace and trim ('' for null). */
function tidy(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The user's alias list made canonical: trimmed, no blanks, no case-insensitive duplicates, never
 * equal to the master's `name`. Order is kept (the first one becomes the "alias" column).
 */
export function normalizeAliases(name: string, raw: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>([tidy(name).toLowerCase()]);
  const out: string[] = [];
  for (const r of raw) {
    const a = tidy(r);
    if (a === '') continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Count / length problems of a normalised list (paths `aliases` / `aliases[i]`). */
export function aliasListIssues(list: readonly string[]): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (list.length > MAX_ALIASES) out.push({ path: 'aliases', message: `A master can have at most ${MAX_ALIASES} aliases. Remove ${list.length - MAX_ALIASES}.` });
  list.forEach((a, i) => {
    if (a.length > ALIAS_MAX_LENGTH) out.push({ path: `aliases[${i}]`, message: `Alias ${i + 1} is longer than ${ALIAS_MAX_LENGTH} characters. Shorten it.` });
  });
  return out;
}

/** Additional aliases (after the first) of one master, in order. */
export function extraAliases(db: Db, kind: AliasKind, id: number): string[] {
  const s = SPECS[kind];
  return db.all<{ alias: string }>(`SELECT alias FROM ${s.table} WHERE ${s.fk} = :id ORDER BY position, id`, { id }).map((r) => r.alias);
}

/** Additional aliases of every master of the kind (id → aliases), or of the given ids only. */
export function extraAliasMap(db: Db, kind: AliasKind, ids?: readonly number[]): Map<number, string[]> {
  const s = SPECS[kind];
  const out = new Map<number, string[]>();
  if (ids !== undefined && ids.length === 0) return out;
  const rows =
    ids === undefined
      ? db.all<{ mid: number; alias: string }>(`SELECT ${s.fk} AS mid, alias FROM ${s.table} ORDER BY ${s.fk}, position, id`)
      : db.all<{ mid: number; alias: string }>(
          `SELECT ${s.fk} AS mid, alias FROM ${s.table} WHERE ${s.fk} IN (SELECT value FROM json_each(:ids)) ORDER BY ${s.fk}, position, id`,
          { ids: JSON.stringify(ids.map((n) => Math.trunc(n))) },
        );
  for (const r of rows) {
    const list = out.get(r.mid);
    if (list) list.push(r.alias);
    else out.set(r.mid, [r.alias]);
  }
  return out;
}

/** Complete alias list: the first alias (column) followed by the extras. */
export function allAliases(first: string | null, extras: readonly string[] | undefined): string[] {
  return [...(first ? [first] : []), ...(extras ?? [])];
}

export interface AliasOwner {
  id: number;
  name: string;
  /** How the value is used by that master. */
  as: 'name' | 'alias';
}

/** Another master of the kind (not `excludeId`) whose name, first alias or extra alias equals `value`. */
export function aliasOwner(db: Db, kind: AliasKind, value: string, excludeId: number | null): AliasOwner | undefined {
  const s = SPECS[kind];
  const v = tidy(value);
  if (v === '') return undefined;
  const direct = db.get<{ id: number; name: string; alias: string | null }>(
    `SELECT id, name, alias FROM ${s.master} WHERE (name = :v COLLATE NOCASE OR alias = :v COLLATE NOCASE) AND id IS NOT :ex LIMIT 1`,
    { v, ex: excludeId },
  );
  if (direct) return { id: direct.id, name: direct.name, as: direct.name.toLowerCase() === v.toLowerCase() ? 'name' : 'alias' };
  const extra = db.get<{ id: number; name: string }>(
    `SELECT m.id, m.name FROM ${s.table} a JOIN ${s.master} m ON m.id = a.${s.fk} WHERE a.alias = :v COLLATE NOCASE AND m.id IS NOT :ex LIMIT 1`,
    { v, ex: excludeId },
  );
  return extra ? { id: extra.id, name: extra.name, as: 'alias' } : undefined;
}

/**
 * Problems with a master's name and complete alias list against the OTHER masters of its kind,
 * including their extra aliases. The name / first-alias checks against names and first aliases are
 * already done by the services; this adds everything the extra-alias tables bring in.
 * `aliasPath(i)` names the field of alias i (the forms show one aliases field).
 */
export function aliasClashIssues(
  db: Db,
  kind: AliasKind,
  name: string,
  aliases: readonly string[],
  excludeId: number | null,
  aliasPath: (i: number) => string = (i) => (i === 0 ? 'alias' : `aliases[${i}]`),
): FieldIssue[] {
  const s = SPECS[kind];
  const out: FieldIssue[] = [];
  const n = tidy(name);
  if (n !== '') {
    const extra = db.get<{ name: string }>(
      `SELECT m.name FROM ${s.table} a JOIN ${s.master} m ON m.id = a.${s.fk} WHERE a.alias = :v COLLATE NOCASE AND m.id IS NOT :ex LIMIT 1`,
      { v: n, ex: excludeId },
    );
    if (extra) out.push({ path: 'name', message: `'${n}' is already an alias of the ${s.noun} '${extra.name}'. Use a different name.` });
  }
  aliases.forEach((a, i) => {
    const owner = aliasOwner(db, kind, a, excludeId);
    if (!owner) return;
    out.push({
      path: aliasPath(i),
      message:
        owner.as === 'name'
          ? `Alias '${a}' is the name of another ${s.noun}. Choose a different alias.`
          : `Alias '${a}' is already used by the ${s.noun} '${owner.name}'. Choose a different alias.`,
    });
  });
  return out;
}

/** Replace the extra aliases of a master (call inside the save transaction). */
export function writeExtraAliases(db: Db, kind: AliasKind, id: number, extras: readonly string[]): void {
  const s = SPECS[kind];
  db.run(`DELETE FROM ${s.table} WHERE ${s.fk} = :id`, { id });
  extras.forEach((alias, position) => {
    db.run(`INSERT INTO ${s.table} (${s.fk}, alias, position) VALUES (:id, :alias, :position)`, { id, alias, position });
  });
}

/** Id of the master whose name, first alias or extra alias is `value` (case-insensitive). */
export function idByNameOrAlias(db: Db, kind: AliasKind, value: string): number | undefined {
  const s = SPECS[kind];
  const v = tidy(value);
  if (v === '') return undefined;
  return (
    db.value<number>(`SELECT id FROM ${s.master} WHERE name = :v COLLATE NOCASE ORDER BY id LIMIT 1`, { v }) ??
    db.value<number>(`SELECT id FROM ${s.master} WHERE alias = :v COLLATE NOCASE ORDER BY id LIMIT 1`, { v }) ??
    db.value<number>(`SELECT ${s.fk} FROM ${s.table} WHERE alias = :v COLLATE NOCASE ORDER BY id LIMIT 1`, { v })
  );
}

/**
 * SQL fragment: "an extra alias of the master `idExpr` matches the LIKE parameter `:param`". Both
 * arguments are constants written by the caller (a column reference and a placeholder name).
 */
export function extraAliasLike(kind: AliasKind, idExpr: string, param: string): string {
  const s = SPECS[kind];
  return `EXISTS (SELECT 1 FROM ${s.table} xa WHERE xa.${s.fk} = ${idExpr} AND xa.alias LIKE :${param} ESCAPE '\\')`;
}

/** Separator of several aliases in one spreadsheet cell (masters export / import). */
export const ALIAS_CELL_SEPARATOR = ';';

/** 'A; B ;C' → ['A', 'B', 'C'] (blanks dropped). */
export function splitAliasCell(cell: string | null | undefined): string[] {
  return (cell ?? '')
    .split(ALIAS_CELL_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** ['A', 'B'] → 'A; B' (null when empty). */
export function joinAliasCell(list: readonly string[]): string | null {
  return list.length > 0 ? list.join(`${ALIAS_CELL_SEPARATOR} `) : null;
}
