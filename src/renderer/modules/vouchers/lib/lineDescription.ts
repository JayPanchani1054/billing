/**
 * 2.2 — a line's own description, typed per voucher (pure; tested in lineDescription.test.ts).
 *
 * Every item line and every ledger line ("Particulars") may carry free text of its own, saved with THIS
 * voucher only: an item line's in ItemRow.description (→ ItemLineInput.description →
 * inventory_entries.description — never the stock item master's description), a ledger line's in
 * LedgerRow.narration (→ LedgerLineInput.narration → ledger_entries.narration). The voucher view shows it
 * and the printed document puts it under the line's name.
 *
 * On the entry screen the field sits under the item / ledger name and stays out of sight until it matters.
 * One rule (`descriptionShown`) decides both what the grid draws and where Enter stops: a filled line shows
 * its description when the voucher type wants one on every line (the type's `narrationPerEntry` flag,
 * "Description on every line"), when it holds text, or when the user opened it on this voucher (Ctrl+E,
 * the row tool, or by moving into it). The opened lines are screen state — never part of the form (not
 * "touched", never sent) — kept per row key and dropped when the next voucher starts, whose row keys
 * begin again at i1 / l2.
 */
import type { VoucherMode } from '../../../../shared/types/vouchers.ts';

/** Grid column of the description: its cell is `cellId(section, rowKey, DESC_COLUMN)` (letters only, see parseCellId). */
export const DESC_COLUMN = 'desc';

/** Longest description a line takes (the route's limit, `optText(1000)`). */
export const DESC_MAX_LENGTH = 1000;

export interface DescriptionRule {
  /** The voucher type's "Description on every line" (entry context `voucherType.narrationPerEntry`). */
  everyLine: boolean;
  /** Row keys whose description the user opened on this voucher. */
  opened: ReadonlySet<string>;
}

/** What the rule reads of a line. */
export interface DescribedLine {
  /** An item / ledger is chosen on the line. */
  filled: boolean;
  /** The line's description (item line) or narration (ledger line). */
  text: string;
}

/** No line opened (a new voucher). */
export const NO_OPENED: ReadonlySet<string> = new Set<string>();

/** Is the description field of this line on screen (and a stop of the Enter chain)? */
export function descriptionShown(rule: DescriptionRule, rowKey: string, line: DescribedLine): boolean {
  return line.filled && (rule.everyLine || line.text.trim() !== '' || rule.opened.has(rowKey));
}

/**
 * The Enter chain of a grid with the description in it. It follows the item / ledger name: an item line
 * goes item → description → godown / batch / quantity …, an invoice's ledger line ledger → description →
 * amount. In a ledger-mode voucher (payment, receipt, contra, journal …) the amount comes first and the
 * description last — where the 2.1 "Line narration" column was.
 */
export function navColumnsWithDescription(columns: readonly string[], section: 'items' | 'ledgers', mode: VoucherMode): string[] {
  const rest = columns.filter((c) => c !== DESC_COLUMN);
  if (section === 'ledgers' && mode === 'ledger') return [...rest, DESC_COLUMN];
  return [...rest.slice(0, 1), DESC_COLUMN, ...rest.slice(1)];
}

/**
 * The grid's skip rule with the description: its cell is no stop while it is hidden; every other cell
 * keeps the grid's own rule (`otherwise`, e.g. the batch of an item kept without batches).
 */
export function skipHiddenDescription(
  rule: DescriptionRule,
  lineOf: (rowKey: string) => DescribedLine,
  otherwise?: (rowKey: string, column: string) => boolean,
): (rowKey: string, column: string) => boolean {
  return (rowKey, column) => (column === DESC_COLUMN ? !descriptionShown(rule, rowKey, lineOf(rowKey)) : (otherwise?.(rowKey, column) ?? false));
}

/** The opened lines with `rowKey` added — the same set when it is already there, so nothing re-renders. */
export function openedWith(opened: ReadonlySet<string>, rowKey: string): ReadonlySet<string> {
  if (opened.has(rowKey)) return opened;
  const next = new Set(opened);
  next.add(rowKey);
  return next;
}

/**
 * The opened lines after the cursor leaves a description: left empty, it closes again (it still shows when
 * the rule has another reason, e.g. "Description on every line"); with text it stays — the text keeps it
 * on screen anyway. The same set when nothing changes.
 */
export function openedAfterLeaving(opened: ReadonlySet<string>, rowKey: string, text: string): ReadonlySet<string> {
  if (text.trim() !== '' || !opened.has(rowKey)) return opened;
  const next = new Set(opened);
  next.delete(rowKey);
  return next;
}

/** What afterPointerRelease listens on: the document on screen (an EventTarget in tests). */
export interface PressEvents {
  addEventListener(type: string, listener: () => void, options: { capture: boolean; once: boolean }): void;
  removeEventListener(type: string, listener: () => void, options: { capture: boolean }): void;
}

/**
 * The events that end a press: the pointer goes up or is cancelled — or the click of a tap, whose pointer went
 * up before the cursor moved (a tap moves it at its compatibility mousedown, just before that click).
 */
export const PRESS_END_EVENTS = ['pointerup', 'pointercancel', 'click'] as const;

/**
 * Runs `then` once the press under way is over, after the click it makes. An empty description left for a
 * button below it (Remove line 2, Charges & discounts) closes this way: closed at mousedown, it would pull the
 * button up from under the pointer and the click would land elsewhere. One-shot listeners in the capture phase
 * (nothing on the page can stop them) for the first of PRESS_END_EVENTS, then `later` — a timeout of 0, as the
 * click follows the release in the same task.
 */
export function afterPointerRelease(target: PressEvents, then: () => void, later: (run: () => void) => void = (run) => void setTimeout(run, 0)): void {
  const ended = () => {
    for (const type of PRESS_END_EVENTS) target.removeEventListener(type, ended, { capture: true });
    later(then);
  };
  for (const type of PRESS_END_EVENTS) target.addEventListener(type, ended, { capture: true, once: true });
}
