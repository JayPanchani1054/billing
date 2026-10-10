/**
 * Spreadsheet formula ("CSV") injection guard — the ONE rule used by every CSV / Excel export
 * (core `lib/csv.ts` toCsv, `lib/xlsx.ts` text cells, `data/exportTable.ts`, `data/exportData.ts`,
 * the renderer's `app/lib/exportFormat.ts`).
 *
 * OWASP "CSV Injection": a cell whose text starts with = + - @ TAB (0x09) or CR (0x0D) may be evaluated
 * as a formula by Excel / LibreOffice / Google Sheets (e.g. `=HYPERLINK(…)`, `-2+3+cmd|' /C calc'!A0`,
 * `@SUM(…)`). Such text is prefixed with a single quote so the spreadsheet shows it as text.
 *
 * Numbers are never broken: a cell that is exactly a plain numeric literal — an optional sign, digits
 * (optionally grouped with commas, Indian or western), an optional decimal part — is left alone, so a
 * negative amount written as text ("-1250.50", "-1,23,456.00") still opens as a negative number.
 * Anything else after the sign (an operator, a letter, a space, a second sign) is neutralised.
 */

/** Characters that make a spreadsheet treat a cell as a formula (OWASP list). */
export const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** A plain signed decimal number, optionally comma-grouped: "-12", "+3.50", "-1,23,456.00", "-1,234,567.8". */
const PLAIN_NUMBER = /^[-+]?(?:\d+|\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

/** True when `text` is a plain numeric literal (see PLAIN_NUMBER) — safe to leave as is. */
export function isPlainNumberText(text: string): boolean {
  return PLAIN_NUMBER.test(text);
}

/** True when a spreadsheet could evaluate `text` as a formula (and it is not a plain number). */
export function needsFormulaGuard(text: string): boolean {
  return FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text);
}

/** Prefix a single quote to text that a spreadsheet would otherwise evaluate as a formula. */
export function neutraliseFormula(text: string): string {
  return needsFormulaGuard(text) ? `'${text}` : text;
}
