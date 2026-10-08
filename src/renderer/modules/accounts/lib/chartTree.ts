/**
 * Chart of Accounts tree → flat display rows (pre-order with levels) for the DataTable tree grid,
 * plus search that keeps the path to every match. Pure — tested in chartTree.test.ts.
 */
import type { Paise } from '../../../../shared/money.ts';
import type { ChartNode } from '../../../../shared/types/accounts.ts';

export interface ChartRow {
  /** 'g:<id>' for groups, 'l:<id>' for ledgers. */
  key: string;
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  alias: string | null;
  level: number;
  closing: Paise;
  isPredefined: boolean;
  isActive: boolean;
  reservedCode: string | null;
  childCount: number;
  /** Ledgers in this group and its sub-groups (groups only). */
  ledgerCount: number;
  /** Names from the primary group down to the parent (for the search hit's context). */
  parents: string[];
}

export function chartKey(kind: 'group' | 'ledger', id: number): string {
  return `${kind === 'group' ? 'g' : 'l'}:${id}`;
}

export function flattenChart(roots: readonly ChartNode[]): ChartRow[] {
  const out: ChartRow[] = [];
  const walk = (n: ChartNode, level: number, parents: string[]): number => {
    const row: ChartRow = {
      key: chartKey(n.kind, n.id),
      kind: n.kind,
      id: n.id,
      name: n.name,
      alias: n.alias,
      level,
      closing: n.closing,
      isPredefined: n.isPredefined,
      isActive: n.isActive,
      reservedCode: n.reservedCode,
      childCount: n.children.length,
      ledgerCount: 0,
      parents,
    };
    out.push(row);
    if (n.kind === 'ledger') return 1;
    let ledgers = 0;
    const next = [...parents, n.name];
    for (const c of n.children) ledgers += walk(c, level + 1, next);
    row.ledgerCount = ledgers;
    return ledgers;
  };
  for (const r of roots) walk(r, 0, []);
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Rows matching `query` (name or alias, every word must appear) plus their ancestors so the tree
 * stays readable; a matching group keeps its whole sub-tree. Empty query → all rows.
 */
export function filterChart(rows: readonly ChartRow[], query: string): ChartRow[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return rows.slice();
  const hit = (r: ChartRow): boolean => {
    const text = norm(`${r.name} ${r.alias ?? ''}`);
    return words.every((w) => text.includes(w));
  };
  const keep = new Array<boolean>(rows.length).fill(false);
  const stack: number[] = []; // indices of open ancestors
  let keepSubtreeBelow = -1; // level of a matching group whose sub-tree is kept
  rows.forEach((r, i) => {
    while (stack.length > 0 && rows[stack[stack.length - 1]].level >= r.level) stack.pop();
    if (keepSubtreeBelow >= 0 && r.level <= keepSubtreeBelow) keepSubtreeBelow = -1;
    if (keepSubtreeBelow >= 0 || hit(r)) {
      keep[i] = true;
      for (const a of stack) keep[a] = true;
      if (r.kind === 'group' && keepSubtreeBelow < 0 && hit(r)) keepSubtreeBelow = r.level;
    }
    stack.push(i);
  });
  return rows.filter((_, i) => keep[i]);
}

/** Keys of every row that has children (for "Expand all"). */
export function parentKeys(rows: readonly ChartRow[]): Set<string> {
  const out = new Set<string>();
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    if (next && next.level > r.level) out.add(r.key);
  });
  return out;
}

/** Keys of parent rows above `depth` (for "Collapse to primary groups" = depth 1). */
export function parentKeysUpTo(rows: readonly ChartRow[], depth: number): Set<string> {
  const all = parentKeys(rows);
  return new Set(rows.filter((r) => r.level < depth && all.has(r.key)).map((r) => r.key));
}
