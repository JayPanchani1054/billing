/**
 * Tree order for stock groups, stock categories and godowns (pure, tested in tree.test.ts).
 * Rows come from the API sorted by name with a parentId; the list screens show them as a tree:
 * each parent followed by its children (by name), with a depth level. Rows whose parent is missing
 * (filtered out or deleted) and rows caught in a cycle are shown at the top level — never lost.
 */

export interface TreeRowInput {
  id: number;
  parentId: number | null;
  name: string;
}

export type Leveled<T> = T & { level: number; hasChildren: boolean };

export function orderTree<T extends TreeRowInput>(rows: readonly T[]): Array<Leveled<T>> {
  const byId = new Map<number, T>();
  for (const r of rows) byId.set(r.id, r);
  const children = new Map<number | null, T[]>();
  const rootOf = (r: T): number | null => (r.parentId !== null && byId.has(r.parentId) && r.parentId !== r.id ? r.parentId : null);
  for (const r of rows) {
    const p = rootOf(r);
    const list = children.get(p) ?? [];
    list.push(r);
    children.set(p, list);
  }
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id;
  for (const list of children.values()) list.sort(byName);
  const out: Array<Leveled<T>> = [];
  const seen = new Set<number>();
  const visit = (r: T, level: number): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const kids = children.get(r.id) ?? [];
    out.push({ ...r, level, hasChildren: kids.length > 0 });
    for (const k of kids) visit(k, level + 1);
  };
  for (const r of children.get(null) ?? []) visit(r, 0);
  // Anything left belongs to a cycle (a → b → a): show it at the top level.
  for (const r of [...rows].sort(byName)) if (!seen.has(r.id)) visit(r, 0);
  return out;
}

/** Ids of `id` and everything under it (for "cannot move a group under itself"). */
export function descendantIds(rows: readonly TreeRowInput[], id: number): Set<number> {
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId !== null && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** "Primary › Electronics › Phones" path text of a row (ancestors first). */
export function pathText(rows: readonly TreeRowInput[], id: number | null, rootLabel = 'Primary'): string {
  if (id === null) return rootLabel;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names: string[] = [];
  const seen = new Set<number>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
  }
  return names.length ? names.join(' › ') : rootLabel;
}
