/**
 * Reminder screen helpers (pure): tone labels, batch selection (every party is included unless the
 * user excludes it with Space), the reminders list export and "due soon" wording for the dashboard
 * widget.
 */
import type { ReminderParty, ReminderTone, RemindersInput, RemindersResult } from '../../../../shared/types/outstanding.ts';
import type { ExportTable } from './model.ts';

export const TONE_TEXT: Readonly<Record<ReminderTone, { label: string; tone: 'info' | 'warning' | 'danger'; description: string }>> = {
  gentle: { label: 'Gentle', tone: 'info', description: 'Overdue up to 30 days — a friendly reminder' },
  second: { label: 'Second', tone: 'warning', description: 'Overdue 31–60 days — a second reminder' },
  firm: { label: 'Firm', tone: 'danger', description: 'Overdue over 60 days — asks for payment within 7 days' },
};

/** "Overdue by at least" as typed (blank / 0 / fractions) → the whole number of days the route accepts (1–36,500). */
export function clampMinDays(days: number | null): number {
  if (days === null || !Number.isFinite(days) || days < 1) return 1;
  return Math.min(36_500, Math.round(days));
}

/**
 * The 'outstanding.reminders' input. Customers not maintained bill-wise are aged FIFO (their
 * balance broken down by the latest invoices) — with the route's default 'on_account' their whole
 * balance would be one never-overdue line and they would never get a reminder.
 */
export function remindersQuery(o: { asOf: string; minDays: number | null; groupId?: number; ledgerId?: number }): RemindersInput {
  const input: RemindersInput = { asOf: o.asOf, minOverdueDays: clampMinDays(o.minDays), side: 'receivable', nonBillWise: 'fifo' };
  if (o.ledgerId !== undefined) input.ledgerId = o.ledgerId;
  else if (o.groupId !== undefined) input.groupId = o.groupId;
  return input;
}

/** Parties chosen for batch printing (all minus the excluded ones), in list order. */
export function selectedParties(parties: readonly ReminderParty[], excluded: ReadonlySet<number>): ReminderParty[] {
  return parties.filter((p) => !excluded.has(p.ledgerId));
}

/** Space on a row: include ↔ exclude. Returns a new set. */
export function toggleExcluded(excluded: ReadonlySet<number>, ledgerId: number): Set<number> {
  const next = new Set(excluded);
  if (next.has(ledgerId)) next.delete(ledgerId);
  else next.add(ledgerId);
  return next;
}

/** Alt+A: when everything is included exclude all, otherwise include all. */
export function toggleAll(parties: readonly ReminderParty[], excluded: ReadonlySet<number>): Set<number> {
  const anyExcluded = parties.some((p) => excluded.has(p.ledgerId));
  return anyExcluded ? new Set() : new Set(parties.map((p) => p.ledgerId));
}

/** The reminders list for Excel / CSV (follow-up calls): amounts are positive receivables. */
export function remindersExport(r: RemindersResult): ExportTable {
  return {
    subtitle: `Customers overdue by ${r.minOverdueDays}+ ${r.minOverdueDays === 1 ? 'day' : 'days'}`,
    landscape: true,
    columns: [
      { header: 'Customer', width: 30 },
      { header: 'Mobile', width: 14 },
      { header: 'E-mail', width: 24 },
      { header: 'Overdue bills', kind: 'number' },
      { header: 'Oldest overdue (days)', kind: 'number' },
      { header: 'Overdue amount', kind: 'amount' },
      { header: 'Unadjusted credits', kind: 'amount' },
      { header: 'Amount due', kind: 'amount' },
      { header: 'Reminder', width: 10 },
    ],
    rows: r.parties.map((p) => [
      p.ledgerName,
      p.mobile,
      p.email,
      p.overdueBills.length,
      p.oldestOverdueDays,
      p.totalOverdue,
      p.unadjustedCredits === 0 ? null : -p.unadjustedCredits,
      p.amountDue,
      TONE_TEXT[p.tone].label,
    ]),
    totals: [
      'Total',
      null,
      null,
      r.parties.reduce((s, p) => s + p.overdueBills.length, 0),
      null,
      r.parties.reduce((s, p) => s + p.totalOverdue, 0),
      -r.parties.reduce((s, p) => s + p.unadjustedCredits, 0) || null,
      r.totals.amountDue,
      null,
    ],
  };
}

/** Due-soon look-ahead from a widget prop → the whole number of days the route accepts (0–366; junk → 7). */
export function clampLookAhead(days: number): number {
  if (!Number.isFinite(days)) return 7;
  return Math.min(366, Math.max(0, Math.round(days)));
}

/** 'Due today' · 'Due tomorrow' · 'In 5 days'. */
export function dueInText(daysToDue: number): string {
  if (daysToDue <= 0) return 'Due today';
  if (daysToDue === 1) return 'Due tomorrow';
  return `In ${daysToDue} days`;
}

const NUMERIC_CELL = /^-?[\d,]+(\.\d+)?$/;

/** Columns of a letter's bills table whose every cell is a number (right-aligned in the preview). */
export function letterNumericColumns(table: { columns: readonly string[]; rows: readonly (readonly string[])[] }): boolean[] {
  return table.columns.map((_, i) => table.rows.length > 0 && table.rows.every((r) => (r[i] ?? '') === '' || NUMERIC_CELL.test(r[i] ?? '')));
}
