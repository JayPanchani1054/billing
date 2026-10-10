/**
 * Voucher numbering — prefix / suffix tokens and dated prefix / suffix rows (dataplus), shared by the
 * core (allocation, checks) and the voucher-type form (live preview, the same checks before saving).
 *
 * Tokens (expanded with the VOUCHER DATE when the number is allocated):
 *   {FY}      financial year, short   '26-27'   (a calendar-year company: '26')
 *   {FYYYYY}  financial year, long    '2026-27' (a calendar-year company: '2026')
 *   {YY}      calendar year of the date, 2 digits   '26'
 *   {MM}      month of the date, 2 digits           '04'
 *   {MMM}     month of the date, 3 letters          'Apr'
 * Token names are case-insensitive; any other {…} is refused.
 *
 * Dated rows: the voucher type's own prefix / suffix applies from the beginning; a row
 * `{ applicableFrom, text }` replaces it for vouchers dated on or after that date (the latest row on
 * or before the voucher date wins; `text` null/'' = no prefix / suffix from that date) — the usual
 * "Prefix / Suffix details" with "Applicable from".
 *
 * GST (CGST Rule 46(b), Rules 49, 53): a tax invoice / bill of supply / credit or debit note carries a
 * consecutive serial number of at most 16 characters, letters, digits, '-' and '/' only, unique for the
 * financial year. The checks below apply that to every prefix / suffix variant with the tokens at
 * their longest expansion.
 */
import type { VoucherBaseType } from './constants.ts';
import { addDays, financialYear, MONTH_NAMES } from './dates.ts';
import { formatIndianNumber } from './format.ts';

export type NumberingMethodName = 'automatic' | 'automatic_override' | 'manual' | 'none';
export type NumberingRestartName = 'yearly' | 'monthly' | 'never';

/** A dated prefix or suffix: applies to vouchers dated on or after `applicableFrom`. */
export interface NumberingTextRow {
  applicableFrom: string;
  /** null = no prefix / suffix from that date. */
  text: string | null;
}

/** The parts of a numbering scheme the helpers need (VoucherNumbering satisfies it). */
export interface NumberingScheme {
  method: NumberingMethodName;
  prefix: string | null;
  suffix: string | null;
  start: number;
  width: number;
  restart: NumberingRestartName;
  prefixRows?: readonly NumberingTextRow[];
  suffixRows?: readonly NumberingTextRow[];
}

export const NUMBERING_TOKENS: ReadonlyArray<{ token: string; label: string; example: string; maxLength: number }> = [
  { token: '{FY}', label: 'Financial year (short)', example: '26-27', maxLength: 5 },
  { token: '{FYYYYY}', label: 'Financial year (long)', example: '2026-27', maxLength: 7 },
  { token: '{YY}', label: 'Year of the voucher date', example: '26', maxLength: 2 },
  { token: '{MM}', label: 'Month number', example: '04', maxLength: 2 },
  { token: '{MMM}', label: 'Month name', example: 'Apr', maxLength: 3 },
];

const TOKEN_RE = /\{([A-Za-z]+)\}/g;
const MAX_LEN = new Map(NUMBERING_TOKENS.map((t) => [t.token.slice(1, -1), t.maxLength] as const));

/** Max lengths of each part — prefix / suffix text may be up to 16 characters as typed. */
export const NUMBERING_TEXT_MAX = 16;
export const GST_DOC_NUMBER_MAX_LENGTH = 16;
/** GST documents issued by the company (their numbers go to GSTR-1). */
export const GST_NUMBERED_BASE_TYPES: readonly VoucherBaseType[] = ['sales', 'credit_note', 'debit_note'];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Expand the tokens of a prefix / suffix for a voucher dated `date` ('YYYY-MM-DD'). */
export function expandNumberingText(text: string | null | undefined, date: string, fyStartMonth = 4): string {
  if (!text) return '';
  if (!text.includes('{')) return text;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  let fy: { short: string; long: string } | null = null;
  const fyParts = (): { short: string; long: string } => {
    if (fy) return fy;
    const label = financialYear(date, fyStartMonth).label; // '2026-27' or '2026'
    fy = { long: label, short: label.length === 4 ? label.slice(2) : `${label.slice(2, 4)}-${label.slice(5)}` };
    return fy;
  };
  return text.replace(TOKEN_RE, (all, name: string) => {
    switch (name.toUpperCase()) {
      case 'FY':
        return fyParts().short;
      case 'FYYYYY':
        return fyParts().long;
      case 'YY':
        return pad2(y % 100);
      case 'MM':
        return pad2(m);
      case 'MMM':
        return MONTH_NAMES[m - 1] ?? all;
      default:
        return all;
    }
  });
}

/** Problems with the tokens of one prefix / suffix text (unknown token, stray brace). */
export function tokenProblems(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (!MAX_LEN.has(m[1].toUpperCase())) out.push(`'${m[0]}' is not a numbering token. Use ${NUMBERING_TOKENS.map((t) => t.token).join(', ')}.`);
  }
  if (/[{}]/.test(text.replace(TOKEN_RE, ''))) out.push("A '{' or '}' is not part of a token. Write tokens like {FY}.");
  return out;
}

/** Longest length of a prefix / suffix after expansion (unknown tokens count as typed). */
export function expandedMaxLength(text: string | null | undefined): number {
  if (!text) return 0;
  return text.replace(TOKEN_RE, (all, name: string) => 'x'.repeat(MAX_LEN.get(name.toUpperCase()) ?? all.length)).length;
}

/** Text with the tokens removed (for the GST character check: token output is always allowed). */
function withoutTokens(text: string): string {
  // Unknown tokens and stray braces are reported by tokenProblems (once), not as bad characters too.
  return text.replace(TOKEN_RE, '').replace(/[{}]/g, '');
}

export function hasMonthToken(text: string | null | undefined): boolean {
  return !!text && /\{(MM|MMM)\}/i.test(text);
}

export function hasYearToken(text: string | null | undefined): boolean {
  return !!text && /\{(FY|FYYYYY|YY)\}/i.test(text);
}

/** The prefix (or suffix) text in force on `date`: the latest dated row on or before it, else the base text. */
export function effectiveText(base: string | null, rows: readonly NumberingTextRow[] | undefined, date: string): string | null {
  let best: NumberingTextRow | null = null;
  for (const r of rows ?? []) if (r.applicableFrom <= date && (!best || r.applicableFrom >= best.applicableFrom)) best = r;
  return best ? best.text || null : base;
}

/** Number for sequence `seq` of a voucher dated `date`: expanded prefix + zero-padded seq + expanded suffix. */
export function formatSchemeNumber(n: Pick<NumberingScheme, 'prefix' | 'suffix' | 'width' | 'prefixRows' | 'suffixRows'>, seq: number, date: string, fyStartMonth = 4): string {
  const body = n.width > 0 ? String(seq).padStart(n.width, '0') : String(seq);
  const prefix = expandNumberingText(effectiveText(n.prefix, n.prefixRows, date), date, fyStartMonth);
  const suffix = expandNumberingText(effectiveText(n.suffix, n.suffixRows, date), date, fyStartMonth);
  return `${prefix}${body}${suffix}`;
}

/** Sequence number of `number` if it is in this scheme's format for `date` ('INV/26-27/0012' → 12), else null. */
export function parseSchemeSeq(n: Pick<NumberingScheme, 'prefix' | 'suffix' | 'prefixRows' | 'suffixRows'>, number: string, date: string, fyStartMonth = 4): number | null {
  const prefix = expandNumberingText(effectiveText(n.prefix, n.prefixRows, date), date, fyStartMonth);
  const suffix = expandNumberingText(effectiveText(n.suffix, n.suffixRows, date), date, fyStartMonth);
  if (!number.startsWith(prefix) || !number.endsWith(suffix) || number.length <= prefix.length + suffix.length) return null;
  const body = number.slice(prefix.length, number.length - suffix.length);
  if (!/^\d{1,15}$/.test(body)) return null;
  const v = Number(body);
  return Number.isSafeInteger(v) ? v : null;
}

/** Every prefix (or suffix) text the scheme can use: the base text and each dated row. */
function variants(base: string | null, rows: readonly NumberingTextRow[] | undefined): string[] {
  return [base ?? '', ...(rows ?? []).map((r) => r.text ?? '')];
}

export interface NumberingCheckIssue {
  path: string;
  message: string;
}

/**
 * Check a numbering scheme. For GST documents of a GST-registered company, length / character /
 * uniqueness problems are errors (paths under 'numbering.'); otherwise they are warnings. Token
 * problems are always errors (the number could not be produced).
 */
export function checkNumberingScheme(baseType: VoucherBaseType, n: NumberingScheme, gstEnabled: boolean): { errors: NumberingCheckIssue[]; warnings: string[] } {
  const gstDoc = GST_NUMBERED_BASE_TYPES.includes(baseType);
  const strict = gstDoc && gstEnabled;
  const errors: NumberingCheckIssue[] = [];
  const warnings: string[] = [];
  const flag = (path: string, message: string): void => {
    if (strict) errors.push({ path, message });
    else warnings.push(message);
  };
  const prefixes = variants(n.prefix, n.prefixRows);
  const suffixes = variants(n.suffix, n.suffixRows);
  for (const [path, label, list, rowsPath] of [
    ['numbering.prefix', 'prefix', prefixes, 'numbering.prefixRows'],
    ['numbering.suffix', 'suffix', suffixes, 'numbering.suffixRows'],
  ] as const) {
    list.forEach((text, i) => {
      const at = i === 0 ? path : `${rowsPath}[${i - 1}].text`;
      for (const p of tokenProblems(text)) errors.push({ path: at, message: p });
      const bad = [...new Set(withoutTokens(text).replace(/[A-Za-z0-9/-]/g, ''))];
      if (bad.length > 0) {
        const shown = bad.map((c) => (c === ' ' ? 'a space' : `'${c}'`)).join(', ');
        const rows = label === 'prefix' ? n.prefixRows : n.suffixRows;
        const when = i === 0 ? '' : ` applicable from ${rows?.[i - 1]?.applicableFrom ?? ''}`;
        flag(at, `The ${label}${when} contains ${shown}. GST invoice numbers may contain only letters, digits, '/' and '-'.`);
      }
    });
  }
  if (n.method === 'automatic' || n.method === 'automatic_override') {
    const pLen = Math.max(...prefixes.map(expandedMaxLength));
    const sLen = Math.max(...suffixes.map(expandedMaxLength));
    const room = GST_DOC_NUMBER_MAX_LENGTH - pLen - sLen;
    const digits = Math.max(n.width, String(n.start).length);
    if (digits > room) {
      flag(
        'numbering.prefix',
        `Voucher numbers would be ${pLen + digits + sLen} characters long (prefix ${pLen} + number ${digits} + suffix ${sLen}). ` +
          'GST invoice numbers can have at most 16 characters: shorten the prefix or suffix, or reduce the zero padding.',
      );
    } else if (gstDoc && room < 6) {
      warnings.push(
        `Voucher numbers will be longer than 16 characters after no. ${formatIndianNumber(10 ** room - 1, 0)}. GST invoice numbers can have at most 16 characters; consider a shorter prefix or suffix.`,
      );
    }
  }
  if (gstDoc && gstEnabled) {
    // A monthly restart repeats numbers within the financial year unless every prefix / suffix
    // variant carries the month ({MM} / {MMM}) — then each month's numbers are distinct.
    const monthInEvery = prefixes.every((p) => suffixes.every((x) => hasMonthToken(p) || hasMonthToken(x)));
    if (n.restart === 'monthly' && n.method !== 'manual' && n.method !== 'none' && !monthInEvery) {
      errors.push({
        path: 'numbering.restart',
        message:
          'Numbers would restart every month with the same prefix, so invoice numbers would repeat within the financial year. ' +
          'GST requires a number to be unique for the whole financial year: restart yearly (or never), or put {MM} or {MMM} in the prefix or suffix.',
      });
    }
    if (n.method === 'manual') warnings.push('Manual numbering: make sure every number is unique within the financial year (GST requirement).');
    if (n.method === 'none') errors.push({ path: 'numbering.method', message: 'GST invoices, credit notes and debit notes must carry a serial number: choose automatic or manual numbering.' });
  }
  return { errors, warnings };
}

/** Problems with dated rows as typed (dates, duplicates, length) — paths `numbering.<kind>Rows[i].…`. */
export function numberingRowProblems(kind: 'prefix' | 'suffix', rows: readonly NumberingTextRow[], booksFrom?: string): NumberingCheckIssue[] {
  const out: NumberingCheckIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const at = `numbering.${kind}Rows[${i}]`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.applicableFrom)) out.push({ path: `${at}.applicableFrom`, message: 'Enter the date from which this applies.' });
    else if (seen.has(r.applicableFrom)) out.push({ path: `${at}.applicableFrom`, message: `Two ${kind} rows apply from the same date. Keep one.` });
    else if (booksFrom && r.applicableFrom <= booksFrom) out.push({ path: `${at}.applicableFrom`, message: `A dated ${kind} must apply after the books beginning; change the ${kind} itself for earlier vouchers.` });
    seen.add(r.applicableFrom);
    if ((r.text ?? '').length > NUMBERING_TEXT_MAX) out.push({ path: `${at}.text`, message: `The ${kind} can have at most ${NUMBERING_TEXT_MAX} characters.` });
  });
  return out;
}

// ───────────────────────────── 2.0: typed numbers and scheme summary ─────────────────────────────

/** Longest number a user may type for a voucher that is not a GST document (VoucherInput.numberOverride). */
export const VOUCHER_NUMBER_MAX_LENGTH = 60;

const describeChars = (chars: readonly string[]): string => chars.map((c) => (c === ' ' ? 'a space' : `'${c}'`)).join(', ');

/**
 * Problems with a GST document number as typed (CGST Rule 46(b): at most 16 characters, letters, digits,
 * '/' and '-' only) — the single source of these messages for the core and the screens. [] when valid.
 */
export function gstDocNumberProblems(number: string): string[] {
  const n = number.trim();
  if (n.length === 0) return ['Enter the invoice number.'];
  const out: string[] = [];
  if (n.length > GST_DOC_NUMBER_MAX_LENGTH) out.push(`GST invoice numbers can have at most ${GST_DOC_NUMBER_MAX_LENGTH} characters; this one has ${n.length}.`);
  const bad = [...new Set(n.replace(/[A-Za-z0-9/-]/g, ''))];
  if (bad.length > 0) out.push(`GST invoice numbers may contain only letters, digits, '/' and '-' (not ${describeChars(bad)}).`);
  return out;
}

/**
 * Problems with a voucher number typed by an authorised user. A GST document (`gstDoc`: sales, credit
 * or debit note of a GST company) follows gstDocNumberProblems; any other voucher number has 1–60
 * characters and no control characters.
 */
export function voucherNumberProblems(number: string, gstDoc: boolean): string[] {
  if (gstDoc) return gstDocNumberProblems(number);
  const n = number.trim();
  if (n.length === 0) return ['Enter the voucher number.'];
  const out: string[] = [];
  if (n.length > VOUCHER_NUMBER_MAX_LENGTH) out.push(`Voucher numbers can have at most ${VOUCHER_NUMBER_MAX_LENGTH} characters; this one has ${n.length}.`);
  if (/[\u0000-\u001f\u007f]/.test(n)) out.push('A voucher number cannot contain tabs, line breaks or other control characters.');
  return out;
}

export type NumberingResetsOn = 'financial year' | 'month' | 'never';

export interface SchemeDescription {
  /** The number `seq` (default: the starting number) takes on `date`, e.g. 'INV/26-27/0001'. */
  example: string;
  /** First day of the next financial year and the number a voucher dated then gets ('INV/27-28/0001'). */
  nextFy: { date: string; number: string };
  /** Longest number the scheme can produce (tokens at their longest, every dated variant). */
  longest: number;
  resetsOn: NumberingResetsOn;
}

/**
 * Plain-language summary of a numbering scheme for the Invoice Numbering screen: an example for
 * `date`, the first number of the next financial year (the starting number again when the series
 * restarts; `seq` continued when it never restarts), the longest number and when it restarts.
 */
export function describeScheme(n: NumberingScheme, date: string, fyStartMonth = 4, seq?: number): SchemeDescription {
  const start = Number.isSafeInteger(n.start) && n.start > 0 ? n.start : 1;
  const current = seq !== undefined && Number.isSafeInteger(seq) && seq > 0 ? seq : start;
  const nextDate = addDays(financialYear(date, fyStartMonth).end, 1);
  const prefixes = variants(n.prefix, n.prefixRows);
  const suffixes = variants(n.suffix, n.suffixRows);
  const digits = Math.max(n.width, String(n.restart === 'never' ? Math.max(current, start) : start).length);
  return {
    example: formatSchemeNumber(n, current, date, fyStartMonth),
    nextFy: { date: nextDate, number: formatSchemeNumber(n, n.restart === 'never' ? current : start, nextDate, fyStartMonth) },
    longest: Math.max(...prefixes.map(expandedMaxLength)) + digits + Math.max(...suffixes.map(expandedMaxLength)),
    resetsOn: n.restart === 'yearly' ? 'financial year' : n.restart === 'monthly' ? 'month' : 'never',
  };
}
