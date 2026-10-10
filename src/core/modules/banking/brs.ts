/**
 * Bank Reconciliation Statement (conventional semantics), manual bank dates and the per-bank summary.
 *
 * An entry on a bank ledger is "not reflected in the bank" as of a date when it has no bank date, or a bank
 * date after that date. Balance as per bank (computed) = balance as per books + cheques issued but not
 * presented − cheques deposited but not cleared (+ entries dated later that the bank already cleared)
 * = opening balance + Σ entries with bank date ≤ asOf. Worked example in README.md.
 */
import { startOfMonth } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BankSummaryRow,
  BrsCategory,
  BrsEntry,
  BrsInput,
  BrsResult,
  SetBankDatesInput,
  SetBankDatesResult,
  StatementLineStatus,
} from '../../../shared/types/banking.ts';
import { BRS_MAX_ROWS } from '../../../shared/types/banking.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { rule, validation } from '../../lib/errors.ts';
import { closingBalances, ledgerBalance } from '../accounts/books.ts';
import {
  ENTRY_SELECT,
  IN_BOOKS,
  asInstrument,
  assertEntryInBooks,
  bankLedgers,
  bankRef,
  fmtDate,
  loadEntry,
  paramsFor,
  particularsResolver,
  requireBankLedger,
  assertBankDateChangeAllowed,
  unlinkLine,
  voucherLabel,
  voucherRef,
  type EntryRow,
} from './common.ts';

interface Agg {
  issued: number | null;
  issued_n: number | null;
  deposited: number | null;
  deposited_n: number | null;
}

/** Unreconciled as of asOf: dated ≤ asOf, in the books, no bank date or a later one. */
const UNRECONCILED = `le.date <= :asOf AND ${IN_BOOKS} AND (le.bank_date IS NULL OR le.bank_date > :asOf)`;
/** Dated after asOf but already cleared by the bank on/before asOf. */
const CLEARED_EARLY = `le.date > :asOf AND ${IN_BOOKS} AND le.bank_date IS NOT NULL AND le.bank_date <= :asOf`;

function statementBalanceAsOf(db: Db, ledgerId: number, asOf: string): { date: string; balance: Paise } | null {
  const r = db.get<{ txn_date: string; balance: number }>(
    `SELECT txn_date, balance FROM bank_statement_lines
      WHERE ledger_id = :l AND txn_date <= :asOf AND balance IS NOT NULL
      ORDER BY txn_date DESC, batch_id DESC, seq DESC LIMIT 1`,
    { l: ledgerId, asOf },
  );
  return r ? { date: r.txn_date, balance: r.balance } : null;
}

const NOT_LINKED = `(s.status IN ('unmatched', 'ignored') OR s.matched_entry_id IS NULL)`;

/** Opening balance + entries (books filter) the bank has cleared on or before `date`: the bank's balance per the books. */
function bankBalanceOn(db: Db, ledgerId: number, opening: Paise, date: string, today: string): Paise {
  const sum = db.value<number>(
    `SELECT COALESCE(SUM(le.amount), 0) FROM ledger_entries le
      WHERE le.ledger_id = :l AND ${IN_BOOKS} AND le.bank_date IS NOT NULL AND le.bank_date <= :d`,
    { l: ledgerId, d: date, today },
  );
  return opening + (sum ?? 0);
}

export function brs(db: Db, today: string, input: BrsInput): BrsResult {
  const bank = requireBankLedger(db, input.ledgerId, 'Bank reconciliation');
  const asOf = input.asOf;
  const show = input.show ?? 'unreconciled';
  const from = input.from ?? startOfMonth(asOf);
  if (from > asOf) throw validation([{ path: 'from', message: 'The start date must be on or before the reconciliation date' }]);
  const p = { l: bank.id, asOf, today };

  const books = ledgerBalance(db, bank.id, { to: asOf, today }).closing;
  const agg = db.get<Agg>(
    `SELECT SUM(CASE WHEN le.amount < 0 THEN -le.amount ELSE 0 END) AS issued,
            SUM(CASE WHEN le.amount < 0 THEN 1 ELSE 0 END) AS issued_n,
            SUM(CASE WHEN le.amount > 0 THEN le.amount ELSE 0 END) AS deposited,
            SUM(CASE WHEN le.amount > 0 THEN 1 ELSE 0 END) AS deposited_n
       FROM ledger_entries le WHERE le.ledger_id = :l AND ${UNRECONCILED}`,
    p,
  );
  const early = db.get<{ net: number | null; n: number }>(
    `SELECT SUM(le.amount) AS net, COUNT(*) AS n FROM ledger_entries le WHERE le.ledger_id = :l AND ${CLEARED_EARLY}`,
    p,
  );
  const issued = agg?.issued ?? 0;
  const deposited = agg?.deposited ?? 0;
  const clearedEarly = early?.net ?? 0;
  const balanceAsPerBank = books + issued - deposited + clearedEarly;

  // Listing
  const where: string[] = [];
  if (show !== 'reconciled') where.push(`(${UNRECONCILED})`, `(${CLEARED_EARLY})`);
  if (show !== 'unreconciled') where.push(`(le.date >= :from AND le.date <= :asOf AND ${IN_BOOKS} AND le.bank_date IS NOT NULL AND le.bank_date <= :asOf)`);
  const listSql = `${ENTRY_SELECT} WHERE le.ledger_id = :l AND (${where.join(' OR ')}) ORDER BY le.date, le.voucher_id, le.id LIMIT ${BRS_MAX_ROWS + 1}`;
  const rows = db.all<EntryRow>(listSql, paramsFor(listSql, { ...p, from }));
  const truncated = rows.length > BRS_MAX_ROWS;
  if (truncated) rows.length = BRS_MAX_ROWS;
  const particulars = particularsResolver(
    db,
    rows.map((r) => r.voucher_id),
  );
  const counts = { issuedNotPresented: agg?.issued_n ?? 0, depositedNotCleared: agg?.deposited_n ?? 0, clearedBeforeVoucher: early?.n ?? 0, reconciledListed: 0 };
  const entries: BrsEntry[] = rows.map((r) => {
    let category: BrsCategory;
    if (r.date > asOf) category = 'cleared_before_voucher';
    else if (r.bank_date !== null && r.bank_date <= asOf) category = 'reconciled';
    else category = r.amount < 0 ? 'issued_not_presented' : 'deposited_not_cleared';
    if (category === 'reconciled') counts.reconciledListed++;
    return {
      ...voucherRef(r, particulars(r)),
      narration: r.entry_narration ?? r.narration,
      instrumentType: asInstrument(r.instrument_type),
      instrumentNo: r.instrument_no,
      instrumentDate: r.instrument_date,
      drawnOn: r.bank_name,
      debit: r.amount > 0 ? r.amount : 0,
      credit: r.amount < 0 ? -r.amount : 0,
      bankDate: r.bank_date,
      category,
      statementLineId: r.line_id,
      isPostDated: r.is_post_dated === 1,
    };
  });

  // The statement is compared on ITS last date: bank dates entered for later days (statement downloaded on the
  // 25th, BRS as on the 30th) are not in the statement balance and must not show up as a difference.
  const stmt = statementBalanceAsOf(db, bank.id, asOf);
  const bankOnStatementDate = stmt === null ? null : stmt.date >= asOf ? balanceAsPerBank : bankBalanceOn(db, bank.id, bank.openingBalance, stmt.date, today);
  const notInBooks = db.get<{ n: number; dep: number | null; wd: number | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN s.amount > 0 THEN s.amount ELSE 0 END) AS dep,
            SUM(CASE WHEN s.amount < 0 THEN -s.amount ELSE 0 END) AS wd
       FROM bank_statement_lines s
      WHERE s.ledger_id = :l AND s.txn_date >= :booksFrom AND s.txn_date <= :upTo AND ${NOT_LINKED}`,
    // Lines before the books begin are part of the opening balance, not "missing from the books".
    { l: bank.id, upTo: stmt?.date ?? asOf, booksFrom: db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? '' },
  );
  const amountsNotInBooks = { count: notInBooks?.n ?? 0, deposits: notInBooks?.dep ?? 0, withdrawals: notInBooks?.wd ?? 0 };
  const difference = stmt && bankOnStatementDate !== null ? stmt.balance - bankOnStatementDate : null;
  return {
    ledger: bankRef(bank),
    asOf,
    from,
    show,
    balanceAsPerBooks: books,
    chequesIssuedNotPresented: issued,
    chequesDepositedNotCleared: deposited,
    clearedBeforeVoucherDate: clearedEarly,
    balanceAsPerBank,
    statementBalance: stmt?.balance ?? null,
    statementDate: stmt?.date ?? null,
    balanceAsPerBankOnStatementDate: bankOnStatementDate,
    difference,
    amountsNotInBooks,
    unexplainedDifference: difference === null ? null : difference - (amountsNotInBooks.deposits - amountsNotInBooks.withdrawals),
    counts,
    entries,
    truncated,
  };
}

// ───────────────────────────── Bank dates ─────────────────────────────

export function setBankDates(ctx: CompanyCtx, input: SetBankDatesInput): SetBankDatesResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  const seen = new Set<number>();
  input.entries.forEach((e, i) => {
    if (seen.has(e.ledgerEntryId)) {
      throw validation([{ path: `entries[${i}].ledgerEntryId`, message: `Ledger entry ${e.ledgerEntryId} is listed twice` }]);
    }
    seen.add(e.ledgerEntryId);
  });
  const banks = new Map(bankLedgers(db).map((b) => [b.id, b]));
  const rows = input.entries.map((e) => {
    const r = loadEntry(db, e.ledgerEntryId);
    const bank = banks.get(r.ledger_id);
    if (!bank) {
      const name = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: r.ledger_id }) ?? '';
      throw rule(`Bank dates can only be set on Bank Accounts / Bank OD ledgers. ${voucherLabel(r)} line "${name}" is not a bank ledger.`);
    }
    // Rows sent back unchanged (the grid may resend them) are not re-validated: an auto-match within the
    // 2-day early tolerance legitimately holds a bank date just before the voucher date.
    if (r.bank_date === e.bankDate) return { input: e, row: r, bank };
    assertEntryInBooks(r, today);
    assertBankDateChangeAllowed(ctx, r.bank_date, e.bankDate, () => `Changing ${voucherLabel(r)}`);
    if (e.bankDate !== null) {
      const chequeEarlier = r.instrument_date !== null && r.instrument_date < r.date;
      const earliest = chequeEarlier ? (r.instrument_date as string) : r.date;
      if (e.bankDate < earliest) {
        throw rule(
          `Bank date ${fmtDate(e.bankDate)} for ${voucherLabel(r)} is before the ${chequeEarlier ? 'cheque' : 'voucher'} date ${fmtDate(earliest)}. ` +
            'A cheque or transfer cannot clear before it is issued — correct the bank date, or alter the voucher date if that is wrong.',
        );
      }
      if (e.bankDate > today) {
        throw rule(`Bank date ${fmtDate(e.bankDate)} for ${voucherLabel(r)} is after today (${fmtDate(today)}). Enter the date shown in the bank statement.`);
      }
    }
    return { input: e, row: r, bank };
  });

  let updated = 0;
  let unchanged = 0;
  let unmatchedLines = 0;
  const audit = new Map<number, { name: string; before: unknown[]; after: unknown[] }>();
  for (const { input: e, row: r, bank } of rows) {
    if (r.bank_date === e.bankDate) {
      unchanged++;
      continue;
    }
    // A statement line linked to the entry stays linked only while the bank date is the line's date: clearing
    // the date, or moving it to another day, unmatches the line (it is then "not in the books" in the BRS).
    if (r.line_id !== null) {
      const lineDate = db.value<string>('SELECT txn_date FROM bank_statement_lines WHERE id = :id', { id: r.line_id });
      if (e.bankDate === null || e.bankDate !== lineDate) {
        unlinkLine(db, { id: r.line_id, matched_entry_id: r.entry_id });
        unmatchedLines++;
      }
    }
    db.run('UPDATE ledger_entries SET bank_date = :d WHERE id = :id', { d: e.bankDate, id: r.entry_id });
    updated++;
    const a = audit.get(bank.id) ?? { name: bank.name, before: [], after: [] };
    a.before.push([r.entry_id, voucherLabel(r), r.amount, r.bank_date]);
    a.after.push([r.entry_id, voucherLabel(r), r.amount, e.bankDate]);
    audit.set(bank.id, a);
  }
  for (const [ledgerId, a] of audit) {
    ctx.audit({
      action: 'alter',
      entityType: 'bank_reconciliation',
      entityId: ledgerId,
      entityLabel: `Bank dates: ${a.name} (${a.after.length} entr${a.after.length === 1 ? 'y' : 'ies'})`,
      before: { entries: a.before },
      after: { entries: a.after },
    });
  }
  return { updated, unchanged, unmatchedLines };
}

// ───────────────────────────── Summary ─────────────────────────────

const ZERO_COUNTS = (): Record<StatementLineStatus, number> => ({ unmatched: 0, matched: 0, created: 0, ignored: 0 });

export function bankSummary(db: Db, today: string, asOf: string): BankSummaryRow[] {
  const banks = bankLedgers(db);
  if (banks.length === 0) return [];
  const ids = JSON.stringify(banks.map((b) => b.id));
  const p = { ids, asOf, today };
  const balances = closingBalances(db, { asOf, today, ledgerIds: banks.map((b) => b.id) });
  const unrec = new Map(
    db
      .all<Agg & { ledger_id: number }>(
        `SELECT le.ledger_id,
                SUM(CASE WHEN le.amount < 0 THEN -le.amount ELSE 0 END) AS issued,
                SUM(CASE WHEN le.amount < 0 THEN 1 ELSE 0 END) AS issued_n,
                SUM(CASE WHEN le.amount > 0 THEN le.amount ELSE 0 END) AS deposited,
                SUM(CASE WHEN le.amount > 0 THEN 1 ELSE 0 END) AS deposited_n
           FROM ledger_entries le
          WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND ${UNRECONCILED}
          GROUP BY le.ledger_id`,
        p,
      )
      .map((r) => [r.ledger_id, r]),
  );
  const early = new Map(
    db
      .all<{ ledger_id: number; net: number }>(
        `SELECT le.ledger_id, SUM(le.amount) AS net FROM ledger_entries le
          WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND ${CLEARED_EARLY} GROUP BY le.ledger_id`,
        p,
      )
      .map((r) => [r.ledger_id, r.net]),
  );
  const lastRec = new Map(
    db
      .all<{ ledger_id: number; d: string }>(
        `SELECT le.ledger_id, MAX(le.bank_date) AS d FROM ledger_entries le
          WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND le.bank_date IS NOT NULL AND le.bank_date <= :asOf
            AND ${IN_BOOKS}
          GROUP BY le.ledger_id`,
        p,
      )
      .map((r) => [r.ledger_id, r.d]),
  );
  const lineCounts = new Map<number, Record<StatementLineStatus, number>>();
  for (const r of db.all<{ ledger_id: number; st: string; n: number }>(
    `SELECT s.ledger_id,
            CASE WHEN s.status IN ('matched', 'created') AND s.matched_entry_id IS NULL THEN 'unmatched' ELSE s.status END AS st,
            COUNT(*) AS n
       FROM bank_statement_lines s
      WHERE s.ledger_id IN (SELECT value FROM json_each(:ids)) AND s.txn_date <= :asOf
      GROUP BY s.ledger_id, st`,
    { ids, asOf },
  )) {
    const c = lineCounts.get(r.ledger_id) ?? ZERO_COUNTS();
    if (r.st in c) c[r.st as StatementLineStatus] += r.n;
    lineCounts.set(r.ledger_id, c);
  }

  const out: BankSummaryRow[] = [];
  for (const b of banks) {
    const books = balances.get(b.id) ?? b.openingBalance;
    const u = unrec.get(b.id);
    const issued = u?.issued ?? 0;
    const deposited = u?.deposited ?? 0;
    const count = (u?.issued_n ?? 0) + (u?.deposited_n ?? 0);
    if (!b.isActive && books === 0 && count === 0) continue;
    const last = db.get<{ txn_date: string; balance: number | null; imported_at: string }>(
      `SELECT s.txn_date, s.balance, b.imported_at FROM bank_statement_lines s JOIN import_batches b ON b.id = s.batch_id
        WHERE s.ledger_id = :l AND s.txn_date <= :asOf
        ORDER BY s.txn_date DESC, (s.balance IS NOT NULL) DESC, s.batch_id DESC, s.seq DESC LIMIT 1`,
      { l: b.id, asOf },
    );
    out.push({
      ...bankRef(b),
      balanceAsPerBooks: books,
      balanceAsPerBank: books + issued - deposited + (early.get(b.id) ?? 0),
      unreconciled: { count, depositsCount: u?.deposited_n ?? 0, deposits: deposited, issuedCount: u?.issued_n ?? 0, issued },
      lastReconciledDate: lastRec.get(b.id) ?? null,
      lastStatement: last
        ? {
            date: last.txn_date,
            balance: last.balance,
            importedAt: last.imported_at,
            difference: last.balance === null ? null : last.balance - bankBalanceOn(db, b.id, b.openingBalance, last.txn_date, today),
          }
        : null,
      statementLines: lineCounts.get(b.id) ?? ZERO_COUNTS(),
    });
  }
  return out;
}
