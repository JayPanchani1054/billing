/**
 * Graphs and stats of the outstanding screens (2.1, SPEC-21 §1.9, §5, D25) — pure builders, tested in
 * charts.test.ts with "what the graph or stat says = what the table says".
 *
 *   receivablesStat(r)   Receivables / Payables (all three views): "To collect ₹x · Overdue ₹y › ·
 *                        ₹z not matched to bills ›" — zeros dropped. "To collect" is the Net outstanding
 *                        total in the owner's words (allow-listed in app/lib/chartCatalogue.ts).
 *   partiesChart(r)      the Parties view (2.1.2, the owner's change to D25): "Who owes me the most?" /
 *                        "Whom do I owe the most?" — a bar per party of its Net outstanding on the natural
 *                        side; a party whose advance outweighs its bills left of zero (slot 2, said
 *                        "advance"). Inline in the Net outstanding column with ≤ 7 parties, else Top 6 + Other.
 *   ageingChart(r)       the Ageing view (Ctrl+3): unpaid bills by age, ordinal (Not due grey, the age
 *                        ranges o1…o5; more than five ranges fold the oldest into one). The Bills view has
 *                        no graph (a worklist).
 *   partyChart(d)        Party Outstanding: a meter "balance of the credit limit", only with a limit and a
 *                        balance on the party's side.
 *   statementChart(s)    Statement of Account: the running balance (screen only, never printed).
 *
 * Money is integer paise. Side reports are side-signed (positive = receivable / payable); the party
 * and the statement are ledger-signed (Dr +, Cr −).
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { AgeingBucket, AgeingResult, LedgerBillsResult, PartyOutstandingRow, PartySummaryResult, StatementResult } from '../../../../shared/types/outstanding.ts';
import { INLINE_MAX_ROWS, MAX_LINE_POINTS, MIN_LINE_POINTS, TAKEAWAY_MAX, clipTakeaway, compactValue, decimate, enoughData, foldTop, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec, ValueFormat } from '../../../ui/lib/chartSpec.ts';

// ───────────────────────────── The stat (Receivables / Payables) ─────────────────────────────

export type OutstandingStatId = 'net' | 'overdue' | 'unmatched';

export interface OutstandingStatItem {
  id: OutstandingStatId;
  label: string;
  /** The figure shown (exact paise; never negative for 'net' and 'unmatched' — the label carries the side). */
  value: Paise;
  /** The total it comes from, side-signed as the route returns it (what the tests compare). */
  amount: Paise;
  /** The one link of the line ("₹3,66,000 not matched to bills ›"). */
  link?: boolean;
}

/**
 * The answer of Receivables / Payables in the owner's words (D25), over the totals of the parties shown:
 *  - net       "To collect" / "To pay" = totals.pending (bills + advances + on account). When advances
 *              outweigh the bills it reads "Received in advance" / "Paid in advance" with the amount.
 *  - overdue   "Overdue" = totals.overdue (opens the Ageing view).
 *  - unmatched "not matched to bills" = totals.advance + totals.onAccount (opens the Bills view filtered
 *              to those lines); shown without a sign, the words carry it.
 * Items whose amount is zero are left out.
 */
export function receivablesStat(r: Pick<PartySummaryResult, 'side' | 'totals'>): OutstandingStatItem[] {
  const t = r.totals;
  const unmatched = t.advance + t.onAccount;
  const netLabel = t.pending >= 0 ? (r.side === 'receivable' ? 'To collect' : 'To pay') : r.side === 'receivable' ? 'Received in advance' : 'Paid in advance';
  const items: OutstandingStatItem[] = [
    { id: 'net', label: netLabel, value: Math.abs(t.pending), amount: t.pending },
    { id: 'overdue', label: 'Overdue', value: t.overdue, amount: t.overdue },
    { id: 'unmatched', label: 'not matched to bills', value: Math.abs(unmatched), amount: unmatched, link: true },
  ];
  return items.filter((it) => it.amount !== 0);
}

/** The visible totals of the Parties table (ledger-signed like its cells) — what the stat is checked against. */
export function partiesTableTotals(r: Pick<PartySummaryResult, 'side' | 'totals'>): number[] {
  const s = r.side === 'receivable' ? 1 : -1;
  const t = r.totals;
  return [t.overdue * s, t.notDue * s, (t.advance + t.onAccount) * s, t.pending * s];
}

// ───────────────────────────── Parties view (2.1.2) ─────────────────────────────

/** Parties drawn as bars before the rest fold into "Other" (D26: Top 6 + Other). */
export const TOP_PARTIES = 6;

/**
 * Money on the side's natural side in words: a party on the other side (its advance outweighs its
 * bills) reads "₹x advance", never with a bare minus.
 */
export function advanceFormat(): ValueFormat {
  return {
    tick: (v) => (v < 0 ? `${compactValue(-v)} advance` : compactValue(v)),
    full: (v) => (v < 0 ? `${formatMoney(-v, { symbol: true })} advance` : formatMoney(v, { symbol: true })),
  };
}

/** The parties of the view in the bars' order: by |Net outstanding|, ties in table order (as `foldTop`). */
function rankedParties(rows: readonly PartyOutstandingRow[]): PartyOutstandingRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Math.abs(b.r.pending) - Math.abs(a.r.pending) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * The Parties view's graph (2.1.2 — the owner's change to D25): "Who owes me the most?" (receivables) /
 * "Whom do I owe the most?" (payables). One bar per party of its Net outstanding on the side's natural
 * side (`pending`, side-signed): a party whose advance outweighs its bills sits left of zero in slot 2
 * and says "advance". Top 6 + Other; inline in the Net outstanding column when the table has ≤ 7
 * parties (`inlineBars`). Total = Σ parties = the Net outstanding total of the rows shown
 * (`totals.pending`). Null below two parties with an amount (2.1.1 D2).
 * `onParty` (Enter on a bar = Enter on that party's row) receives the party's ledger id; "Other" opens nothing.
 */
export function partiesChart(r: Pick<PartySummaryResult, 'side' | 'rows'>, onParty?: (ledgerId: number) => void): ChartSpec | null {
  const ranked = rankedParties(r.rows);
  const f = foldTop(
    ranked,
    TOP_PARTIES,
    (p) => p.pending,
    (p) => p.ledgerName,
  );
  const named = f.categories.length < ranked.length ? f.categories.length - 1 : f.categories.length;
  const ids = ranked.slice(0, named).map((p) => p.ledgerId);
  const receivable = r.side === 'receivable';
  const spec: ChartSpec = {
    kind: 'bar',
    title: receivable ? 'Net outstanding by customer' : 'Net outstanding by supplier',
    takeaway: partiesTakeaway(ranked, receivable),
    categories: f.categories,
    series: [{ name: 'Net outstanding', values: f.values }],
    color: 'polarity',
    label: f.categories.length <= INLINE_MAX_ROWS ? 'tips' : 'none',
    valueFormat: advanceFormat(),
    total: f.values.reduce((a, b) => a + b, 0),
    activate: onParty
      ? (i) => {
          const id = ids[i];
          if (id !== undefined) onParty(id);
        }
      : undefined,
  };
  return enoughData(spec) ? spec : null;
}

/**
 * "Top 3 customers owe 72 % of ₹1.03 L" (the base is what the parties on the natural side owe / are
 * owed); with three or fewer such parties the largest by name ("Asha Retail owes 64 % of ₹82.6 K"). A
 * party in advance is said in words: "· advance from 1 customer". `ranked` is by |Net outstanding|.
 */
function partiesTakeaway(ranked: readonly PartyOutstandingRow[], receivable: boolean): string {
  const owing = ranked.filter((p) => p.pending > 0);
  const base = owing.reduce((a, p) => a + p.pending, 0);
  const advances = ranked.filter((p) => p.pending < 0);
  const n = advances.length;
  const who = (k: number): string => `${k} ${receivable ? 'customer' : 'supplier'}${k === 1 ? '' : 's'}`;
  const inAdvance = n > 0 ? ` · advance ${receivable ? 'from' : 'to'} ${who(n)}` : '';
  if (base <= 0) {
    const adv = compactValue(-advances.reduce((a, p) => a + p.pending, 0));
    return receivable ? `No customer owes you; ${adv} received in advance` : `You owe no supplier; ${adv} paid in advance`;
  }
  if (owing.length <= 3) {
    const top = owing[0];
    const tail = ` ${receivable ? 'owes' : 'is owed'} ${Math.round((top.pending / base) * 100)} % of ${compactValue(base)}${inAdvance}`;
    return clipTakeaway(`${clipTakeaway(top.ledgerName, Math.max(12, TAKEAWAY_MAX - tail.length))}${tail}`);
  }
  const top3 = owing.slice(0, 3).reduce((a, p) => a + p.pending, 0);
  return clipTakeaway(`Top 3 ${receivable ? 'customers owe' : 'suppliers are owed'} ${Math.round((top3 / base) * 100)} % of ${compactValue(base)}${inAdvance}`);
}

// ───────────────────────────── Days ─────────────────────────────

/** "190 d" — overdue days as plain text ('' when not overdue). */
export function daysText(days: number): string {
  return days > 0 ? `${days} d` : '';
}

/** Danger text only beyond the last ageing period (D25: "190 d" is plain until it passes the oldest bucket). */
export function isLate(days: number, limits: readonly number[]): boolean {
  const last = limits.length ? limits[limits.length - 1] : 0;
  return last > 0 && days > last;
}

// ───────────────────────────── Ageing (Ctrl+3) ─────────────────────────────

/** Coloured age ranges the ordinal ramp can tell apart (§4.3 rule 3). */
export const MAX_AGE_RANGES = 5;
/** "Old" money in the takeaway: over this many days, or over the nearest ageing limit below it. */
export const OLD_AFTER_DAYS = 90;

export interface AgeingColumn {
  label: string;
  /** Side-signed Σ of the bills in this range. */
  amount: Paise;
  /** First day overdue (by the report's basis) the range holds; null for "Not due". */
  minDays: number | null;
}

/**
 * The Ageing totals as graph columns: "Not due" first, then the age ranges; beyond five ranges the
 * oldest fold into one "> N days" column (Σ preserved), so the ramp never needs a sixth step.
 */
export function ageingColumns(buckets: readonly AgeingBucket[], amounts: readonly Paise[]): AgeingColumn[] {
  const cols = buckets.map((b, i) => ({ label: b.label, amount: amounts[i] ?? 0, minDays: b.minDays }));
  const [notDue, ...ranges] = cols;
  if (!notDue || ranges.length <= MAX_AGE_RANGES) return cols;
  const kept = ranges.slice(0, MAX_AGE_RANGES - 1);
  const rest = ranges.slice(MAX_AGE_RANGES - 1);
  const from = rest[0].minDays;
  const folded: AgeingColumn = { label: from !== null ? `> ${from - 1} days` : rest[0].label, amount: rest.reduce((s, c) => s + c.amount, 0), minDays: from };
  return [notDue, ...kept, folded];
}

/** The ageing limit the takeaway calls "old": the largest limit ≤ 90 days, else the first limit. */
export function oldThreshold(buckets: readonly AgeingBucket[]): number | null {
  const limits = buckets.map((b) => b.maxDays).filter((d): d is number => d !== null && d > 0);
  if (!limits.length) return null;
  const within = limits.filter((d) => d <= OLD_AFTER_DAYS);
  return within.length ? within[within.length - 1] : limits[0];
}

/**
 * The Ageing view's graph: unpaid bills by age (advances and on-account amounts are not age — the
 * table shows them in their own columns). Its total is Σ of the table's age-range columns
 * (= totals.total − advance − on account). Null below two non-zero columns (age buckets are categories,
 * 2.1.1 D2) or when nothing is unpaid.
 * `onColumn` (Enter on a column) receives the column's first overdue day (null = Not due).
 */
export function ageingChart(r: AgeingResult, onColumn?: (minDays: number | null) => void): ChartSpec | null {
  const cols = ageingColumns(r.buckets, r.totals.amounts);
  const values = cols.map((c) => c.amount);
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0 || values.filter((v) => v !== 0).length < 2) return null;
  const threshold = oldThreshold(r.buckets);
  const old = threshold === null ? 0 : cols.reduce((s, c) => s + (c.minDays !== null && c.minDays > threshold ? c.amount : 0), 0);
  const base = `${compactValue(total)} in unpaid bills`;
  return {
    kind: 'column',
    title: `${r.side === 'receivable' ? 'Receivables' : 'Payables'} by age`,
    takeaway: take.ordinal(old > 0 ? compactValue(old) : 'none', base, `${threshold ?? 0} days`),
    categories: cols.map((c) => c.label),
    series: [{ name: r.side === 'receivable' ? 'Receivable' : 'Payable', values }],
    color: 'ordinal',
    greyBefore: 1,
    label: 'max',
    total,
    activate: onColumn ? (i) => onColumn(cols[i]?.minDays ?? null) : undefined,
  };
}

// ───────────────────────────── Party Outstanding (meter) ─────────────────────────────

/** The party's balance on its own side (receivable: Dr +; payable: Cr +); null when it has no side. */
export function sideBalance(d: Pick<LedgerBillsResult, 'ledger' | 'balance'>): Paise | null {
  if (d.ledger.side === null) return null;
  return d.ledger.side === 'payable' ? -d.balance : d.balance;
}

/**
 * "Balance ₹A of limit ₹B" — only when the party has a credit limit and a balance on its side;
 * otherwise no graph. The meter's whole is the limit; its fill is the balance the footer shows.
 */
export function partyChart(d: Pick<LedgerBillsResult, 'ledger' | 'balance'>): ChartSpec | null {
  const limit = d.ledger.creditLimit ?? 0;
  const bal = sideBalance(d);
  if (limit <= 0 || bal === null || bal <= 0) return null;
  const pct = Math.round((bal / limit) * 100);
  const takeaway = bal > limit ? `${compactValue(bal - limit)} over the ${compactValue(limit)} credit limit` : `${pct} % of the ${compactValue(limit)} credit limit is used`;
  return {
    kind: 'meter',
    title: 'Balance against the credit limit',
    takeaway,
    categories: ['Balance'],
    series: [{ name: 'Balance', values: [bal] }],
    max: limit,
    total: limit,
  };
}

/** Over the credit limit (the context run's one danger word). */
export function overCreditLimit(d: Pick<LedgerBillsResult, 'ledger' | 'balance'>): boolean {
  const limit = d.ledger.creditLimit ?? 0;
  const bal = sideBalance(d);
  return limit > 0 && bal !== null && bal > limit;
}

// ───────────────────────────── Statement of Account (line) ─────────────────────────────

/**
 * The statement's side: the closing balance's (Dr for a customer who owes, Cr for a supplier owed),
 * else the opening's, else Dr. The line is drawn on that side so it rises when the party owes more.
 */
export function statementSide(s: Pick<StatementResult, 'openingBalance' | 'closingBalance'>): 1 | -1 {
  if (s.closingBalance !== 0) return s.closingBalance < 0 ? -1 : 1;
  return s.openingBalance < 0 ? -1 : 1;
}

/** Ticks and tooltips in Dr / Cr words, never a bare minus (`v` is on the statement's side). */
export function drCrFormat(sign: 1 | -1): { tick: (v: number) => string; full: (v: number) => string } {
  const side = sign === 1 ? 'Dr' : 'Cr';
  const other = sign === 1 ? 'Cr' : 'Dr';
  return {
    tick: (v) => (v === 0 ? compactValue(0) : `${compactValue(Math.abs(v))} ${v > 0 ? side : other}`),
    full: (v) => formatDrCr(v * sign, { keepZero: true }),
  };
}

/** The first point of the statement line: the opening balance. */
export const OPENING_LABEL = 'Opening';

/** The running balance at the end of each day with entries, after the opening on the first day. */
export function statementPoints(s: Pick<StatementResult, 'from' | 'openingBalance' | 'transactions'>): Array<{ date: string; balance: Paise; opening?: true }> {
  const out: Array<{ date: string; balance: Paise; opening?: true }> = [{ date: s.from, balance: s.openingBalance, opening: true }];
  for (const t of s.transactions) {
    const last = out[out.length - 1];
    if (last.date === t.date && !last.opening) last.balance = t.balance;
    else out.push({ date: t.date, balance: t.balance });
  }
  return out;
}

/**
 * The statement's graph: its running balance from the opening to the closing, on the party's side.
 * The last point is the table's closing balance (the line's total). Null below two points (2.1.1 D2).
 */
export function statementChart(s: Pick<StatementResult, 'from' | 'to' | 'openingBalance' | 'closingBalance' | 'transactions'>): ChartSpec | null {
  let points = statementPoints(s);
  if (points.length < MIN_LINE_POINTS) return null;
  if (points.length > MAX_LINE_POINTS) {
    const keep = decimate(points.map((p, x) => ({ x, y: p.balance })), MAX_LINE_POINTS).map((p) => p.x);
    points = keep.map((x) => points[x]);
  }
  const sign = statementSide(s);
  const values = points.map((p) => p.balance * sign);
  const first = values[0];
  const last = values[values.length - 1];
  const f = drCrFormat(sign);
  const delta = last === first ? `unchanged since ${formatDate(s.from, 'D-MMM-YY')}` : `${last > first ? 'up' : 'down'} ${compactValue(Math.abs(last - first))} since ${formatDate(s.from, 'D-MMM-YY')}`;
  return {
    kind: 'line',
    title: 'Running balance',
    takeaway: take.last(f.tick(last), formatDate(s.to, 'D-MMM-YY'), delta),
    categories: points.map((p, i) => (i === 0 && p.opening ? OPENING_LABEL : formatDate(p.date, 'D-MMM-YY'))),
    series: [{ name: 'Balance', values }],
    label: 'last',
    valueFormat: f,
    total: last,
  };
}
