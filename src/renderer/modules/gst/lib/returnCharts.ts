/**
 * GST returns in 2.1 (SPEC-21 §1.9, §5 "GST returns"): the one graph each return screen draws — or the
 * stat / figure it shows instead — built from data the screen already has. Pure (no React), so every
 * "graph total = table total" rule is tested in node (returnCharts.test.ts). Money is integer paise.
 *
 *   GSTR-1          no graph (the portal tables are the filing) — stat "Nothing blocking" / "N block the JSON"
 *   GSTR-3B         head figure "Cash to pay ₹x" + due caption; meter "From credit · In cash" only when both > 0
 *   GSTR-9          polarity columns "Tax payable after credit, by month" (Enter → that month's GSTR-3B)
 *   GST Set-off     meter "Cash in ledger ₹A of ₹B needed" (both > 0) + stat "To deposit ₹x"
 *   e-ledgers       line of the running balance (detail class: folded until asked for)
 */
import type { CashLedgerTxn, CreditLedgerTxn, ElectronicCashLedger, ElectronicCreditLedger, GstSetoffResult } from '../../../../shared/types/gst-plus.ts';
import type { GstIssue, Gstr1Summary, Gstr3bSummary, Gstr9MonthRow, Gstr9Summary, ReturnPeriodRef } from '../../../../shared/types/gst-returns.ts';
import { addDays, diffDays, formatDate } from '../../../../shared/dates.ts';
import { clipTakeaway, compactValue, enoughData, MIN_LINE_POINTS, monthName, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import type { Gstr1Tile } from './gstr1.ts';
import { sumTax } from './reports.ts';

const money = (p: number): string => compactValue(p, 'inr');
/** '2026-10-10' → '10-Oct'. */
const dayMonth = (iso: string): string => formatDate(iso, 'D-MMM-YY').slice(0, -3);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ───────────────────────────── GSTR-1 ─────────────────────────────

export interface Gstr1Stat {
  /** "Nothing blocking" · "2 documents block the JSON". */
  text: string;
  tone: 'danger' | null;
  /** The one link: "Review" (errors) or "3 warnings" — both open GST Exceptions for the period. */
  link: string | null;
}

/**
 * GSTR-1's answer (§5 `gst.gstr1`): can I file? Errors block the JSON (the portal would reject it):
 * counted as documents (distinct vouchers), or as problems when a period-level error (no voucher) is
 * among them. Warnings never block; they are the link when nothing does.
 */
export function gstr1Stat(issues: readonly GstIssue[]): Gstr1Stat {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.length - errors.length;
  if (errors.length > 0) {
    const docs = new Set(errors.filter((i) => i.voucherId !== null).map((i) => i.voucherId)).size;
    const periodLevel = errors.filter((i) => i.voucherId === null).length;
    const n = docs + periodLevel;
    const what = periodLevel > 0 ? (n === 1 ? '1 problem blocks' : `${n} problems block`) : n === 1 ? '1 document blocks' : `${n} documents block`;
    return { text: `${what} the JSON`, tone: 'danger', link: 'Review' };
  }
  return { text: 'Nothing blocking', tone: null, link: warnings > 0 ? plural(warnings, 'warning') : null };
}

/**
 * The Total row of the GSTR-1 tables: the return's net outward supplies (as GSTR-3B 3.1(a)/(b) reads
 * them — `summary.totals`). It is labelled "Total" only when it foots with the supply rows shown above
 * it; otherwise (4B, whose tax the buyer pays, and 8, which has none, are not in the net; advances and the
 * amendments of filed periods are) it reads "Net total" and `note` says why — never a "Total" that does
 * not add up.
 */
export function gstr1Total(
  s: Pick<Gstr1Summary, 'totals'>,
  supply: ReadonlyArray<Pick<Gstr1Tile, 'taxable' | 'tax'>>,
): { label: 'Total' | 'Net total'; taxable: number; tax: number; split: string; note: string | null } {
  const t = s.totals;
  const tax = t.igst + t.cgst + t.sgst + t.cess;
  const rowsTaxable = supply.reduce((a, r) => a + r.taxable, 0);
  const rowsTax = supply.reduce((a, r) => a + r.tax, 0);
  const foots = rowsTaxable === t.taxable && rowsTax === tax;
  return {
    label: foots ? 'Total' : 'Net total',
    taxable: t.taxable,
    tax,
    split: `IGST ${money(t.igst)} · CGST ${money(t.cgst)} · SGST ${money(t.sgst)} · Cess ${money(t.cess)}`,
    note: foots
      ? null
      : 'The return’s net, as GSTR-3B 3.1(a) and (b) read it: without 4B (the buyer pays that tax) and 8 (no tax), with advances and amendments of filed periods — so it differs from the sum of the rows.',
  };
}

/** "2 optional · 1 cancelled · 3 without GST" — documents of the period that are not in GSTR-1 ('' when none). */
export function gstr1Excluded(s: Pick<Gstr1Summary, 'excluded'>): string {
  const e = s.excluded;
  return [e.optional > 0 ? `${e.optional} optional` : '', e.cancelled > 0 ? `${e.cancelled} cancelled` : '', e.notGst > 0 ? `${e.notGst} without GST` : ''].filter(Boolean).join(' · ');
}

// ───────────────────────────── GSTR-3B ─────────────────────────────

/** 6.1 in three numbers: tax payable (A + B), the part paid from credit, the part paid in cash. */
export function gstr3bPaid(s: Pick<Gstr3bSummary, 'payment'>): { payable: number; fromCredit: number; inCash: number } {
  let payable = 0;
  let fromCredit = 0;
  let inCash = 0;
  for (const r of s.payment.rows) {
    payable += r.liability + r.rcmLiability;
    fromCredit += r.paidIgst + r.paidCgst + r.paidSgst + r.paidCess;
    inCash += r.cash + r.rcmLiability;
  }
  return { payable, fromCredit, inCash };
}

/**
 * GSTR-3B's meter (§5 `gst.gstr3b`): how the tax payable is paid — from credit against the whole. Drawn
 * only when both parts are above 0; with no credit used (or nothing in cash) the "Cash to pay" figure is
 * the whole answer. Total = the 6.1 "Tax payable" column (A + B).
 */
export function gstr3bMeter(s: Pick<Gstr3bSummary, 'payment'>): ChartSpec | null {
  const p = gstr3bPaid(s);
  if (p.fromCredit <= 0 || p.inCash <= 0) return null;
  const spec: ChartSpec = {
    kind: 'meter',
    title: 'Tax payable, paid from credit',
    takeaway: `From credit ${money(p.fromCredit)} · In cash ${money(p.inCash)}`,
    categories: ['From credit'],
    series: [{ name: 'From credit', values: [p.fromCredit] }],
    max: p.payable,
    total: p.payable,
  };
  return enoughData(spec) ? spec : null;
}

/**
 * States / UTs whose quarterly (QRMP) GSTR-3B is due on the 22nd — the same list as the core's
 * `QRMP_22ND_STATES` (core/modules/dashboard/summary.ts; returnCharts.test.ts checks they agree).
 */
const QRMP_22ND = new Set(['22', '23', '24', '25', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37']);

/**
 * When the return's cash is due (the Home dashboard's rule, core `gstDueDate`): monthly filers — GSTR-3B
 * on the 20th of the next month; quarterly (QRMP) filers — the quarter's GSTR-3B on the 22nd / 24th
 * (by state, from the GSTIN), a single month's tax by PMT-06 on the 25th. Null for a date range.
 */
export function returnDue(period: Pick<ReturnPeriodRef, 'kind' | 'to'>, frequency: 'monthly' | 'quarterly', stateCode: string): { date: string; form: 'GSTR-3B' | 'PMT-06' } | null {
  if (period.kind === 'range') return null;
  const next = addDays(period.to, 1); // the 1st of the month after the period
  const day = (d: number): string => `${next.slice(0, 8)}${String(d).padStart(2, '0')}`;
  if (frequency === 'monthly' && period.kind === 'month') return { date: day(20), form: 'GSTR-3B' };
  const m = Number(period.to.slice(5, 7));
  if (period.kind === 'month' && m % 3 !== 0) return { date: day(25), form: 'PMT-06' };
  return { date: day(QRMP_22ND.has(stateCode) ? 22 : 24), form: 'GSTR-3B' };
}

/**
 * The state whose due date applies: the company's own state (as the core's dashboard reads it,
 * `company.stateCode`), else the GSTIN's first two digits; '' when neither is known.
 */
export function dueStateCode(companyState: string | null | undefined, gstin: string | null | undefined): string {
  if (companyState && /^\d{2}$/.test(companyState)) return companyState;
  return gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '';
}

/** "Due 20-Oct-26 (in 10 days)" · "(today)" · "(3 days late)"; PMT-06 says so. `late` drives the warning tone. */
export function dueCaption(due: { date: string; form: 'GSTR-3B' | 'PMT-06' }, today: string): { text: string; late: boolean } {
  const days = diffDays(today, due.date);
  const when = days === 0 ? 'today' : days > 0 ? `in ${plural(days, 'day')}` : `${plural(-days, 'day')} late`;
  const head = due.form === 'PMT-06' ? 'PMT-06 due' : 'Due';
  return { text: `${head} ${formatDate(due.date, 'D-MMM-YY')} (${when})`, late: days < 0 };
}

// ───────────────────────────── GSTR-9 ─────────────────────────────

/** A month's tax on outward supplies less its net ITC: > 0 payable after credit, < 0 credit left over. */
export function afterCredit(m: Pick<Gstr9MonthRow, 'outwardTax' | 'itc'>): number {
  return sumTax(m.outwardTax) - sumTax(m.itc);
}

/** 'MMYYYY' → 'Apr' (falls back to the row's own label). */
function monthLabel(m: Pick<Gstr9MonthRow, 'period' | 'label'>): string {
  return /^\d{6}$/.test(m.period) ? monthName(`${m.period.slice(2)}-${m.period.slice(0, 2)}`) : m.label;
}

/**
 * GSTR-9's graph (§5 `gst.gstr9`): tax payable after credit, month by month — a question the annual
 * form's tables do not answer. Polarity: payable above the line (slot 1), credit left over below (slot 2);
 * total = the month table's "After credit" column total. Enter on a month = Enter on its row (its 3B).
 */
export function gstr9Chart(s: Pick<Gstr9Summary, 'months'>, activate?: (index: number) => void): ChartSpec | null {
  if (s.months.length === 0) return null;
  const values = s.months.map(afterCredit);
  const categories = s.months.map(monthLabel);
  const total = values.reduce((a, b) => a + b, 0);
  const due = values.filter((v) => v > 0).length;
  const left = values.filter((v) => v < 0).length;
  let most = -1;
  values.forEach((v, i) => {
    if (v > 0 && (most < 0 || v > values[most])) most = i;
  });
  const peak = most >= 0 ? `most in ${categories[most]} (${money(values[most])})` : '';
  const takeaway =
    left > 0
      ? `Credit left over in ${left} of ${values.length} months${peak ? `; tax due ${peak}` : ''}`
      : `Tax due after credit in ${due} of ${values.length} months${peak ? `; ${peak}` : ''}`;
  const spec: ChartSpec = {
    kind: 'column',
    title: 'Tax payable after credit, by month',
    takeaway: clipTakeaway(takeaway),
    categories,
    xKind: 'time',
    series: [{ name: 'After credit', values }],
    color: 'polarity',
    axisCaptions: { up: 'Payable ↑', down: 'Credit left ↓' },
    label: 'max',
    total,
    activate,
  };
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── GST Set-off ─────────────────────────────

/** Cash in the electronic cash ledger that this return can use: per major head, never more than it needs. */
export function setoffCovered(s: Pick<GstSetoffResult, 'cash'>): number {
  return s.cash.reduce((a, r) => a + Math.min(Math.max(r.available, 0), r.total), 0);
}

/**
 * GST Set-off's meter (§5 `gst.setoff`): is there enough cash in the e-ledger? Cash in the ledger
 * (capped per head at what the head needs) against the cash needed; both parts must be above 0.
 * Total = the cash needed (Σ the "Total" column of Cash by head = `cashTotal`).
 */
export function setoffMeter(s: Pick<GstSetoffResult, 'cash' | 'cashTotal'>): ChartSpec | null {
  const covered = setoffCovered(s);
  if (covered <= 0 || s.cashTotal <= 0) return null;
  const spec: ChartSpec = {
    kind: 'meter',
    title: 'Cash in the ledger for this return',
    takeaway: `Cash in ledger ${money(covered)} of ${money(s.cashTotal)} needed`,
    categories: ['Cash in ledger'],
    series: [{ name: 'Cash in ledger', values: [covered] }],
    max: s.cashTotal,
    total: s.cashTotal,
  };
  return enoughData(spec) ? spec : null;
}

/** The set-off's answer in words: what is still to deposit (exact), or that the ledger covers it. */
export function setoffStat(s: Pick<GstSetoffResult, 'cashTotal' | 'toDepositTotal'>): { label: string; value: number | string; tone?: 'warning' } | null {
  if (s.toDepositTotal > 0) return { label: 'To deposit', value: s.toDepositTotal, tone: 'warning' };
  if (s.cashTotal > 0) return { label: '', value: 'Covered by the cash ledger' };
  return null;
}

// ───────────────────────────── Electronic ledgers ─────────────────────────────

/** At most this many points on a ledger line (the kit's cap): longer ranges keep evenly spaced dates and the last. */
const MAX_POINTS = 480;

interface Point {
  date: string;
  value: number;
}

/** Opening, then the balance at the end of each day with a movement (transactions in date order). */
function runningBalance<T extends { date: string }>(from: string, opening: number, txns: readonly T[], delta: (t: T) => number): Point[] {
  const points: Point[] = [{ date: from, value: opening }];
  let bal = opening;
  const sorted = txns.map((t, i) => ({ t, i })).sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i));
  for (const { t } of sorted) {
    bal += delta(t);
    const last = points[points.length - 1];
    if (points.length > 1 && last.date === t.date) last.value = bal;
    else points.push({ date: t.date, value: bal });
  }
  if (points.length <= MAX_POINTS) return points;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, k) => points[Math.round(k * step)]);
}

function ledgerLine(title: string, from: string, points: Point[]): ChartSpec | null {
  if (points.length < MIN_LINE_POINTS) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const change = last.value - first.value;
  const delta = change === 0 ? `unchanged since ${dayMonth(from)}` : `${change > 0 ? 'up' : 'down'} ${money(Math.abs(change))} since ${dayMonth(from)}`;
  const spec: ChartSpec = {
    kind: 'line',
    title,
    takeaway: take.last(money(last.value), dayMonth(last.date), delta),
    categories: points.map((p, i) => (i === 0 ? `Opening ${formatDate(p.date, 'D-MMM-YY')}` : formatDate(p.date, 'D-MMM-YY'))),
    series: [{ name: 'Balance', values: points.map((p) => p.value) }],
    label: 'last',
    total: last.value,
  };
  return enoughData(spec) ? spec : null;
}

const cashDelta = (t: CashLedgerTxn): number => (t.kind === 'deposit' ? 1 : -1) * (t.igst + t.cgst + t.sgst + t.cess);
const creditDelta = (t: CreditLedgerTxn): number => t.igst + t.cgst + t.sgst + t.cess;

/**
 * The electronic cash ledger's balance over the period (§5 `gst.ledger.cash`, detail class): the opening,
 * then + deposits − utilisation, day by day. Total = the closing balance (the Total row of "Balance by head").
 */
export function cashLedgerChart(l: Pick<ElectronicCashLedger, 'from' | 'totals' | 'transactions'>): ChartSpec | null {
  return ledgerLine('Cash in the electronic cash ledger', l.from, runningBalance(l.from, l.totals.opening, l.transactions, cashDelta));
}

/** Σ closing of the credit ledger's heads (the "Closing" column total). */
export function creditClosing(l: Pick<ElectronicCreditLedger, 'rows'>): number {
  return l.rows.reduce((a, r) => a + r.closing, 0);
}

/**
 * The electronic credit ledger's balance (§5 `gst.ledger.credit`, detail class): Σ opening of the heads,
 * then the signed movements (accrued +, reversed / utilised −). Total = Σ closing of the heads.
 */
export function creditLedgerChart(l: Pick<ElectronicCreditLedger, 'from' | 'rows' | 'transactions'>): ChartSpec | null {
  const opening = l.rows.reduce((a, r) => a + r.opening, 0);
  return ledgerLine('Input tax credit in hand', l.from, runningBalance(l.from, opening, l.transactions, creditDelta));
}
