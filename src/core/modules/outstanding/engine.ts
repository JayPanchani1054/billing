/**
 * Outstanding engine: which ledgers a report covers (scope), and for each of them the pending bills,
 * the unallocated ("On Account") remainder and the closing balance as of a date.
 *
 *   bill pending = opening_bills.amount + Σ bill_allocations.amount   per (ledger_id, bill_name)
 *   on account   = closing balance − Σ bill pending                    per ledger
 *
 * so Σ bills + on account always equals the ledger's closing balance (books filter, as of `asOf`).
 * Amounts here are LEDGER-SIGNED (Dr +, Cr −); report services convert to side-signed amounts.
 * See README.md in this folder for the full semantics.
 */
import { addDays, diffDays, formatDate } from '../../../shared/dates.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { NonBillWiseMode, OutstandingRefType, OutstandingSide } from '../../../shared/types/outstanding.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';
import { BOOKS_FILTER, closingBalances, loadGroupTree, type GroupTree } from '../accounts/books.ts';
import { getFeatures } from '../company/service.ts';

// ───────────────────────────── Ledgers in scope ─────────────────────────────

export type PartyKind = 'debtor' | 'creditor' | 'other';

export interface OsLedger {
  id: number;
  name: string;
  alias: string | null;
  groupId: number;
  groupName: string;
  kind: PartyKind;
  /** maintain_bill_wise on the ledger AND the company's bill-wise feature on. */
  billWise: boolean;
  creditDays: number | null;
  /** Paise; null when not set (0 counts as not set). */
  creditLimit: number | null;
  /** % p.a. when interest is enabled on the ledger and a positive rate is set. */
  interestRate: number | null;
  openingBalance: number;
  mobile: string | null;
  phone: string | null;
  email: string | null;
}

interface LedgerDbRow {
  id: number;
  name: string;
  alias: string | null;
  group_id: number;
  maintain_bill_wise: number;
  default_credit_days: number | null;
  credit_limit: number | null;
  interest_enabled: number;
  interest_rate: number | null;
  opening_balance: number;
  mobile: string | null;
  phone: string | null;
  email: string | null;
}

export interface ScopeQuery {
  /** receivable → Sundry Debtors (+ bill-wise "other" ledgers with a Dr balance); payable mirror; both → debtors + creditors. */
  side: OutstandingSide | 'both';
  groupId?: number;
  ledgerId?: number;
}

export interface Scope {
  ledgers: OsLedger[];
  /**
   * Ledgers outside Sundry Debtors/Creditors that are in the default scope only when their balance is
   * on the report's side (Dr for receivable, Cr for payable). Empty when groupId/ledgerId is given.
   */
  conditional: Set<number>;
  tree: GroupTree;
}

const LEDGER_COLUMNS = `id, name, alias, group_id, maintain_bill_wise, default_credit_days, credit_limit, interest_enabled,
  interest_rate, opening_balance, mobile, phone, email`;

function toOsLedger(r: LedgerDbRow, tree: GroupTree, billWiseFeature: boolean): OsLedger {
  const g = tree.byId.get(r.group_id);
  const kind: PartyKind = g?.cls.isDebtor ? 'debtor' : g?.cls.isCreditor ? 'creditor' : 'other';
  return {
    id: r.id,
    name: r.name,
    alias: r.alias,
    groupId: r.group_id,
    groupName: g?.name ?? '',
    kind,
    billWise: billWiseFeature && r.maintain_bill_wise === 1,
    creditDays: r.default_credit_days ?? null,
    creditLimit: r.credit_limit !== null && r.credit_limit > 0 ? r.credit_limit : null,
    interestRate: r.interest_enabled === 1 && r.interest_rate !== null && r.interest_rate > 0 ? r.interest_rate : null,
    openingBalance: r.opening_balance,
    mobile: r.mobile,
    phone: r.phone,
    email: r.email,
  };
}

/** One ledger as an OsLedger (NOT_FOUND when missing). */
export function loadLedger(db: Db, ledgerId: number, tree: GroupTree = loadGroupTree(db)): OsLedger {
  const r = db.get<LedgerDbRow>(`SELECT ${LEDGER_COLUMNS} FROM ledgers WHERE id = :id`, { id: ledgerId });
  if (!r) throw notFound('Ledger', ledgerId);
  return toOsLedger(r, tree, getFeatures(db).billWise);
}

/** Ledgers a report covers. Throws NOT_FOUND for an unknown group or ledger. */
export function loadScope(db: Db, q: ScopeQuery): Scope {
  const tree = loadGroupTree(db);
  const billWiseFeature = getFeatures(db).billWise;
  const conditional = new Set<number>();
  if (q.groupId !== undefined && !tree.byId.has(q.groupId)) throw notFound('Group', q.groupId);

  if (q.ledgerId !== undefined) {
    const one = loadLedger(db, q.ledgerId, tree);
    const inGroup = q.groupId === undefined || (tree.byId.get(one.groupId)?.chainIds.includes(q.groupId) ?? false);
    return { ledgers: inGroup ? [one] : [], conditional, tree };
  }

  const rows = db.all<LedgerDbRow>(`SELECT ${LEDGER_COLUMNS} FROM ledgers ORDER BY name COLLATE NOCASE, id`);
  const ledgers: OsLedger[] = [];
  for (const r of rows) {
    const chain = tree.byId.get(r.group_id)?.chainIds ?? [];
    if (q.groupId !== undefined) {
      if (chain.includes(q.groupId)) ledgers.push(toOsLedger(r, tree, billWiseFeature));
      continue;
    }
    const l = toOsLedger(r, tree, billWiseFeature);
    if (q.side === 'both') {
      if (l.kind !== 'other') ledgers.push(l);
    } else if ((q.side === 'receivable' && l.kind === 'debtor') || (q.side === 'payable' && l.kind === 'creditor')) {
      ledgers.push(l);
    } else if (l.kind === 'other' && l.billWise) {
      ledgers.push(l);
      conditional.add(l.id);
    }
  }
  return { ledgers, conditional, tree };
}

// ───────────────────────────── Bills ─────────────────────────────

export interface OsBill {
  billName: string;
  refType: OutstandingRefType;
  billDate: string | null;
  dueDate: string | null;
  creditDays: number | null;
  /** Signed amount of the originating reference(s) (new / advance / opening; fifo: the voucher's amount). */
  original: number;
  /** Signed pending amount. */
  pending: number;
  voucherId: number | null;
}

/** Aggregate of one (ledger, bill name): opening bill + allocations. */
export interface BillAggregate {
  billName: string;
  /** Earliest date of an originating reference (opening / new / advance). */
  originDate: string | null;
  /** Earliest date of any line. */
  firstDate: string;
  /** Earliest stored due date of an originating reference. */
  dueDate: string | null;
  /** Credit days of the originating 'new'/'advance' allocation. */
  creditDays: number | null;
  pending: number;
  original: number;
  hasOpening: boolean;
  hasNew: boolean;
  hasAdvance: boolean;
  voucherId: number | null;
}

/** Allocations that belong to a named bill (everything else is "on account"). */
export const NAMED_BILL_SQL = (a: string): string =>
  `${a}.ref_type <> 'on_account' AND ${a}.bill_name IS NOT NULL AND TRIM(${a}.bill_name) <> ''`;

/** Turn a bill aggregate into a bill: reference type, bill date, due date (stored or bill date + credit days). */
export function billFromAggregate(a: BillAggregate, ledger: Pick<OsLedger, 'creditDays'>): OsBill {
  const refType: OutstandingRefType = a.hasOpening ? 'opening' : a.hasNew ? 'new' : a.hasAdvance ? 'advance' : 'against';
  const billDate = a.originDate ?? a.firstDate;
  let dueDate: string | null = null;
  let creditDays: number | null = null;
  if (refType !== 'advance') {
    if (a.dueDate) {
      dueDate = a.dueDate;
      creditDays = a.creditDays ?? diffDays(billDate, a.dueDate);
    } else {
      creditDays = a.creditDays ?? ledger.creditDays;
      dueDate = addDays(billDate, creditDays ?? 0);
    }
  }
  return {
    billName: a.billName,
    refType,
    billDate,
    dueDate,
    creditDays,
    original: a.original,
    pending: a.pending,
    voucherId: refType === 'opening' ? null : a.voucherId,
  };
}

/** Days past the due date on `asOf` (0 when not yet due; always 0 for advances and On Account). */
export function overdueDays(b: Pick<OsBill, 'refType' | 'dueDate'>, asOf: string): number {
  if (b.refType === 'advance' || b.refType === 'on_account' || !b.dueDate) return 0;
  return Math.max(0, diffDays(b.dueDate, asOf));
}

interface AggregateRow {
  ledger_id: number;
  bill_name: string;
  origin_date: string | null;
  first_date: string;
  due_date: string | null;
  credit_days: number | null;
  pending: number;
  original: number;
  has_opening: number;
  has_new: number;
  has_advance: number;
  voucher_id: number | null;
}

const ORIGIN = `('opening', 'new', 'advance')`;

/**
 * Bill aggregates for many ledgers in one query. `includeSettled` keeps bills whose pending is 0.
 * Opening bills always count (they are as at books beginning); allocations count when in the books
 * (BOOKS_FILTER with :today) and dated on or before `asOf`.
 */
export function loadBillAggregates(
  db: Db,
  ledgerIds: readonly number[],
  q: { asOf: string; today: string; includeSettled?: boolean },
): Map<number, BillAggregate[]> {
  const out = new Map<number, BillAggregate[]>();
  if (ledgerIds.length === 0) return out;
  const rows = db.all<AggregateRow>(
    `SELECT ledger_id, bill_name,
            MIN(CASE WHEN src IN ${ORIGIN} THEN bdate END) AS origin_date,
            MIN(bdate) AS first_date,
            MIN(CASE WHEN src IN ${ORIGIN} THEN due_date END) AS due_date,
            MIN(CASE WHEN src IN ('new', 'advance') THEN credit_days END) AS credit_days,
            SUM(amount) AS pending,
            SUM(CASE WHEN src IN ${ORIGIN} THEN amount ELSE 0 END) AS original,
            MAX(CASE WHEN src = 'opening' THEN 1 ELSE 0 END) AS has_opening,
            MAX(CASE WHEN src = 'new' THEN 1 ELSE 0 END) AS has_new,
            MAX(CASE WHEN src = 'advance' THEN 1 ELSE 0 END) AS has_advance,
            MIN(CASE WHEN src IN ('new', 'advance') THEN voucher_id END) AS voucher_id
       FROM (
             SELECT ob.ledger_id AS ledger_id, ob.bill_name AS bill_name, ob.bill_date AS bdate, ob.due_date AS due_date,
                    NULL AS credit_days, ob.amount AS amount, 'opening' AS src, NULL AS voucher_id
               FROM opening_bills ob
              WHERE ob.ledger_id IN (SELECT value FROM json_each(:ids))
             UNION ALL
             SELECT ba.ledger_id, ba.bill_name, ba.date, ba.due_date, ba.credit_days, ba.amount, ba.ref_type, ba.voucher_id
               FROM bill_allocations ba
              WHERE ba.ledger_id IN (SELECT value FROM json_each(:ids))
                AND ba.date <= :asOf
                AND ${BOOKS_FILTER('ba')}
                AND ${NAMED_BILL_SQL('ba')}
            )
      GROUP BY ledger_id, bill_name
      ${q.includeSettled ? '' : 'HAVING SUM(amount) <> 0'}`,
    { ids: JSON.stringify(ledgerIds), asOf: q.asOf, today: q.today },
  );
  for (const r of rows) {
    const agg: BillAggregate = {
      billName: r.bill_name,
      originDate: r.origin_date,
      firstDate: r.first_date,
      dueDate: r.due_date,
      creditDays: r.credit_days,
      pending: r.pending,
      original: r.original,
      hasOpening: r.has_opening === 1,
      hasNew: r.has_new === 1,
      hasAdvance: r.has_advance === 1,
      voucherId: r.voucher_id,
    };
    const list = out.get(r.ledger_id);
    if (list) list.push(agg);
    else out.set(r.ledger_id, [agg]);
  }
  return out;
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Natural, case-insensitive name order ('INV-2' before 'INV-10'). Shared collator: localeCompare with options is slow. */
export const compareNames = (a: string, b: string): number => COLLATOR.compare(a, b);

/** Bills sort: by bill date (null last), then name. */
export function compareBills(a: Pick<OsBill, 'billDate' | 'billName'>, b: Pick<OsBill, 'billDate' | 'billName'>): number {
  const da = a.billDate ?? '9999-12-31';
  const dbb = b.billDate ?? '9999-12-31';
  if (da !== dbb) return da < dbb ? -1 : 1;
  return compareNames(a.billName, b.billName);
}

// ───────────────────────────── FIFO (non-bill-wise ledgers) ─────────────────────────────

export interface FifoItem {
  date: string;
  /** Signed amount (Dr +, Cr −). */
  amount: number;
  voucherId: number | null;
  /** Voucher number, else '<type> <date>', or 'Opening Balance'. */
  label: string;
  voucherNumber?: string | null;
  voucherType?: string | null;
  baseType?: VoucherBaseType | null;
}

export interface FifoSlice extends FifoItem {
  /** Part of the balance this item explains, signed like the balance. */
  take: number;
}

/**
 * First-in-first-out ageing of a balance: the balance is made up of the most recent items on its side
 * (debits for a Dr balance, credits for a Cr balance), newest first, the oldest one possibly partly.
 * `items` must be newest first. Σ take = balance (the same-side items always cover it, because
 * Σ same-side − Σ other-side = |balance|).
 */
export function fifoSlices(balance: number, items: readonly FifoItem[]): FifoSlice[] {
  const out: FifoSlice[] = [];
  if (balance === 0) return out;
  const sign = balance > 0 ? 1 : -1;
  let remaining = Math.abs(balance);
  for (const it of items) {
    if (remaining <= 0) break;
    if (Math.sign(it.amount) !== sign) continue;
    const take = Math.min(Math.abs(it.amount), remaining);
    out.push({ ...it, take: sign * take });
    remaining -= take;
  }
  // Defensive: items that do not explain the balance (should not happen) leave an undated remainder.
  if (remaining > 0) out.push({ date: '', amount: sign * remaining, voucherId: null, label: 'Unexplained balance', take: sign * remaining });
  return out;
}

interface EntryRow {
  ledger_id: number;
  voucher_id: number;
  date: string;
  amount: number;
  number: string | null;
  type_name: string;
  base_type: VoucherBaseType;
}

/** Per-voucher net entries of the ledgers, newest first (books filter, ≤ asOf). */
function loadEntriesNewestFirst(db: Db, ledgerIds: readonly number[], q: { asOf: string; today: string }): Map<number, FifoItem[]> {
  const out = new Map<number, FifoItem[]>();
  if (ledgerIds.length === 0) return out;
  const rows = db.all<EntryRow>(
    `SELECT le.ledger_id, le.voucher_id, le.date, SUM(le.amount) AS amount, v.number, vt.name AS type_name, v.base_type
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE le.ledger_id IN (SELECT value FROM json_each(:ids))
        AND le.date <= :asOf
        AND ${BOOKS_FILTER('le')}
      GROUP BY le.ledger_id, le.voucher_id
      ORDER BY le.ledger_id, le.date DESC, le.voucher_id DESC`,
    { ids: JSON.stringify(ledgerIds), asOf: q.asOf, today: q.today },
  );
  for (const r of rows) {
    if (r.amount === 0) continue;
    const label = r.number ? r.number : `${r.type_name} ${formatDate(r.date)}`;
    const item: FifoItem = {
      date: r.date,
      amount: r.amount,
      voucherId: r.voucher_id,
      label,
      voucherNumber: r.number,
      voucherType: r.type_name,
      baseType: r.base_type,
    };
    const list = out.get(r.ledger_id);
    if (list) list.push(item);
    else out.set(r.ledger_id, [item]);
  }
  return out;
}

/** FIFO slices of a ledger as pseudo-bills (refType 'fifo'; due date = date + credit days). */
export function fifoBills(ledger: OsLedger, balance: number, entriesNewestFirst: readonly FifoItem[], booksFrom: string): OsBill[] {
  const items: FifoItem[] = [...entriesNewestFirst];
  if (ledger.openingBalance !== 0) items.push({ date: booksFrom, amount: ledger.openingBalance, voucherId: null, label: 'Opening Balance' });
  return fifoSlices(balance, items).map((s) => ({
    billName: s.label,
    refType: 'fifo' as const,
    billDate: s.date || null,
    dueDate: s.date ? addDays(s.date, ledger.creditDays ?? 0) : null,
    creditDays: ledger.creditDays,
    original: s.amount,
    pending: s.take,
    voucherId: s.voucherId,
  }));
}

// ───────────────────────────── Parties ─────────────────────────────

export type BreakdownMethod = 'bill_wise' | 'fifo' | 'on_account';

export interface OsParty {
  ledger: OsLedger;
  /** Closing balance as of asOf (signed). */
  balance: number;
  /** Pending bills (incl. advances and fifo slices), signed, oldest first. */
  bills: OsBill[];
  /** balance − Σ bills.pending (signed). */
  onAccount: number;
  method: BreakdownMethod;
}

export interface PartyQuery {
  asOf: string;
  today: string;
  nonBillWise: NonBillWiseMode;
  /** Bill-wise ledgers: also keep settled bills (pending 0). */
  includeSettled?: boolean;
}

export function booksFromDate(db: Db): string {
  return db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? '0000-01-01';
}

/** Balances, pending bills and on-account remainders for the ledgers (three queries in total). */
export function loadParties(db: Db, ledgers: readonly OsLedger[], q: PartyQuery): OsParty[] {
  if (ledgers.length === 0) return [];
  const ids = ledgers.map((l) => l.id);
  const balances = closingBalances(db, { asOf: q.asOf, today: q.today, ledgerIds: ids });
  const billWiseIds = ledgers.filter((l) => l.billWise).map((l) => l.id);
  const aggregates = loadBillAggregates(db, billWiseIds, q);
  const fifoIds = q.nonBillWise === 'fifo' ? ledgers.filter((l) => !l.billWise && (balances.get(l.id) ?? 0) !== 0).map((l) => l.id) : [];
  const entries = loadEntriesNewestFirst(db, fifoIds, q);
  const booksFrom = fifoIds.length > 0 ? booksFromDate(db) : '';

  return ledgers.map((ledger) => {
    const balance = balances.get(ledger.id) ?? ledger.openingBalance;
    let bills: OsBill[] = [];
    let method: BreakdownMethod;
    if (ledger.billWise) {
      method = 'bill_wise';
      bills = (aggregates.get(ledger.id) ?? []).map((a) => billFromAggregate(a, ledger));
      bills.sort(compareBills);
    } else if (q.nonBillWise === 'fifo') {
      method = 'fifo';
      // Oldest slice first, like bills.
      bills = fifoBills(ledger, balance, entries.get(ledger.id) ?? [], booksFrom).reverse();
    } else {
      method = 'on_account';
    }
    let billed = 0;
    for (const b of bills) billed += b.pending;
    return { ledger, balance, bills, onAccount: balance - billed, method };
  });
}

/** Default-scope "other" ledgers are kept only when their balance is on the report's side. */
export function keepOnSide(parties: readonly OsParty[], scope: Scope, side: OutstandingSide): OsParty[] {
  if (scope.conditional.size === 0) return [...parties];
  const sign = sideSign(side);
  return parties.filter((p) => !scope.conditional.has(p.ledger.id) || p.balance * sign > 0);
}

export function sideSign(side: OutstandingSide): 1 | -1 {
  return side === 'receivable' ? 1 : -1;
}

/** Side a single ledger belongs to: debtors receivable, creditors payable, others by balance sign. */
export function ledgerSide(ledger: Pick<OsLedger, 'kind'>, balance: number): OutstandingSide | null {
  if (ledger.kind === 'debtor') return 'receivable';
  if (ledger.kind === 'creditor') return 'payable';
  return balance > 0 ? 'receivable' : balance < 0 ? 'payable' : null;
}

// ───────────────────────────── Party figures ─────────────────────────────

export interface PartyFigures {
  /** All side-signed. pending = billsPending + advance + onAccount. */
  pending: number;
  billsPending: number;
  overdue: number;
  notDue: number;
  advance: number;
  onAccount: number;
  billCount: number;
  overdueBillCount: number;
  oldestDueDays: number;
}

export function partyFigures(p: OsParty, asOf: string, sign: 1 | -1): PartyFigures {
  const f: PartyFigures = {
    pending: p.balance * sign,
    billsPending: 0,
    overdue: 0,
    notDue: 0,
    advance: 0,
    onAccount: p.onAccount * sign,
    billCount: 0,
    overdueBillCount: 0,
    oldestDueDays: 0,
  };
  for (const b of p.bills) {
    const amt = b.pending * sign;
    if (b.refType === 'advance') {
      f.advance += amt;
      continue;
    }
    f.billsPending += amt;
    f.billCount += 1;
    const od = overdueDays(b, asOf);
    if (od > 0) {
      f.overdue += amt;
      f.overdueBillCount += 1;
      if (od > f.oldestDueDays) f.oldestDueDays = od;
    } else {
      f.notDue += amt;
    }
  }
  return f;
}

/** Case-insensitive "contains" on party name/alias (and optional extra text such as a bill name). */
export function matchesSearch(term: string | undefined, ...texts: Array<string | null | undefined>): boolean {
  if (!term) return true;
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return texts.some((s) => s !== null && s !== undefined && s.toLowerCase().includes(t));
}

// ───────────────────────────── FIFO settlement (histories) ─────────────────────────────

export interface FifoOpenItem {
  item: FifoItem;
  /** Signed amount that started this item (the part not used to settle older opposite items). */
  original: number;
  /** Signed amount still open after all items. */
  open: number;
  /** Origin + each settlement applied to it, in date order (signed). */
  /** Origin first, then the opposite items applied to it. */
  events: Array<{ date: string; amount: number; item: FifoItem }>;
}

/**
 * Replays items oldest first, each new item settling the oldest open items of the opposite sign
 * (first in, first out). Returns every item that opened a balance, with its settlement history.
 * The items still open at the end are exactly the newest same-side items that fifoSlices() returns.
 */
export function fifoSettle(itemsOldestFirst: readonly FifoItem[]): FifoOpenItem[] {
  const all: FifoOpenItem[] = [];
  const queue: FifoOpenItem[] = [];
  for (const it of itemsOldestFirst) {
    let rest = it.amount;
    while (rest !== 0 && queue.length > 0 && Math.sign(queue[0].open) === -Math.sign(rest)) {
      const head = queue[0];
      const take = Math.min(Math.abs(head.open), Math.abs(rest));
      const delta = Math.sign(rest) * take;
      head.open += delta;
      head.events.push({ date: it.date, amount: delta, item: it });
      rest -= delta;
      if (head.open === 0) queue.shift();
    }
    if (rest !== 0) {
      const o: FifoOpenItem = { item: it, original: rest, open: rest, events: [{ date: it.date, amount: rest, item: it }] };
      all.push(o);
      queue.push(o);
    }
  }
  return all;
}

/** Ledger items oldest first for FIFO: opening balance (dated books beginning) + per-voucher net entries. */
export function fifoItemsOldestFirst(
  db: Db,
  ledger: Pick<OsLedger, 'id' | 'openingBalance'>,
  q: { asOf: string; today: string; booksFrom: string },
): FifoItem[] {
  const newest = loadEntriesNewestFirst(db, [ledger.id], q).get(ledger.id) ?? [];
  const items = [...newest].reverse();
  if (ledger.openingBalance !== 0) items.unshift({ date: q.booksFrom, amount: ledger.openingBalance, voucherId: null, label: 'Opening Balance' });
  return items;
}

// ───────────────────────────── Bill lines (histories) ─────────────────────────────

export interface BillLine {
  billName: string;
  kind: 'opening' | 'new' | 'against' | 'advance';
  date: string;
  dueDate: string | null;
  creditDays: number | null;
  /** Signed. */
  amount: number;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  baseType: VoucherBaseType | null;
  narration: string | null;
}

interface BillLineRow {
  ledger_id: number;
  bill_name: string;
  kind: BillLine['kind'];
  date: string;
  due_date: string | null;
  credit_days: number | null;
  amount: number;
  voucher_id: number | null;
  number: string | null;
  type_name: string | null;
  base_type: VoucherBaseType | null;
  narration: string | null;
}

/**
 * Every line of every named bill of the ledgers (opening bills + allocations in the books dated ≤ asOf),
 * grouped by ledger then bill name, each list in date order (opening first).
 */
export function loadBillLines(db: Db, ledgerIds: readonly number[], q: { asOf: string; today: string }): Map<number, Map<string, BillLine[]>> {
  const out = new Map<number, Map<string, BillLine[]>>();
  if (ledgerIds.length === 0) return out;
  const rows = db.all<BillLineRow>(
    `SELECT * FROM (
       SELECT ob.ledger_id AS ledger_id, ob.bill_name AS bill_name, 'opening' AS kind, ob.bill_date AS date, ob.due_date AS due_date,
              NULL AS credit_days, ob.amount AS amount, NULL AS voucher_id, NULL AS number, NULL AS type_name, NULL AS base_type,
              NULL AS narration, 0 AS ord, ob.id AS row_id
         FROM opening_bills ob
        WHERE ob.ledger_id IN (SELECT value FROM json_each(:ids))
       UNION ALL
       SELECT ba.ledger_id, ba.bill_name, ba.ref_type, ba.date, ba.due_date, ba.credit_days, ba.amount, ba.voucher_id,
              v.number, vt.name, v.base_type, v.narration, 1, ba.id
         FROM bill_allocations ba
         JOIN vouchers v ON v.id = ba.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE ba.ledger_id IN (SELECT value FROM json_each(:ids))
          AND ba.date <= :asOf
          AND ${BOOKS_FILTER('ba')}
          AND ${NAMED_BILL_SQL('ba')}
     )
     ORDER BY ledger_id, bill_name, ord, date, voucher_id, row_id`,
    { ids: JSON.stringify(ledgerIds), asOf: q.asOf, today: q.today },
  );
  for (const r of rows) {
    let bills = out.get(r.ledger_id);
    if (!bills) {
      bills = new Map();
      out.set(r.ledger_id, bills);
    }
    const line: BillLine = {
      billName: r.bill_name,
      kind: r.kind,
      date: r.date,
      dueDate: r.due_date,
      creditDays: r.credit_days,
      amount: r.amount,
      voucherId: r.voucher_id,
      voucherNumber: r.number,
      voucherType: r.type_name,
      baseType: r.base_type,
      narration: r.narration,
    };
    const list = bills.get(r.bill_name);
    if (list) list.push(line);
    else bills.set(r.bill_name, [line]);
  }
  return out;
}

const isOrigin = (k: BillLine['kind']): boolean => k === 'opening' || k === 'new' || k === 'advance';
const minStr = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a <= b ? a : b);

/** JS mirror of the SQL aggregate in loadBillAggregates (same rules, from the lines). */
export function aggregateLines(billName: string, lines: readonly BillLine[]): BillAggregate {
  const a: BillAggregate = {
    billName,
    originDate: null,
    firstDate: lines[0]?.date ?? '',
    dueDate: null,
    creditDays: null,
    pending: 0,
    original: 0,
    hasOpening: false,
    hasNew: false,
    hasAdvance: false,
    voucherId: null,
  };
  for (const l of lines) {
    a.pending += l.amount;
    if (l.date < a.firstDate) a.firstDate = l.date;
    if (!isOrigin(l.kind)) continue;
    a.original += l.amount;
    a.originDate = minStr(a.originDate, l.date);
    a.dueDate = minStr(a.dueDate, l.dueDate);
    if (l.kind === 'opening') a.hasOpening = true;
    else {
      if (l.kind === 'new') a.hasNew = true;
      else a.hasAdvance = true;
      if (l.creditDays !== null) a.creditDays = a.creditDays === null ? l.creditDays : Math.min(a.creditDays, l.creditDays);
      if (l.voucherId !== null) a.voucherId = a.voucherId === null ? l.voucherId : Math.min(a.voucherId, l.voucherId);
    }
  }
  return a;
}
