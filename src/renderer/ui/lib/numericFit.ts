/**
 * Money and quantities are never cut off in a table. A numeric column is at least as wide as its longest
 * formatted value (rows and totals): digits are tabular, so a value of N characters needs N `ch` plus the
 * cell padding; bold totals run a little wider (×1.08). Pure; DataTable applies it to its `<col>` widths.
 */

/** Rows read per column to find the longest value (a 20,000-row ledger keeps its first 5,000 in view). */
export const FIT_SCAN_LIMIT = 5000;

/** Characters of the longest text (0 when none). */
export function longestChars(texts: Iterable<string>): number {
  let n = 0;
  for (const t of texts) if (t.length > n) n = t.length;
  return n;
}

/** The CSS length that fits `chars` characters of tabular digits in a cell (padding both sides). */
export function fitLength(chars: number): string {
  return `calc(${chars}ch * 1.08 + 2 * var(--cell-px) + 2px)`;
}

/**
 * The `<col>` width for a numeric column: the declared width, but never narrower than its longest value.
 * A flexible column (no declared width) stays flexible; the table's minimum width covers it instead.
 */
export function fitColWidth(declared: number | string | undefined, chars: number): number | string | undefined {
  if (declared === undefined || chars <= 0) return declared;
  return `max(${typeof declared === 'number' ? `${declared}px` : declared}, ${fitLength(chars)})`;
}

/** A px estimate of the same fit (≈ 7.5 px per character at the 13–14 px table text, plus padding). */
export function fitPx(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars * 7.5 * 1.08 + 26);
}
