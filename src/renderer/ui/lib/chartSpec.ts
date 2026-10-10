/**
 * The 2.1 graph contract (docs/ARCHITECTURE.md §7b, SPEC-21 §4.1): what a report hands the chart kit,
 * the folding helpers its builders use, and the rules every graph obeys. Pure — no React, no DOM —
 * so builders (`modules/<m>/lib/charts.ts`) and their "graph total = table total" tests run in node.
 *
 * Money values are integer paise. Colour is assigned by meaning (D29), never by rank:
 *   slot 1 = the thing measured · 'other' (grey) = context · slot 2 = ONLY the negative or problem
 *   pole (loss, overdrawn, overdue, mismatch) · ordinal o1–o5 = age / lateness. Slot 3 is never drawn.
 */
import { formatCompactINR, formatIndianNumber, formatPercent } from '../../../shared/format.ts';

export type ChartKind = 'column' | 'bar' | 'line' | 'share' | 'meter';

/** How colour is assigned (D29). Never by rank; never status tokens as series. */
export type ChartColor =
  | 'series' // one series in slot 1; an optional second series is context and must be slot 'other'
  | 'emphasis' // categories in `emphasis` use slot 1, the rest --chart-other
  | 'problem' // categories in `emphasis` use slot 2 (error, overdue, late, mismatch), the rest --chart-other
  | 'ordinal' // ordered buckets: --chart-o1..o5 (o1,o3,o5 for 3); indexes < greyBefore use --chart-other ("Not due")
  | 'polarity'; // value ≥ 0 → slot 1, value < 0 → slot 2 (profit/loss, Dr/Cr side, gain/loss, in/out) — never red/green

/** 3 stays for type compatibility with the 2.0 kit; `assertSpec` rejects it (D29). */
export type ChartSlot = 1 | 2 | 3 | 'other';

/** 'inr' = values in paise (ticks ₹1.2 L, tooltips ₹1,23,456.00) · 'number' · 'percent' · custom. */
export type ValueFormat = 'inr' | 'number' | 'percent' | { tick: (v: number) => string; full: (v: number) => string };

export interface ChartSeries {
  /** Legend + tooltip name (rendered as a text node). */
  name: string;
  /** Aligned with categories; null = no mark. */
  values: readonly (number | null)[];
  /** Default 1; a second series must say 'other'. */
  slot?: ChartSlot;
}

export interface ChartSpec {
  kind: ChartKind;
  /** Accessible name + strip title ("Net profit by month"). */
  title: string;
  /** ONE visible sentence, ≤ 90 chars, says the shape not the total; stays visible when folded. */
  takeaway: string;
  /** Already folded (Top-N + "Other", months / quarters / years). */
  categories: readonly string[];
  /** column/line: 1, or 1 + one 'other' context series; bar/share/meter: 1. */
  series: readonly ChartSeries[];
  /** Default 'series'. */
  color?: ChartColor;
  /** 'emphasis' / 'problem' category indexes. */
  emphasis?: readonly number[];
  /** 'ordinal': indexes < greyBefore use --chart-other. */
  greyBefore?: number;
  /**
   * Only kind 'column', one series, colour 'series': the last category is still running → drawn in
   * --chart-partial with "so far" in its direct label and tooltip.
   */
  partialLast?: boolean;
  /** Direct labels: the extreme, the endpoint, every bar tip (bar ≤ 7 rows), none. */
  label?: 'max' | 'last' | 'tips' | 'none';
  /** Default 'inr'. */
  valueFormat?: ValueFormat;
  /** Polarity columns: "Profit ↑" / "Loss ↓" (absolute tick labels). */
  axisCaptions?: { up: string; down: string };
  /** 'meter': the track (the limit / the whole). */
  max?: number;
  /**
   * What the graph adds up to — MUST equal the table's figure (tested per builder): Σ drawn values of
   * the measured series for column / bar / share; the last drawn point for a line (the closing the
   * table ends on); the whole (`max`) for a meter. See `drawnTotal`.
   */
  total: number;
  /** = Enter on the matching table row (drill); absent = not interactive. */
  activate?: (index: number) => void;
}

/** Longest takeaway the strip header shows on one line at 1366 px. */
export const TAKEAWAY_MAX = 90;
/** Folded output limits (§4.7): categories for a column (13 = 13 months before quarters), points for a line. */
export const MAX_CATEGORIES = 13;
/**
 * Rows of a horizontal bar strip: Top 6 + Other is the norm (7 rows × 20 px pitch); 10 is the one
 * exception the catalogue needs (Item Profitability: top 6 + up to 3 loss items + Other), which keeps
 * the strip within ≈ 220 px.
 */
export const MAX_BAR_ROWS = 10;
/** Segments of a share bar: ≤ 3 named + Other, or the 4 named statuses of a reconciliation. */
export const MAX_SHARE_SEGMENTS = 4;
export const MAX_LINE_POINTS = 480;
/** Bars short enough to draw inside the table instead of a strip (D26). */
export const INLINE_MAX_ROWS = 7;
export const OTHER_LABEL = 'Other';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// ---------------------------------------------------------------------------------------------
// Folding helpers (Σ-preserving)
// ---------------------------------------------------------------------------------------------

/**
 * Top `n` items by |value| (ties keep input order) and the rest summed into one "Other" category,
 * last. Σ of the values is preserved exactly. "Other" is never a single item in disguise: when only
 * one item would fall into it, that item is shown by name instead (so 7 items at n = 6 are 7 bars,
 * the same count as 6 + Other). No "Other" when n ≥ length. A fold therefore always shows fewer
 * categories than there are items — `inlineBars` relies on that. When a kept item is itself named
 * like the fold (a POS tender "Other"), the fold says how many it holds: "Other (5)".
 */
export function foldTop<T>(items: readonly T[], n: number, value: (t: T) => number, label: (t: T) => string, otherLabel: string = OTHER_LABEL): { categories: string[]; values: number[] } {
  const ranked = items.map((t, i) => ({ v: value(t), name: label(t), i })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i);
  const keep = Math.max(0, Math.floor(Number.isFinite(n) ? n : items.length));
  const head = ranked.length > keep + 1 ? ranked.slice(0, keep) : ranked;
  const tail = ranked.length > keep + 1 ? ranked.slice(keep) : [];
  const categories = head.map((r) => r.name);
  const values = head.map((r) => r.v);
  if (tail.length > 0) {
    categories.push(categories.includes(otherLabel) ? `${otherLabel} (${tail.length})` : otherLabel);
    values.push(tail.reduce((s, r) => s + r.v, 0));
  }
  return { categories, values };
}

/** 'YYYY-MM' of every month from `from` to `to` (dates 'YYYY-MM-DD' or months 'YYYY-MM'), inclusive. */
export function monthRange(from: string, to: string): string[] {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  if (![fy, fm, ty, tm].every(Number.isFinite)) return [];
  const out: string[] = [];
  for (let y = fy, m = fm, guard = 0; (y < ty || (y === ty && m <= tm)) && guard < 1200; guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * Sums rows into the months from `from` to `to`, zero-filled ('YYYY-MM', ascending). Rows dated
 * outside the range are ignored (a builder passes the report's own period, so none are).
 */
export function byMonth<T>(rows: readonly T[], date: (t: T) => string, value: (t: T) => number, from: string, to: string): { months: string[]; values: number[] } {
  const months = monthRange(from, to);
  const index = new Map(months.map((m, i) => [m, i]));
  const values = months.map(() => 0);
  for (const r of rows) {
    const i = index.get(date(r).slice(0, 7));
    if (i !== undefined) values[i] += value(r);
  }
  return { months, values };
}

/** 'Sep' for '2026-09'. */
export function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}

function fyStart(month: string): number {
  const y = Number(month.slice(0, 4));
  return Number(month.slice(5, 7)) >= 4 ? y : y - 1;
}

const yy = (y: number) => String(((y % 100) + 100) % 100).padStart(2, '0');

/** Indian financial year of a month: 'FY 26-27' for '2026-04' … '2027-03'. */
export function fyLabel(month: string): string {
  const y = fyStart(month);
  return `FY ${yy(y)}-${yy(y + 1)}`;
}

/** Financial-year quarter: 'Q1 26-27' (Apr–Jun 2026) … 'Q4 26-27' (Jan–Mar 2027). */
export function quarterLabel(month: string): string {
  const m = Number(month.slice(5, 7));
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  const y = fyStart(month);
  return `Q${q} ${yy(y)}-${yy(y + 1)}`;
}

/**
 * Picks the grain a period reads best at and folds the months into it (Σ preserved):
 * ≤ 13 months → monthly ('Apr', 'May'…; 'Apr 25' … 'Apr 26' when a name would repeat);
 * 14–39 → financial-year quarters ('Q1 26-27'); ≥ 40 → financial years ('FY 26-27').
 */
export function foldMonths(months: readonly string[], values: readonly number[]): { categories: string[]; values: number[]; grain: 'month' | 'quarter' | 'year' } {
  if (months.length <= 13) {
    const names = months.map(monthName);
    const repeats = new Set(names).size !== names.length;
    return { categories: repeats ? months.map((m) => `${monthName(m)} ${m.slice(2, 4)}`) : names, values: months.map((_, i) => values[i] ?? 0), grain: 'month' };
  }
  const grain = months.length <= 39 ? 'quarter' : 'year';
  const key = grain === 'quarter' ? quarterLabel : fyLabel;
  const categories: string[] = [];
  const out: number[] = [];
  months.forEach((m, i) => {
    const k = key(m);
    if (categories[categories.length - 1] !== k) {
      categories.push(k);
      out.push(0);
    }
    out[out.length - 1] += values[i] ?? 0;
  });
  return { categories, values: out, grain };
}

/**
 * At most `max` points for a line: the first and last point plus, per bucket of the interior, its
 * lowest and highest point in x order — so every peak and trough (and the global min / max) survives.
 */
export function decimate(points: readonly { x: number; y: number }[], max: number): { x: number; y: number }[] {
  const limit = Math.max(2, Math.floor(max));
  if (points.length <= limit) return points.map((p) => ({ x: p.x, y: p.y }));
  const first = points[0];
  const last = points[points.length - 1];
  const interior = points.length - 2;
  const buckets = Math.floor((limit - 2) / 2);
  const out: { x: number; y: number }[] = [{ x: first.x, y: first.y }];
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor((b * interior) / buckets);
    const end = 1 + Math.floor(((b + 1) * interior) / buckets);
    if (end <= start) continue;
    let lo = start;
    let hi = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].y < points[lo].y) lo = i;
      if (points[i].y > points[hi].y) hi = i;
    }
    for (const i of lo === hi ? [lo] : lo < hi ? [lo, hi] : [hi, lo]) out.push({ x: points[i].x, y: points[i].y });
  }
  out.push({ x: last.x, y: last.y });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Totals, gates and rules
// ---------------------------------------------------------------------------------------------

/** The series the graph measures: the first one not marked as context ('other'). */
export function measuredSeries(spec: ChartSpec): ChartSeries | null {
  return spec.series.find((s) => s.slot !== 'other') ?? null;
}

function drawn(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * What the drawing adds up to, to compare with the table: Σ of the measured series for column, bar
 * and share; the last drawn point of a line (a running balance ends on the table's closing); the
 * whole (`max`) of a meter.
 */
export function drawnTotal(spec: ChartSpec): number {
  if (spec.kind === 'meter') return spec.max ?? 0;
  const s = measuredSeries(spec);
  if (!s) return 0;
  const vals = drawn(s.values);
  if (spec.kind === 'line') return vals.length ? vals[vals.length - 1] : 0;
  return vals.reduce((a, b) => a + b, 0);
}

/**
 * Minimum data (D26): bar / column / share need ≥ 3 categories with a non-zero value; a line ≥ 3
 * points; a meter both parts (the fill and the track) > 0. Below that a builder returns null.
 */
export function enoughData(spec: ChartSpec): boolean {
  const s = measuredSeries(spec);
  if (!s) return false;
  if (spec.kind === 'meter') {
    const v = s.values[0];
    return typeof v === 'number' && v > 0 && (spec.max ?? 0) > 0;
  }
  const vals = drawn(s.values);
  if (spec.kind === 'line') return vals.length >= 3;
  return vals.filter((v) => v !== 0).length >= 3;
}

/**
 * Every rule a spec breaks (empty = valid). `assertSpec` throws with these; tests read them.
 */
export function specProblems(spec: ChartSpec): string[] {
  const p: string[] = [];
  const color = spec.color ?? 'series';
  const n = spec.categories.length;
  if (!spec.title.trim()) p.push('title is empty');
  if (!spec.takeaway.trim()) p.push('takeaway is empty');
  if (spec.takeaway.length > TAKEAWAY_MAX) p.push(`takeaway is ${spec.takeaway.length} chars (max ${TAKEAWAY_MAX})`);

  // Series caps and slots.
  if (spec.series.length === 0) p.push('no series');
  const multi = spec.kind === 'column' || spec.kind === 'line';
  if (!multi && spec.series.length > 1) p.push(`${spec.kind} takes one series`);
  if (multi && spec.series.length > 2) p.push(`${spec.kind} takes one series plus at most one context series`);
  spec.series.forEach((s, i) => {
    if (s.slot === 3) p.push(`series "${s.name}": slot 3 is never drawn (D29)`);
    if (s.slot === 2) p.push(`series "${s.name}": slot 2 comes only through 'problem' or 'polarity' colour`);
    if (i === 0 && s.slot === 'other') p.push(`series "${s.name}": the first series is the measured one, not context`);
    if (i > 0 && s.slot !== 'other') p.push(`series "${s.name}": a second series is context and must be slot 'other'`);
    if (s.values.length !== n) p.push(`series "${s.name}": ${s.values.length} values for ${n} categories`);
    if (s.values.some((v) => v !== null && !Number.isFinite(v))) p.push(`series "${s.name}": non-finite value`);
    if ((spec.valueFormat ?? 'inr') === 'inr' && s.values.some((v) => v !== null && !Number.isInteger(v))) p.push(`series "${s.name}": money must be integer paise`);
  });

  // Size.
  const cap = spec.kind === 'line' ? MAX_LINE_POINTS : spec.kind === 'bar' ? MAX_BAR_ROWS : spec.kind === 'share' ? MAX_SHARE_SEGMENTS : spec.kind === 'meter' ? 1 : MAX_CATEGORIES;
  const unit = spec.kind === 'line' ? 'points' : spec.kind === 'bar' ? 'rows' : spec.kind === 'share' ? 'segments' : spec.kind === 'meter' ? 'values (a meter is one value against max)' : 'categories';
  if (n > cap) p.push(`${spec.kind} has ${n} ${unit} (max ${cap}${spec.kind === 'share' ? ': 3 named + Other' : spec.kind === 'meter' ? '' : '; fold first'})`);
  if (!enoughData(spec)) p.push('not enough data (≥ 3 non-zero categories / ≥ 3 points / both meter parts > 0) — return null instead');

  // Colour rules.
  if (color === 'ordinal') {
    const grey = spec.greyBefore ?? 0;
    if (!Number.isInteger(grey) || grey < 0 || grey >= n) p.push(`greyBefore ${grey} is not an index of the ${n} categories`);
    const coloured = n - grey;
    if (coloured > 5) p.push(`ordinal has ${coloured} coloured buckets (max 5; fold the oldest)`);
    if (spec.kind !== 'column' && spec.kind !== 'share') p.push(`ordinal colour is for column or share, not ${spec.kind}`);
  } else if (spec.greyBefore !== undefined) p.push("greyBefore needs 'ordinal' colour");
  if (color === 'emphasis' || color === 'problem') {
    if ((spec.emphasis ?? []).some((i) => !Number.isInteger(i) || i < 0 || i >= n)) p.push('emphasis index out of range');
  } else if (spec.emphasis !== undefined) p.push("emphasis needs 'emphasis' or 'problem' colour");
  if (color === 'polarity' && spec.kind !== 'column' && spec.kind !== 'bar') p.push(`polarity colour is for column or bar, not ${spec.kind}`);
  if (spec.axisCaptions && !(color === 'polarity' && spec.kind === 'column')) p.push('axis captions belong to polarity columns');
  // §4.2: polarity columns read up/down from one baseline with absolute ticks — the captions carry the sign.
  if (color === 'polarity' && spec.kind === 'column' && !(spec.axisCaptions?.up.trim() && spec.axisCaptions.down.trim())) p.push('a polarity column needs axisCaptions ("Profit ↑" / "Loss ↓"): ticks are absolute, never a bare minus');
  if (spec.partialLast && !(spec.kind === 'column' && spec.series.length === 1 && color === 'series')) p.push("partialLast is only for a one-series 'series' column");

  // Labels and kind-specific fields.
  if (spec.label === 'tips' && !(spec.kind === 'bar' && n <= INLINE_MAX_ROWS)) p.push("label 'tips' is for bar graphs of ≤ 7 rows");
  if (spec.kind === 'meter' && !(typeof spec.max === 'number' && Number.isFinite(spec.max))) p.push('meter needs max (the track)');
  if (spec.kind !== 'meter' && spec.max !== undefined) p.push('max is only for a meter');
  if (drawnTotal(spec) !== spec.total) p.push(`total ${spec.total} ≠ drawn total ${drawnTotal(spec)}`);
  return p;
}

/** Dev and tests: throws when the spec breaks a graph rule (see `specProblems`). */
export function assertSpec(spec: ChartSpec): void {
  const p = specProblems(spec);
  if (p.length) throw new Error(`Invalid graph "${spec.title}": ${p.join('; ')}`);
}

/**
 * D26: a bar graph whose categories are exactly the table's rows, ≤ 7 of them and none folded into
 * "Other", is drawn as 4 px bars inside the table instead of a strip. `tableRows` = the rows the
 * bars sit on (the ones the builder folded). A fold always shows fewer categories than rows (see
 * `foldTop`), so the count decides — never the label: a real row named "Other" (the POS tender, an
 * "Other Expenses" group) keeps its inline bar.
 */
export function inlineBars(spec: ChartSpec | null, tableRows: number): boolean {
  if (!spec || spec.kind !== 'bar') return false;
  if (!Number.isInteger(tableRows) || tableRows < 1 || tableRows > INLINE_MAX_ROWS) return false;
  return spec.categories.length === tableRows;
}

/**
 * D24: a stat never repeats a visible table total. True when a shown (non-zero) stat value equals a
 * table total, sign ignored (a Cr total and its owner's-words amount are the same number).
 */
export function statRepeatsTotal(statValues: readonly number[], tableTotals: readonly number[]): boolean {
  const totals = new Set(tableTotals.filter((t) => Number.isFinite(t) && t !== 0).map((t) => Math.abs(t)));
  return statValues.some((s) => Number.isFinite(s) && s !== 0 && totals.has(Math.abs(s)));
}

// ---------------------------------------------------------------------------------------------
// Colour resolution (pure; the kit maps these to CSS classes)
// ---------------------------------------------------------------------------------------------

export type MarkColor = 1 | 2 | 'other' | 'partial' | 'o1' | 'o2' | 'o3' | 'o4' | 'o5';

/**
 * Ramp steps for `n` ordered buckets, the oldest always o5: 1 → o5 · 2 → o3 o5 · 3 → o1 o3 o5 ·
 * 4 → o2…o5 · 5 → o1…o5; more than 5 fold into o5 (assertSpec rejects them; this stays total).
 */
export function ordinalSteps(n: number): number[] {
  const table: Record<number, number[]> = { 1: [5], 2: [3, 5], 3: [1, 3, 5], 4: [2, 3, 4, 5], 5: [1, 2, 3, 4, 5] };
  if (n <= 0) return [];
  if (n <= 5) return table[n];
  return [1, 2, 3, 4, ...Array.from({ length: n - 4 }, () => 5)];
}

/** The colour of one mark (D29): meaning decides, never rank. */
export function markColor(spec: ChartSpec, categoryIndex: number, seriesIndex = 0): MarkColor {
  const s = spec.series[seriesIndex];
  if (!s || s.slot === 'other') return 'other';
  const color = spec.color ?? 'series';
  if (color === 'emphasis') return (spec.emphasis ?? []).includes(categoryIndex) ? 1 : 'other';
  if (color === 'problem') return (spec.emphasis ?? []).includes(categoryIndex) ? 2 : 'other';
  if (color === 'polarity') return (s.values[categoryIndex] ?? 0) < 0 ? 2 : 1;
  if (color === 'ordinal') {
    const grey = spec.greyBefore ?? 0;
    if (categoryIndex < grey) return 'other';
    const step = ordinalSteps(spec.categories.length - grey)[categoryIndex - grey] ?? 5;
    return `o${step}` as MarkColor;
  }
  if (spec.partialLast && spec.kind === 'column' && categoryIndex === spec.categories.length - 1) return 'partial';
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Takeaway templates (Indian compact money)
// ---------------------------------------------------------------------------------------------

/** Compact value for a takeaway or tick: ₹87.4 K · 1.2 L · 12.5 %. */
export function compactValue(v: number, f: ValueFormat = 'inr'): string {
  if (typeof f === 'object') return f.tick(v);
  if (f === 'inr') return formatCompactINR(v);
  if (f === 'percent') return formatPercent(v);
  const a = Math.abs(v);
  if (a >= 1e7) return `${formatIndianNumber(v / 1e7, 1)} Cr`;
  if (a >= 1e5) return `${formatIndianNumber(v / 1e5, 1)} L`;
  return formatIndianNumber(v, Number.isInteger(v) ? 0 : 2);
}

/** Keeps a takeaway within TAKEAWAY_MAX (an ellipsis replaces the overflow). */
export function clipTakeaway(s: string, max = TAKEAWAY_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function grainWord(category: string): string | null {
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{2,4})?$/.test(category)) return 'month';
  if (/^Q[1-4] \d{2}-\d{2}$/.test(category)) return 'quarter';
  if (/^FY \d{2}-\d{2}$/.test(category)) return 'year';
  return null;
}

export const take = {
  /** "Best month Sep ₹87.4 K · Oct so far ₹42.3 K" (the running period is never the "best"). */
  max(spec: ChartSpec): string {
    const s = measuredSeries(spec);
    if (!s) return '';
    const f = spec.valueFormat ?? 'inr';
    const lastIdx = spec.categories.length - 1;
    const partial = !!spec.partialLast && spec.kind === 'column';
    let best = -1;
    s.values.forEach((v, i) => {
      if (v === null || (partial && i === lastIdx)) return;
      if (best < 0 || v > (s.values[best] ?? -Infinity)) best = i;
    });
    const parts: string[] = [];
    if (best >= 0) {
      const cat = spec.categories[best];
      const word = grainWord(cat);
      parts.push(`${word ? `Best ${word}` : 'Highest'} ${cat} ${compactValue(s.values[best] ?? 0, f)}`);
    }
    const last = s.values[lastIdx];
    if (partial && last !== null && last !== undefined) parts.push(`${spec.categories[lastIdx]} so far ${compactValue(last, f)}`);
    return clipTakeaway(parts.join(' · '));
  },
  /** "Wood Primer 1L holds 70 % of stock value". */
  share(name: string, pct: number, of: string): string {
    const tail = ` holds ${Math.round(pct)} % of ${of}`;
    const room = TAKEAWAY_MAX - tail.length;
    return clipTakeaway(`${name.length > room ? clipTakeaway(name, Math.max(8, room)) : name}${tail}`);
  },
  /** "₹1.67 L on 10-Oct, up ₹1.67 L since 1-Apr" (`delta` = "up ₹1.67 L since 1-Apr", or ''). */
  last(value: string, date: string, delta: string): string {
    return clipTakeaway(delta ? `${value} on ${date}, ${delta}` : `${value} on ${date}`);
  },
  /**
   * "Loss in 6 of 7 months; smallest in Sep (₹12.4 K)" (`best` = the closing phrase, or ''). Pass
   * `foldMonths(…).grain` when the period was folded: "Loss in 2 of 8 quarters".
   */
  polarity(lossMonths: number, months: number, best: string, grain: 'month' | 'quarter' | 'year' = 'month'): string {
    const unit = `${grain}s`;
    const head = lossMonths <= 0 ? `Profit in all ${months} ${unit}` : lossMonths >= months ? `Loss in all ${months} ${unit}` : `Loss in ${lossMonths} of ${months} ${unit}`;
    return clipTakeaway(best ? `${head}; ${best}` : head);
  },
  /** "Of ₹4.66 L in unpaid bills, ₹1.91 L is over 90 days". */
  ordinal(old: string, base: string, threshold: string): string {
    return clipTakeaway(`Of ${base}, ${old} is over ${threshold}`);
  },
};
