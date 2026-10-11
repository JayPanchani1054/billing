/**
 * Money and quantities are never cut off in a table. A numeric column is at least as wide as its longest
 * formatted value (rows and totals). Widths are estimated in `em` from the characters: tabular digits
 * ≈ 0.64em, separators ≈ 0.34em, letters and spaces ≈ 0.6em (wide enough for Segoe UI and the Linux
 * fallbacks), bold totals ×1.1, plus the Dr/Cr suffix box. The table's minimum width is the sum of the
 * same expressions, so a flexible text column is never squeezed by a widened number. Pure; DataTable uses it.
 */

/** Rows read per column to find the longest value (a 20,000-row ledger keeps its first 5,000 in view). */
export const FIT_SCAN_LIMIT = 5000;

/** The Dr/Cr suffix box (2em of 12 px plus its 0.4em gap), in table em. */
export const DRCR_SUFFIX_EM = 2.3;

const DIGIT_EM = 0.64;
const SEPARATOR_EM = 0.34;
const OTHER_EM = 0.6;
const BOLD = 1.1;

/** Estimated width of a formatted value in em (before padding). */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text) em += ch >= '0' && ch <= '9' ? DIGIT_EM : ch === ',' || ch === '.' || ch === '-' || ch === '−' ? SEPARATOR_EM : OTHER_EM;
  return em;
}

/** The widest of `texts` in em, bold-safe, plus a suffix box (0 when there is nothing to show). */
export function fitEm(texts: Iterable<string>, suffixEm = 0): number {
  let max = 0;
  for (const t of texts) if (t !== '') max = Math.max(max, textEm(t));
  return max === 0 ? 0 : Math.round((max * BOLD + suffixEm) * 100) / 100;
}

/** The CSS length that fits `em` of text in a cell (padding both sides). */
export function fitLength(em: number): string {
  return `calc(${em}em + 2 * var(--cell-px) + 2px)`;
}

/** The `<col>` width: the declared (or minimum) width, but never narrower than the longest value. */
export function fitColWidth(declared: number | string | undefined, em: number): number | string | undefined {
  if (declared === undefined || em <= 0) return declared;
  return `max(${typeof declared === 'number' ? `${declared}px` : declared}, ${fitLength(em)})`;
}

/** The table's minimum width: the sum of each column's own expression (px or a fitted `max(…)`). */
export function minWidthCalc(parts: readonly (number | string)[]): string {
  return `calc(${parts.map((p) => (typeof p === 'number' ? `${p}px` : p)).join(' + ') || '0px'})`;
}
