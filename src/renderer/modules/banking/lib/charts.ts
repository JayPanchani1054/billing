/**
 * The graphs and stat lines of the banking screens (2.1, SPEC-21 §5 "Banking and cheques", D24, D26).
 * Pure — no React — so every builder's "graph total = table total" and every stat's "never a visible
 * total" are tested in node (charts.test.ts). A builder returns null when the data cannot carry the
 * graph (< 2 accounts, < 2 weeks with cheques — categories need two non-zero values, 2.1.1 D2): the
 * screen then shows no strip and no Ctrl+J.
 *
 *   banking.summary   bar per bank account of the balance as per books (polarity: an overdrawn OD / CC
 *                     account is left of 0 in slot 2) — inline in the table for ≤ 7 accounts, a Top-6 +
 *                     Other strip beyond; none with fewer than 2 accounts. Stat: entries not in the bank
 *                     yet · statement lines to match ›
 *   banking.pdc       columns of the post-dated cheques by week (Due now, Week 1 … Week 8, Later), the
 *                     net of what comes in (↑ slot 1) and goes out (↓ slot 2)
 *   banking.cheques   no graph (two numbers) — stat: not cleared, issued ₹x · received ₹y · stale N
 *   banking.brs       no graph (the books → bank bridge is the picture) — stat: agrees ✓ / difference ₹x
 *
 * Money is paise, signed like the books (Dr + = money in the bank, an overdraft Cr −).
 */
import type { BankSummaryRow, BrsResult, ChequeRegisterResult, PdcResult, PdcRow } from '../../../../shared/types/banking.ts';
import { clipTakeaway, compactValue, drawnTotal, INLINE_MAX_ROWS, OTHER_LABEL } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import type { BrsStatus } from './brsGrid.ts';

/** Rows of a bar strip before "Other" (Top 6 + Other, §5 legend "T6+O"). */
export const BAR_TOP = 6;

/** One item of a stat line, without its click handler (the screen adds it by `id`). */
export interface StatItemSpec {
  id: string;
  label: string;
  /** Paise (exact money) or words ("5 entries"). */
  value: number | string;
  tone?: 'warning' | 'danger';
  title?: string;
  link?: boolean;
}

/** A spec with its `total` set to what it draws (tests compare it with the table's total). */
function withTotal(spec: Omit<ChartSpec, 'total'>): ChartSpec {
  const s: ChartSpec = { ...spec, total: 0 };
  return { ...s, total: drawnTotal(s) };
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

// ───────────────────────────── Bank Overview ─────────────────────────────

/** The name a bank account goes by in the graph: "HDFC Bank", "SBI CC (OD/CC)". */
export function bankBarLabel(b: Pick<BankSummaryRow, 'name' | 'isOd'>): string {
  return b.isOd ? `${b.name} (OD/CC)` : b.name;
}

/** The bars of the Bank Overview graph: the account behind each one (null for "Other"). */
export interface BankBar {
  label: string;
  value: number;
  bank: BankSummaryRow | null;
}

/**
 * One bar per account in table order while there are ≤ 7 (the categories are the table's rows, so the
 * screen draws them inline, D26); more: the non-zero ones by |balance|, the top 6 by name and the rest as
 * "Other" (a single leftover account keeps its name). Σ is preserved exactly.
 */
export function bankBars(banks: readonly BankSummaryRow[]): BankBar[] {
  if (banks.length <= INLINE_MAX_ROWS) return banks.map((b) => ({ label: bankBarLabel(b), value: b.balanceAsPerBooks, bank: b }));
  const ranked = banks
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.balanceAsPerBooks !== 0)
    .sort((a, z) => Math.abs(z.b.balanceAsPerBooks) - Math.abs(a.b.balanceAsPerBooks) || a.i - z.i);
  const fold = ranked.length > BAR_TOP + 1;
  const head = fold ? ranked.slice(0, BAR_TOP) : ranked;
  const out: BankBar[] = head.map((x) => ({ label: bankBarLabel(x.b), value: x.b.balanceAsPerBooks, bank: x.b }));
  if (fold) {
    const tail = ranked.slice(BAR_TOP);
    out.push({ label: out.some((s) => s.label === OTHER_LABEL) ? `${OTHER_LABEL} (${tail.length})` : OTHER_LABEL, value: tail.reduce((s, x) => s + x.b.balanceAsPerBooks, 0), bank: null });
  }
  return out;
}

/**
 * "Where is my money sitting, bank by bank?" — the balance as per books of every account (polarity: an
 * overdrawn account is drawn left of 0 in slot 2, and the takeaway says "overdrawn"). Null with fewer
 * than 2 accounts (a single bank needs no graph) or fewer than 2 non-zero balances (2.1.1 D2).
 * `open(id)` = Enter on that account's row (the reconciliation); "Other" opens nothing.
 */
export function bankBalancesChart(banks: readonly BankSummaryRow[], open?: (ledgerId: number) => void): ChartSpec | null {
  if (banks.length < 2) return null;
  const bars = bankBars(banks);
  if (bars.filter((b) => b.value !== 0).length < 2) return null;
  return withTotal({
    kind: 'bar',
    title: 'Money in each bank',
    takeaway: bankTakeaway(banks),
    categories: bars.map((b) => b.label),
    series: [{ name: 'Balance as per books', values: bars.map((b) => b.value) }],
    color: 'polarity',
    label: 'tips',
    activate: open
      ? (i) => {
          const bank = bars[i]?.bank;
          if (bank) open(bank.id);
        }
      : undefined,
  });
}

/** "HDFC Bank holds 70 % of the money in banks · 1 overdrawn" / "All 3 accounts overdrawn; most on SBI CC (₹4.2 L)". */
export function bankTakeaway(banks: readonly BankSummaryRow[]): string {
  const inBank = banks.filter((b) => b.balanceAsPerBooks > 0);
  const overdrawn = banks.filter((b) => b.balanceAsPerBooks < 0);
  if (inBank.length === 0) {
    if (overdrawn.length === 0) return 'Every account is at zero';
    const worst = overdrawn.reduce((a, b) => (b.balanceAsPerBooks < a.balanceAsPerBooks ? b : a));
    return clipTakeaway(`All ${plural(overdrawn.length, 'account', 'accounts')} overdrawn; most on ${worst.name} (${compactValue(-worst.balanceAsPerBooks)})`);
  }
  const total = inBank.reduce((s, b) => s + b.balanceAsPerBooks, 0);
  const top = inBank.reduce((a, b) => (b.balanceAsPerBooks > a.balanceAsPerBooks ? b : a));
  const pct = Math.round((top.balanceAsPerBooks / total) * 100);
  const tail = overdrawn.length > 0 ? ` · ${overdrawn.length} overdrawn` : '';
  const head = ` holds ${pct} % of the money in banks${tail}`;
  const room = 90 - head.length;
  const name = top.name.length > room ? clipTakeaway(top.name, Math.max(8, room)) : top.name;
  return clipTakeaway(`${name}${head}`);
}

/**
 * The Bank Overview's answer in words (D24 — never the table's totals, which the Total row shows):
 * the entries not yet in the bank (cheques not presented, deposits not cleared) and, as the one link,
 * the imported statement lines still to match. Zero items are left out.
 */
export function bankSummaryStat(banks: readonly BankSummaryRow[]): StatItemSpec[] {
  const open = banks.reduce((s, b) => s + b.unreconciled.count, 0);
  const toMatch = banks.reduce((s, b) => s + b.statementLines.unmatched, 0);
  const out: StatItemSpec[] = [];
  if (open > 0) out.push({ id: 'open', label: 'Not in the bank yet', value: plural(open, 'entry', 'entries'), title: 'Cheques issued but not presented, and deposits not yet cleared' });
  if (toMatch > 0) out.push({ id: 'match', label: toMatch === 1 ? 'statement line to match' : 'statement lines to match', value: toMatch.toLocaleString('en-IN'), link: true, title: 'Match statement · Alt+M' });
  return out;
}

/** The figures of the Bank Overview table's Total row (what a stat must never repeat). */
export function bankSummaryTotals(banks: readonly BankSummaryRow[]): number[] {
  const sum = (f: (b: BankSummaryRow) => number) => banks.reduce((s, b) => s + f(b), 0);
  return [sum((b) => b.balanceAsPerBooks), sum((b) => b.unreconciled.issued), sum((b) => b.unreconciled.deposits), sum((b) => b.balanceAsPerBank)];
}

// ───────────────────────────── Post-dated cheques ─────────────────────────────

/** Weeks drawn one by one before "Later". */
export const PDC_WEEKS = 8;

/** The bucket of a PDC: 0 = Due now (matured), 1 … 8 = the week it matures in (days 1–7, 8–14 …), 9 = Later. */
export function pdcBucket(r: Pick<PdcRow, 'daysToMaturity' | 'matured'>): number {
  if (r.matured || r.daysToMaturity <= 0) return 0;
  return Math.min(PDC_WEEKS + 1, Math.floor((r.daysToMaturity - 1) / 7) + 1);
}

export const PDC_BUCKETS: readonly string[] = ['Due now', ...Array.from({ length: PDC_WEEKS }, (_, i) => `Week ${i + 1}`), 'Later'];

/** Signed: a cheque received (receivable) comes in (+), one issued (payable) goes out (−). */
export const pdcSigned = (r: Pick<PdcRow, 'kind' | 'amount'>): number => (r.kind === 'receivable' ? r.amount : -r.amount);

/**
 * "What comes in and goes out, week by week?" — the net of the post-dated cheques maturing in each week
 * (in ↑ slot 1, out ↓ slot 2; captions In ↑ / Out ↓). Its total is In − Out of the table's totals.
 * Null with fewer than 2 weeks that have a non-zero net (maturity buckets are categories, 2.1.1 D2).
 */
export function pdcChart(result: Pick<PdcResult, 'rows'>): ChartSpec | null {
  const values = PDC_BUCKETS.map(() => 0);
  for (const r of result.rows) values[pdcBucket(r)] += pdcSigned(r);
  if (values.filter((v) => v !== 0).length < 2) return null;
  return withTotal({
    kind: 'column',
    title: 'Post-dated cheques by week',
    takeaway: pdcTakeaway(values),
    categories: PDC_BUCKETS,
    series: [{ name: 'In − out', values }],
    color: 'polarity',
    axisCaptions: { up: 'In ↑', down: 'Out ↓' },
    label: 'max',
  });
}

/** "Most coming in: Week 2 (₹1.2 L) · most going out: Week 5 (₹40 K)". */
export function pdcTakeaway(values: readonly number[]): string {
  let inAt = -1;
  let outAt = -1;
  values.forEach((v, i) => {
    if (v > 0 && (inAt < 0 || v > values[inAt])) inAt = i;
    if (v < 0 && (outAt < 0 || v < values[outAt])) outAt = i;
  });
  const parts: string[] = [];
  if (inAt >= 0) parts.push(`most coming in: ${PDC_BUCKETS[inAt]} (${compactValue(values[inAt])})`);
  if (outAt >= 0) parts.push(`most going out: ${PDC_BUCKETS[outAt]} (${compactValue(-values[outAt])})`);
  const s = parts.join(' · ');
  return clipTakeaway(s.charAt(0).toUpperCase() + s.slice(1));
}

/** The PDC table's In cell: a cheque received (from a customer); 0 for one issued. The screen's column uses it. */
export const pdcIn = (r: Pick<PdcRow, 'kind' | 'amount'>): number => (r.kind === 'receivable' ? r.amount : 0);
/** The PDC table's Out cell: a cheque issued (to a supplier); 0 for one received. The screen's column uses it. */
export const pdcOut = (r: Pick<PdcRow, 'kind' | 'amount'>): number => (r.kind === 'receivable' ? 0 : r.amount);

/** The PDC table's two totals (its Total row): Σ In and Σ Out, from the same cell functions as the columns. */
export function pdcTableTotals(rows: readonly Pick<PdcRow, 'kind' | 'amount'>[]): { in: number; out: number } {
  let inn = 0;
  let out = 0;
  for (const r of rows) {
    inn += pdcIn(r);
    out += pdcOut(r);
  }
  return { in: inn, out };
}

// ───────────────────────────── Cheque Register ─────────────────────────────

/**
 * "Uncleared cheques?" — two numbers, no graph: not cleared, issued ₹x · received ₹y · stale N. An
 * amount equal to the table's visible total (e.g. the Not cleared view of issued cheques only) is left
 * out: the Total row already says it (D24). Zero items are left out.
 */
export function chequeRegisterStat(result: ChequeRegisterResult): StatItemSpec[] {
  const t = result.totals;
  const tableTotal = result.rows.reduce((s, r) => s + r.amount, 0);
  const out: StatItemSpec[] = [];
  const money = (id: string, label: string, v: number, title: string) => {
    if (v !== 0 && v !== tableTotal) out.push({ id, label, value: v, title });
  };
  money('issued', 'Issued, not cleared', t.issued.unclearedAmount, plural(t.issued.uncleared, 'cheque', 'cheques'));
  money('received', 'Received, not cleared', t.received.unclearedAmount, plural(t.received.uncleared, 'cheque', 'cheques'));
  if (t.stale > 0) out.push({ id: 'stale', label: 'Stale', value: plural(t.stale, 'cheque', 'cheques'), tone: 'danger', title: 'Not cleared 3 months after their date — re-issue or cancel' });
  return out;
}

// ───────────────────────────── Bank Reconciliation ─────────────────────────────

/**
 * "Does the bank agree?" — no graph (the books → bank lines are the picture): "Agrees ✓" once the
 * imported statement matches, else the difference (danger while unexplained, warning when the statement
 * lines not yet in the books explain it). Nothing before a statement is imported.
 */
export function brsStat(r: Pick<BrsResult, 'difference' | 'unexplainedDifference'>, status: BrsStatus): StatItemSpec[] {
  if (status === 'no_statement' || r.difference === null) return [];
  if (status === 'agrees') return [{ id: 'agrees', label: 'Bank statement', value: 'Agrees ✓', title: 'The books agree with the imported bank statement' }];
  const explained = status === 'explained';
  return [
    {
      id: 'difference',
      label: explained ? 'Difference, explained' : 'Difference',
      value: Math.abs(r.difference),
      tone: explained ? 'warning' : 'danger',
      title: explained ? 'Statement lines not yet entered in the books explain it' : 'Statement − bank as per books, not explained yet',
    },
  ];
}
