/**
 * Cheque register of a bank ledger: every leaf of its cheque books (and cheques issued outside any book)
 * with its state as on a date:
 *   issued    on a Payment / Contra, not yet cleared (post-dated ones flagged)
 *   cleared   bank date entered in the BRS
 *   stale     issued, uncleared, and the cheque date is more than 3 months before `asOf` (RBI: cheques
 *             are valid for three months from their date)
 *   cancelled marked by the user, cancelled with its voucher, or spoilt (printed for a voucher it is no
 *             longer on)
 *   unused    still in the book
 */
import { addMonths, formatDate } from '../../../shared/dates.ts';
import type { ChequeLeafStatus, ChequeRegisterInput, ChequeRegisterResult, ChequeRegisterRow } from '../../../shared/types/cheques.ts';
import type { Db } from '../../db/db.ts';
import { requireBankLedger } from '../banking/common.ts';
import { CHEQUE_VALIDITY_MONTHS } from '../banking/registers.ts';
import { chequePayeeName, issuedCheques, leafMarks, padCheque, spoiltByPrint, voucherLabel } from './common.ts';

interface BookRow {
  id: number;
  name: string;
  from_no: number;
  to_no: number;
  digits: number;
}

export function chequeRegister(db: Db, today: string, input: ChequeRegisterInput): ChequeRegisterResult {
  const bank = requireBankLedger(db, input.bankLedgerId, 'The cheque register');
  const asOf = input.asOf ?? today;
  const books = db.all<BookRow>(
    `SELECT id, name, from_no, to_no, digits FROM cheque_books WHERE bank_ledger_id = :b ${input.bookId !== undefined ? 'AND id = :book' : ''} ORDER BY from_no, id`,
    input.bookId !== undefined ? { b: bank.id, book: input.bookId } : { b: bank.id },
  );
  const issued = issuedCheques(db, bank.id);
  const byNo = new Map<number, (typeof issued)[number]>();
  for (const c of issued) if (!byNo.has(c.chequeNo)) byNo.set(c.chequeNo, c);
  const marks = leafMarks(db, bank.id);
  const spoilt = spoiltByPrint(db, bank.id, issued);
  const printedAt = new Map<string, string>();
  for (const p of db.all<{ voucher_id: number | null; cheque_no: string | null; printed_at: string }>(
    'SELECT voucher_id, cheque_no, printed_at FROM cheque_prints WHERE bank_ledger_id = :b ORDER BY id',
    { b: bank.id },
  )) {
    if (p.voucher_id !== null && p.cheque_no) printedAt.set(`${p.voucher_id}:${p.cheque_no.trim().replace(/^0+(?=\d)/, '')}`, p.printed_at);
  }
  // Payee per voucher: favouring, else the payment's largest non cash / bank debit.
  const payeeCache = new Map<number, string | null>();
  const payeeOf = (voucherId: number, favouring: string | null): string | null => {
    if (favouring && favouring.trim()) return favouring.trim();
    if (!payeeCache.has(voucherId)) {
      const r = db.get<{ ledger_id: number; base_type: string }>(
        `WITH RECURSIVE cb(id) AS (SELECT id FROM groups WHERE reserved_code IN ('BANK_ACCOUNTS', 'BANK_OD', 'CASH_IN_HAND')
                                    UNION SELECT c.id FROM groups c JOIN cb ON c.parent_id = cb.id)
         SELECT le.ledger_id, v.base_type FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id JOIN vouchers v ON v.id = le.voucher_id
          WHERE le.voucher_id = :v AND le.amount > 0 AND l.group_id NOT IN (SELECT id FROM cb)
          ORDER BY le.amount DESC, le.line_no LIMIT 1`,
        { v: voucherId },
      );
      payeeCache.set(voucherId, r ? chequePayeeName(db, r.ledger_id) : 'Self');
    }
    return payeeCache.get(voucherId) ?? null;
  };

  const rows: ChequeRegisterRow[] = [];
  const blank = (key: string, book: BookRow | null, no: string): ChequeRegisterRow => ({
    key,
    bookId: book?.id ?? null,
    bookName: book?.name ?? null,
    chequeNo: no,
    status: 'unused',
    postDated: false,
    voucherId: null,
    voucherLabel: null,
    voucherDate: null,
    chequeDate: null,
    payee: null,
    amount: null,
    bankDate: null,
    printedAt: null,
    reason: null,
  });
  const fill = (row: ChequeRegisterRow, n: number): ChequeRegisterRow => {
    const c = byNo.get(n);
    if (c) {
      const stale = c.bankDate === null && c.chequeDate <= asOf && addMonths(c.chequeDate, CHEQUE_VALIDITY_MONTHS) < asOf;
      const status: ChequeLeafStatus = c.bankDate !== null ? 'cleared' : stale ? 'stale' : 'issued';
      return {
        ...row,
        status,
        postDated: c.chequeDate > asOf,
        voucherId: c.voucherId,
        voucherLabel: voucherLabel(c.typeName, c.number, c.date),
        voucherDate: c.date,
        chequeDate: c.chequeDate,
        payee: payeeOf(c.voucherId, c.favouring),
        amount: c.amount,
        bankDate: c.bankDate,
        printedAt: printedAt.get(`${c.voucherId}:${n}`) ?? null,
        reason: stale ? `Not cleared within ${CHEQUE_VALIDITY_MONTHS} months of ${formatDate(c.chequeDate)}` : null,
      };
    }
    const m = marks.get(n);
    if (m) return { ...row, status: 'cancelled', reason: m.reason, chequeDate: m.date };
    const s = spoilt.get(n);
    if (s) return { ...row, status: 'cancelled', printedAt: s.at, reason: `Printed${s.label ? ` for ${s.label}` : ''} but not issued on it any more (spoilt)` };
    return row;
  };
  const inBooks = new Set<number>();
  for (const b of books) {
    for (let n = b.from_no; n <= b.to_no; n++) {
      inBooks.add(n);
      rows.push(fill(blank(`${b.id}:${n}`, b, padCheque(n, b.digits)), n));
    }
  }
  // Cheques issued outside every book (typed by hand, or before books were set up).
  if (input.bookId === undefined) {
    const allBooks = db.all<{ from_no: number; to_no: number }>('SELECT from_no, to_no FROM cheque_books WHERE bank_ledger_id = :b', { b: bank.id });
    const inAnyBook = (n: number): boolean => allBooks.some((b) => n >= b.from_no && n <= b.to_no);
    for (const c of byNo.values()) {
      if (inBooks.has(c.chequeNo) || inAnyBook(c.chequeNo)) continue;
      rows.push(fill(blank(`x:${c.chequeNo}`, null, c.rawNo), c.chequeNo));
    }
  }
  const totals = { leaves: rows.length, unused: 0, issued: 0, cleared: 0, stale: 0, cancelled: 0, issuedAmount: 0, unclearedAmount: 0 };
  for (const r of rows) {
    totals[r.status]++;
    if (r.amount !== null) {
      totals.issuedAmount += r.amount;
      if (r.status !== 'cleared') totals.unclearedAmount += r.amount;
    }
  }
  const status = input.status ?? 'all';
  return {
    bankLedgerId: bank.id,
    bankLedgerName: bank.name,
    asOf,
    rows: status === 'all' ? rows : rows.filter((r) => r.status === status),
    totals,
  };
}
