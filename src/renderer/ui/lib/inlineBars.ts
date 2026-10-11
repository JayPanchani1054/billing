/**
 * Inline bars for short tables (2.1, SPEC-21 D26, DataTable column `bar`). When a report's graph would
 * only repeat a table of ≤ 7 rows, each value cell gets a 4 px bar instead: width ∝ |value| / the
 * largest |value| of the rendered rows. Totals are excluded (the caller returns null for them, and
 * footer rows never get bars), so one big total never flattens the rest. Pure (inlineBars.test.ts).
 */

export interface InlineBar {
  /** 0 < width ≤ 1: the share of the cell's content width. */
  width: number;
  /** The value is negative (drawn in slot 2 under `slot: 'polarity'`). */
  negative: boolean;
}

/** The smallest drawn bar (a non-zero value never disappears next to a large one). */
export const MIN_BAR = 0.02;

/**
 * One entry per value: a bar, or null for a missing / zero / non-finite value. All null when no value
 * is non-zero (nothing to compare: no bars at all).
 */
export function barWidths(values: readonly (number | null | undefined)[]): (InlineBar | null)[] {
  let max = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) max = Math.max(max, Math.abs(v));
  return values.map((v) => {
    if (max === 0 || typeof v !== 'number' || !Number.isFinite(v) || v === 0) return null;
    return { width: Math.max(MIN_BAR, Math.abs(v) / max), negative: v < 0 };
  });
}
