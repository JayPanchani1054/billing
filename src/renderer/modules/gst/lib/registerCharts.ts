/**
 * The graphs and stats of the GST registers, exceptions, e-documents and bills of entry (SPEC-21 §5,
 * WP-J2). Pure — tested in registerCharts.test.ts ("graph total = table total" for every builder, the
 * gates, the takeaways and the stat rule D24).
 *
 *   rateChart        'gst.register'    column: taxable value by GST rate (Σ = the Taxable value total)
 *   hsnChart         'gst.hsn'         bar: taxable value by HSN/SAC code — inline in the table when every
 *                                      code is one of its ≤ 7 rows, else Top 6 + Other
 *   itcChart         'gst.itc'         bar: eligible ITC by supplier, Top 6 + Other (rows are suppliers'
 *                                      documents summed, so always a strip); Enter = the supplier's ledger
 *   itcStat          'gst.itc'         "Blocked ₹y" (only when > 0; the Blocked column shows no total)
 *   exceptionsChart  'gst.exceptions'  bar: problems by type (error types slot 2, warning types grey);
 *                                      Enter / click = filter the table to that type
 *   exceptionsStat   'gst.exceptions'  "Errors N · Warnings M"
 *   boeChart         'gst.boe'         share of the reconcile view (Matched grey; the three gaps slot 2)
 *   boeStat          'gst.boe'         "Matched N of M"
 *   pendingStat      'gst.einvoice', 'gst.ewaybill'   "Pending N · Ready M" (counts, never money)
 *   advancesStat     'gst.advances'    "Net tax in 3.1(a) ₹x" (received − adjusted, all heads)
 *
 * A builder returns null when the data cannot carry the graph (`enoughData`: ≥ 2 non-zero categories,
 * or a gate named on the builder); the screen then shows no strip and no Ctrl+J item.
 */
import { formatMoney, formatPercent } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { BoeReconResult, Gstr1AdvancesSummary } from '../../../../shared/types/gst-plus.ts';
import type { GstHsnSummaryResult, GstIssue, GstIssueCode, GstItcResult, GstItcSupplierRow, GstRegisterResult, TaxAmounts } from '../../../../shared/types/gst-returns.ts';
import { clipTakeaway, enoughData, OTHER_LABEL, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { ISSUE_CODE_LABELS } from './issues.ts';

/** One item of a toolbar-row stat (ui/StatLine.tsx): a number is paise; a string is shown as written. */
export interface StatItem {
  label: string;
  value: Paise | string;
  title?: string;
}

const taxOf = (t: TaxAmounts): Paise => t.igst + t.cgst + t.sgst + t.cess;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const rupees = (p: Paise): string => `₹${formatMoney(p)}`;

/**
 * Top `n` by |value| (ties keep input order) and the rest as one "Other" — the fold of `foldTop`
 * (ui/lib/chartSpec.ts: never an "Other" of a single item, Σ preserved), keeping the folded items
 * so a bar can open its row.
 */
export function topItems<T>(items: readonly T[], value: (t: T) => number, n = 6): { head: T[]; rest: T[] } {
  const ranked = items.map((t, i) => ({ t, v: value(t), i })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i);
  if (ranked.length <= n + 1) return { head: ranked.map((r) => r.t), rest: [] };
  return { head: ranked.slice(0, n).map((r) => r.t), rest: ranked.slice(n).map((r) => r.t) };
}

/** Index of the largest |value| (−1 when empty). */
function largest(values: readonly number[]): number {
  let top = -1;
  values.forEach((v, i) => {
    if (top < 0 || Math.abs(v) > Math.abs(values[top])) top = i;
  });
  return top;
}

/** "18% carries 72 % of the taxable value" — the share of the largest category. */
function shareTakeaway(categories: readonly string[], values: readonly number[], of: string): string {
  const top = largest(values);
  const whole = values.reduce((a, v) => a + Math.abs(v), 0);
  return top >= 0 && whole > 0 ? take.share(categories[top], (Math.abs(values[top]) / whole) * 100, of) : '';
}

// ───────────────────────────── GST Register ─────────────────────────────

/**
 * Taxable value by GST rate (cess variants of a rate added together), lowest rate first — the
 * question "how much of what I sell is at which rate". Σ = `totals.taxable` (the register's Taxable
 * value total). Null with fewer than 2 rates, or when a rate is negative (its returns exceed its
 * sales: a column of it could not be read as a part of the whole).
 */
export function rateChart(r: Pick<GstRegisterResult, 'kind' | 'rateTotals'>): ChartSpec | null {
  const byRate = new Map<number, number>();
  for (const x of r.rateTotals) byRate.set(x.rate, (byRate.get(x.rate) ?? 0) + x.taxable);
  const rates = [...byRate.keys()].sort((a, b) => a - b);
  const values = rates.map((k) => byRate.get(k) ?? 0);
  if (values.some((v) => v < 0)) return null;
  const categories = rates.map((k) => formatPercent(k));
  const sales = r.kind === 'sales';
  const spec: ChartSpec = {
    kind: 'column',
    title: sales ? 'Sales before GST, by rate' : 'Purchases before GST, by rate',
    takeaway: shareTakeaway(categories, values, sales ? 'taxable sales' : 'taxable purchases').replace(' holds ', ' carries '),
    categories,
    series: [{ name: 'Taxable value', values }],
    label: 'max',
    total: sum(values),
  };
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── HSN/SAC Summary ─────────────────────────────

/** "8471 · Computers" — the code and the first words of its description (the bar's name). */
export function hsnLabel(hsn: string, description: string): string {
  const code = hsn || 'No HSN/SAC';
  const words = description.trim();
  if (!words) return code;
  const short = words.length > 22 ? `${words.slice(0, 21).trimEnd()}…` : words;
  return `${code} · ${short}`;
}

/**
 * Taxable value by HSN/SAC code (the rows of one code — units, rates — added together). Σ = the
 * Taxable value total of the table. Drawn inline (`inlineBars(spec, rows.length)`) when every code is
 * one row and there are ≤ 7; else a strip of Top 6 + Other. Null with fewer than 2 codes, or when a
 * code is negative (inward returns larger than purchases).
 */
export function hsnChart(r: Pick<GstHsnSummaryResult, 'direction' | 'rows'>): ChartSpec | null {
  const codes = new Map<string, { label: string; value: number }>();
  for (const row of r.rows) {
    const c = codes.get(row.hsn) ?? { label: hsnLabel(row.hsn, row.description), value: 0 };
    c.value += row.taxable;
    codes.set(row.hsn, c);
  }
  const all = [...codes.values()];
  if (all.some((c) => c.value < 0)) return null;
  const { head, rest } = topItems(all, (c) => c.value);
  const categories = [...head.map((c) => c.label), ...(rest.length ? [OTHER_LABEL] : [])];
  const values = [...head.map((c) => c.value), ...(rest.length ? [sum(rest.map((c) => c.value))] : [])];
  const spec: ChartSpec = {
    kind: 'bar',
    title: r.direction === 'outward' ? 'Taxable sales by HSN/SAC' : 'Taxable purchases by HSN/SAC',
    takeaway: shareTakeaway(categories, values, 'the taxable value'),
    categories,
    series: [{ name: 'Taxable value', values }],
    label: 'tips',
    total: sum(values),
  };
  return enoughData(spec) ? spec : null;
}

// ───────────────────────────── Input Tax Credit ─────────────────────────────

/** Eligible ITC of a supplier row (all heads, net of purchase returns). */
export const eligibleOf = (r: Pick<GstItcSupplierRow, 'eligible'>): Paise => taxOf(r.eligible);

/**
 * Eligible ITC by supplier, Top 6 + Other — whom the credit comes from. Σ = the eligible ITC of the
 * table (its four Eligible columns' totals added). A supplier whose returns exceed its purchases
 * (negative credit) turns the graph to polarity (slot 2, left of zero). `activate(row)` = Enter on
 * that supplier's row (its ledger); "Other" opens nothing.
 */
export function itcChart(r: Pick<GstItcResult, 'rows'>, activate?: (row: GstItcSupplierRow) => void): ChartSpec | null {
  const withCredit = r.rows.filter((x) => eligibleOf(x) !== 0);
  const { head, rest } = topItems(withCredit, eligibleOf);
  const categories = [...head.map((x) => x.partyName), ...(rest.length ? [OTHER_LABEL] : [])];
  const values = [...head.map(eligibleOf), ...(rest.length ? [sum(rest.map(eligibleOf))] : [])];
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Eligible ITC by supplier',
    takeaway: shareTakeaway(categories, values, 'eligible ITC'),
    categories,
    series: [{ name: 'Eligible ITC', values }],
    label: 'tips',
    total: sum(values),
  };
  if (values.some((v) => v < 0)) spec.color = 'polarity';
  if (activate) {
    spec.activate = (i) => {
      const row = head[i];
      if (row) activate(row);
    };
  }
  return enoughData(spec) ? spec : null;
}

/**
 * The ITC screen's answer in words: the credit blocked under s.17(5) — only when there is some. The
 * table's Blocked column therefore shows no total (D24: a stat never repeats a visible total).
 */
export function itcStat(r: Pick<GstItcResult, 'totals'>): StatItem[] {
  const blocked = taxOf(r.totals.ineligible);
  return blocked !== 0 ? [{ label: 'Blocked', value: blocked, title: 'Credit blocked under s.17(5) — not claimable' }] : [];
}

// ───────────────────────────── GST Exceptions ─────────────────────────────

/**
 * Problems by type — what blocks filing. One bar per problem type (most frequent first), Top 6 +
 * Other; a type with an error is the problem pole (slot 2), a warning-only type is grey. Σ = the number
 * of rows of the table (every issue). `activate(code)` = filter the table to that type ("Other" clears
 * it: `null`). Null with fewer than 2 types — and with no issue at all (the success line says it).
 */
export function exceptionsChart(issues: readonly GstIssue[], activate?: (code: GstIssueCode | null) => void): ChartSpec | null {
  const byCode = new Map<GstIssueCode, { count: number; error: boolean }>();
  for (const i of issues) {
    const c = byCode.get(i.code) ?? { count: 0, error: false };
    c.count++;
    if (i.severity === 'error') c.error = true;
    byCode.set(i.code, c);
  }
  const types = [...byCode.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const { head, rest } = topItems(types, (t) => t.count);
  const categories = [...head.map((t) => ISSUE_CODE_LABELS[t.code] ?? t.code), ...(rest.length ? [OTHER_LABEL] : [])];
  const values = [...head.map((t) => t.count), ...(rest.length ? [sum(rest.map((t) => t.count))] : [])];
  const errorAt = [...head.map((t) => t.error), ...(rest.length ? [rest.some((t) => t.error)] : [])];
  const errorTypes = types.filter((t) => t.error).length;
  const top = types[0];
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Problems by type',
    takeaway: top
      ? clipTakeaway(
          `${errorTypes === 0 ? 'No type blocks filing' : `${errorTypes} of ${types.length} types block filing`}; most often ${ISSUE_CODE_LABELS[top.code] ?? top.code} (${top.count})`,
        )
      : '',
    categories,
    series: [{ name: 'Problems', values }],
    color: 'problem',
    emphasis: errorAt.flatMap((e, i) => (e ? [i] : [])),
    label: 'tips',
    valueFormat: 'number',
    total: sum(values),
  };
  if (activate) spec.activate = (i) => activate(head[i]?.code ?? null);
  return issues.length > 0 && enoughData(spec) ? spec : null;
}

/** "Errors 3 · Warnings 1" — counts (zero items left out). */
export function exceptionsStat(counts: { errors: number; warnings: number }): StatItem[] {
  return [
    ...(counts.errors > 0 ? [{ label: 'Errors', value: String(counts.errors), title: 'Must be fixed before filing' }] : []),
    ...(counts.warnings > 0 ? [{ label: 'Warnings', value: String(counts.warnings), title: 'Worth a look' }] : []),
  ];
}

// ───────────────────────────── Bills of entry ─────────────────────────────

const BOE_SEGMENTS = [
  ['matched', 'Matched'],
  ['mismatch', 'Mismatch'],
  ['missing_in_books', 'Not in books'],
  ['missing_in_portal', 'Not in GSTR-2B'],
] as const;

/**
 * The reconcile view as one share bar: Matched in grey, the three gaps (Mismatch, Not in books, Not
 * in GSTR-2B) as the problem pole. Σ = the rows of the reconciliation table. Null with fewer than 2
 * non-zero segments (one part is a sentence — the stat says it; 2.1.1 D2).
 */
export function boeChart(r: Pick<BoeReconResult, 'counts' | 'rows'>): ChartSpec | null {
  const values = BOE_SEGMENTS.map(([k]) => r.counts[k] ?? 0);
  const total = sum(values);
  const gaps = total - values[0];
  const spec: ChartSpec = {
    kind: 'share',
    title: 'Bills of entry against GSTR-2B',
    takeaway: gaps === 0 ? 'Every bill of entry agrees with GSTR-2B' : `${gaps} of ${total} bills of entry do not agree with GSTR-2B`,
    categories: BOE_SEGMENTS.map(([, label]) => label),
    series: [{ name: 'Bills of entry', values }],
    color: 'problem',
    emphasis: [1, 2, 3],
    valueFormat: 'number',
    total,
  };
  return enoughData(spec) ? spec : null;
}

/** "Matched 4 of 6". */
export function boeStat(r: Pick<BoeReconResult, 'counts' | 'rows'>): StatItem[] {
  if (r.rows.length === 0) return [];
  return [{ label: 'Matched', value: `${r.counts.matched ?? 0} of ${r.rows.length}`, title: 'Bills of entry that agree with GSTR-2B' }];
}

// ───────────────────────────── e-Invoice / e-Way Bills ─────────────────────────────

/** "Pending 12 · Ready 9" — the work queue in counts. */
export function pendingStat(rows: ReadonlyArray<{ ready: boolean }>): StatItem[] {
  if (rows.length === 0) return [];
  const ready = rows.filter((r) => r.ready).length;
  return [
    { label: 'Pending', value: String(rows.length) },
    { label: 'Ready', value: String(ready), title: ready < rows.length ? `${rows.length - ready} need a fix first` : 'Every pending document can be exported' },
  ];
}

// ───────────────────────────── Advances (Table 11) ─────────────────────────────

/**
 * The one figure of Table 11: the net tax on advances that goes into GSTR-3B 3.1(a) (received in 11A
 * − adjusted or refunded in 11B, all heads). Empty when nothing was received or adjusted.
 */
export function advancesStat(a: Pick<Gstr1AdvancesSummary, 'received' | 'adjusted' | 'net'>): StatItem[] {
  const received = sum(a.received.map(taxOf));
  const adjusted = sum(a.adjusted.map(taxOf));
  if (received === 0 && adjusted === 0) return [];
  return [{ label: 'Net tax in 3.1(a)', value: taxOf(a.net), title: `Received (11A) ${rupees(received)} − adjusted / refunded (11B) ${rupees(adjusted)} · taxable ${rupees(a.net.taxable)}` }];
}
