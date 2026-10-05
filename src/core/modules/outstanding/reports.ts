/**
 * Side reports: bills receivable/payable, group (party) outstandings, ageing analysis and the
 * dashboard "due soon" list. All amounts are side-signed (positive = receivable / payable).
 */
import { addDays, diffDays } from '../../../shared/dates.ts';
import type {
  AgeingInput,
  AgeingPartyRow,
  AgeingResult,
  DueSoonInput,
  DueSoonResult,
  DueSoonRow,
  NonBillWiseMode,
  OutstandingBillRow,
  OutstandingBillSort,
  OutstandingBillsInput,
  OutstandingBillsResult,
  OutstandingSide,
  OutstandingTotals,
  PartyOutstandingRow,
  PartySummaryInput,
  PartySummaryResult,
} from '../../../shared/types/outstanding.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import type { Db } from '../../db/db.ts';
import { billAge, bucketIndex, makeBuckets } from './ageing.ts';
import {
  compareNames,
  keepOnSide,
  loadParties,
  loadScope,
  matchesSearch,
  overdueDays,
  partyFigures,
  sideSign,
  type OsBill,
  type OsParty,
} from './engine.ts';

export const ON_ACCOUNT_LABEL = 'On Account';

/** Parties of a side report (scope + balances + bills), with default-scope "other" ledgers filtered by side. */
export function sideParties(
  db: Db,
  today: string,
  q: { side: OutstandingSide; asOf: string; groupId?: number; ledgerId?: number; nonBillWise?: NonBillWiseMode },
): OsParty[] {
  const scope = loadScope(db, { side: q.side, groupId: q.groupId, ledgerId: q.ledgerId });
  const parties = loadParties(db, scope.ledgers, { asOf: q.asOf, today, nonBillWise: q.nonBillWise ?? 'on_account' });
  return keepOnSide(parties, scope, q.side);
}

/** Party has something to show: a balance or open bills. */
const hasOutstanding = (p: OsParty): boolean => p.balance !== 0 || p.bills.length > 0;

function billRow(p: OsParty, b: OsBill, sign: 1 | -1, asOf: string): OutstandingBillRow {
  return {
    ledgerId: p.ledger.id,
    ledgerName: p.ledger.name,
    groupId: p.ledger.groupId,
    groupName: p.ledger.groupName,
    billWise: p.ledger.billWise,
    billName: b.billName,
    billDate: b.billDate,
    dueDate: b.dueDate,
    creditDays: b.creditDays,
    originalAmount: b.original * sign,
    pendingAmount: b.pending * sign,
    overdueDays: overdueDays(b, asOf),
    refType: b.refType,
    voucherId: b.voucherId,
  };
}

function onAccountRow(p: OsParty, sign: 1 | -1): OutstandingBillRow {
  return {
    ledgerId: p.ledger.id,
    ledgerName: p.ledger.name,
    groupId: p.ledger.groupId,
    groupName: p.ledger.groupName,
    billWise: p.ledger.billWise,
    billName: ON_ACCOUNT_LABEL,
    billDate: null,
    dueDate: null,
    creditDays: null,
    originalAmount: p.onAccount * sign,
    pendingAmount: p.onAccount * sign,
    overdueDays: 0,
    refType: 'on_account',
    voucherId: null,
  };
}

export function emptyTotals(): OutstandingTotals {
  return { pending: 0, overdue: 0, notDue: 0, advance: 0, onAccount: 0, billCount: 0, overdueCount: 0 };
}

export function addToTotals(t: OutstandingTotals, r: Pick<OutstandingBillRow, 'refType' | 'pendingAmount' | 'overdueDays'>): void {
  t.pending += r.pendingAmount;
  if (r.refType === 'advance') t.advance += r.pendingAmount;
  else if (r.refType === 'on_account') t.onAccount += r.pendingAmount;
  else {
    t.billCount += 1;
    if (r.overdueDays > 0) {
      t.overdue += r.pendingAmount;
      t.overdueCount += 1;
    } else {
      t.notDue += r.pendingAmount;
    }
  }
}

const byName = compareNames;
const nullLast = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

function comparator(sort: OutstandingBillSort): (a: OutstandingBillRow, b: OutstandingBillRow) => number {
  const tie = (a: OutstandingBillRow, b: OutstandingBillRow): number =>
    byName(a.ledgerName, b.ledgerName) || nullLast(a.billDate, b.billDate) || byName(a.billName, b.billName);
  switch (sort) {
    case 'due_date':
      return (a, b) => nullLast(a.dueDate, b.dueDate) || tie(a, b);
    case 'party':
      return (a, b) => byName(a.ledgerName, b.ledgerName) || nullLast(a.billDate, b.billDate) || byName(a.billName, b.billName);
    case 'amount':
      return (a, b) => b.pendingAmount - a.pendingAmount || tie(a, b);
    case 'overdue':
      return (a, b) => b.overdueDays - a.overdueDays || b.pendingAmount - a.pendingAmount || tie(a, b);
    default:
      return (a, b) => nullLast(a.billDate, b.billDate) || tie(a, b);
  }
}

// ───────────────────────────── outstanding.bills ─────────────────────────────

export function outstandingBills(db: Db, today: string, input: OutstandingBillsInput): OutstandingBillsResult {
  const sign = sideSign(input.side);
  const parties = sideParties(db, today, input);
  const minOverdue = input.minOverdueDays ?? 0;
  const overdueFilter = input.overdueOnly || minOverdue > 0;
  const includeOnAccount = input.includeOnAccount ?? true;

  const rows: OutstandingBillRow[] = [];
  for (const p of parties) {
    const partyMatches = matchesSearch(input.search, p.ledger.name, p.ledger.alias);
    for (const b of p.bills) {
      const row = billRow(p, b, sign, input.asOf);
      if (overdueFilter && (row.overdueDays <= 0 || row.overdueDays < minOverdue)) continue;
      if (!partyMatches && !matchesSearch(input.search, b.billName)) continue;
      rows.push(row);
    }
    if (includeOnAccount && !overdueFilter && p.onAccount !== 0 && (partyMatches || matchesSearch(input.search, ON_ACCOUNT_LABEL))) {
      rows.push(onAccountRow(p, sign));
    }
  }
  const totals = emptyTotals();
  for (const r of rows) addToTotals(totals, r);
  rows.sort(comparator(input.sort ?? 'bill_date'));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 1000;
  return { side: input.side, asOf: input.asOf, rows: rows.slice(offset, offset + limit), total: rows.length, totals };
}

// ───────────────────────────── outstanding.partySummary ─────────────────────────────

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function partySummary(db: Db, today: string, input: PartySummaryInput): PartySummaryResult {
  const sign = sideSign(input.side);
  const parties = sideParties(db, today, input);
  const rows: PartyOutstandingRow[] = [];
  const totals: PartySummaryResult['totals'] = {
    pending: 0,
    billsPending: 0,
    overdue: 0,
    notDue: 0,
    advance: 0,
    onAccount: 0,
    partyCount: 0,
    overLimitCount: 0,
  };
  for (const p of parties) {
    if (!input.includeZero && !hasOutstanding(p)) continue;
    if (!matchesSearch(input.search, p.ledger.name, p.ledger.alias)) continue;
    const f = partyFigures(p, input.asOf, sign);
    const limit = p.ledger.creditLimit;
    const row: PartyOutstandingRow = {
      ledgerId: p.ledger.id,
      ledgerName: p.ledger.name,
      groupId: p.ledger.groupId,
      groupName: p.ledger.groupName,
      billWise: p.ledger.billWise,
      pending: f.pending,
      billsPending: f.billsPending,
      overdue: f.overdue,
      notDue: f.notDue,
      advance: f.advance,
      onAccount: f.onAccount,
      billCount: f.billCount,
      overdueBillCount: f.overdueBillCount,
      oldestDueDays: f.oldestDueDays,
      creditLimit: limit,
      creditDays: p.ledger.creditDays,
      utilisationPercent: limit ? round2((f.pending / limit) * 100) : null,
      overLimit: limit !== null && f.pending > limit,
      mobile: p.ledger.mobile ?? p.ledger.phone,
      email: p.ledger.email,
    };
    rows.push(row);
    totals.pending += f.pending;
    totals.billsPending += f.billsPending;
    totals.overdue += f.overdue;
    totals.notDue += f.notDue;
    totals.advance += f.advance;
    totals.onAccount += f.onAccount;
    totals.partyCount += 1;
    if (row.overLimit) totals.overLimitCount += 1;
  }
  return { side: input.side, asOf: input.asOf, rows, totals };
}

// ───────────────────────────── outstanding.ageing ─────────────────────────────

export function ageing(db: Db, today: string, input: AgeingInput): AgeingResult {
  const sign = sideSign(input.side);
  const basis = input.basis ?? 'due_date';
  const buckets = makeBuckets(input.buckets ?? DEFAULT_AGEING_BUCKETS, basis);
  const parties = sideParties(db, today, input);
  const rows: AgeingPartyRow[] = [];
  const totals = { amounts: buckets.map(() => 0), advance: 0, onAccount: 0, total: 0 };
  for (const p of parties) {
    if (!hasOutstanding(p)) continue;
    if (!matchesSearch(input.search, p.ledger.name, p.ledger.alias)) continue;
    const row: AgeingPartyRow = {
      ledgerId: p.ledger.id,
      ledgerName: p.ledger.name,
      groupId: p.ledger.groupId,
      groupName: p.ledger.groupName,
      billWise: p.ledger.billWise,
      amounts: buckets.map(() => 0),
      advance: 0,
      onAccount: p.onAccount * sign,
      total: p.balance * sign,
    };
    for (const b of p.bills) {
      const amt = b.pending * sign;
      const age = billAge(b, input.asOf, basis);
      if (age === null) {
        if (b.refType === 'advance') row.advance += amt;
        else row.onAccount += amt;
        continue;
      }
      row.amounts[bucketIndex(age, buckets)] += amt;
    }
    rows.push(row);
    row.amounts.forEach((a, i) => (totals.amounts[i] += a));
    totals.advance += row.advance;
    totals.onAccount += row.onAccount;
    totals.total += row.total;
  }
  return { side: input.side, asOf: input.asOf, basis, buckets, rows, totals };
}

// ───────────────────────────── outstanding.dueSoon ─────────────────────────────

export function dueSoon(db: Db, today: string, input: DueSoonInput): DueSoonResult {
  const sign = sideSign(input.side);
  const until = addDays(input.asOf, input.days);
  const parties = sideParties(db, today, input);
  const matches: DueSoonRow[] = [];
  const overdue = { amount: 0, count: 0 };
  let amount = 0;
  for (const p of parties) {
    for (const b of p.bills) {
      if (b.refType === 'advance' || !b.dueDate) continue;
      const row = billRow(p, b, sign, input.asOf);
      if (row.overdueDays > 0) {
        overdue.amount += row.pendingAmount;
        overdue.count += 1;
        continue;
      }
      if (row.pendingAmount <= 0 || b.dueDate < input.asOf || b.dueDate > until) continue;
      matches.push({ ...row, daysToDue: diffDays(input.asOf, b.dueDate) });
      amount += row.pendingAmount;
    }
  }
  matches.sort((a, b) => nullLast(a.dueDate, b.dueDate) || byName(a.ledgerName, b.ledgerName) || byName(a.billName, b.billName));
  const limit = input.limit ?? 50;
  return { side: input.side, asOf: input.asOf, days: input.days, until, rows: matches.slice(0, limit), total: matches.length, amount, overdue };
}
