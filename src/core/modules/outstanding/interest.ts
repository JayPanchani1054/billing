/**
 * Interest on overdue bills — simple interest, 365-day year ('simple_365').
 *
 *   interest(bill) = round( Σ_segments balance × days × rate% ÷ 100 ÷ 365 )      (rounded once per bill)
 *
 * Interest accrues on each day d with  interestFrom < d ≤ to  and  d ≥ from, where
 * interestFrom = basis date (due date or bill date) + grace days. The balance for day d is the bill's
 * pending amount from all its lines dated BEFORE d — so a payment dated d still bears interest for
 * day d (interest runs "up to the date of payment", the usual Indian practice).
 * Only days with a positive side-signed balance accrue: debtors' Dr bills (interest receivable),
 * creditors' Cr bills (interest payable), other ledgers' bills in the direction of their origin.
 * Advances and On Account amounts never bear interest.
 *
 * Worked example: ₹1,00,000 due 30-Apr, unpaid on 14-Jun, 18% p.a. → days 1-May … 14-Jun = 45,
 *   1,00,00,000 paise × 18 × 45 ÷ 36,500 = 2,21,917.8 → 2,21,918 paise = ₹2,219.18.
 *
 * Non-bill-wise ledgers are settled first-in-first-out (each credit clears the oldest debits) and every
 * debit is treated as a bill dated on its voucher, due after the ledger's credit days.
 */
import { addDays, diffDays, maxDate } from '../../../shared/dates.ts';
import { roundPaise } from '../../../shared/money.ts';
import type { InterestBillRow, InterestInput, InterestResult, InterestSegment, OutstandingRefType } from '../../../shared/types/outstanding.ts';
import type { Db } from '../../db/db.ts';
import {
  aggregateLines,
  billFromAggregate,
  booksFromDate,
  fifoItemsOldestFirst,
  fifoSettle,
  loadBillLines,
  loadScope,
  type BillLine,
  type OsLedger,
} from './engine.ts';

export interface InterestEvent {
  date: string;
  /** Signed (Dr +, Cr −). */
  amount: number;
}

export interface BillInterest {
  segments: InterestSegment[];
  days: number;
  /** Σ balance × days (paise·days). */
  product: number;
  interest: number;
  principal: number;
  pendingAtEnd: number;
}

/**
 * Interest on one bill. `events` in date order; `dir` +1 when Dr balances bear interest (receivable),
 * −1 for Cr (payable). Pure.
 */
export function billInterest(
  events: readonly InterestEvent[],
  o: { dir: 1 | -1; interestFrom: string; from: string; to: string; ratePercent: number },
): BillInterest {
  let pendingAtEnd = 0;
  for (const e of events) if (e.date <= o.to) pendingAtEnd += e.amount;
  pendingAtEnd *= o.dir;
  const start = maxDate(o.interestFrom, addDays(o.from, -1));
  const segments: InterestSegment[] = [];
  if (start >= o.to) return { segments, days: 0, product: 0, interest: 0, principal: 0, pendingAtEnd };

  let balance = 0;
  for (const e of events) if (e.date <= start) balance += o.dir * e.amount;
  let cursor = start;
  const push = (until: string): void => {
    const days = diffDays(cursor, until);
    if (days > 0 && balance > 0) segments.push({ from: cursor, to: until, days, balance });
  };
  for (const e of events) {
    if (e.date <= start || e.date >= o.to) continue;
    if (e.date > cursor) {
      push(e.date);
      cursor = e.date;
    }
    balance += o.dir * e.amount;
  }
  push(o.to);

  let product = 0;
  let days = 0;
  for (const s of segments) {
    product += s.balance * s.days;
    days += s.days;
  }
  const interest = roundPaise((product * o.ratePercent) / 36_500);
  return { segments, days, product, interest, principal: segments[0]?.balance ?? 0, pendingAtEnd };
}

interface Candidate {
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  refType: OutstandingRefType;
  /** Signed origin amount. */
  original: number;
  events: InterestEvent[];
}

const NO_RATE = 'No interest rate: enable interest with a rate on the ledger, or enter a rate for this report';

export function interestReport(db: Db, today: string, input: InterestInput): InterestResult {
  const basis = input.basis ?? 'due_date';
  const graceDays = input.graceDays ?? 0;
  const method = input.method ?? 'simple_365';
  const scope = loadScope(db, { side: 'both', groupId: input.groupId, ledgerId: input.ledgerId });
  const rows: InterestBillRow[] = [];
  const skipped: InterestResult['skipped'] = [];

  const rated: Array<{ ledger: OsLedger; rate: number }> = [];
  for (const ledger of scope.ledgers) {
    const rate = input.ratePercent ?? ledger.interestRate;
    if (rate === null || rate <= 0) skipped.push({ ledgerId: ledger.id, ledgerName: ledger.name, reason: NO_RATE });
    else rated.push({ ledger, rate });
  }

  const q = { asOf: input.to, today };
  const lines = loadBillLines(
    db,
    rated.filter((r) => r.ledger.billWise).map((r) => r.ledger.id),
    q,
  );
  const booksFrom = booksFromDate(db);

  for (const { ledger, rate } of rated) {
    const candidates: Candidate[] = [];
    if (ledger.billWise) {
      for (const [name, list] of lines.get(ledger.id) ?? new Map<string, BillLine[]>()) {
        const bill = billFromAggregate(aggregateLines(name, list), ledger);
        candidates.push({ ...bill, events: list.map((l) => ({ date: l.date, amount: l.amount })) });
      }
    } else {
      for (const o of fifoSettle(fifoItemsOldestFirst(db, ledger, { ...q, booksFrom }))) {
        candidates.push({
          billName: o.item.label,
          billDate: o.item.date,
          dueDate: addDays(o.item.date, ledger.creditDays ?? 0),
          refType: 'fifo',
          original: o.original,
          events: o.events.map((e) => ({ date: e.date, amount: e.amount })),
        });
      }
    }

    for (const c of candidates) {
      if (c.refType === 'advance' || c.original === 0) continue;
      const originSign = c.original > 0 ? 1 : -1;
      const dir: 1 | -1 = ledger.kind === 'debtor' ? 1 : ledger.kind === 'creditor' ? -1 : originSign;
      if (originSign !== dir) continue; // a bill in the party's favour (e.g. a credit note on a customer)
      const basisDate = basis === 'due_date' ? (c.dueDate ?? c.billDate) : c.billDate;
      if (!basisDate) continue;
      const interestFrom = addDays(basisDate, graceDays);
      const r = billInterest(c.events, { dir, interestFrom, from: input.from, to: input.to, ratePercent: rate });
      if (r.days === 0) continue;
      rows.push({
        ledgerId: ledger.id,
        ledgerName: ledger.name,
        side: dir === 1 ? 'receivable' : 'payable',
        billName: c.billName,
        billDate: c.billDate,
        dueDate: c.dueDate,
        refType: c.refType,
        interestFrom,
        ratePercent: rate,
        principal: r.principal,
        pendingAtEnd: r.pendingAtEnd,
        days: r.days,
        interest: r.interest,
        segments: r.segments,
      });
    }
  }

  const totals = { receivable: 0, payable: 0, billCount: rows.length };
  for (const r of rows) {
    if (r.side === 'receivable') totals.receivable += r.interest;
    else totals.payable += r.interest;
  }
  return { from: input.from, to: input.to, basis, graceDays, method, rows, totals, skipped };
}
