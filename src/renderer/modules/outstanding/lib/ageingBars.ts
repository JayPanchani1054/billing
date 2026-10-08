/**
 * Small stacked ageing bars (pure): how a party's outstanding splits across the ageing buckets, and
 * which severity level (colour) each bucket gets. Only amounts on the report's side (> 0) are drawn —
 * advances and amounts in the party's favour have no length; the accessible text lists every bucket.
 */

export interface AgeingSegment {
  /** Bucket index (0 = not due). */
  index: number;
  /** Share of the positive total, 0–100 (sums to exactly 100 across segments). */
  percent: number;
  /** 0 = not due … 4 = the oldest buckets. */
  level: AgeingLevel;
}

export type AgeingLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Severity level of bucket `index` out of `bucketCount` buckets (index 0 = not due → 0). The age
 * ranges 1…n are spread over levels 1–4 so the last bucket is always the most severe:
 * n = 5 (default 30/60/90/180): 1–30 → 1, 31–60 → 1, 61–90 → 2, 91–180 → 3, > 180 → 4.
 */
export function ageingLevel(index: number, bucketCount: number): AgeingLevel {
  if (index <= 0) return 0;
  const n = Math.max(1, bucketCount - 1);
  if (index >= n) return 4;
  const lvl = 1 + Math.floor(((index - 1) * 4) / n);
  return Math.min(4, Math.max(1, lvl)) as AgeingLevel;
}

/**
 * Segments of a stacked bar for the side-signed `amounts` (aligned with the buckets). Percentages
 * are rounded to 0.1 with the largest-remainder method so they add up to exactly 100.
 */
export function ageingSegments(amounts: readonly number[]): AgeingSegment[] {
  const positive = amounts.map((a, index) => ({ index, a })).filter((x) => x.a > 0);
  const total = positive.reduce((s, x) => s + x.a, 0);
  if (total <= 0) return [];
  // Work in tenths of a percent: 1000 units.
  const raw = positive.map((x) => ({ index: x.index, exact: (x.a * 1000) / total }));
  const floors = raw.map((r) => Math.floor(r.exact));
  let left = 1000 - floors.reduce((s, f) => s + f, 0);
  const order = raw.map((r, i) => ({ i, rem: r.exact - floors[i] })).sort((x, y) => y.rem - x.rem || x.i - y.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] += 1;
    left -= 1;
  }
  return raw.map((r, i) => ({ index: r.index, percent: floors[i] / 10, level: ageingLevel(r.index, amounts.length) }));
}

/**
 * Accessible description: "Not due ₹40,000.00 (33.3%), 1–30 days ₹80,000.00 (66.7%)" — the same
 * percentages as the bar, so the spoken shares add up to 100 too.
 */
export function ageingBarText(labels: readonly string[], amounts: readonly number[], money: (p: number) => string): string {
  const segs = ageingSegments(amounts);
  if (segs.length === 0) return 'Nothing outstanding to age';
  return segs.map((s) => `${labels[s.index] ?? `Bucket ${s.index}`} ${money(amounts[s.index])} (${s.percent}%)`).join(', ');
}
