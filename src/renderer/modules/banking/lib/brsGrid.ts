/**
 * Pure logic of the BRS screen: Tally-fast bank-date entry (drafts typed per row, shorthand, validation
 * mirroring the server), "set all to statement date", the projected balance after saving and the
 * books ↔ bank explanation panel. No React here — tested with node:test.
 */
import { formatDate, parseDateInput } from '../../../../shared/dates.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { BrsEntry, BrsResult } from '../../../../shared/types/banking.ts';

/** Raw text typed in the bank-date cell of each entry (absent = untouched). */
export type Drafts = ReadonlyMap<number, string>;

export type BankDateEntry = Pick<BrsEntry, 'ledgerEntryId' | 'date' | 'instrumentDate' | 'bankDate' | 'debit' | 'credit' | 'isPostDated'>;

/** Earliest bank date the server accepts: the voucher date, or the cheque date when it is earlier. */
export function earliestBankDate(e: Pick<BrsEntry, 'date' | 'instrumentDate'>): string {
  return e.instrumentDate !== null && e.instrumentDate < e.date ? e.instrumentDate : e.date;
}

export type ParsedCell = { kind: 'clear' } | { kind: 'date'; iso: string } | { kind: 'invalid'; message: string };

/**
 * Interpret a typed bank date:
 *   ''            clear the bank date
 *   'v'           the voucher date
 *   '.' or '"'    same as the row above (ditto)
 *   '5', '5-4', '05042026', '5 apr', 't' …   Tally shorthand against `reference` (the BRS date)
 */
export function parseBankDateCell(text: string, entry: Pick<BrsEntry, 'date' | 'instrumentDate'>, reference: string, previous: string | null): ParsedCell {
  const s = text.trim().toLowerCase();
  if (s === '') return { kind: 'clear' };
  if (s === 'v') return { kind: 'date', iso: entry.date };
  if (s === '.' || s === '"') {
    return previous ? { kind: 'date', iso: previous } : { kind: 'invalid', message: 'There is no bank date in the row above to repeat.' };
  }
  const iso = parseDateInput(s, reference);
  return iso ? { kind: 'date', iso } : { kind: 'invalid', message: `"${text.trim()}" is not a date. Type it like 5-4-2026 or just 5 for the 5th.` };
}

/** Same rules as the server (banking.setBankDates); null when acceptable. */
export function bankDateProblem(iso: string, entry: Pick<BrsEntry, 'date' | 'instrumentDate'>, today: string): string | null {
  const earliest = earliestBankDate(entry);
  if (iso < earliest) {
    const what = earliest === entry.date ? 'voucher' : 'cheque';
    return `Before the ${what} date ${formatDate(earliest)} — a cheque cannot clear before it is issued.`;
  }
  if (iso > today) return `After today (${formatDate(today)}) — enter the date shown in the bank statement.`;
  return null;
}

export interface RowState {
  /** Bank date the row will have after saving (the saved one when untouched or invalid). */
  effective: string | null;
  /** The typed value differs from the saved bank date and is valid. */
  changed: boolean;
  error: string | null;
}

/** Evaluate every row in display order (ditto refers to the effective date of the row above). */
export function evaluateRows(rows: readonly BankDateEntry[], drafts: Drafts, reference: string, today: string): Map<number, RowState> {
  const out = new Map<number, RowState>();
  let previous: string | null = null;
  for (const r of rows) {
    const text = drafts.get(r.ledgerEntryId);
    let state: RowState;
    if (text === undefined) {
      state = { effective: r.bankDate, changed: false, error: null };
    } else {
      const p = parseBankDateCell(text, r, reference, previous);
      if (p.kind === 'invalid') state = { effective: r.bankDate, changed: false, error: p.message };
      else if (p.kind === 'clear') state = { effective: null, changed: r.bankDate !== null, error: null };
      else if (p.iso === r.bankDate) {
        // The saved date typed again (it may predate the voucher after an auto-match): no change, no error.
        state = { effective: r.bankDate, changed: false, error: null };
      } else {
        const problem = bankDateProblem(p.iso, r, today);
        state = problem ? { effective: r.bankDate, changed: false, error: problem } : { effective: p.iso, changed: p.iso !== r.bankDate, error: null };
      }
    }
    out.set(r.ledgerEntryId, state);
    if (state.effective !== null) previous = state.effective;
  }
  return out;
}

export interface PendingSave {
  entries: Array<{ ledgerEntryId: number; bankDate: string | null }>;
  /** Rows with a typed value that cannot be saved. */
  errors: number;
}

export function pendingSave(rows: readonly BankDateEntry[], states: ReadonlyMap<number, RowState>): PendingSave {
  const entries: PendingSave['entries'] = [];
  let errors = 0;
  for (const r of rows) {
    const s = states.get(r.ledgerEntryId);
    if (!s) continue;
    if (s.error) errors++;
    else if (s.changed) entries.push({ ledgerEntryId: r.ledgerEntryId, bankDate: s.effective });
  }
  return { entries, errors };
}

/**
 * Alt+R: give every row without a bank date (saved or typed) the statement date, when the server would
 * accept it there. Rows dated after it (or post-dated) are skipped and counted.
 */
export function fillBankDates(rows: readonly BankDateEntry[], drafts: Drafts, date: string, today: string): { drafts: Map<number, string>; filled: number; skipped: number } {
  const next = new Map(drafts);
  let filled = 0;
  let skipped = 0;
  for (const r of rows) {
    const typed = drafts.get(r.ledgerEntryId);
    if (r.bankDate !== null || (typed !== undefined && typed.trim() !== '')) continue;
    if (bankDateProblem(date, r, today) !== null) {
      skipped++;
      continue;
    }
    next.set(r.ledgerEntryId, formatDate(date));
    filled++;
  }
  return { drafts: next, filled, skipped };
}

const reflected = (bankDate: string | null, asOf: string): boolean => bankDate !== null && bankDate <= asOf;

/** Balance as per bank after saving the drafts: each entry moves in or out of "reflected as of asOf". */
export function projectedBankBalance(brs: Pick<BrsResult, 'balanceAsPerBank' | 'asOf'>, rows: readonly BankDateEntry[], states: ReadonlyMap<number, RowState>): Paise {
  let total = brs.balanceAsPerBank;
  for (const r of rows) {
    const s = states.get(r.ledgerEntryId);
    if (!s || !s.changed) continue;
    const signed = r.debit - r.credit;
    const before = reflected(r.bankDate, brs.asOf);
    const after = reflected(s.effective, brs.asOf);
    if (before !== after) total += after ? signed : -signed;
  }
  return total;
}

// ───────────────────────────── Balances panel ─────────────────────────────

export interface BalanceLine {
  key: string;
  label: string;
  /** Signed for 'drcr' lines, unsigned for 'amount' lines. */
  amount: Paise;
  kind: 'drcr' | 'amount';
  /** Bold result lines. */
  strong?: boolean;
  /** '+', '−' operator shown before the label. */
  op?: '+' | '−';
  note?: string;
}

export type BrsStatus = 'no_statement' | 'agrees' | 'explained' | 'unexplained';

export interface BrsExplanation {
  lines: BalanceLine[];
  status: BrsStatus;
  /** Plain-English summary for the banner. */
  message: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function explainBrs(r: BrsResult, fmt: (p: Paise) => string): BrsExplanation {
  const lines: BalanceLine[] = [
    { key: 'books', label: 'Balance as per company books', amount: r.balanceAsPerBooks, kind: 'drcr', strong: true },
    {
      key: 'issued',
      label: 'Cheques issued / payments not yet presented',
      amount: r.chequesIssuedNotPresented,
      kind: 'amount',
      op: '+',
      note: plural(r.counts.issuedNotPresented, 'entry', 'entries'),
    },
    {
      key: 'deposited',
      label: 'Cheques deposited / receipts not yet cleared',
      amount: r.chequesDepositedNotCleared,
      kind: 'amount',
      op: '−',
      note: plural(r.counts.depositedNotCleared, 'entry', 'entries'),
    },
  ];
  if (r.clearedBeforeVoucherDate !== 0) {
    lines.push({
      key: 'early',
      label: 'Cleared by the bank before the voucher date',
      amount: Math.abs(r.clearedBeforeVoucherDate),
      kind: 'amount',
      op: r.clearedBeforeVoucherDate > 0 ? '+' : '−',
      note: plural(r.counts.clearedBeforeVoucher, 'entry', 'entries'),
    });
  }
  lines.push({ key: 'bank', label: 'Balance as per bank (from the books)', amount: r.balanceAsPerBank, kind: 'drcr', strong: true });

  if (r.statementBalance === null || r.difference === null) {
    return {
      lines,
      status: 'no_statement',
      message: 'Compare "Balance as per bank" with the closing balance in your bank statement. Import the statement to have the difference checked for you.',
    };
  }
  const earlier = r.statementDate !== null && r.statementDate < r.asOf && r.balanceAsPerBankOnStatementDate !== null;
  if (earlier) {
    lines.push({
      key: 'bankOnStatement',
      label: `Balance as per bank on ${formatDate(r.statementDate)} (from the books)`,
      amount: r.balanceAsPerBankOnStatementDate as Paise,
      kind: 'drcr',
      note: 'The statement ends earlier, so it is compared on its own last date',
    });
  }
  lines.push({ key: 'statement', label: `Balance in the imported statement on ${formatDate(r.statementDate)}`, amount: r.statementBalance, kind: 'drcr' });
  lines.push({
    key: 'difference',
    label: earlier ? `Difference on ${formatDate(r.statementDate)} (statement − bank as per books)` : 'Difference (statement − bank as per books)',
    amount: r.difference,
    kind: 'drcr',
    strong: true,
  });
  const nib = r.amountsNotInBooks;
  if (nib.count > 0) {
    lines.push({
      key: 'notInBooks',
      label: 'Statement lines not entered in the books (charges, interest, direct credits …)',
      amount: nib.deposits - nib.withdrawals,
      kind: 'drcr',
      note: plural(nib.count, 'line'),
    });
    lines.push({ key: 'unexplained', label: 'Difference still unexplained', amount: r.unexplainedDifference ?? 0, kind: 'drcr', strong: true });
  }
  if (r.difference === 0) return { lines, status: 'agrees', message: `The books agree with the bank statement as on ${formatDate(r.statementDate)}.` };
  if (r.unexplainedDifference === 0) {
    return {
      lines,
      status: 'explained',
      message: `The difference of ${fmt(Math.abs(r.difference))} is fully explained by ${plural(nib.count, 'statement line')} not yet entered in the books. Create vouchers for them in Match statement (Alt+M).`,
    };
  }
  return {
    lines,
    status: 'unexplained',
    message: `${fmt(Math.abs(r.unexplainedDifference ?? r.difference))} is not explained. Check bank dates against the statement, look for amounts entered wrongly, or import the missing part of the statement.`,
  };
}

/** Category label shown in the grid. */
export const CATEGORY_LABEL: Record<BrsEntry['category'], string> = {
  issued_not_presented: 'Not presented',
  deposited_not_cleared: 'Not cleared',
  cleared_before_voucher: 'Cleared early',
  reconciled: 'Reconciled',
};
