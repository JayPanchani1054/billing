/**
 * 2.2 — a line's own description on the Manufacturing Journal / Material In / Out screen (pure; tested in
 * journalDescription.test.ts).
 *
 * The rule is voucher entry's (vouchers/lib/lineDescription.ts — imported, never copied): a line shows its
 * description field, under its item, when an item is chosen on it and it holds text or was opened on this voucher
 * (Ctrl+E, the row tool, or by moving into it); the field is a stop of the Enter chain only while it shows. The
 * opened lines are screen state — row keys, never part of the JournalForm (so never "unsaved changes", never
 * sent) — and are dropped when the next voucher starts. The text itself is `JournalRow.description` →
 * `stockJournal.lines[].description` → inventory_entries.description (journalForm.ts › toBlock), never the stock
 * item master's description.
 *
 * Not on this screen: the voucher type's "Description on every line" (mfg.journal.context does not carry the
 * flag), so a line's description shows only for its text or when opened.
 */
import { descriptionShown } from '../../vouchers/lib/lineDescription.ts';
import type { DescribedLine } from '../../vouchers/lib/lineDescription.ts';
import type { JournalForm, JournalRow } from './journalForm.ts';

/** What the rule reads of a journal line: is an item chosen on it, and its description. */
export function describedLine(row: Pick<JournalRow, 'itemId' | 'description'>): DescribedLine {
  return { filled: row.itemId !== null, text: row.description };
}

/** Is the description field of this line on screen (and a stop of the Enter chain)? */
export function lineDescriptionShown(opened: ReadonlySet<string>, row: Pick<JournalRow, 'key' | 'itemId' | 'description'>): boolean {
  return descriptionShown({ everyLine: false, opened }, row.key, describedLine(row));
}

/** id of a line's description field — where Ctrl+E and the row tool put the cursor. */
export function descriptionId(rowKey: string): string {
  return `mfg-desc-${rowKey}`;
}

/**
 * Ctrl+E on the line `rowKey` (the one the cursor is on, or was last on when the focus is on More ▾ / the
 * shortcut bar): 'focus' — its description is on screen, the cursor goes in; 'open' — it opens, then the cursor
 * goes in; null — no item line with an item there (the header, the narration, an additional cost, an empty
 * line): the screen says where to go.
 */
export function describeAction(form: Pick<JournalForm, 'rows'>, opened: ReadonlySet<string>, rowKey: string | null): 'focus' | 'open' | null {
  const row = rowKey === null ? undefined : form.rows.find((r) => r.key === rowKey);
  if (!row || row.itemId === null) return null;
  return lineDescriptionShown(opened, row) ? 'focus' : 'open';
}

/**
 * Enter / Shift+Enter from a description: the next / previous field of the screen's Enter chain (`fields`, in
 * useEnterAdvance's order) — null when there is none on that side or `current` is not in the chain.
 */
export function enterNeighbour<T>(fields: readonly T[], current: T, back: boolean): T | null {
  const i = fields.indexOf(current);
  if (i < 0) return null;
  return fields[back ? i - 1 : i + 1] ?? null;
}
