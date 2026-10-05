/**
 * Single-ledger documents: 'outstanding.ledgerBills' (Tally "Ledger Outstandings" with each bill's
 * history) and 'outstanding.statement' (statement of account with running balance and pending bills).
 * Amounts are ledger-signed: Dr +, Cr −.
 */
import { addDays } from '../../../shared/dates.ts';
import { stateName } from '../../../shared/gst/states.ts';
import type {
  BillHistoryLine,
  LedgerBillDetail,
  LedgerBillsInput,
  LedgerBillsResult,
  NonBillWiseMode,
  OnAccountLine,
  StatementBillRow,
  StatementInput,
  StatementLine,
  StatementResult,
} from '../../../shared/types/outstanding.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER, ledgerBalance } from '../accounts/books.ts';
import { getCompanyProfile } from '../company/service.ts';
import { billAge, bucketIndex, makeBuckets } from './ageing.ts';
import {
  NAMED_BILL_SQL,
  aggregateLines,
  billFromAggregate,
  booksFromDate,
  compareBills,
  fifoItemsOldestFirst,
  fifoSettle,
  ledgerSide,
  loadBillLines,
  loadLedger,
  loadParties,
  overdueDays,
  type BillLine,
  type OsLedger,
} from './engine.ts';

// ───────────────────────────── outstanding.ledgerBills ─────────────────────────────

interface UnallocatedRow {
  voucher_id: number;
  date: string;
  number: string | null;
  type_name: string;
  base_type: VoucherBaseType;
  narration: string | null;
  unallocated: number;
  has_on_account: number;
}

/** Opening difference + every entry's part not allocated to a named bill (Σ = the On Account remainder). */
function onAccountLines(db: Db, ledger: OsLedger, q: { asOf: string; today: string; booksFrom: string }): OnAccountLine[] {
  const lines: OnAccountLine[] = [];
  const openingBills = db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM opening_bills WHERE ledger_id = :id', { id: ledger.id }) ?? 0;
  const openingDiff = ledger.openingBalance - openingBills;
  if (openingDiff !== 0) {
    lines.push({ kind: 'opening', date: q.booksFrom, voucherId: null, voucherNumber: null, voucherType: null, baseType: null, amount: openingDiff, narration: 'Opening balance not allocated to bills' });
  }
  // Allocations aggregated per ledger entry via the (ledger_id, date) index; there is no index on ledger_entry_id.
  const rows = db.all<UnallocatedRow>(
    `WITH alloc AS (
       SELECT ba.ledger_entry_id AS entry_id,
              SUM(CASE WHEN ${NAMED_BILL_SQL('ba')} THEN ba.amount ELSE 0 END) AS named,
              MAX(CASE WHEN ba.ref_type = 'on_account' THEN 1 ELSE 0 END) AS has_on_account
         FROM bill_allocations ba
        WHERE ba.ledger_id = :id AND ba.date <= :asOf
        GROUP BY ba.ledger_entry_id
     )
     SELECT le.voucher_id, le.date, v.number, vt.name AS type_name, v.base_type,
            COALESCE(le.narration, v.narration) AS narration,
            le.amount - COALESCE(a.named, 0) AS unallocated,
            COALESCE(a.has_on_account, 0) AS has_on_account
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN alloc a ON a.entry_id = le.id
      WHERE le.ledger_id = :id AND le.date <= :asOf AND ${BOOKS_FILTER('le')}
      ORDER BY le.date, le.voucher_id, le.id`,
    { id: ledger.id, asOf: q.asOf, today: q.today },
  );
  for (const r of rows) {
    if (r.unallocated === 0) continue;
    lines.push({
      kind: r.has_on_account ? 'on_account' : 'unallocated',
      date: r.date,
      voucherId: r.voucher_id,
      voucherNumber: r.number,
      voucherType: r.type_name,
      baseType: r.base_type,
      amount: r.unallocated,
      narration: r.narration,
    });
  }
  return lines;
}

function historyOf(lines: readonly { kind: BillHistoryLine['kind']; voucherId: number | null; voucherNumber: string | null; voucherType: string | null; baseType: VoucherBaseType | null; date: string; amount: number; narration: string | null }[]): BillHistoryLine[] {
  let running = 0;
  return lines.map((l) => {
    running += l.amount;
    return { ...l, runningPending: running };
  });
}

export function ledgerBills(db: Db, today: string, input: LedgerBillsInput): LedgerBillsResult {
  const ledger = loadLedger(db, input.ledgerId);
  const mode: NonBillWiseMode = input.nonBillWise ?? 'fifo';
  const q = { asOf: input.asOf, today };
  const [party] = loadParties(db, [ledger], { ...q, nonBillWise: mode });
  const booksFrom = booksFromDate(db);
  const bills: LedgerBillDetail[] = [];
  let onAccount: LedgerBillsResult['onAccount'] = { total: party.onAccount, lines: [] };

  if (ledger.billWise) {
    const byBill = loadBillLines(db, [ledger.id], q).get(ledger.id) ?? new Map<string, BillLine[]>();
    for (const [name, list] of byBill) {
      const bill = billFromAggregate(aggregateLines(name, list), ledger);
      if (bill.pending === 0 && !input.includeSettled) continue;
      bills.push({
        billName: bill.billName,
        billDate: bill.billDate,
        dueDate: bill.dueDate,
        creditDays: bill.creditDays,
        refType: bill.refType,
        originalAmount: bill.original,
        pendingAmount: bill.pending,
        overdueDays: overdueDays(bill, input.asOf),
        voucherId: bill.voucherId,
        history: historyOf(
          list.map((l) => ({
            kind: l.kind,
            voucherId: l.voucherId,
            voucherNumber: l.voucherNumber,
            voucherType: l.voucherType,
            baseType: l.baseType,
            date: l.date,
            amount: l.amount,
            narration: l.narration,
          })),
        ),
      });
    }
    onAccount = { total: party.onAccount, lines: onAccountLines(db, ledger, { ...q, booksFrom }) };
  } else if (mode === 'fifo') {
    // Each debit (Dr balance) / credit (Cr balance) that is still open, with the payments FIFO-applied to it.
    for (const o of fifoSettle(fifoItemsOldestFirst(db, ledger, { ...q, booksFrom }))) {
      if (o.open === 0 && !input.includeSettled) continue;
      const bill = {
        billName: o.item.label,
        refType: 'fifo' as const,
        billDate: o.item.date,
        dueDate: addDays(o.item.date, ledger.creditDays ?? 0),
        creditDays: ledger.creditDays,
      };
      bills.push({
        ...bill,
        originalAmount: o.original,
        pendingAmount: o.open,
        overdueDays: overdueDays(bill, input.asOf),
        voucherId: o.item.voucherId,
        history: historyOf(
          o.events.map((e, i) => ({
            kind: i === 0 ? ('fifo' as const) : ('against' as const),
            voucherId: e.item.voucherId,
            voucherNumber: e.item.voucherNumber ?? null,
            voucherType: e.item.voucherType ?? null,
            baseType: e.item.baseType ?? null,
            date: e.date,
            amount: e.amount,
            narration: e.item.voucherId === null ? e.item.label : null,
          })),
        ),
      });
    }
    let open = 0;
    for (const b of bills) open += b.pendingAmount;
    onAccount = { total: party.balance - open, lines: [] };
  }
  bills.sort(compareBills);

  const totals = { billsPending: 0, advance: 0, onAccount: onAccount.total, overdue: 0, balance: party.balance };
  for (const b of bills) {
    if (b.refType === 'advance') totals.advance += b.pendingAmount;
    else {
      totals.billsPending += b.pendingAmount;
      if (b.overdueDays > 0) totals.overdue += b.pendingAmount;
    }
  }
  return {
    ledger: {
      id: ledger.id,
      name: ledger.name,
      groupId: ledger.groupId,
      groupName: ledger.groupName,
      billWise: ledger.billWise,
      side: ledgerSide(ledger, party.balance),
      creditDays: ledger.creditDays,
      creditLimit: ledger.creditLimit,
      interestRate: ledger.interestRate,
    },
    asOf: input.asOf,
    method: party.method,
    balance: party.balance,
    bills,
    onAccount,
    totals,
  };
}

// ───────────────────────────── outstanding.statement ─────────────────────────────

interface StatementRow {
  voucher_id: number;
  date: string;
  number: string | null;
  reference_no: string | null;
  narration: string | null;
  type_name: string;
  base_type: VoucherBaseType;
  dr: number;
  cr: number;
}

interface PartyRow {
  mailing_name: string | null;
  address: string | null;
  state_code: string | null;
  pincode: string | null;
  gstin: string | null;
  pan: string | null;
  contact_person: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
}

/** Counter ledger per voucher: the largest entry on the other side among the other ledgers. */
function particularsFor(db: Db, ledgerId: number, rows: readonly StatementRow[]): Map<number, string> {
  const out = new Map<number, string>();
  if (rows.length === 0) return out;
  const net = new Map(rows.map((r) => [r.voucher_id, r.dr - r.cr]));
  const entries = db.all<{ voucher_id: number; name: string; amount: number }>(
    `SELECT le.voucher_id, l.name, SUM(le.amount) AS amount
       FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
      WHERE le.voucher_id IN (SELECT value FROM json_each(:vids)) AND le.ledger_id <> :id
      GROUP BY le.voucher_id, le.ledger_id
      ORDER BY le.voucher_id, MIN(le.line_no)`,
    { vids: JSON.stringify(rows.map((r) => r.voucher_id)), id: ledgerId },
  );
  const best = new Map<number, number>();
  for (const e of entries) {
    const mine = net.get(e.voucher_id) ?? 0;
    const opposite = mine >= 0 ? e.amount < 0 : e.amount > 0;
    if (!opposite) continue;
    if (Math.abs(e.amount) > (best.get(e.voucher_id) ?? 0)) {
      best.set(e.voucher_id, Math.abs(e.amount));
      out.set(e.voucher_id, e.name);
    }
  }
  return out;
}

export function statement(db: Db, today: string, input: StatementInput): StatementResult {
  const ledger = loadLedger(db, input.ledgerId);
  const company = getCompanyProfile(db);
  const p = db.get<PartyRow>(
    `SELECT mailing_name, address, state_code, pincode, gstin, pan, contact_person, phone, mobile, email FROM ledgers WHERE id = :id`,
    { id: ledger.id },
  ) as PartyRow;
  const bal = ledgerBalance(db, ledger.id, { from: input.from, to: input.to, today });

  const rows = db.all<StatementRow>(
    `SELECT le.voucher_id, v.date, v.number, v.reference_no, v.narration, vt.name AS type_name, v.base_type,
            SUM(CASE WHEN le.amount > 0 THEN le.amount ELSE 0 END) AS dr,
            SUM(CASE WHEN le.amount < 0 THEN -le.amount ELSE 0 END) AS cr
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE le.ledger_id = :id AND le.date >= :from AND le.date <= :to AND ${BOOKS_FILTER('le')}
      GROUP BY le.voucher_id
      ORDER BY v.date, v.id`,
    { id: ledger.id, from: input.from, to: input.to, today },
  );
  const particulars = particularsFor(db, ledger.id, rows);
  let running = bal.opening;
  const transactions: StatementLine[] = rows.map((r) => {
    running += r.dr - r.cr;
    return {
      date: r.date,
      voucherId: r.voucher_id,
      voucherType: r.type_name,
      baseType: r.base_type,
      voucherNumber: r.number,
      referenceNo: r.reference_no,
      particulars: particulars.get(r.voucher_id) ?? '(as per details)',
      narration: r.narration,
      debit: r.dr,
      credit: r.cr,
      balance: running,
    };
  });

  // Pending bills as at the statement's end date, aged on the due date.
  const buckets = makeBuckets(input.buckets ?? DEFAULT_AGEING_BUCKETS, 'due_date');
  const [party] = loadParties(db, [ledger], { asOf: input.to, today, nonBillWise: input.nonBillWise ?? 'fifo' });
  const billRows: StatementBillRow[] = [];
  const bucketTotals = buckets.map(() => 0);
  let advance = 0;
  let onAccount = party.onAccount;
  for (const b of party.bills) {
    const age = billAge(b, input.to, 'due_date');
    const idx = age === null ? null : bucketIndex(age, buckets);
    billRows.push({
      billName: b.billName,
      billDate: b.billDate,
      dueDate: b.dueDate,
      refType: b.refType,
      pendingAmount: b.pending,
      overdueDays: overdueDays(b, input.to),
      ageDays: age,
      bucketIndex: idx,
    });
    if (idx !== null) bucketTotals[idx] += b.pending;
    else if (b.refType === 'advance') advance += b.pending;
    else onAccount += b.pending;
  }

  return {
    company: {
      name: company.name,
      mailingName: company.mailingName,
      address: company.address,
      stateCode: company.stateCode,
      stateName: stateName(company.stateCode) || null,
      pincode: company.pincode,
      phone: company.phone,
      mobile: company.mobile,
      email: company.email,
      gstin: company.gstin,
      pan: company.pan,
    },
    party: {
      ledgerId: ledger.id,
      name: ledger.name,
      mailingName: p.mailing_name,
      address: p.address,
      stateCode: p.state_code,
      stateName: stateName(p.state_code) || null,
      pincode: p.pincode,
      gstin: p.gstin,
      pan: p.pan,
      contactPerson: p.contact_person,
      phone: p.phone,
      mobile: p.mobile,
      email: p.email,
      groupName: ledger.groupName,
      billWise: ledger.billWise,
      creditDays: ledger.creditDays,
      creditLimit: ledger.creditLimit,
    },
    from: input.from,
    to: input.to,
    generatedOn: today,
    openingBalance: bal.opening,
    transactions,
    totals: { debit: bal.debit, credit: bal.credit },
    closingBalance: bal.closing,
    pendingBills: {
      asOf: input.to,
      method: party.method,
      buckets,
      rows: billRows,
      bucketTotals,
      advance,
      onAccount,
      total: party.balance,
    },
  };
}
