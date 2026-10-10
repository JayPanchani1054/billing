/**
 * Voucher-type numbering: live preview of the numbers a scheme produces and the GST invoice-number
 * checks (≤ 16 characters, only A–Z a–z 0–9 / -, unique for the financial year). Mirrors core
 * `checkNumbering` (src/core/modules/accounts/voucherTypes.ts) and `formatVoucherNumber`
 * (src/core/modules/vouchers/numbering.ts) so the form can warn before saving.
 * Pure — tested in numbering.test.ts.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import {
  checkNumberingScheme,
  describeScheme,
  expandedMaxLength,
  expandNumberingText,
  formatSchemeNumber,
  GST_DOC_NUMBER_MAX_LENGTH,
  GST_NUMBERED_BASE_TYPES,
  NUMBERING_TEXT_MAX,
  NUMBERING_TOKENS,
} from '../../../../shared/numbering.ts';
import type { SchemeDescription } from '../../../../shared/numbering.ts';
import { formatIndianNumber } from '../../../../shared/format.ts';
import type { NumberingMethod, NumberingRestart, VoucherNumbering, VoucherTypeRow } from '../../../../shared/types/accounts.ts';

/** GST documents whose numbers go to GSTR-1 — the shared list the core uses (src/shared/numbering.ts). */
export const GST_DOCUMENT_BASE_TYPES: readonly VoucherBaseType[] = GST_NUMBERED_BASE_TYPES;
export { GST_DOC_NUMBER_MAX_LENGTH };

export const METHOD_OPTIONS: ReadonlyArray<{ value: NumberingMethod; label: string; hint: string }> = [
  { value: 'automatic', label: 'Automatic', hint: 'The next number is given on save; it cannot be changed.' },
  { value: 'automatic_override', label: 'Automatic (can change)', hint: 'Suggested automatically; you may type another number.' },
  { value: 'manual', label: 'Manual', hint: 'You type every number yourself.' },
  { value: 'none', label: 'None', hint: 'Vouchers carry no number.' },
];

export const RESTART_OPTIONS: ReadonlyArray<{ value: NumberingRestart; label: string }> = [
  { value: 'yearly', label: 'Every financial year' },
  { value: 'monthly', label: 'Every month' },
  { value: 'never', label: 'Never' },
];

/**
 * A number of the scheme. With a voucher `date` the tokens ({FY} {MM} …) and the dated prefix /
 * suffix rows in force on that date are applied (dataplus, src/shared/numbering.ts); without one the
 * prefix / suffix are shown as typed.
 */
export function formatNumber(n: Pick<VoucherNumbering, 'prefix' | 'suffix' | 'width' | 'prefixRows' | 'suffixRows'>, seq: number, date?: string, fyStartMonth = 4): string {
  if (date !== undefined) return formatSchemeNumber(n, seq, date, fyStartMonth);
  const body = n.width > 0 ? String(seq).padStart(n.width, '0') : String(seq);
  return `${n.prefix ?? ''}${body}${n.suffix ?? ''}`;
}

/**
 * Numbers shown in the live preview: the first two numbers of a numbering period, for a voucher
 * dated `date` (tokens expanded). null for manual numbering or no numbering (nothing is generated).
 */
export function numberingPreview(n: VoucherNumbering, date?: string, fyStartMonth = 4): { first: string; second: string } | null {
  if (n.method === 'none' || n.method === 'manual') return null;
  const start = Math.max(1, Math.floor(n.start || 1));
  return { first: formatNumber(n, start, date, fyStartMonth), second: formatNumber(n, start + 1, date, fyStartMonth) };
}

/** Plain-English description of when the numbers start again. */
export function restartText(r: NumberingRestart, fyLabel?: string): string {
  if (r === 'monthly') return 'Starts again on the 1st of every month.';
  if (r === 'never') return 'Never starts again — numbers keep running across years.';
  return `Starts again every financial year${fyLabel ? ` (next: ${fyLabel})` : ''}.`;
}

/** Characters that GST does not allow in a document number (deduplicated, in order). */
export function badCharacters(text: string): string[] {
  return [...new Set(text.replace(/[A-Za-z0-9/-]/g, ''))];
}

export interface NumberingIssue {
  /** Field path as the server reports it ('numbering.prefix', 'numbering.prefixRows[0].text' …). */
  path: string;
  message: string;
}

/**
 * Same rules as the core (one implementation: src/shared/numbering.ts › checkNumberingScheme): for
 * sales / credit note / debit note of a GST company these are errors (the save would be refused);
 * otherwise warnings. Tokens and dated prefix / suffix rows are checked at their longest expansion.
 */
export function checkNumbering(baseType: VoucherBaseType, n: VoucherNumbering, gstEnabled: boolean): { errors: NumberingIssue[]; warnings: string[] } {
  return checkNumberingScheme(baseType, n, gstEnabled);
}

const DEFAULT_NUMBERING: VoucherNumbering = { method: 'automatic', prefix: null, suffix: null, start: 1, width: 0, restart: 'yearly' };

/**
 * Numbering a NEW voucher type starts with (same as the core): the parent's method, padding and
 * restart, but no prefix/suffix and start 1. Copying the parent's prefix would give two series that
 * issue the same numbers (Sales INV/1 and Cash Sales INV/1).
 */
export function newTypeNumbering(parent: VoucherNumbering | null): VoucherNumbering {
  return parent ? { ...parent, prefix: null, suffix: null, start: 1 } : { ...DEFAULT_NUMBERING };
}

const fix = (v: string | null): string => (v ?? '').trim().toUpperCase();

/**
 * Other active voucher types of the same GST document kind (sales / credit note / debit note) whose
 * automatic numbers look exactly like this one's (same prefix, suffix and padding, compared without
 * case as the GST portal does). Two such series issue the same numbers, and GST needs each
 * document number to be unique in the financial year. Empty for other base types.
 */
export function seriesClashes(
  types: readonly Pick<VoucherTypeRow, 'id' | 'name' | 'baseType' | 'isActive' | 'numbering'>[],
  selfId: number | null,
  baseType: VoucherBaseType,
  n: VoucherNumbering,
): string[] {
  if (!GST_DOCUMENT_BASE_TYPES.includes(baseType) || !isAutomatic(n.method)) return [];
  return types
    .filter(
      (t) =>
        t.id !== selfId &&
        t.isActive &&
        t.baseType === baseType &&
        isAutomatic(t.numbering.method) &&
        fix(t.numbering.prefix) === fix(n.prefix) &&
        fix(t.numbering.suffix) === fix(n.suffix) &&
        t.numbering.width === n.width,
    )
    .map((t) => t.name);
}

/** Plain-English warning for `seriesClashes` (null when there is none). */
export function seriesClashWarning(names: readonly string[], n: VoucherNumbering): string | null {
  if (names.length === 0) return null;
  const sample = formatNumber(n, 1);
  const who = names.length === 1 ? `“${names[0]}” already numbers` : `${names.map((x) => `“${x}”`).join(', ')} already number`;
  const how = n.prefix || n.suffix ? 'the same way' : 'without a prefix';
  return `${who} documents ${how}, so both series would issue ${sample}, ${formatNumber(n, 2)} … GST needs every document number to be unique in the financial year: give this type its own prefix (e.g. CS/ for cash sales).`;
}

/** Length of the longest number for a width/start (for the "12 of 16 characters" meter). */
export function numberLength(n: VoucherNumbering): number {
  const digits = Math.max(n.width, String(Math.max(1, n.start)).length);
  const longest = (base: string | null, rows: VoucherNumbering['prefixRows']): number => Math.max(expandedMaxLength(base), ...(rows ?? []).map((r) => expandedMaxLength(r.text)));
  return longest(n.prefix, n.prefixRows) + digits + longest(n.suffix, n.suffixRows);
}

/** Ledger side a voucher type's default ledger must be on (null = not applicable). Mirrors the core. */
export function defaultLedgerSide(baseType: VoucherBaseType): 'sales' | 'purchase' | null {
  if (['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in'].includes(baseType)) return 'sales';
  if (['purchase', 'debit_note', 'purchase_order', 'receipt_note', 'rejection_out'].includes(baseType)) return 'purchase';
  return null;
}

export function isInvoiceBase(baseType: VoucherBaseType): boolean {
  return baseType === 'sales' || baseType === 'purchase' || baseType === 'credit_note' || baseType === 'debit_note';
}

/** Base types that move stock (default godown makes sense). */
export function movesStock(baseType: VoucherBaseType): boolean {
  return !['payment', 'receipt', 'contra', 'journal', 'memorandum', 'reversing_journal'].includes(baseType);
}

export const BASE_TYPE_LABELS: Readonly<Record<VoucherBaseType, string>> = {
  sales: 'Sales',
  purchase: 'Purchase',
  payment: 'Payment',
  receipt: 'Receipt',
  contra: 'Contra',
  journal: 'Journal',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
  delivery_note: 'Delivery Note',
  receipt_note: 'Receipt Note',
  rejection_in: 'Rejections In',
  rejection_out: 'Rejections Out',
  stock_journal: 'Stock Journal',
  physical_stock: 'Physical Stock',
  memorandum: 'Memorandum',
  reversing_journal: 'Reversing Journal',
  quotation: 'Quotation',
  proforma: 'Proforma Invoice',
};

// ───────────────────── 2.0: the Invoice Numbering screen (NumberingScreen.tsx) ─────────────────────
// A focused facade over the voucher types' numbering: the list of number series, the editor drawer
// (prefix / suffix with token chips, digits, start, "start again every financial year", the next
// number), its preview and the GST notes. Everything here is pure; the screen only renders it.

/** The methods in plain words (the Advanced part of the editor). Same values as METHOD_OPTIONS. */
export const SIMPLE_METHOD_OPTIONS: ReadonlyArray<{ value: NumberingMethod; label: string; description: string }> = [
  { value: 'automatic', label: 'Automatic', description: 'Pevqori gives the next number when the voucher is saved.' },
  { value: 'automatic_override', label: 'Automatic, can be typed while entering', description: 'The next number is filled in; you may type another one.' },
  { value: 'manual', label: 'Type manually', description: 'You type every number yourself.' },
  { value: 'none', label: 'No numbers', description: 'Vouchers of this type carry no number.' },
];

/** Zero-padding choices of the "Digits" box: 0 (no zeros) to 9. */
export const DIGIT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Array.from({ length: 10 }, (_, w) => ({
  value: String(w),
  label: w === 0 ? 'No zeros (1)' : `${w} (${'1'.padStart(w, '0')})`,
}));

export const isAutomatic = (m: NumberingMethod): boolean => m === 'automatic' || m === 'automatic_override';

/** Highest next number a series may be set to (core accounts/numbering.ts MAX_NEXT_NUMBER). */
export const MAX_NEXT_NUMBER = 999_999_999;

export interface TokenChip {
  token: string;
  /** Short chip text: "FY 26-27", "2026-27", "YY", "MM", "Mon". */
  label: string;
  /**
   * Accessible name: the visible text first, then the code it inserts — "FY 26-27 (insert {FY})" — so
   * the name a speech user reads off the chip works (WCAG 2.5.3 label in name).
   */
  name: string;
  /** Tooltip / description: "Insert {FY} — financial year (short), 26-27 today". */
  title: string;
}

/** The insert chips of the editor, with today's expansion of each token in its tooltip. */
export function tokenChips(date: string, fyStartMonth = 4): TokenChip[] {
  const short: Record<string, (x: string) => string> = { '{FY}': (x) => `FY ${x}`, '{FYYYYY}': (x) => x, '{YY}': () => 'YY', '{MM}': () => 'MM', '{MMM}': () => 'Mon' };
  return NUMBERING_TOKENS.map((t) => {
    const now = expandNumberingText(t.token, date, fyStartMonth);
    const label = (short[t.token] ?? (() => t.token))(now);
    return { token: t.token, label, name: `${label} (insert ${t.token})`, title: `Insert ${t.token} — ${t.label.toLowerCase()}, ${now} today` };
  });
}

/**
 * Put `token` at the caret (replacing the selected text) of a prefix / suffix. null when the result
 * would be longer than a prefix / suffix may be typed (16 characters). `caret` is where the caret goes.
 */
export function insertToken(text: string, token: string, selectionStart: number | null, selectionEnd: number | null, max = NUMBERING_TEXT_MAX): { text: string; caret: number } | null {
  const clamp = (v: number | null, fallback: number): number => Math.min(text.length, Math.max(0, v ?? fallback));
  const start = clamp(selectionStart, text.length);
  const end = Math.max(start, clamp(selectionEnd, start));
  const next = `${text.slice(0, start)}${token}${text.slice(end)}`;
  if (next.length > max) return null;
  return { text: next, caret: start + token.length };
}

/** "Start again from the first number every financial year" is on for yearly (and monthly) restarts. */
export const yearlySwitchOn = (r: NumberingRestart): boolean => r !== 'never';
/** The switch: on ⇒ yearly, off ⇒ never. */
export const restartForSwitch = (on: boolean): NumberingRestart => (on ? 'yearly' : 'never');
/** Advanced "every month": on ⇒ monthly, off ⇒ back to yearly. */
export const restartForMonthly = (monthly: boolean): NumberingRestart => (monthly ? 'monthly' : 'yearly');

/** "Every financial year" / "Every month" / "Never" (— for a series without numbers). */
export function restartLabel(n: Pick<VoucherNumbering, 'method' | 'restart'>): string {
  if (n.method === 'none') return '—';
  return RESTART_OPTIONS.find((o) => o.value === n.restart)?.label ?? n.restart;
}

/**
 * The one-click fix for a GST series that restarts every month without the month in its number:
 * the prefix with `{MM}/` added ("INV/{FY}/" → "INV/{FY}/{MM}/"). null when no fix is needed, when the
 * longer prefix would not fit, or when it would not cure the problem (a dated prefix / suffix row
 * without the month — that is fixed in the Voucher Type form). It cures the restart only: a number
 * that becomes longer than 16 characters (e.g. with 4 digits) is then reported by the usual checks.
 */
export function monthFix(baseType: VoucherBaseType, n: VoucherNumbering, gstEnabled: boolean): string | null {
  const restartError = (x: VoucherNumbering): boolean => checkNumberingScheme(baseType, x, gstEnabled).errors.some((e) => e.path === 'numbering.restart');
  if (!restartError(n)) return null;
  const p = n.prefix ?? '';
  const prefix = `${p}${p === '' || /[/-]$/.test(p) ? '' : '/'}{MM}/`;
  if (prefix.length > NUMBERING_TEXT_MAX) return null;
  return restartError({ ...n, prefix }) ? null : prefix;
}

/** The note shown when a GST series no longer starts again every year (D27: still unique per year). */
export function fyUniquenessNote(baseType: VoucherBaseType, n: Pick<VoucherNumbering, 'method' | 'restart'>, gstEnabled: boolean): string | null {
  if (!gstEnabled || !GST_DOCUMENT_BASE_TYPES.includes(baseType) || n.method === 'none' || n.restart !== 'never') return null;
  return 'Numbers must still be unique within each financial year — Pevqori checks this.';
}

export type SeriesGroupId = 'gst' | 'other';

export const SERIES_GROUP_LABELS: Readonly<Record<SeriesGroupId, string>> = { gst: 'Invoices & notes', other: 'Other vouchers' };

/** Invoices, credit and debit notes (GST-numbered documents) come first; everything else is "Other vouchers". */
export const seriesGroup = (baseType: VoucherBaseType): SeriesGroupId => (GST_DOCUMENT_BASE_TYPES.includes(baseType) ? 'gst' : 'other');

/** What the list needs from 'accounts.voucherType.numberingStatus' (src/shared/types/vouchers.ts NumberingStatusRow). */
export interface SeriesStatus {
  id: number;
  periodLabel: string;
  counter: number;
  highestUsed: number | null;
  nextSeq: number;
  next: string;
  vouchersInPeriod: number;
}

export type SeriesListRow =
  | { kind: 'group'; key: string; group: SeriesGroupId; label: string; count: number }
  | {
      kind: 'series';
      key: string;
      group: SeriesGroupId;
      type: VoucherTypeRow;
      status: SeriesStatus | null;
      /** A number of the series dated `date` (its starting number), "Typed by hand" or "—". */
      example: string;
      restarts: string;
      /** The next automatic number, "Typed by hand" or "—". */
      next: string;
      vouchers: number;
    };

/** Text of a series with no automatic numbers. */
function notAutomatic(m: NumberingMethod): string {
  return m === 'manual' ? 'Typed by hand' : '—';
}

/**
 * The list of the Invoice Numbering screen: group rows ("Invoices & notes", then "Other vouchers"),
 * each followed by its series in the order the core lists them. Empty groups are left out.
 */
export function buildSeriesRows(types: readonly VoucherTypeRow[], statuses: readonly SeriesStatus[], date: string, fyStartMonth = 4): SeriesListRow[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const out: SeriesListRow[] = [];
  for (const group of ['gst', 'other'] as const) {
    const members = types.filter((t) => seriesGroup(t.baseType) === group);
    if (members.length === 0) continue;
    out.push({ kind: 'group', key: `group:${group}`, group, label: SERIES_GROUP_LABELS[group], count: members.length });
    for (const t of members) {
      const status = byId.get(t.id) ?? null;
      const auto = isAutomatic(t.numbering.method);
      out.push({
        kind: 'series',
        key: String(t.id),
        group,
        type: t,
        status,
        example: auto ? formatSchemeNumber(t.numbering, Math.max(1, t.numbering.start || 1), date, fyStartMonth) : notAutomatic(t.numbering.method),
        restarts: restartLabel(t.numbering),
        next: auto ? status?.next || '…' : notAutomatic(t.numbering.method),
        vouchers: status?.vouchersInPeriod ?? 0,
      });
    }
  }
  return out;
}

/** The editor's form state (texts as typed; `next` = the next number's sequence, null when not used). */
export interface SeriesDraft {
  /** Only for a new series (Add series). */
  name: string;
  method: NumberingMethod;
  prefix: string;
  suffix: string;
  width: number;
  start: number;
  restart: NumberingRestart;
  next: number | null;
}

/**
 * The scheme a new series (Create series) starts from: the parent's method, digits and restart, no
 * prefix / suffix, start 1 (`newTypeNumbering`) — and never the parent's dated prefix / suffix rows.
 */
export function newSeriesNumbering(parent: VoucherNumbering): VoucherNumbering {
  const n = newTypeNumbering(parent);
  return { method: n.method, prefix: n.prefix, suffix: n.suffix, start: n.start, width: n.width, restart: n.restart };
}

export function draftFromNumbering(n: VoucherNumbering, nextSeq: number | null, name = ''): SeriesDraft {
  return { name, method: n.method, prefix: n.prefix ?? '', suffix: n.suffix ?? '', width: n.width, start: Math.max(1, n.start || 1), restart: n.restart, next: isAutomatic(n.method) ? nextSeq : null };
}

/** The scheme the draft describes (dated prefix / suffix rows kept from `base`). */
export function draftNumbering(base: VoucherNumbering, d: SeriesDraft): VoucherNumbering {
  return { ...base, method: d.method, prefix: d.prefix === '' ? null : d.prefix, suffix: d.suffix === '' ? null : d.suffix, width: d.width, start: d.start, restart: d.restart };
}

/**
 * Key-level patch for 'accounts.voucherType.save { id, numbering }': only the keys the draft changed
 * (dated rows are never sent, so they stay as they are). null when nothing changed.
 */
export function numberingPatch(base: VoucherNumbering, d: SeriesDraft): Partial<VoucherNumbering> | null {
  const now = draftNumbering(base, d);
  const patch: Partial<VoucherNumbering> = {};
  if (now.method !== base.method) patch.method = now.method;
  if ((now.prefix ?? null) !== (base.prefix ?? null)) patch.prefix = now.prefix;
  if ((now.suffix ?? null) !== (base.suffix ?? null)) patch.suffix = now.suffix;
  if (now.width !== base.width) patch.width = now.width;
  if (now.start !== base.start) patch.start = now.start;
  if (now.restart !== base.restart) patch.restart = now.restart;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Problem with the next number as typed (null when fine): a whole number from the starting number up. */
export function nextNumberProblem(next: number | null, start: number): string | null {
  if (next === null || !Number.isSafeInteger(next) || next < 1 || next > MAX_NEXT_NUMBER) return `Enter a whole number from 1 to ${formatIndianNumber(MAX_NEXT_NUMBER, 0)}.`;
  if (next < start) return `The series starts at ${formatIndianNumber(start, 0)}. Lower the starting number to go below it.`;
  return null;
}

/** The next number to send to 'accounts.voucherType.setNextNumber' after saving: only when it was changed. */
export function nextNumberToSet(d: SeriesDraft, initial: SeriesDraft): number | null {
  if (!isAutomatic(d.method) || d.next === null || d.next === initial.next) return null;
  return d.next;
}

/**
 * The next sequence the preview shows for an alteration, as the core will give it after the save
 * (vouchers/numbering.ts: max(counter, start − 1) + 1, taken numbers skipped):
 *  - a next number typed in the editor → that number (it is set after the save);
 *  - only the starting number changed → max(the next number without the old start, the new start);
 *  - the restart changed, or the series was not automatic → null: the counter of the new period is
 *    seeded from the numbers already used when the type is saved, so it is known only then.
 */
export function previewNextSeq(d: SeriesDraft, initial: SeriesDraft, status: Pick<SeriesStatus, 'counter' | 'nextSeq'> | null): number | null {
  if (!isAutomatic(d.method)) return null;
  if (d.next !== initial.next) return d.next;
  if (initial.next === null || d.restart !== initial.restart) return null;
  if (d.start === initial.start) return initial.next;
  if (status === null) return null;
  // The old starting number held the series up (nothing given out above it yet): drop it.
  const withoutStart = status.counter + 1 >= initial.start ? status.nextSeq : status.counter + 1;
  return Math.max(withoutStart, d.start);
}

export interface SeriesPreview {
  today: { date: string; number: string };
  nextFy: { date: string; number: string };
  longest: number;
  resetsOn: SchemeDescription['resetsOn'];
}

/**
 * "10-Oct-2026 → INV/26-27/0042 · 1-Apr-2027 → INV/27-28/0001 · longest 14 of 16" (null for manual /
 * none). `seq` = the next sequence (`previewNextSeq`); without it the numbers start at the starting number.
 */
export function seriesPreview(n: VoucherNumbering, date: string, fyStartMonth = 4, seq?: number | null): SeriesPreview | null {
  if (!isAutomatic(n.method)) return null;
  const d = describeScheme(n, date, fyStartMonth, seq ?? undefined);
  return { today: { date, number: d.example }, nextFy: d.nextFy, longest: d.longest, resetsOn: d.resetsOn };
}

/** "Valid GST invoice number" (sales) / "Valid GST note number" (credit and debit notes). */
export function gstValidText(baseType: VoucherBaseType): string {
  return baseType === 'sales' ? 'Valid GST invoice number' : 'Valid GST note number';
}

/** "longest 14 of 16 characters" for a GST document of a GST company, else "longest 14 characters". */
export function lengthNote(longest: number, gstDoc: boolean): string {
  return gstDoc ? `longest ${longest} of ${GST_DOC_NUMBER_MAX_LENGTH} characters` : `longest ${longest} characters`;
}

/** The confirm-level warnings of a needs-confirmation error (strings, or VoucherWarning-like `{ message }`). */
export function confirmWarningsOf(details: unknown): string[] {
  if (typeof details !== 'object' || details === null) return [];
  const raw = (details as { warnings?: unknown }).warnings;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((w) => (typeof w === 'string' ? w : typeof w === 'object' && w !== null && typeof (w as { message?: unknown }).message === 'string' ? (w as { message: string }).message : ''))
    .filter((w) => w.trim() !== '');
}

/** What 'accounts.voucherType.numberGaps' returns (src/shared/types/vouchers.ts NumberGapsResult). */
export interface GapsSummaryInput {
  first: string | null;
  last: string | null;
  issued: number;
  missing: readonly string[];
  missingCount: number;
}

/** One line for the editor: "3 missing (INV/5, INV/6, INV/9)" / "No gaps …" / "No numbers issued yet …". */
export function gapsSummary(g: GapsSummaryInput, shown = 3): string {
  if (g.issued === 0) return 'No numbers issued yet this financial year.';
  if (g.missingCount === 0) return g.first && g.last && g.first !== g.last ? `No gaps: every number from ${g.first} to ${g.last} was issued.` : 'No gaps.';
  const listed = g.missing.slice(0, shown).join(', ');
  return `${formatIndianNumber(g.missingCount, 0)} missing (${listed}${g.missingCount > shown ? ', …' : ''})`;
}

/** Problem with a new series' name as typed (null when fine). */
export function seriesNameProblem(name: string, types: readonly Pick<VoucherTypeRow, 'name'>[]): string | null {
  const n = name.trim();
  if (n === '') return 'Enter a name for the series, e.g. Cash Sales or Export Invoice.';
  if (n.length > 60) return 'A name can have at most 60 characters.';
  if (types.some((t) => t.name.trim().toLowerCase() === n.toLowerCase())) return `“${n}” is already a voucher type. Choose another name.`;
  return null;
}
