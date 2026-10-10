/**
 * TDS/TCS reports, all read from tds_lines / tds_challans (books filter: affects_books = 1 AND
 * (is_post_dated = 0 OR date <= today)):
 *
 *   computation   per party + nature: credited, below threshold, tax base, deducted, deposited, balance
 *   lines         the voucher lines behind any figure (drill-down)
 *   outstanding   per section + month: deducted, deposited, balance, due date (7th / 30-Apr for March),
 *                 interest u/s 201(1A)(ii) / 206C(7); quarterly statements with late fee u/s 234E
 *   challans      challan register with the amount each challan clears
 *   returnData    26Q / 27Q / 27EQ deductee + challan rows of a quarter
 *   exceptions    no / invalid PAN, deducted below threshold, threshold crossed but not deducted, …
 *
 * Clearing: a challan pays the deductions of its kind + section + month (the "bill" is the month),
 * oldest first (FIFO) — so alters and deletions of vouchers never leave stale links.
 */
import { formatDate, formatMonth } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import {
  depositDueDate,
  lateDepositInterest,
  lateFee234E,
  nonDeductionInterest,
  periodDueDate,
  quarterOf,
  quarterRange,
  statementDueDate,
  taxOn,
  taxYearOf,
  type Quarter,
  type TdsForm,
} from '../../../shared/tds/rules.ts';
import type {
  DeducteeType,
  TdsChallanRegister,
  TdsChallanRow,
  TdsComputationResult,
  TdsComputationRow,
  TdsExceptionRow,
  TdsLineRow,
  TdsOutstandingResult,
  TdsOutstandingRow,
  TdsReturnChallanRow,
  TdsReturnData,
  TdsReturnDeducteeRow,
  TdsStatementRow,
  TdsKind,
} from '../../../shared/types/tds.ts';
import type { Db } from '../../db/db.ts';
import { rateFor } from './engine.ts';
import { getTdsSettings, payableLedgerName, rateFromRow, TdsStore } from './store.ts';

const inr = (p: Paise): string => formatMoney(p, { symbol: true });

// ───────────────────────────── Loading + FIFO clearing ─────────────────────────────

/** What clearing, statements and the outstanding report need of a line. */
interface TaxLine {
  id: number;
  date: string;
  kind: TdsKind;
  section: string;
  amount: Paise;
  status: string;
  nonResident: boolean;
  forNonResidents: boolean;
  voucherId?: number;
  /** Debit / credit note reversal (negative) or gross-bill journal: the bill (tds_lines.bill_voucher_id). */
  billVoucherId?: number | null;
}

/**
 * A reversal on a debit / credit note (negative line carrying its bill) nets into the deduction on that
 * bill (same section), never below zero, and is then dropped: the bill's tax to deposit / report is the
 * net. A reversal whose bill is not among `lines` (e.g. reported in an earlier quarter) is dropped.
 */
export function netReversals<T extends TaxLine & { base?: Paise; assessable?: Paise }>(lines: readonly T[]): T[] {
  const out = lines.map((l) => ({ ...l }));
  const reversals = out.filter((l) => l.amount < 0 && l.billVoucherId !== undefined && l.billVoucherId !== null);
  if (reversals.length === 0) return out;
  for (const r of reversals) {
    let tax = -r.amount;
    let base = r.base !== undefined ? -r.base : 0;
    for (const l of out) {
      if (tax <= 0) break;
      if (l.amount <= 0 || l.voucherId !== r.billVoucherId || l.section !== r.section || l.kind !== r.kind) continue;
      const take = Math.min(tax, l.amount);
      l.amount -= take;
      tax -= take;
      if (l.base !== undefined && base > 0) {
        const b = Math.min(base, l.base);
        l.base -= b;
        if (l.assessable !== undefined) l.assessable = Math.max(0, l.assessable - b);
        base -= b;
      }
    }
  }
  return out.filter((l) => !(l.amount < 0 && l.billVoucherId !== undefined && l.billVoucherId !== null));
}

interface LineRec extends TaxLine {
  id: number;
  voucherId: number;
  number: string | null;
  typeName: string;
  baseType: string;
  date: string;
  kind: TdsKind;
  natureId: number;
  natureName: string;
  section: string;
  forNonResidents: boolean;
  partyLedgerId: number | null;
  partyName: string | null;
  deducteeType: string;
  pan: string | null;
  panStatus: string;
  nonResident: boolean;
  assessable: Paise;
  catchUp: Paise;
  advanceAdjusted: Paise;
  base: Paise;
  rate: number;
  computed: Paise;
  amount: Paise;
  overridden: boolean;
  reason: string | null;
  status: string;
  note: string | null;
  certNumber: string | null;
}

interface ChallanRec {
  id: number;
  voucherId: number;
  number: string | null;
  date: string;
  kind: TdsKind;
  section: string;
  period: string;
  bsrCode: string;
  challanNo: string;
  depositDate: string;
  minorHead: string;
  tax: Paise;
  surcharge: Paise;
  cess: Paise;
  interest: Paise;
  fee: Paise;
  others: Paise;
  bankName: string | null;
}

interface Portion {
  challan: ChallanRec;
  amount: Paise;
}

interface Cleared {
  /** Payments of each line (tds_lines.id → portions, oldest challan first). */
  byLine: Map<number, Portion[]>;
  /** Tax of each challan used by deductions (challan id → amount). */
  used: Map<number, Paise>;
}

function loadLines(db: Db, p: { kind?: TdsKind; from?: string; to: string; today: string }): LineRec[] {
  const where = ['tl.affects_books = 1 AND (tl.is_post_dated = 0 OR tl.date <= :today)', 'tl.date <= :to'];
  const params: Record<string, string> = { to: p.to, today: p.today };
  if (p.from) {
    where.push('tl.date >= :from');
    params.from = p.from;
  }
  if (p.kind) {
    where.push('tl.kind = :kind');
    params.kind = p.kind;
  } else {
    // Both kinds: still the (kind, date) index for the period, not a scan of every line.
    where.push("tl.kind IN ('tds', 'tcs')");
  }
  return db
    .all<{
      id: number;
      voucher_id: number;
      number: string | null;
      type_name: string;
      base_type: string;
      date: string;
      kind: TdsKind;
      nature_id: number;
      nature_name: string;
      section: string;
      for_nr: number;
      party_ledger_id: number | null;
      party_name: string | null;
      deductee_type: string;
      pan: string | null;
      pan_status: string;
      non_resident: number;
      assessable: number;
      catch_up: number;
      advance_adjusted: number;
      base: number;
      rate: number;
      computed: number;
      amount: number;
      overridden: number;
      reason: string | null;
      status: string;
      note: string | null;
      cert_number: string | null;
      bill_voucher_id: number | null;
    }>(
      `SELECT tl.id, tl.voucher_id, v.number, vt.name AS type_name, v.base_type, tl.date, tl.kind, tl.nature_id, n.name AS nature_name,
              tl.section, n.for_non_residents AS for_nr, tl.party_ledger_id, l.name AS party_name, tl.deductee_type, tl.pan, tl.pan_status,
              tl.non_resident, tl.assessable, tl.catch_up, tl.advance_adjusted, tl.base, tl.rate, tl.computed, tl.amount, tl.overridden, tl.reason, tl.status,
              tl.note, d.cert_number, tl.bill_voucher_id
         FROM tds_lines tl
         JOIN vouchers v ON v.id = tl.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         JOIN tds_natures n ON n.id = tl.nature_id
         LEFT JOIN ledgers l ON l.id = tl.party_ledger_id
         LEFT JOIN tds_ledger_details d ON d.ledger_id = tl.party_ledger_id
        WHERE ${where.join(' AND ')}
        ORDER BY tl.date, tl.voucher_id, tl.line_no`,
      params,
    )
    .map((r) => ({
      id: r.id,
      voucherId: r.voucher_id,
      number: r.number,
      typeName: r.type_name,
      baseType: r.base_type,
      date: r.date,
      kind: r.kind,
      natureId: r.nature_id,
      natureName: r.nature_name,
      section: r.section,
      forNonResidents: r.for_nr === 1,
      partyLedgerId: r.party_ledger_id,
      partyName: r.party_name,
      deducteeType: r.deductee_type,
      pan: r.pan,
      panStatus: r.pan_status,
      nonResident: r.non_resident === 1,
      assessable: r.assessable,
      catchUp: r.catch_up,
      advanceAdjusted: r.advance_adjusted,
      base: r.base,
      rate: r.rate,
      computed: r.computed,
      amount: r.amount,
      overridden: r.overridden === 1,
      reason: r.reason,
      status: r.status,
      note: r.note,
      certNumber: r.status === 'certificate' ? r.cert_number : null,
      billVoucherId: r.bill_voucher_id,
    }));
}

function loadChallans(db: Db, p: { kind?: TdsKind; depositFrom?: string; depositTo: string; today: string; periodFrom?: string }): ChallanRec[] {
  const where = ['c.affects_books = 1 AND (c.is_post_dated = 0 OR c.date <= :today)', 'c.deposit_date <= :to'];
  const params: Record<string, string> = { to: p.depositTo, today: p.today };
  if (p.depositFrom) {
    where.push('c.deposit_date >= :from');
    params.from = p.depositFrom;
  }
  if (p.periodFrom) {
    where.push('c.period >= :periodFrom');
    params.periodFrom = p.periodFrom;
  }
  if (p.kind) {
    where.push('c.kind = :kind');
    params.kind = p.kind;
  }
  return db
    .all<{
      id: number;
      voucher_id: number;
      number: string | null;
      date: string;
      kind: TdsKind;
      section: string;
      period: string;
      bsr_code: string;
      challan_no: string;
      deposit_date: string;
      minor_head: string;
      tax: number;
      surcharge: number;
      cess: number;
      interest: number;
      fee: number;
      others: number;
      bank_name: string | null;
    }>(
      `SELECT c.id, c.voucher_id, v.number, c.date, c.kind, c.section, c.period, c.bsr_code, c.challan_no, c.deposit_date, c.minor_head,
              c.tax, c.surcharge, c.cess, c.interest, c.fee, c.others,
              (SELECT l.name FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
                WHERE le.voucher_id = c.voucher_id AND le.role = 'cash_bank' AND le.amount < 0 ORDER BY le.amount LIMIT 1) AS bank_name
         FROM tds_challans c JOIN vouchers v ON v.id = c.voucher_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.deposit_date, c.id`,
      params,
    )
    .map((r) => ({
      id: r.id,
      voucherId: r.voucher_id,
      number: r.number,
      date: r.date,
      kind: r.kind,
      section: r.section,
      period: r.period,
      bsrCode: r.bsr_code,
      challanNo: r.challan_no,
      depositDate: r.deposit_date,
      minorHead: r.minor_head,
      tax: r.tax,
      surcharge: r.surcharge,
      cess: r.cess,
      interest: r.interest,
      fee: r.fee,
      others: r.others,
      bankName: r.bank_name,
    }));
}

const keyOf = (kind: TdsKind, section: string, period: string): string => `${kind}|${section}|${period}`;

/**
 * First day of the month of `iso`. Clearing pools are per kind + section + MONTH, so the deductions and
 * challans of earlier months never change how a later month is cleared: a report about a period loads
 * from the start of its first month instead of the whole history (fast on years of vouchers).
 */
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;

/**
 * Lines that carry tax (or a lower / nil certificate) up to `to` — the few columns the outstanding
 * report, the clearing and the statements need. Below-threshold lines (most of them) never leave SQLite.
 */
function loadTaxLines(db: Db, p: { kind: TdsKind; to: string; today: string }): TaxLine[] {
  return netReversals(loadTaxLinesRaw(db, p));
}

function loadTaxLinesRaw(db: Db, p: { kind: TdsKind; to: string; today: string }): TaxLine[] {
  return db
    .all<{ id: number; voucher_id: number; bill_voucher_id: number | null; date: string; kind: TdsKind; section: string; amount: number; status: string; non_resident: number; for_nr: number }>(
      `SELECT tl.id, tl.voucher_id, tl.bill_voucher_id, tl.date, tl.kind, tl.section, tl.amount, tl.status, tl.non_resident, n.for_non_residents AS for_nr
         FROM tds_lines tl JOIN tds_natures n ON n.id = tl.nature_id
        WHERE tl.kind = :kind AND tl.date <= :to AND (tl.amount > 0 OR tl.status = 'certificate' OR (tl.amount < 0 AND tl.bill_voucher_id IS NOT NULL))
          AND tl.affects_books = 1 AND (tl.is_post_dated = 0 OR tl.date <= :today)
        ORDER BY tl.date, tl.voucher_id, tl.line_no`,
      p,
    )
    .map((r) => ({
      id: r.id,
      voucherId: r.voucher_id,
      billVoucherId: r.bill_voucher_id,
      date: r.date,
      kind: r.kind,
      section: r.section,
      amount: r.amount,
      status: r.status,
      nonResident: r.non_resident === 1,
      forNonResidents: r.for_nr === 1,
    }));
}

/** FIFO clearing of deductions by the challans of the same kind + section + month. */
export function clearDeductions(lines: readonly TaxLine[], challans: readonly ChallanRec[]): Cleared {
  const byLine = new Map<number, Portion[]>();
  const used = new Map<number, Paise>();
  const pools = new Map<string, Array<{ c: ChallanRec; left: Paise }>>();
  for (const c of challans) {
    const k = keyOf(c.kind, c.section, c.period);
    const pool = pools.get(k) ?? [];
    pool.push({ c, left: c.tax + c.surcharge + c.cess });
    pools.set(k, pool);
  }
  for (const l of lines) {
    if (l.amount <= 0) continue;
    const pool = pools.get(keyOf(l.kind, l.section, l.date.slice(0, 7)));
    if (!pool) continue;
    let need = l.amount;
    for (const slot of pool) {
      if (need === 0) break;
      if (slot.left <= 0) continue;
      const take = Math.min(need, slot.left);
      slot.left -= take;
      need -= take;
      const list = byLine.get(l.id) ?? [];
      list.push({ challan: slot.c, amount: take });
      byLine.set(l.id, list);
      used.set(slot.c.id, (used.get(slot.c.id) ?? 0) + take);
    }
  }
  return { byLine, used };
}

const paidOf = (cleared: Cleared, id: number): Paise => (cleared.byLine.get(id) ?? []).reduce((a, p) => a + p.amount, 0);

export function formOf(l: { kind: TdsKind; nonResident: boolean; forNonResidents: boolean }): TdsForm {
  if (l.kind === 'tcs') return '27EQ';
  return l.nonResident || l.forNonResidents ? '27Q' : '26Q';
}

// ───────────────────────────── Computation ─────────────────────────────

export function computation(db: Db, p: { from: string; to: string; kind?: TdsKind; today: string }): TdsComputationResult {
  const all = loadLines(db, { kind: p.kind, from: monthStart(p.from), to: p.to, today: p.today });
  const cleared = clearDeductions(all, loadChallans(db, { kind: p.kind, depositTo: p.to, today: p.today, periodFrom: p.from.slice(0, 7) }));
  const groups = new Map<string, TdsComputationRow>();
  for (const l of all) {
    if (l.date < p.from) continue;
    const key = `${l.kind}|${l.partyLedgerId ?? 0}|${l.natureId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind: l.kind,
        partyLedgerId: l.partyLedgerId,
        partyName: l.partyName ?? '(no party)',
        pan: l.pan,
        panStatus: l.panStatus as TdsComputationRow['panStatus'],
        deducteeType: l.deducteeType as TdsComputationRow['deducteeType'],
        natureId: l.natureId,
        natureName: l.natureName,
        section: l.section,
        count: 0,
        credited: 0,
        belowThreshold: 0,
        base: 0,
        deducted: 0,
        deposited: 0,
        balance: 0,
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.credited += l.assessable;
    if (l.status === 'below_threshold') g.belowThreshold += l.assessable;
    g.base += l.base;
    g.deducted += l.amount;
    g.deposited += paidOf(cleared, l.id);
    g.balance = g.deducted - g.deposited;
    if (l.pan) {
      g.pan = l.pan;
      g.panStatus = l.panStatus as TdsComputationRow['panStatus'];
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.section.localeCompare(b.section) || a.partyName.localeCompare(b.partyName));
  const totals = { count: 0, credited: 0, belowThreshold: 0, base: 0, deducted: 0, deposited: 0, balance: 0 };
  for (const r of rows) {
    totals.count += r.count;
    totals.credited += r.credited;
    totals.belowThreshold += r.belowThreshold;
    totals.base += r.base;
    totals.deducted += r.deducted;
    totals.deposited += r.deposited;
    totals.balance += r.balance;
  }
  return { rows, totals };
}

export function lineRows(
  db: Db,
  p: { from: string; to: string; kind?: TdsKind; today: string; partyLedgerId?: number; natureId?: number; section?: string; period?: string; voucherId?: number; depositTo?: string },
): TdsLineRow[] {
  const all = loadLines(db, { kind: p.kind, from: monthStart(p.from), to: p.to, today: p.today });
  // Deposits count up to the period end (as in the computation), or to `depositTo` (voucher view: today).
  const cleared = clearDeductions(all, loadChallans(db, { kind: p.kind, depositTo: p.depositTo ?? p.to, today: p.today, periodFrom: p.from.slice(0, 7) }));
  return all
    .filter(
      (l) =>
        l.date >= p.from &&
        (p.partyLedgerId === undefined || l.partyLedgerId === p.partyLedgerId) &&
        (p.natureId === undefined || l.natureId === p.natureId) &&
        (p.section === undefined || l.section === p.section) &&
        (p.period === undefined || l.date.slice(0, 7) === p.period) &&
        (p.voucherId === undefined || l.voucherId === p.voucherId),
    )
    .map((l) => {
      const paid = paidOf(cleared, l.id);
      return {
        id: l.id,
        voucherId: l.voucherId,
        number: l.number,
        typeName: l.typeName,
        date: l.date,
        kind: l.kind,
        section: l.section,
        natureName: l.natureName,
        partyLedgerId: l.partyLedgerId,
        partyName: l.partyName,
        pan: l.pan,
        panStatus: l.panStatus as TdsLineRow['panStatus'],
        assessable: l.assessable,
        catchUp: l.catchUp,
        advanceAdjusted: l.advanceAdjusted,
        base: l.base,
        rate: l.rate,
        computed: l.computed,
        amount: l.amount,
        overridden: l.overridden,
        reason: l.reason,
        status: l.status as TdsLineRow['status'],
        note: l.note,
        deposited: paid,
        balance: l.amount - paid,
        dueDate: l.amount > 0 ? depositDueDate(l.kind, l.date) : null,
      };
    });
}

// ───────────────────────────── Outstanding ─────────────────────────────

export function outstanding(db: Db, p: { asOf: string; kind: TdsKind; today: string; includeSettled?: boolean }): TdsOutstandingResult {
  const lines = loadTaxLines(db, { kind: p.kind, to: p.asOf, today: p.today });
  const challans = loadChallans(db, { kind: p.kind, depositTo: p.asOf, today: p.today });
  const cleared = clearDeductions(lines, challans);
  const groups = new Map<string, TdsOutstandingRow>();
  const row = (section: string, period: string): TdsOutstandingRow => {
    const key = keyOf(p.kind, section, period);
    let g = groups.get(key);
    if (!g) {
      const due = periodDueDate(p.kind, period);
      g = {
        key,
        kind: p.kind,
        section,
        period,
        periodLabel: formatMonth(period),
        payableLedgerName: payableLedgerName(p.kind, section),
        deducted: 0,
        deposited: 0,
        balance: 0,
        dueDate: due,
        daysOverdue: 0,
        status: 'nothing_due',
        interest: 0,
        interestPaid: 0,
        lastDeposit: null,
        lines: 0,
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const l of lines) {
    if (l.amount <= 0) continue;
    const g = row(l.section, l.date.slice(0, 7));
    g.lines += 1;
    g.deducted += l.amount;
    const portions = cleared.byLine.get(l.id) ?? [];
    let paid = 0;
    for (const pt of portions) {
      paid += pt.amount;
      g.interest += lateDepositInterest(p.kind, pt.amount, l.date, pt.challan.depositDate).interest;
    }
    g.deposited += paid;
    const unpaid = l.amount - paid;
    if (unpaid > 0) g.interest += lateDepositInterest(p.kind, unpaid, l.date, p.asOf).interest;
  }
  for (const c of challans) {
    const g = row(c.section, c.period);
    g.interestPaid += c.interest;
    if (!g.lastDeposit || c.depositDate > g.lastDeposit) g.lastDeposit = c.depositDate;
    // A challan with nothing to clear in its month shows as an excess deposit (negative balance).
    const excess = c.tax + c.surcharge + c.cess - (cleared.used.get(c.id) ?? 0);
    if (excess > 0) g.deposited += excess;
  }
  for (const g of groups.values()) {
    g.balance = g.deducted - g.deposited;
    const overdue = p.asOf > g.dueDate;
    g.daysOverdue = g.balance > 0 && overdue ? Math.max(0, Math.round((Date.parse(p.asOf) - Date.parse(g.dueDate)) / 86_400_000)) : 0;
    g.status =
      g.balance > 0 ? (overdue ? 'overdue' : 'due') : g.balance < 0 ? 'excess' : g.deducted === 0 ? 'nothing_due' : g.lastDeposit && g.lastDeposit > g.dueDate ? 'paid_late' : 'paid';
  }
  const rows = [...groups.values()]
    .filter((g) => p.includeSettled === true || g.balance !== 0 || g.interest - g.interestPaid > 0)
    .sort((a, b) => a.period.localeCompare(b.period) || a.section.localeCompare(b.section));
  const statements = statementRows(db, lines, p.asOf);
  const totals = {
    deducted: rows.reduce((a, r) => a + r.deducted, 0),
    deposited: rows.reduce((a, r) => a + r.deposited, 0),
    balance: rows.reduce((a, r) => a + r.balance, 0),
    interest: rows.reduce((a, r) => a + r.interest, 0),
    interestPaid: rows.reduce((a, r) => a + r.interestPaid, 0),
    lateFee: statements.reduce((a, s) => a + s.lateFee, 0),
  };
  return { asOf: p.asOf, kind: p.kind, rows, statements, totals };
}

function statementRows(db: Db, lines: readonly TaxLine[], asOf: string): TdsStatementRow[] {
  const groups = new Map<string, { form: TdsForm; fyStart: number; quarter: Quarter; tax: Paise; count: number }>();
  const quarterKey = new Map<string, { fyStart: number; quarter: Quarter }>();
  for (const l of lines) {
    if (l.amount <= 0 && l.status !== 'certificate') continue;
    const form = formOf(l);
    const month = l.date.slice(0, 7);
    let fq = quarterKey.get(month);
    if (!fq) {
      fq = { fyStart: taxYearOf(l.date).startYear, quarter: quarterOf(l.date) };
      quarterKey.set(month, fq);
    }
    const { fyStart, quarter } = fq;
    const k = `${form}|${fyStart}|${quarter}`;
    const g = groups.get(k) ?? { form, fyStart, quarter, tax: 0, count: 0 };
    g.tax += l.amount;
    g.count += 1;
    groups.set(k, g);
  }
  const filed = new Map(
    db
      .all<{ form: string; fy_start: number; quarter: number; filed_on: string | null; token_no: string | null }>(
        'SELECT form, fy_start, quarter, filed_on, token_no FROM tds_statements',
      )
      .map((r) => [`${r.form}|${r.fy_start}|${r.quarter}`, r]),
  );
  const out: TdsStatementRow[] = [];
  for (const [k, g] of groups) {
    const due = statementDueDate(g.form, g.fyStart, g.quarter);
    const f = filed.get(k);
    const filedOn = f?.filed_on ?? null;
    const until = filedOn ?? asOf;
    const fee = until > due ? lateFee234E(due, until, g.tax) : { days: 0, fee: 0 };
    out.push({
      key: k,
      form: g.form,
      fyStart: g.fyStart,
      quarter: g.quarter,
      label: `Q${g.quarter} ${g.fyStart}-${String(g.fyStart + 1).slice(-2)}`,
      dueDate: due,
      filedOn,
      tokenNo: f?.token_no ?? null,
      tax: g.tax,
      lines: g.count,
      daysLate: fee.days,
      lateFee: fee.fee,
      status: filedOn ? (filedOn > due ? 'filed_late' : 'filed') : asOf > due ? 'overdue' : 'due',
    });
  }
  return out.sort((a, b) => a.fyStart - b.fyStart || a.quarter - b.quarter || a.form.localeCompare(b.form));
}

// ───────────────────────────── Challan register ─────────────────────────────

export function challanRegister(db: Db, p: { from: string; to: string; kind?: TdsKind; today: string }): TdsChallanRegister {
  const challans = loadChallans(db, { kind: p.kind, depositTo: p.to, today: p.today });
  // Only the months the listed challans pay for matter to their clearing.
  const shown = challans.filter((c) => c.depositDate >= p.from);
  const firstPeriod = shown.reduce<string | null>((a, c) => (a === null || c.period < a ? c.period : a), null);
  const lines = firstPeriod === null ? [] : loadLines(db, { kind: p.kind, from: `${firstPeriod}-01`, to: '9999-12-31', today: p.today });
  const cleared = clearDeductions(lines, firstPeriod === null ? [] : challans.filter((c) => c.period >= firstPeriod));
  const rows: TdsChallanRow[] = challans
    .filter((c) => c.depositDate >= p.from)
    .map((c) => {
      const total = c.tax + c.surcharge + c.cess + c.interest + c.fee + c.others;
      const used = cleared.used.get(c.id) ?? 0;
      return {
        id: c.id,
        voucherId: c.voucherId,
        number: c.number,
        kind: c.kind,
        section: c.section,
        period: c.period,
        periodLabel: formatMonth(c.period),
        bsrCode: c.bsrCode,
        challanNo: c.challanNo,
        depositDate: c.depositDate,
        minorHead: c.minorHead,
        bankName: c.bankName,
        tax: c.tax,
        surcharge: c.surcharge,
        cess: c.cess,
        interest: c.interest,
        fee: c.fee,
        others: c.others,
        total,
        cleared: used,
        unconsumed: c.tax + c.surcharge + c.cess - used,
        late: c.depositDate > periodDueDate(c.kind, c.period),
      };
    });
  const sum = (f: (r: TdsChallanRow) => Paise): Paise => rows.reduce((a, r) => a + f(r), 0);
  return {
    rows,
    totals: {
      tax: sum((r) => r.tax),
      surcharge: sum((r) => r.surcharge),
      cess: sum((r) => r.cess),
      interest: sum((r) => r.interest),
      fee: sum((r) => r.fee),
      others: sum((r) => r.others),
      total: sum((r) => r.total),
      cleared: sum((r) => r.cleared),
      unconsumed: sum((r) => r.unconsumed),
    },
  };
}

/** Unpaid tax (and the interest if deposited on `depositDate`) of one kind + section + month: the challan suggestion. */
export function challanSuggestion(db: Db, p: { kind: TdsKind; section: string; period: string; depositDate: string; today: string; excludeVoucherId?: number }): {
  unpaid: Paise;
  interest: Paise;
  dueDate: string;
  lines: number;
} {
  const range = { from: `${p.period}-01`, to: `${p.period}-31` };
  // A debit / credit note dated up to the deposit date that reverses part of a bill of this month nets
  // into that bill's deduction (netReversals), exactly as the outstanding report and the statement count
  // it — otherwise the suggestion asks for the gross and the challan over-deposits the reversed part.
  const lines = netReversals(
    loadLines(db, { kind: p.kind, from: range.from, to: p.depositDate > range.to ? p.depositDate : range.to, today: p.today }).filter(
      (l) => l.section === p.section && (l.date <= range.to || (l.amount < 0 && l.billVoucherId !== undefined && l.billVoucherId !== null)),
    ),
  );
  const challans = loadChallans(db, { kind: p.kind, depositTo: '9999-12-31', today: p.today }).filter(
    (c) => c.section === p.section && c.period === p.period && c.voucherId !== (p.excludeVoucherId ?? 0),
  );
  const cleared = clearDeductions(lines, challans);
  let unpaid = 0;
  let interest = 0;
  let count = 0;
  for (const l of lines) {
    const left = l.amount - paidOf(cleared, l.id);
    if (left <= 0) continue;
    count += 1;
    unpaid += left;
    interest += lateDepositInterest(p.kind, left, l.date, p.depositDate).interest;
  }
  return { unpaid, interest, dueDate: periodDueDate(p.kind, p.period), lines: count };
}

// ───────────────────────────── Quarterly return data ─────────────────────────────

const REASON_CERT = 'A';
const REASON_NO_PAN = 'C';

export function returnData(db: Db, p: { form: TdsForm; fyStart: number; quarter: Quarter; today: string; asOf: string }): TdsReturnData {
  const range = quarterRange(p.fyStart, p.quarter);
  const kind: TdsKind = p.form === '27EQ' ? 'tcs' : 'tds';
  const all = netReversals(loadLines(db, { kind, from: range.from, to: range.to, today: p.today }).filter((l) => formOf(l) === p.form));
  const challansAll = loadChallans(db, { kind, depositTo: '9999-12-31', today: p.today, periodFrom: range.from.slice(0, 7) });
  const cleared = clearDeductions(all, challansAll);
  const months = new Set([0, 1, 2].map((i) => {
    const [y, m] = range.from.split('-').map(Number);
    const mm = m + i;
    return `${y}-${String(mm).padStart(2, '0')}`;
  }));
  const challans = challansAll.filter((c) => months.has(c.period) && (p.form === '27EQ' || challanFitsForm(c, all, p.form)));
  const challanIndex = new Map(challans.map((c, i) => [c.id, i + 1]));
  const deductees: TdsReturnDeducteeRow[] = [];
  const warnings: string[] = [];
  const settings = getTdsSettings(db);
  if (!settings.tan) warnings.push('The TAN is not set (TDS/TCS › Setup or Company profile).');
  for (const l of all) {
    if (l.date < range.from) continue;
    if (l.amount <= 0 && l.status !== 'certificate') continue;
    const reason = l.status === 'certificate' ? REASON_CERT : l.panStatus !== 'valid' && l.amount > 0 ? REASON_NO_PAN : '';
    const base = {
      deducteeCode: (l.deducteeType === 'company' ? '01' : '02') as TdsReturnDeducteeRow['deducteeCode'],
      pan: l.panStatus === 'valid' && l.pan ? l.pan : 'PANNOTAVBL',
      name: l.partyName ?? '',
      partyLedgerId: l.partyLedgerId,
      section: l.section,
      paymentDate: l.date,
      deductionDate: l.date,
      rate: l.rate,
      reasonCode: reason,
      certificateNo: l.certNumber,
      voucherId: l.voucherId,
      voucherNumber: l.number,
    };
    const portions = cleared.byLine.get(l.id) ?? [];
    const paid = portions.reduce((a, x) => a + x.amount, 0);
    if (portions.length === 0 && l.amount === 0) {
      deductees.push({ ...base, challanSr: null, bsrCode: null, depositDate: null, challanNo: null, amountPaid: l.base, tax: 0, deposited: 0 });
      continue;
    }
    // One row per challan the deduction was paid with; the amount paid / credited is split pro rata.
    let baseLeft = l.base;
    portions.forEach((pt, i) => {
      const share = i === portions.length - 1 && paid === l.amount ? baseLeft : Math.round((l.base * pt.amount) / l.amount);
      baseLeft -= share;
      deductees.push({
        ...base,
        challanSr: challanIndex.get(pt.challan.id) ?? null,
        bsrCode: pt.challan.bsrCode,
        depositDate: pt.challan.depositDate,
        challanNo: pt.challan.challanNo,
        amountPaid: share,
        tax: pt.amount,
        deposited: pt.amount,
      });
    });
    if (paid < l.amount) {
      deductees.push({ ...base, challanSr: null, bsrCode: null, depositDate: null, challanNo: null, amountPaid: baseLeft, tax: l.amount - paid, deposited: 0 });
      warnings.push(`${l.partyName ?? 'A deductee'}: ${inr(l.amount - paid)} of ${kind.toUpperCase()} u/s ${l.section} deducted on ${formatDate(l.date)} has not been deposited.`);
    }
    if (l.panStatus !== 'valid' && l.amount > 0) warnings.push(`${l.partyName ?? 'A deductee'} has no valid PAN (${formatDate(l.date)}).`);
  }
  const challanRows: TdsReturnChallanRow[] = challans.map((c, i) => ({
    sr: i + 1,
    voucherId: c.voucherId,
    section: c.section,
    period: c.period,
    bsrCode: c.bsrCode,
    challanNo: c.challanNo,
    depositDate: c.depositDate,
    minorHead: c.minorHead,
    tax: c.tax,
    surcharge: c.surcharge,
    cess: c.cess,
    interest: c.interest,
    fee: c.fee,
    others: c.others,
    total: c.tax + c.surcharge + c.cess + c.interest + c.fee + c.others,
    allocated: deductees.filter((d) => d.challanSr === i + 1).reduce((a, d) => a + d.deposited, 0),
  }));
  const status = db.get<{ filed_on: string | null; token_no: string | null }>(
    'SELECT filed_on, token_no FROM tds_statements WHERE form = :form AND fy_start = :fy AND quarter = :q',
    { form: p.form, fy: p.fyStart, q: p.quarter },
  );
  const due = statementDueDate(p.form, p.fyStart, p.quarter);
  const tax = deductees.reduce((a, d) => a + d.tax, 0);
  const until = status?.filed_on ?? p.asOf;
  const fee = until > due ? lateFee234E(due, until, tax) : { days: 0, fee: 0 };
  return {
    form: p.form,
    fyStart: p.fyStart,
    quarter: p.quarter,
    from: range.from,
    to: range.to,
    tan: settings.tan,
    deductees,
    challans: challanRows,
    totals: {
      amountPaid: deductees.reduce((a, d) => a + d.amountPaid, 0),
      tax,
      deposited: deductees.reduce((a, d) => a + d.deposited, 0),
      challanTotal: challanRows.reduce((a, c) => a + c.total, 0),
    },
    dueDate: due,
    filedOn: status?.filed_on ?? null,
    tokenNo: status?.token_no ?? null,
    lateFee: fee.fee,
    daysLate: fee.days,
    warnings,
  };
}

/** A TDS challan belongs to 27Q when it clears only non-resident deductions of its month, else 26Q. */
function challanFitsForm(c: ChallanRec, lines: readonly LineRec[], form: TdsForm): boolean {
  const of = lines.filter((l) => l.section === c.section && l.date.slice(0, 7) === c.period);
  if (of.length === 0) return form === '26Q' ? !c.section.startsWith('195') : c.section.startsWith('195');
  return of.some((l) => formOf(l) === form);
}

// ───────────────────────────── Exceptions ─────────────────────────────

export function exceptions(db: Db, p: { from: string; to: string; kind?: TdsKind; asOf: string; today: string }): TdsExceptionRow[] {
  // Thresholds aggregate per income-tax year (or month): lines from the start of the year of `from` suffice.
  const all = loadLines(db, { kind: p.kind, from: taxYearOf(p.from).start, to: p.to, today: p.today });
  const out: TdsExceptionRow[] = [];
  const push = (l: LineRec, type: TdsExceptionRow['type'], severity: TdsExceptionRow['severity'], message: string, shortfall = 0, interest = 0): void => {
    out.push({
      key: `${type}|${l.id}`,
      type,
      severity,
      voucherId: l.voucherId,
      number: l.number,
      typeName: l.typeName,
      date: l.date,
      partyLedgerId: l.partyLedgerId,
      partyName: l.partyName,
      section: l.section,
      amount: l.amount,
      shortfall,
      interest,
      message,
    });
  };
  for (const l of all) {
    if (l.date < p.from) continue;
    const who = l.partyName ?? 'The deductee';
    if (l.status === 'no_party') push(l, 'no_party', 'error', `${l.section}: ${inr(l.assessable)} is ${l.kind.toUpperCase()}-applicable but the voucher has no party — nothing was ${l.kind === 'tds' ? 'deducted' : 'collected'}.`);
    if (l.amount > 0 && l.panStatus === 'missing') push(l, 'no_pan', 'warning', `${who} has no PAN: ${l.kind.toUpperCase()} at the higher rate ${l.rate}%. Collect the PAN; the statement shows PANNOTAVBL.`);
    if (l.amount > 0 && l.panStatus === 'invalid') push(l, 'invalid_pan', 'error', `${who}'s PAN ${l.pan ?? ''} is not valid: correct it in the ledger's TDS details.`);
    if (l.overridden && l.computed === 0 && l.amount > 0) {
      push(l, 'below_threshold_deducted', 'warning', `${inr(l.amount)} deducted although the amount was below the threshold. Reason: ${l.reason ?? '—'}`);
    }
    if (l.status === 'overridden_nil' && l.computed > 0) {
      const i = nonDeductionInterest(l.computed, l.date, p.asOf);
      push(l, 'not_deducted', 'error', `Threshold crossed but not deducted (${inr(l.computed)} was due). Reason: ${l.reason ?? '—'}. Interest u/s 201(1A)(i) at 1% for ${i.months} month(s) to ${formatDate(p.asOf)}.`, l.computed, i.interest);
    } else if (l.overridden && l.amount > 0 && l.amount < l.computed) {
      push(l, 'short_deducted', 'warning', `Deducted ${inr(l.amount)} instead of ${inr(l.computed)}. Reason: ${l.reason ?? '—'}`, l.computed - l.amount);
    }
  }
  // Threshold crossed for the period, yet credits below it were never taken in (vouchers entered out of
  // date order, or a later alter / deletion).
  const store = new TdsStore(db);
  const settings = getTdsSettings(db);
  const groups = new Map<string, LineRec[]>();
  for (const l of all) {
    if (l.partyLedgerId === null) continue;
    const rr = store.rateOn(l.natureId, l.date);
    if (!rr || rr.threshold_aggregate === null || rr.threshold_basis === 'excess') continue;
    const period = rr.aggregate_period === 'month' ? l.date.slice(0, 7) : String(taxYearOf(l.date).startYear);
    const k = `${l.partyLedgerId}|${l.natureId}|${period}`;
    const list = groups.get(k) ?? [];
    list.push(l);
    groups.set(k, list);
  }
  for (const list of groups.values()) {
    const last = list[list.length - 1];
    if (last.date < p.from) continue;
    const rr = store.rateOn(last.natureId, last.date);
    if (!rr || rr.threshold_aggregate === null) continue;
    const total = list.reduce((a, l) => a + l.assessable, 0);
    const below = list.filter((l) => l.status === 'below_threshold').reduce((a, l) => a + l.assessable, 0);
    const caught = list.reduce((a, l) => a + l.catchUp, 0);
    const left = below - caught;
    if (total > rr.threshold_aggregate && left > 0) {
      const r = rateFor(rateFromRow(rr), last.deducteeType as DeducteeType, last.panStatus === 'valid');
      const shortfall = taxOn(left, r, settings.roundToRupee);
      const first = list.find((l) => l.status === 'below_threshold') ?? last;
      const i = nonDeductionInterest(shortfall, last.date, p.asOf);
      push(
        last,
        'threshold_not_deducted',
        'error',
        `${last.partyName ?? ''} — ${last.section}: credits of ${inr(total)} exceed the threshold ${inr(rr.threshold_aggregate)}, but ${inr(left)} (from ${formatDate(first.date)}) was never subjected to ${last.kind.toUpperCase()}. Re-save the latest voucher, or deduct ${inr(shortfall)} by a journal. Interest u/s 201(1A)(i) ~ ${inr(i.interest)}.`,
        shortfall,
        i.interest,
      );
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

// ───────────────────────────── One voucher ─────────────────────────────

/**
 * TDS/TCS of one voucher (voucher view panel): its lines with what has been deposited against them,
 * and the challan it carries. Lines of a voucher outside the books (optional, cancelled, post-dated
 * not yet due) are not in tds_lines' books view, so they come back empty.
 */
export function voucherTds(db: Db, p: { voucherId: number; today: string }): { lines: TdsLineRow[]; challan: TdsChallanRow | null } {
  const date = db.value<string>('SELECT date FROM vouchers WHERE id = :id', { id: p.voucherId });
  if (date === undefined) return { lines: [], challan: null };
  const lines = lineRows(db, { from: date, to: date, today: p.today, voucherId: p.voucherId, depositTo: '9999-12-31' });
  const challanId = db.value<number>('SELECT id FROM tds_challans WHERE voucher_id = :id', { id: p.voucherId });
  let challan: TdsChallanRow | null = null;
  if (challanId !== undefined) {
    const deposit = db.value<string>('SELECT deposit_date FROM tds_challans WHERE id = :id', { id: challanId }) ?? date;
    challan = challanRegister(db, { from: deposit, to: deposit, today: p.today }).rows.find((r) => r.id === challanId) ?? null;
  }
  return { lines, challan };
}
