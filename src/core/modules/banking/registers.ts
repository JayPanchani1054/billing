/**
 * Banking registers: cheque register (cheques/DDs issued and received with clearing status), post-dated
 * cheques (PDC) pending maturity, and the bank deposit slip (cheques and cash paid into a bank on a day).
 */
import { addMonths } from '../../../shared/dates.ts';
import { amountInWords } from '../../../shared/words.ts';
import type {
  ChequeRegisterInput,
  ChequeRegisterResult,
  ChequeRegisterRow,
  ChequeStatus,
  DepositSlip,
  DepositSlipCheque,
  PdcInput,
  PdcResult,
  PdcRow,
} from '../../../shared/types/banking.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { loadGroupTree } from '../accounts/books.ts';
import {
  ENTRY_SELECT,
  asInstrument,
  bankLedgers,
  bankRef,
  particularsResolver,
  requireBankLedger,
  voucherRef,
  type BankLedger,
  type EntryRow,
} from './common.ts';
import { dayDiff } from './values.ts';

function banksFor(db: Db, ledgerId: number | undefined, purpose: string): BankLedger[] {
  return ledgerId !== undefined ? [requireBankLedger(db, ledgerId, purpose)] : bankLedgers(db);
}

/** RBI/CTS: a cheque is valid for 3 months from its date. */
export const CHEQUE_VALIDITY_MONTHS = 3;

export function chequeRegister(db: Db, today: string, input: ChequeRegisterInput): ChequeRegisterResult {
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The end date must be on or after the start date' }]);
  const banks = banksFor(db, input.ledgerId, 'The cheque register');
  const empty: ChequeRegisterResult = {
    rows: [],
    totals: { issued: { count: 0, amount: 0, uncleared: 0, unclearedAmount: 0 }, received: { count: 0, amount: 0, uncleared: 0, unclearedAmount: 0 }, stale: 0 },
  };
  if (banks.length === 0) return empty;
  const names = new Map(banks.map((b) => [b.id, b.name]));
  const where = [
    'le.ledger_id IN (SELECT value FROM json_each(:ids))',
    "le.instrument_type IN ('cheque', 'dd')",
    'le.date >= :from',
    'le.date <= :to',
    'le.affects_books = 1',
  ];
  const status = input.status ?? 'all';
  if (status === 'cleared') where.push('le.bank_date IS NOT NULL');
  if (status === 'uncleared') where.push('le.bank_date IS NULL');
  const direction = input.direction ?? 'all';
  if (direction === 'issued') where.push('le.amount < 0');
  if (direction === 'received') where.push('le.amount > 0');
  const rows = db.all<EntryRow>(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY le.date, le.instrument_no, le.id`, {
    ids: JSON.stringify(banks.map((b) => b.id)),
    from: input.from,
    to: input.to,
  });
  const particulars = particularsResolver(
    db,
    rows.map((r) => r.voucher_id),
  );
  const out: ChequeRegisterRow[] = rows.map((r) => {
    const st: ChequeStatus = r.bank_date !== null ? 'cleared' : r.is_post_dated === 1 && r.date > today ? 'post_dated' : 'uncleared';
    const chequeDate = r.instrument_date ?? r.date;
    return {
      ...voucherRef(r, particulars(r)),
      bankLedgerId: r.ledger_id,
      bankLedgerName: names.get(r.ledger_id) ?? '',
      direction: r.amount < 0 ? 'issued' : 'received',
      instrumentType: r.instrument_type === 'dd' ? 'dd' : 'cheque',
      instrumentNo: r.instrument_no,
      instrumentDate: r.instrument_date,
      drawnOn: r.bank_name,
      favouring: r.favouring,
      amount: Math.abs(r.amount),
      bankDate: r.bank_date,
      status: st,
      stale: st === 'uncleared' && addMonths(chequeDate, CHEQUE_VALIDITY_MONTHS) < today,
    };
  });
  const totals = empty.totals;
  for (const r of out) {
    const t = r.direction === 'issued' ? totals.issued : totals.received;
    t.count++;
    t.amount += r.amount;
    if (r.status !== 'cleared') {
      t.uncleared++;
      t.unclearedAmount += r.amount;
    }
    if (r.stale) totals.stale++;
  }
  return { rows: out, totals };
}

export function postDatedCheques(db: Db, input: PdcInput): PdcResult {
  const banks = banksFor(db, input.ledgerId, 'The post-dated cheque report');
  const result: PdcResult = { asOf: input.asOf, rows: [], totals: { receivable: { count: 0, amount: 0 }, payable: { count: 0, amount: 0 } } };
  if (banks.length === 0) return result;
  const names = new Map(banks.map((b) => [b.id, b.name]));
  const rows = db.all<EntryRow>(
    `${ENTRY_SELECT}
      WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND le.is_post_dated = 1 AND le.affects_books = 1
        ${input.includeMatured ? '' : 'AND le.date > :asOf'}
      ORDER BY le.date, le.id`,
    input.includeMatured ? { ids: JSON.stringify(banks.map((b) => b.id)) } : { ids: JSON.stringify(banks.map((b) => b.id)), asOf: input.asOf },
  );
  const particulars = particularsResolver(
    db,
    rows.map((r) => r.voucher_id),
  );
  result.rows = rows.map((r): PdcRow => {
    const days = dayDiff(input.asOf, r.date);
    return {
      ...voucherRef(r, particulars(r)),
      bankLedgerId: r.ledger_id,
      bankLedgerName: names.get(r.ledger_id) ?? '',
      kind: r.amount > 0 ? 'receivable' : 'payable',
      instrumentType: asInstrument(r.instrument_type),
      instrumentNo: r.instrument_no,
      instrumentDate: r.instrument_date,
      drawnOn: r.bank_name,
      amount: Math.abs(r.amount),
      daysToMaturity: days,
      matured: days <= 0,
      bankDate: r.bank_date,
    };
  });
  for (const r of result.rows) {
    const t = r.kind === 'receivable' ? result.totals.receivable : result.totals.payable;
    t.count++;
    t.amount += r.amount;
  }
  return result;
}

export function depositSlip(db: Db, input: { ledgerId: number; date: string }): DepositSlip {
  const bank = requireBankLedger(db, input.ledgerId, 'The deposit slip');
  const company = db.get<{ name: string; gstin: string | null }>('SELECT name, gstin FROM company WHERE id = 1') ?? { name: '', gstin: null };
  const chequeRows = db.all<EntryRow>(
    `${ENTRY_SELECT}
      WHERE le.ledger_id = :l AND le.date = :d AND le.amount > 0 AND le.affects_books = 1 AND le.instrument_type IN ('cheque', 'dd')
      ORDER BY le.instrument_no, le.id`,
    { l: bank.id, d: input.date },
  );
  const particulars = particularsResolver(
    db,
    chequeRows.map((r) => r.voucher_id),
  );
  const cheques: DepositSlipCheque[] = chequeRows.map((r) => ({
    ledgerEntryId: r.entry_id,
    voucherId: r.voucher_id,
    voucherType: r.type_name,
    number: r.number,
    particulars: particulars(r),
    instrumentType: r.instrument_type === 'dd' ? 'dd' : 'cheque',
    instrumentNo: r.instrument_no,
    instrumentDate: r.instrument_date,
    drawnOn: r.bank_name,
    amount: r.amount,
  }));
  const tree = loadGroupTree(db);
  const cashGroups = [...tree.byId.values()].filter((g) => g.cls.isCash).map((g) => g.id);
  const cash = db.get<{ amount: number | null; n: number }>(
    `SELECT SUM(le.amount) AS amount, COUNT(DISTINCT le.voucher_id) AS n
       FROM ledger_entries le
      WHERE le.ledger_id = :l AND le.date = :d AND le.amount > 0 AND le.affects_books = 1
        AND (le.instrument_type IS NULL OR le.instrument_type NOT IN ('cheque', 'dd'))
        AND (le.instrument_type = 'cash' OR EXISTS (
              SELECT 1 FROM ledger_entries o JOIN ledgers ol ON ol.id = o.ledger_id
               WHERE o.voucher_id = le.voucher_id AND o.amount < 0 AND ol.group_id IN (SELECT value FROM json_each(:cg))))`,
    { l: bank.id, d: input.date, cg: JSON.stringify(cashGroups) },
  );
  const chequeTotal = cheques.reduce((s, c) => s + c.amount, 0);
  const cashTotal = cash?.amount ?? 0;
  const total = chequeTotal + cashTotal;
  return {
    company: { name: company.name, gstin: company.gstin },
    bank: { ...bankRef(bank), holder: bank.holder },
    date: input.date,
    cheques,
    cash: { amount: cashTotal, vouchers: cash?.n ?? 0 },
    totals: { chequeCount: cheques.length, cheques: chequeTotal, cash: cashTotal, total },
    amountInWords: amountInWords(total),
  };
}
