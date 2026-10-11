/**
 * The graphs and stats of GST Reconciliation (SPEC-21 §5, WP-J2). Pure — tested in charts.test.ts.
 *
 *   reconChart     'gstrecon.home' Purchases / GSTR-1 views: one share bar of the documents by status —
 *                  Matched (+ accepted) grey; Amount differs, Not in books, Not on portal (Not in GSTR-1)
 *                  the problem pole. A segment = the status filter of the table (click / Enter).
 *   reconStat      the same views: "ITC at risk ₹x · Reconciled y % · ITC not booked ₹z" (purchases) or
 *                  "Tax not reported ₹x · Reported, not in books ₹y" (GSTR-1) — amounts the table never
 *                  totals (it is a paged list of documents)
 *   supplierChart  Supplier-wise view: bar of |tax difference| per supplier; inline in the table when it
 *                  is the table's ≤ 7 rows, else Top 6 + Other; the name says "less / more on portal"
 *
 * Duplicates and ignored documents are not drawn: they are neither matched nor a gap to chase (the
 * "Show" filter still lists them). So the share's total = every reconciled row − duplicates − ignored.
 */
import type { Paise } from '../../../../shared/money.ts';
import type { ReconStatus, ReconSummary, SupplierReconRow } from '../../../../shared/types/gstrecon.ts';
import { clipTakeaway, compactValue, enoughData, OTHER_LABEL } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { itcRiskCaption } from './recon.ts';

/** One item of the toolbar-row stat (ui/StatLine.tsx): a number is paise; a string is shown as written. */
export interface StatItem {
  label: string;
  value: Paise | string;
  title?: string;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** The share's segments: the statuses each one adds up, and the filter a click applies. */
const SEGMENTS: ReadonlyArray<{ statuses: readonly ReconStatus[]; filter: ReconStatus }> = [
  { statuses: ['matched', 'accepted'], filter: 'matched' },
  { statuses: ['partial'], filter: 'partial' },
  { statuses: ['missing_in_books'], filter: 'missing_in_books' },
  { statuses: ['missing_in_portal'], filter: 'missing_in_portal' },
];

/** Segment names, worded for the side reconciled. */
export function segmentLabels(source: ReconSummary['source']): string[] {
  return ['Matched', 'Amount differs', 'Not in books', source === 'gstr1' ? 'Not in GSTR-1' : 'Not on portal'];
}

/**
 * The documents of the period by status, as one share bar (counts). Null before the first run and
 * with fewer than 2 non-zero segments. `activate(status)` filters the table to that status.
 */
export function reconChart(s: Pick<ReconSummary, 'source' | 'run'>, activate?: (status: ReconStatus) => void): ChartSpec | null {
  if (!s.run) return null;
  const counts = s.run.counts;
  const values = SEGMENTS.map((g) => sum(g.statuses.map((st) => counts[st] ?? 0)));
  const labels = segmentLabels(s.source);
  const total = sum(values);
  const gaps = total - values[0];
  let top = 1;
  for (let i = 2; i < values.length; i++) if (values[i] > values[top]) top = i;
  const spec: ChartSpec = {
    kind: 'share',
    title: 'Documents by status',
    takeaway: gaps === 0 ? 'Every document matches or is accepted' : clipTakeaway(`${gaps} of ${total} need action; most: ${labels[top].toLowerCase()} (${values[top]})`),
    categories: labels,
    series: [{ name: 'Documents', values }],
    color: 'problem',
    emphasis: [1, 2, 3],
    valueFormat: 'number',
    total,
  };
  if (activate) spec.activate = (i) => activate(SEGMENTS[i]?.filter ?? 'matched');
  return enoughData(spec) ? spec : null;
}

/** The view's answer in words (empty before the first run). */
export function reconStat(s: Pick<ReconSummary, 'source' | 'run' | 'itcAtRisk' | 'itcNotBooked' | 'reconciledPct'>): StatItem[] {
  if (!s.run) return [];
  if (s.source === 'gstr1') {
    return [
      { label: 'Tax not reported', value: s.itcAtRisk.total, title: 'Tax in the books that GSTR-1 does not carry' },
      ...(s.itcNotBooked.total !== 0 ? [{ label: 'Reported, not in books', value: s.itcNotBooked.total, title: 'GSTR-1 higher than the books' }] : []),
    ];
  }
  return [
    { label: 'ITC at risk', value: s.itcAtRisk.total, title: itcRiskCaption(s) },
    { label: 'Reconciled', value: `${s.reconciledPct} %`, title: 'Portal documents matched or accepted' },
    ...(s.itcNotBooked.total !== 0 ? [{ label: 'ITC not booked', value: s.itcNotBooked.total, title: 'On the portal, not in your books' }] : []),
  ];
}

/** "Asha Traders · less on portal" — a supplier's bar name (its sign in words, never a minus). */
export function supplierLabel(r: Pick<SupplierReconRow, 'name' | 'gstin' | 'taxDifference'>): string {
  const who = r.name || r.gstin || '(no GSTIN)';
  return r.taxDifference < 0 ? `${who} · less on portal` : r.taxDifference > 0 ? `${who} · more on portal` : who;
}

/**
 * Whom to chase: the tax difference (portal − books) per supplier, as a size (|difference|); the bar
 * name says the side. Σ = Σ |difference| of the table's rows. `activate(row)` = Enter on that
 * supplier (its documents); "Other" opens nothing. Null with fewer than 2 suppliers that differ.
 */
export function supplierChart(rows: readonly SupplierReconRow[], activate?: (row: SupplierReconRow) => void): ChartSpec | null {
  const ranked = rows.map((r, i) => ({ r, v: Math.abs(r.taxDifference), i })).sort((a, b) => b.v - a.v || a.i - b.i);
  const fold = ranked.length > 7;
  const head = fold ? ranked.slice(0, 6) : ranked;
  const rest = fold ? ranked.slice(6) : [];
  const categories = [...head.map((x) => supplierLabel(x.r)), ...(rest.length ? [OTHER_LABEL] : [])];
  const values = [...head.map((x) => x.v), ...(rest.length ? [sum(rest.map((x) => x.v))] : [])];
  const first = head[0];
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Tax difference by supplier',
    takeaway:
      first && first.v > 0
        ? clipTakeaway(`${first.r.name || first.r.gstin || '(no GSTIN)'}: ${compactValue(first.v)} ${first.r.taxDifference < 0 ? 'less' : 'more'} on the portal than in your books`)
        : '',
    categories,
    series: [{ name: 'Tax difference', values }],
    label: 'tips',
    total: sum(values),
  };
  if (activate) {
    spec.activate = (i) => {
      const x = head[i];
      if (x) activate(x.r);
    };
  }
  return enoughData(spec) ? spec : null;
}
