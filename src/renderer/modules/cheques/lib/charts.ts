/**
 * The graph and stat line of the Cheque Leaf Register (2.1, SPEC-21 §5 "Banking and cheques", D24).
 * Pure — no React — so "graph total = table total" and "a stat never repeats a visible total" are tested
 * in node (charts.test.ts).
 *
 *   cheques.register   meter "Leaves used N of M" (static, role=img) — only with one cheque book chosen
 *                      (a bank's books together are not one stock of leaves); none otherwise, or while no
 *                      leaf is used. Stat: issued, not cleared ₹x · stale N · (no book chosen) unused N.
 *   every other cheques screen: masters and printing workflows, deliberately no graph.
 */
import type { ChequeRegisterResult } from '../../../../shared/types/cheques.ts';
import { clipTakeaway, drawnTotal } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';

/** One item of a stat line, without its click handler. */
export interface StatItemSpec {
  id: string;
  label: string;
  /** Paise (exact money) or words ("3 cheques"). */
  value: number | string;
  tone?: 'warning' | 'danger';
  title?: string;
}

/** Few enough unused leaves to say "order a new book". */
export const LOW_LEAVES = 5;

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** Counts of leaves are whole numbers: "18" on the meter, "18 leaves" in its tooltip. */
const LEAVES = { tick: (v: number) => Math.round(v).toLocaleString('en-IN'), full: (v: number) => plural(Math.round(v), 'leaf', 'leaves') };

/**
 * "Leaves left in this book" — a meter of the leaves used (issued, cleared, stale or cancelled) against
 * the book's leaves. Its whole (`total`) is the book's leaf count = the rows of the All leaves view.
 * Null without a chosen book, with no leaf, or while no leaf is used yet.
 */
export function leafMeter(result: Pick<ChequeRegisterResult, 'totals'>, bookName: string | null): ChartSpec | null {
  if (bookName === null) return null;
  const { leaves, unused } = result.totals;
  const used = leaves - unused;
  if (leaves <= 0 || used <= 0) return null;
  const spec: ChartSpec = {
    kind: 'meter',
    title: 'Leaves used',
    takeaway: leafTakeaway(unused, leaves, bookName),
    categories: [bookName],
    series: [{ name: 'Leaves used', values: [used] }],
    valueFormat: LEAVES,
    max: leaves,
    total: 0,
  };
  return { ...spec, total: drawnTotal(spec) };
}

/** "7 of 25 leaves left in 000501–000525" · "… — order a new book" · "No leaf left in …". */
export function leafTakeaway(unused: number, leaves: number, bookName: string): string {
  if (unused <= 0) return clipTakeaway(`No leaf left in ${bookName} — order a new book`);
  const head = `${unused.toLocaleString('en-IN')} of ${plural(leaves, 'leaf', 'leaves')} left in ${bookName}`;
  return clipTakeaway(unused <= LOW_LEAVES ? `${head} — order a new book` : head);
}

/**
 * The register's answer in words (D24): the cheques issued but not presented as on the date (the BRS's
 * figure), the stale ones (danger), and — when no single book is chosen, so no meter — the unused leaves.
 * An amount equal to the table's visible total is left out (the Total row says it); zeros are left out.
 */
export function leafStat(result: Pick<ChequeRegisterResult, 'rows' | 'totals'>, bookChosen: boolean): StatItemSpec[] {
  const t = result.totals;
  const tableTotal = leafTableTotal(result);
  const out: StatItemSpec[] = [];
  if (t.unclearedAmount !== 0 && t.unclearedAmount !== tableTotal) {
    out.push({ id: 'uncleared', label: 'Issued, not cleared', value: t.unclearedAmount, title: 'Cheques issued but not presented, as Bank Reconciliation counts them on this date' });
  }
  if (t.stale > 0) out.push({ id: 'stale', label: 'Stale', value: plural(t.stale, 'cheque', 'cheques'), tone: 'danger', title: 'Valid 3 months from their date: re-issue them, or cancel the payment' });
  if (!bookChosen && t.unused > 0) out.push({ id: 'unused', label: 'Unused', value: plural(t.unused, 'leaf', 'leaves'), title: `${t.cleared} cleared · ${t.cancelled} cancelled` });
  return out;
}

/** The Total row of the register's table (the Amount column). */
export function leafTableTotal(result: Pick<ChequeRegisterResult, 'rows'>): number {
  return result.rows.reduce((s, r) => s + (r.amount ?? 0), 0);
}
