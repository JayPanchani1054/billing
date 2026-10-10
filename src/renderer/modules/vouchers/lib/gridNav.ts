/**
 * Keyboard model of the entry grids (pure; tested in gridNav.test.ts).
 *
 * Keyboard-first behaviour: Enter moves cell by cell and row by row; Enter on the first cell of an EMPTY row
 * leaves the grid (items → additional ledgers → narration); Shift+Enter goes back; from the first
 * cell of the first row it leaves the grid backwards (to the header).
 */
import { cellId, headerId } from './errorPaths.ts';

export type NavTarget = { kind: 'cell'; rowKey: string; column: string } | { kind: 'exit-forward' } | { kind: 'exit-back' };

export interface GridModel {
  /** Editable columns in visual order (the first one is the item / ledger cell). */
  columns: readonly string[];
  rowKeys: readonly string[];
  /** Row has nothing chosen in its first cell. */
  isBlank: (rowKey: string) => boolean;
  /** Cell not applicable on this row (no batches for this item, …). */
  skip?: (rowKey: string, column: string) => boolean;
}

function cellsOf(m: GridModel, rowKey: string): string[] {
  return m.columns.filter((c, i) => i === 0 || !m.skip?.(rowKey, c));
}

export function nextCell(m: GridModel, at: { rowKey: string; column: string }, dir: 'forward' | 'back'): NavTarget {
  const r = m.rowKeys.indexOf(at.rowKey);
  if (r < 0) return dir === 'forward' ? { kind: 'exit-forward' } : { kind: 'exit-back' };
  const cells = cellsOf(m, at.rowKey);
  let c = cells.indexOf(at.column);
  if (c < 0) c = 0;
  if (dir === 'forward') {
    if (c === 0 && m.isBlank(at.rowKey)) return { kind: 'exit-forward' };
    if (c + 1 < cells.length) return { kind: 'cell', rowKey: at.rowKey, column: cells[c + 1] };
    const nextKey = m.rowKeys[r + 1];
    if (nextKey === undefined) return { kind: 'exit-forward' };
    return { kind: 'cell', rowKey: nextKey, column: m.columns[0] };
  }
  if (c > 0) return { kind: 'cell', rowKey: at.rowKey, column: cells[c - 1] };
  const prevKey = m.rowKeys[r - 1];
  if (prevKey === undefined) return { kind: 'exit-back' };
  const prevCells = cellsOf(m, prevKey);
  return { kind: 'cell', rowKey: prevKey, column: prevCells[prevCells.length - 1] };
}

/** Row to focus after deleting `deletedKey`: the next row, else the previous one, else null. */
export function rowAfterDelete(rowKeys: readonly string[], deletedKey: string): string | null {
  const i = rowKeys.indexOf(deletedKey);
  if (i < 0) return null;
  return rowKeys[i + 1] ?? rowKeys[i - 1] ?? null;
}

/** ↑ / ↓ keep the column: the same column in the previous / next row (skipped cells fall back to the first). */
export function verticalCell(m: GridModel, at: { rowKey: string; column: string }, dir: 'up' | 'down'): NavTarget | null {
  const r = m.rowKeys.indexOf(at.rowKey);
  const k = m.rowKeys[dir === 'up' ? r - 1 : r + 1];
  if (r < 0 || k === undefined) return null;
  const column = cellsOf(m, k).includes(at.column) ? at.column : m.columns[0];
  return { kind: 'cell', rowKey: k, column };
}

/** Body sections of the entry screen in Enter order (the header comes before, Accept after). */
export type EntrySection = 'items' | 'items:src' | 'items:dst' | 'ledgers' | 'narration';

/**
 * Item invoice: items → additional ledgers → narration. Stock journal: source → destination →
 * narration. Other stock documents: items → narration. Accounting invoice / ledger vouchers:
 * ledgers → narration.
 */
export function entrySections(mode: 'item_invoice' | 'accounting_invoice' | 'ledger' | 'inventory', baseType: string): EntrySection[] {
  if (baseType === 'stock_journal') return ['items:src', 'items:dst', 'narration'];
  if (mode === 'item_invoice') return ['items', 'ledgers', 'narration'];
  if (mode === 'inventory') return ['items', 'narration'];
  return ['ledgers', 'narration'];
}

/** Section after / before `current` ('header' before the first; 'accept' after the narration). */
export function neighbourSection(sections: readonly EntrySection[], current: EntrySection, dir: 'forward' | 'back'): EntrySection | 'header' | 'accept' {
  const i = sections.indexOf(current);
  if (i < 0) return dir === 'forward' ? 'accept' : 'header';
  const j = dir === 'forward' ? i + 1 : i - 1;
  if (j < 0) return 'header';
  return sections[j] ?? 'accept';
}

/**
 * Where the cursor starts on the entry screen: a manually numbered new voucher asks for its
 * number first; a purchase starts on the supplier's invoice no. (then its date and the party); then
 * the party of an invoice / order / note; then the cash or bank Account of a
 * single-entry payment / receipt / contra; otherwise the first line of the first grid. The date is
 * one key away (F2).
 */
export function initialFocusId(o: {
  manualNumber: boolean;
  /** Purchase-side invoice: the supplier's invoice number comes first. */
  referenceFirst: boolean;
  partyShown: boolean;
  singleAccount: boolean;
  firstSection: EntrySection;
  firstRowKey: string | null;
}): string {
  if (o.manualNumber) return headerId('number');
  if (o.referenceFirst) return headerId('referenceNo');
  if (o.partyShown) return headerId('party');
  if (o.singleAccount) return headerId('account');
  if (o.firstRowKey !== null && o.firstSection !== 'narration') {
    return o.firstSection === 'ledgers' ? cellId('ledgers', o.firstRowKey, 'ledger') : cellId('items', o.firstRowKey, 'item');
  }
  return headerId('date');
}
