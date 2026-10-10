/**
 * Cheque books per bank ledger (leaf ranges) and leaf allocation.
 *
 * A leaf is used when a Payment / Contra credits the bank with a cheque of that number (any voucher
 * still in the file: regular, optional or post-dated), when it is marked cancelled (by the user, or
 * with its voucher), or when it was printed for a voucher it is no longer on (spoilt). The next leaf
 * is the lowest unused one of the bank's active books, in book order — a physical book is used front
 * to back, and a skipped leaf is still in the book until it is cancelled.
 */
import { randomUUID } from 'node:crypto';
import type { ChequeBank, ChequeBook, ChequeBookSaveInput } from '../../../shared/types/cheques.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { bankLedgers, requireBankLedger } from '../banking/common.ts';
import { assertDateUnlocked } from '../company/service.ts';
import { chequeNumber, issuedCheques, issuedLeaves, leafMarks, padCheque, requirePermission, spoiltByPrint } from './common.ts';

interface BookRow {
  id: number;
  guid: string;
  bank_ledger_id: number;
  name: string;
  from_no: number;
  to_no: number;
  digits: number;
  is_active: number;
}

const BOOK_COLS = 'id, guid, bank_ledger_id, name, from_no, to_no, digits, is_active';

/** Numbers of a bank that are not free: issued (minus `excludeVoucherId`), marked, spoilt by a print. */
export function usedLeaves(db: Db, bankLedgerId: number, excludeVoucherId: number | null = null): { issued: Set<number>; cancelled: Set<number> } {
  const all = issuedLeaves(db, bankLedgerId);
  const issued = new Set(all.filter((c) => c.voucherId !== excludeVoucherId).map((c) => c.chequeNo));
  const cancelled = new Set<number>(leafMarks(db, bankLedgerId).keys());
  for (const n of spoiltByPrint(db, bankLedgerId, all).keys()) cancelled.add(n);
  return { issued, cancelled };
}

function booksOf(db: Db, bankLedgerId: number, activeOnly: boolean): BookRow[] {
  return db.all<BookRow>(
    `SELECT ${BOOK_COLS} FROM cheque_books WHERE bank_ledger_id = :b ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY from_no, id`,
    { b: bankLedgerId },
  );
}

/**
 * The next free leaf of the bank's active books (lowest number, book order), skipping `taken` (numbers
 * already given to other lines of the voucher being saved). null when there is no book or all are used.
 */
export function nextLeaf(
  db: Db,
  bankLedgerId: number,
  opts: { excludeVoucherId?: number | null; taken?: ReadonlySet<number> } = {},
): { bookId: number; chequeNo: string } | null {
  const books = booksOf(db, bankLedgerId, true);
  if (books.length === 0) return null;
  const { issued, cancelled } = usedLeaves(db, bankLedgerId, opts.excludeVoucherId ?? null);
  for (const b of books) {
    for (let n = b.from_no; n <= b.to_no; n++) {
      if (issued.has(n) || cancelled.has(n) || opts.taken?.has(n)) continue;
      return { bookId: b.id, chequeNo: padCheque(n, b.digits) };
    }
  }
  return null;
}

/** True when the bank has at least one active cheque book. */
export function hasActiveBook(db: Db, bankLedgerId: number): boolean {
  return (db.value<number>('SELECT COUNT(*) FROM cheque_books WHERE bank_ledger_id = :b AND is_active = 1', { b: bankLedgerId }) ?? 0) > 0;
}

/** The book (any, active or not) that holds a number, or null. */
export function bookOfLeaf(db: Db, bankLedgerId: number, n: number): { id: number; name: string } | null {
  return db.get<{ id: number; name: string }>('SELECT id, name FROM cheque_books WHERE bank_ledger_id = :b AND :n BETWEEN from_no AND to_no ORDER BY id LIMIT 1', { b: bankLedgerId, n }) ?? null;
}

function toBook(db: Db, r: BookRow, bankName: string, used: { issued: Set<number>; cancelled: Set<number> }): ChequeBook {
  let issued = 0;
  let cancelled = 0;
  let next: number | null = null;
  for (let n = r.from_no; n <= r.to_no; n++) {
    if (used.issued.has(n)) issued++;
    else if (used.cancelled.has(n)) cancelled++;
    else if (next === null) next = n;
  }
  const leaves = r.to_no - r.from_no + 1;
  void db;
  return {
    id: r.id,
    bankLedgerId: r.bank_ledger_id,
    bankLedgerName: bankName,
    name: r.name,
    fromNo: r.from_no,
    toNo: r.to_no,
    digits: r.digits,
    isActive: r.is_active === 1,
    leaves,
    issued,
    cancelled,
    unused: leaves - issued - cancelled,
    nextNo: next === null ? null : padCheque(next, r.digits),
  };
}

export function listBooks(db: Db, bankLedgerId?: number): ChequeBook[] {
  const banks = bankLedgers(db).filter((b) => bankLedgerId === undefined || b.id === bankLedgerId);
  const out: ChequeBook[] = [];
  for (const bank of banks) {
    const rows = booksOf(db, bank.id, false);
    if (rows.length === 0) continue;
    const used = usedLeaves(db, bank.id);
    for (const r of rows) out.push(toBook(db, r, bank.name, used));
  }
  return out;
}

export function getBook(db: Db, id: number): ChequeBook {
  const r = db.get<BookRow>(`SELECT ${BOOK_COLS} FROM cheque_books WHERE id = :id`, { id });
  if (!r) throw notFound('Cheque book', id);
  const name = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: r.bank_ledger_id }) ?? '';
  return toBook(db, r, name, usedLeaves(db, r.bank_ledger_id));
}

/** Bank ledgers with their cheque set-up (for pickers and the cheque print screen). */
export function listChequeBanks(db: Db): ChequeBank[] {
  return bankLedgers(db)
    .filter((b) => b.isActive)
    .map((b) => {
      const books = booksOf(db, b.id, true);
      let unused = 0;
      if (books.length > 0) {
        const used = usedLeaves(db, b.id);
        for (const r of books) for (let n = r.from_no; n <= r.to_no; n++) if (!used.issued.has(n) && !used.cancelled.has(n)) unused++;
      }
      const layoutId = db.value<number | null>('SELECT layout_id FROM cheque_bank_settings WHERE bank_ledger_id = :b', { b: b.id }) ?? null;
      return { ledgerId: b.id, name: b.name, accountNo: b.accountNo, books: books.length, unusedLeaves: unused, layoutId };
    });
}

export function saveBook(ctx: CompanyCtx, input: ChequeBookSaveInput): ChequeBook {
  const { db } = ctx;
  const existing = input.id !== undefined ? db.get<BookRow>(`SELECT ${BOOK_COLS} FROM cheque_books WHERE id = :id`, { id: input.id }) : undefined;
  if (input.id !== undefined && !existing) throw notFound('Cheque book', input.id);
  requirePermission(ctx, existing ? 'masters.alter' : 'masters.create', existing ? 'alter cheque books' : 'create cheque books');
  const bank = requireBankLedger(db, input.bankLedgerId, 'A cheque book');
  if (existing && existing.bank_ledger_id !== input.bankLedgerId) {
    throw validation([{ path: 'bankLedgerId', message: 'A cheque book cannot move to another bank. Create a new book for that bank.' }]);
  }
  const digits = input.digits ?? existing?.digits ?? 6;
  const issues: Array<{ path: string; message: string }> = [];
  if (!Number.isInteger(input.fromNo) || input.fromNo < 0) issues.push({ path: 'fromNo', message: 'Enter the first cheque number of the book' });
  if (!Number.isInteger(input.toNo) || input.toNo < input.fromNo) issues.push({ path: 'toNo', message: 'The last cheque number must be the same as or after the first' });
  else if (input.toNo - input.fromNo >= 10_000) issues.push({ path: 'toNo', message: 'A cheque book can have at most 10,000 leaves' });
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) issues.push({ path: 'digits', message: 'Cheque numbers have 1 to 12 digits (6 on CTS-2010 cheques)' });
  else if (input.toNo >= 10 ** digits) issues.push({ path: 'toNo', message: `Cheque ${input.toNo} has more than ${digits} digits` });
  if (issues.length > 0) throw validation(issues);
  const overlap = db.get<{ name: string; from_no: number; to_no: number; digits: number }>(
    `SELECT name, from_no, to_no, digits FROM cheque_books
      WHERE bank_ledger_id = :b AND id <> :id AND from_no <= :to AND to_no >= :from LIMIT 1`,
    { b: bank.id, id: existing?.id ?? -1, from: input.fromNo, to: input.toNo },
  );
  if (overlap) {
    throw validation([
      {
        path: 'fromNo',
        message: `These leaves overlap the cheque book “${overlap.name}” (${padCheque(overlap.from_no, overlap.digits)}–${padCheque(overlap.to_no, overlap.digits)}) of ${bank.name}.`,
      },
    ]);
  }
  const name = (input.name ?? '').trim() || `${padCheque(input.fromNo, digits)}–${padCheque(input.toNo, digits)}`;
  if (name.length > 100) throw validation([{ path: 'name', message: 'Keep the name under 100 characters' }]);
  const now = ctx.clock.now().toISOString();
  const isActive = input.isActive ?? (existing ? existing.is_active === 1 : true);
  let id: number;
  if (existing) {
    db.run(
      `UPDATE cheque_books SET name = :name, from_no = :from, to_no = :to, digits = :digits, is_active = :active, updated_at = :now WHERE id = :id`,
      { name, from: input.fromNo, to: input.toNo, digits, active: isActive ? 1 : 0, now, id: existing.id },
    );
    id = existing.id;
  } else {
    id = Number(
      db.run(
        `INSERT INTO cheque_books (guid, bank_ledger_id, name, from_no, to_no, digits, is_active, created_at, updated_at)
         VALUES (:guid, :b, :name, :from, :to, :digits, :active, :now, :now)`,
        { guid: randomUUID(), b: bank.id, name, from: input.fromNo, to: input.toNo, digits, active: isActive ? 1 : 0, now },
      ).lastInsertRowid,
    );
  }
  const after = getBook(db, id);
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'cheque_book',
    entityId: id,
    entityGuid: existing?.guid ?? db.value<string>('SELECT guid FROM cheque_books WHERE id = :id', { id }),
    entityLabel: `Cheque book ${name} — ${bank.name}`,
    before: existing ? { name: existing.name, fromNo: existing.from_no, toNo: existing.to_no, digits: existing.digits, isActive: existing.is_active === 1 } : undefined,
    after: { name, fromNo: input.fromNo, toNo: input.toNo, digits, isActive },
  });
  return after;
}

export function deleteBook(ctx: CompanyCtx, id: number): { ok: true } {
  const { db } = ctx;
  requirePermission(ctx, 'masters.delete', 'delete cheque books');
  const r = db.get<BookRow>(`SELECT ${BOOK_COLS} FROM cheque_books WHERE id = :id`, { id });
  if (!r) throw notFound('Cheque book', id);
  const used = usedLeaves(db, r.bank_ledger_id);
  let n = 0;
  for (let x = r.from_no; x <= r.to_no; x++) if (used.issued.has(x) || used.cancelled.has(x)) n++;
  if (n > 0) {
    throw rule(`${n} leaf${n === 1 ? ' of this book is' : 'ves of this book are'} already used or cancelled, so the book stays on record. Make it inactive instead (Alter › Active: No).`);
  }
  db.run('DELETE FROM cheque_books WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'cheque_book', entityId: id, entityGuid: r.guid, entityLabel: `Cheque book ${r.name}`, before: { fromNo: r.from_no, toNo: r.to_no } });
  return { ok: true };
}

/** Cancel (spoil) an unused leaf, or re-open one cancelled by mistake. */
export function cancelLeaf(ctx: CompanyCtx, input: { bankLedgerId: number; chequeNo: string; reason: string; date?: string }): { ok: true } {
  const { db } = ctx;
  requirePermission(ctx, 'vouchers.alter', 'cancel cheque leaves');
  const bank = requireBankLedger(db, input.bankLedgerId, 'Cancelling a cheque leaf');
  const n = chequeNumber(input.chequeNo);
  if (n === null) throw validation([{ path: 'chequeNo', message: 'Enter the cheque number (digits only)' }]);
  const reason = input.reason.trim();
  if (!reason) throw validation([{ path: 'reason', message: 'Say why the leaf is cancelled (e.g. spoilt while writing)' }]);
  const issued = issuedCheques(db, bank.id).find((c) => c.chequeNo === n);
  if (issued) {
    throw rule(`Cheque ${input.chequeNo.trim()} is issued on ${issued.typeName} ${issued.number ?? ''}. Cancel or alter that voucher instead.`);
  }
  if (db.value('SELECT 1 FROM cheque_leaf_marks WHERE bank_ledger_id = :b AND cheque_no = :n', { b: bank.id, n }) !== undefined) {
    throw rule(`Cheque ${input.chequeNo.trim()} is already cancelled.`);
  }
  const date = input.date ?? ctx.clock.today();
  // The cheque register of a locked period (F12) stays as it was closed.
  assertDateUnlocked(db, date);
  db.run(
    `INSERT INTO cheque_leaf_marks (bank_ledger_id, cheque_no, status, reason, date, voucher_id, created_by, created_at)
     VALUES (:b, :n, 'cancelled', :reason, :date, NULL, :by, :now)`,
    { b: bank.id, n, reason: reason.slice(0, 300), date, by: ctx.session.userId, now: ctx.clock.now().toISOString() },
  );
  ctx.audit({ action: 'cancel', entityType: 'cheque_leaf', entityId: n, entityLabel: `Cheque ${input.chequeNo.trim()} — ${bank.name}`, after: { reason, date } });
  return { ok: true };
}

export function restoreLeaf(ctx: CompanyCtx, input: { bankLedgerId: number; chequeNo: string }): { ok: true } {
  const { db } = ctx;
  requirePermission(ctx, 'vouchers.alter', 're-open cheque leaves');
  const bank = requireBankLedger(db, input.bankLedgerId, 'Re-opening a cheque leaf');
  const n = chequeNumber(input.chequeNo);
  if (n === null) throw validation([{ path: 'chequeNo', message: 'Enter the cheque number (digits only)' }]);
  const mark = db.get<{ reason: string | null; date: string }>('SELECT reason, date FROM cheque_leaf_marks WHERE bank_ledger_id = :b AND cheque_no = :n', { b: bank.id, n });
  if (!mark) throw rule(`Cheque ${input.chequeNo.trim()} is not marked cancelled. (A leaf spoilt by printing stays cancelled.)`);
  assertDateUnlocked(db, mark.date);
  db.run('DELETE FROM cheque_leaf_marks WHERE bank_ledger_id = :b AND cheque_no = :n', { b: bank.id, n });
  ctx.audit({ action: 'alter', entityType: 'cheque_leaf', entityId: n, entityLabel: `Cheque ${input.chequeNo.trim()} — ${bank.name} re-opened`, before: mark });
  return { ok: true };
}
