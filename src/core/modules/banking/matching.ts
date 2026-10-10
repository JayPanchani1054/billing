/**
 * Reconciling statement lines with book entries: auto-match (matcher.ts scoring), suggestions for one line,
 * manual match / unmatch and ignoring lines. Linking a line sets the entry's bank date to the statement date.
 */
import { addDays } from '../../../shared/dates.ts';
import type {
  AutoMatchInput,
  AutoMatchResult,
  MatchCandidate,
  StatementLineView,
} from '../../../shared/types/banking.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { rule } from '../../lib/errors.ts';
import {
  ENTRY_SELECT,
  IN_BOOKS,
  asInstrument,
  assertEntryInBooks,
  effectiveStatus,
  fmtDate,
  healOrphanLines,
  lineLabel,
  lineView,
  lineViews,
  LINE_SELECT,
  linkLine,
  loadEntry,
  loadLine,
  money,
  particularsResolver,
  requireBankLedger,
  unlinkLine,
  assertBankDateChangeAllowed,
  canChangeLockedBankDates,
  lockedBankDate,
  voucherLabel,
  voucherRef,
  type EntryRow,
  type LineRow,
} from './common.ts';
import {
  CHEQUE_WINDOW_DAYS,
  DEFAULT_MATCH_OPTIONS,
  assignMatches,
  scoreAll,
  scorePair,
  type MatchEntry,
  type MatchLine,
  type MatchOptions,
  type ScoredPair,
} from './matcher.ts';

/** Entries of the ledger that count in the books and are not linked to any statement line. */
function openEntries(db: Db, ledgerId: number, today: string, minDate: string, amount?: number): EntryRow[] {
  return db.all<EntryRow>(
    `${ENTRY_SELECT}
      WHERE le.ledger_id = :l AND ${IN_BOOKS} AND le.date >= :min ${amount !== undefined ? 'AND le.amount = :amt' : ''}
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s.matched_entry_id = le.id)
      ORDER BY le.date, le.id`,
    amount !== undefined ? { l: ledgerId, today, min: minDate, amt: amount } : { l: ledgerId, today, min: minDate },
  );
}

function toMatchEntries(db: Db, rows: readonly EntryRow[]): { entries: MatchEntry[]; particulars: Map<number, string> } {
  const resolve = particularsResolver(
    db,
    rows.map((r) => r.voucher_id),
  );
  const particulars = new Map<number, string>();
  const entries = rows.map((r) => {
    const p = resolve(r);
    particulars.set(r.entry_id, p);
    return {
      id: r.entry_id,
      date: r.date,
      amount: r.amount,
      instrumentType: r.instrument_type,
      instrumentNo: r.instrument_no,
      instrumentDate: r.instrument_date,
      bankDate: r.bank_date,
      particulars: p,
    };
  });
  return { entries, particulars };
}

const toMatchLine = (r: Pick<LineRow, 'id' | 'txn_date' | 'amount' | 'description' | 'reference'>): MatchLine => ({
  id: r.id,
  txnDate: r.txn_date,
  amount: r.amount,
  description: r.description ?? '',
  reference: r.reference ?? '',
});

function toCandidate(row: EntryRow, particulars: string, p: ScoredPair): MatchCandidate {
  return {
    ...voucherRef(row, particulars),
    amount: row.amount,
    instrumentType: asInstrument(row.instrument_type),
    instrumentNo: row.instrument_no,
    bankDate: row.bank_date,
    score: p.score,
    dayGap: p.dayGap,
    reasons: p.reasons,
  };
}

function matchOptions(input: { dateWindowDays?: number; threshold?: number }): MatchOptions {
  return {
    ...DEFAULT_MATCH_OPTIONS,
    dateWindowDays: input.dateWindowDays ?? DEFAULT_MATCH_OPTIONS.dateWindowDays,
    threshold: input.threshold ?? DEFAULT_MATCH_OPTIONS.threshold,
  };
}

const UNMATCHED_SQL = `(s.status = 'unmatched' OR (s.status IN ('matched', 'created') AND s.matched_entry_id IS NULL))`;

export function autoMatch(ctx: CompanyCtx, input: AutoMatchInput): AutoMatchResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  const bank = requireBankLedger(db, input.ledgerId, 'Bank reconciliation');
  const dryRun = input.apply === false;
  if (!dryRun) healOrphanLines(db, bank.id);
  let lineRows = db.all<LineRow>(
    `${LINE_SELECT} WHERE s.ledger_id = :l AND ${UNMATCHED_SQL} ${input.batchId !== undefined ? 'AND s.batch_id = :b' : ''}
      ORDER BY s.txn_date, s.batch_id, s.seq, s.id`,
    input.batchId !== undefined ? { l: bank.id, b: input.batchId } : { l: bank.id },
  );
  // Lines dated in the locked period would set bank dates there: left for a user who may lock and
  // unlock the books (they stay unmatched; see common.ts assertBankDateChangeAllowed).
  if (!canChangeLockedBankDates(ctx)) lineRows = lineRows.filter((l) => lockedBankDate(ctx, l.txn_date) === null);
  if (lineRows.length === 0) return { applied: [], suggestions: [], considered: 0, withoutCandidates: 0, dryRun };
  const minDate = addDays(lineRows[0].txn_date, -(CHEQUE_WINDOW_DAYS + 1));
  const entryRows = openEntries(db, bank.id, today, minDate);
  const { entries, particulars } = toMatchEntries(db, entryRows);
  const opts = matchOptions(input);
  const result = assignMatches(lineRows.map(toMatchLine), entries, opts);
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  const entryById = new Map(entryRows.map((e) => [e.entry_id, e]));

  const applied = result.applied.map((p) => ({
    lineId: p.lineId,
    ledgerEntryId: p.entryId,
    voucherId: (entryById.get(p.entryId) as EntryRow).voucher_id,
    score: p.score,
  }));
  if (!dryRun && applied.length > 0) {
    for (const p of result.applied) linkLine(ctx, lineById.get(p.lineId) as LineRow, p.entryId, 'auto', p.score);
    ctx.audit({
      action: 'alter',
      entityType: 'bank_reconciliation',
      entityId: bank.id,
      entityLabel: `Auto-match: ${bank.name} (${applied.length} line${applied.length === 1 ? '' : 's'})`,
      after: {
        matches: result.applied.map((p) => {
          const e = entryById.get(p.entryId) as EntryRow;
          return [p.lineId, p.entryId, voucherLabel(e), lineById.get(p.lineId)?.txn_date ?? null, p.score];
        }),
      },
    });
  }
  const pendingViews = new Map(
    lineViews(
      db,
      result.pending.map((p) => lineById.get(p.lineId) as LineRow),
    ).map((v) => [v.id, v]),
  );
  const suggestions = result.pending.map((p) => ({
    line: pendingViews.get(p.lineId) as StatementLineView,
    reason: p.reason,
    candidates: p.candidates.map((c) => toCandidate(entryById.get(c.entryId) as EntryRow, particulars.get(c.entryId) ?? '', c)),
  }));
  return { applied, suggestions, considered: lineRows.length, withoutCandidates: result.withoutCandidates.length, dryRun };
}

/**
 * Open entries (in the books, not linked to any statement line) that could be this line: same signed amount
 * and eligible under the matcher's date rules, best first. An entry already linked to THIS line is included
 * when `includeOwn` (so the current match can be compared).
 */
export function lineCandidates(
  db: Db,
  today: string,
  line: Pick<LineRow, 'id' | 'ledger_id' | 'txn_date' | 'amount' | 'description' | 'reference' | 'matched_entry_id'>,
  opts: { dateWindowDays: number; includeOwn?: boolean; limit?: number },
): MatchCandidate[] {
  const minDate = addDays(line.txn_date, -(CHEQUE_WINDOW_DAYS + 1));
  const rows = openEntries(db, line.ledger_id, today, minDate, line.amount);
  if (opts.includeOwn && line.matched_entry_id !== null) {
    const own = db.get<EntryRow>(`${ENTRY_SELECT} WHERE le.id = :id`, { id: line.matched_entry_id });
    if (own) rows.push(own);
  }
  if (rows.length === 0) return [];
  const { entries, particulars } = toMatchEntries(db, rows);
  const byId = new Map(rows.map((r) => [r.entry_id, r]));
  const ownEntries = entries.map((e) => (e.id === line.matched_entry_id ? { ...e, bankDate: null } : e));
  return scoreAll([toMatchLine(line)], ownEntries, matchOptions({ dateWindowDays: opts.dateWindowDays }))
    .slice(0, opts.limit ?? 10)
    .map((p) => toCandidate(byId.get(p.entryId) as EntryRow, particulars.get(p.entryId) ?? '', p));
}

/** Candidate entries for one statement line (same amount, best first, ≤ 10). */
export function suggestions(db: Db, today: string, lineId: number, dateWindowDays?: number): MatchCandidate[] {
  return lineCandidates(db, today, loadLine(db, lineId), { dateWindowDays: dateWindowDays ?? 30, includeOwn: true });
}

const EARLY_TOLERANCE_DAYS = DEFAULT_MATCH_OPTIONS.earlyToleranceDays;

export function matchLine(ctx: CompanyCtx, lineId: number, ledgerEntryId: number): StatementLineView {
  const { db } = ctx;
  const today = ctx.clock.today();
  const line = loadLine(db, lineId);
  const status = effectiveStatus(line);
  if (status === 'matched' || status === 'created') {
    if (line.matched_entry_id === ledgerEntryId) return lineView(db, lineId);
    const with_ = [line.e_type_name ?? 'a voucher', line.e_number].filter(Boolean).join(' ');
    throw rule(`Statement line ${lineLabel(line)} is already matched with ${with_}. Unmatch it first.`);
  }
  const entry = loadEntry(db, ledgerEntryId);
  if (entry.ledger_id !== line.ledger_id) {
    throw rule(`${voucherLabel(entry)} does not touch this bank account, so it cannot be matched with statement line ${lineLabel(line)}.`);
  }
  assertEntryInBooks(entry, today);
  if (entry.line_id !== null && entry.line_id !== line.id) {
    const other = loadLine(db, entry.line_id);
    throw rule(`${voucherLabel(entry)} is already matched with statement line ${lineLabel(other)}. Unmatch that line first.`);
  }
  if (entry.amount !== line.amount) {
    throw rule(
      `Amounts differ: the statement shows a ${line.amount >= 0 ? 'deposit' : 'withdrawal'} of ${money(Math.abs(line.amount))}, but ${voucherLabel(entry)} ` +
        `${entry.amount >= 0 ? 'debits' : 'credits'} the bank with ${money(Math.abs(entry.amount))}. ` +
        'Correct the voucher, or create a voucher for the statement line instead.',
    );
  }
  const earliest = entry.instrument_date !== null && entry.instrument_date < entry.date ? entry.instrument_date : entry.date;
  if (line.txn_date < addDays(earliest, -EARLY_TOLERANCE_DAYS)) {
    throw rule(
      `The statement date ${fmtDate(line.txn_date)} is more than ${EARLY_TOLERANCE_DAYS} days before ${voucherLabel(entry)}. ` +
        'A payment cannot clear before it is made — check the voucher date.',
    );
  }
  assertBankDateChangeAllowed(ctx, entry.bank_date, line.txn_date, () => `Matching ${voucherLabel(entry)} with statement line ${lineLabel(line)}`);
  const { entries } = toMatchEntries(db, [entry]);
  const scored = scorePair(toMatchLine(line), { ...entries[0], bankDate: null }, { ...DEFAULT_MATCH_OPTIONS, dateWindowDays: CHEQUE_WINDOW_DAYS });
  linkLine(ctx, line, entry.entry_id, 'manual', scored?.score ?? null);
  ctx.audit({
    action: 'alter',
    entityType: 'bank_statement_line',
    entityId: line.id,
    entityLabel: `Matched ${lineLabel(line)}`,
    before: { status, ledgerEntryId: null, bankDate: entry.bank_date },
    after: { status: 'matched', ledgerEntryId: entry.entry_id, voucher: voucherLabel(entry), bankDate: line.txn_date },
  });
  return lineView(db, lineId);
}

export function unmatchLine(ctx: CompanyCtx, lineId: number): StatementLineView {
  const { db } = ctx;
  const line = loadLine(db, lineId);
  const status = effectiveStatus(line);
  if (status !== 'matched' && status !== 'created') throw rule(`Statement line ${lineLabel(line)} is not matched with any voucher.`);
  assertBankDateChangeAllowed(ctx, line.e_bank_date, null, () => `Unmatching statement line ${lineLabel(line)}`);
  unlinkLine(db, line);
  ctx.audit({
    action: 'alter',
    entityType: 'bank_statement_line',
    entityId: line.id,
    entityLabel: `Unmatched ${lineLabel(line)}`,
    before: { status, ledgerEntryId: line.matched_entry_id, bankDate: line.e_bank_date },
    after: { status: 'unmatched', ledgerEntryId: null, bankDate: null },
  });
  return lineView(db, lineId);
}

export function ignoreLine(ctx: CompanyCtx, lineId: number, ignore: boolean): StatementLineView {
  const { db } = ctx;
  const line = loadLine(db, lineId);
  const status = effectiveStatus(line);
  if (ignore) {
    if (status === 'ignored') return lineView(db, lineId);
    if (status !== 'unmatched') throw rule(`Statement line ${lineLabel(line)} is matched with a voucher. Unmatch it before ignoring it.`);
  } else if (status !== 'ignored') {
    return lineView(db, lineId);
  }
  const next = ignore ? 'ignored' : 'unmatched';
  db.run(
    `UPDATE bank_statement_lines
        SET status = :st, matched_entry_id = NULL, match_score = NULL, match_method = NULL, matched_at = NULL, matched_by = NULL
      WHERE id = :id`,
    { st: next, id: lineId },
  );
  ctx.audit({
    action: 'alter',
    entityType: 'bank_statement_line',
    entityId: line.id,
    entityLabel: `${ignore ? 'Ignored' : 'Restored'} ${lineLabel(line)}`,
    before: { status },
    after: { status: next },
  });
  return lineView(db, lineId);
}
