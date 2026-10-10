/**
 * Change Number dialog (Ctrl+R in voucher entry and voucher view) — the pure view-model (tested in
 * changeNumber.test.ts). The dialog types a new number, checks it live with 'vouchers.numberCheck'
 * (format + uniqueness in the scope the save applies: the financial year for an outward GST document,
 * else the numbering period), takes an optional reason for the edit log and can continue the automatic
 * series from the new number. Entry stores the result as VoucherInput.numberOverride (sent with the
 * normal save); view calls 'vouchers.renumber'. The server repeats every check.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatSchemeNumber, GST_DOC_NUMBER_MAX_LENGTH, GST_NUMBERED_BASE_TYPES, parseSchemeSeq, voucherNumberProblems } from '../../../../shared/numbering.ts';
import type { NumberingScheme } from '../../../../shared/numbering.ts';
import type { NumberingMethod, VoucherNumberCheckResult, VoucherNumberOverride } from '../../../../shared/types/vouchers.ts';

/** Longest reason kept in the edit log (VoucherNumberOverride.reason). */
export const RENUMBER_REASON_MAX = 200;

/** Debounce of the live number check (ms). */
export const NUMBER_CHECK_DEBOUNCE_MS = 300;

/** A GST document number (sales, credit / debit note of a GST company): ≤ 16 characters, letters, digits, '/' and '-'. */
export function isGstDocType(baseType: VoucherBaseType, gstEnabled: boolean): boolean {
  return gstEnabled && GST_NUMBERED_BASE_TYPES.includes(baseType);
}

/** "invoice", "credit note", "debit note" or "voucher" — the noun of the dialog's title and texts. */
export function numberNoun(baseType: VoucherBaseType): string {
  if (baseType === 'sales') return 'invoice';
  if (baseType === 'credit_note') return 'credit note';
  if (baseType === 'debit_note') return 'debit note';
  return 'voucher';
}

/** Dialog title: "Change invoice number". */
export function changeNumberTitle(baseType: VoucherBaseType): string {
  return `Change ${numberNoun(baseType)} number`;
}

/** Where the Change number action is offered and why it may be greyed out. */
export interface ChangeNumberAvailability {
  hidden: boolean;
  disabled: boolean;
  /** Why it is disabled (tooltip / description), else undefined. */
  hint: string | undefined;
}

/**
 * Ctrl+R "Change number":
 * - entry (create and alter): shown when the user holds `vouchers.renumber` and the type is numbered;
 * - view: shown with `vouchers.renumber` + `vouchers.alter` (method unknown → shown; the server explains
 *   numbering "None"), disabled with the reason when the voucher is cancelled or its e-invoice (IRN) exists.
 */
export function changeNumberAvailability(a: {
  where: 'entry' | 'view';
  canRenumber: boolean;
  canAlter?: boolean;
  method: NumberingMethod | null;
  isCancelled?: boolean;
  irnGenerated?: boolean;
}): ChangeNumberAvailability {
  const hidden = !a.canRenumber || a.method === 'none' || (a.where === 'view' && a.canAlter !== true);
  if (hidden) return { hidden: true, disabled: true, hint: undefined };
  if (a.where === 'view' && a.isCancelled) return { hidden: false, disabled: true, hint: 'A cancelled voucher keeps its number (GST numbering stays continuous).' };
  if (a.where === 'view' && a.irnGenerated) return { hidden: false, disabled: true, hint: 'An e-invoice (IRN) has been generated for this number: cancel the e-invoice first.' };
  return { hidden: false, disabled: false, hint: undefined };
}

/** Result of the live check, kept with the number it was asked for (a stale answer is never shown). */
export interface NumberCheckState {
  /** The trimmed number the result / error belongs to. */
  number: string;
  result: VoucherNumberCheckResult | null;
  error: string | null;
}

export interface NumberMessage {
  tone: 'neutral' | 'success' | 'danger';
  text: string;
  /** "Use this number" may be pressed. */
  canAccept: boolean;
}

/**
 * The line under "New number": "✓ Available in FY 2026-27 · 14 of 16 characters", "INV/26-27/0005 is
 * already used in FY 2026-27", the format problems (shared gstDocNumberProblems texts, shown at once
 * without waiting for the server), or "Checking…". Accept is enabled only by a fresh `ok` answer.
 */
export function numberMessage(typed: string, current: string | null, gstDoc: boolean, check: NumberCheckState | null): NumberMessage {
  const n = typed.trim();
  if (n === '') return { tone: 'neutral', text: gstDoc ? `Up to ${GST_DOC_NUMBER_MAX_LENGTH} letters, digits, '/' or '-'.` : 'Type the new number.', canAccept: false };
  if (current !== null && n === current.trim()) return { tone: 'neutral', text: 'This is the current number.', canAccept: false };
  const problems = voucherNumberProblems(n, gstDoc);
  if (problems.length > 0) return { tone: 'danger', text: problems.join(' '), canAccept: false };
  if (!check || check.number !== n) return { tone: 'neutral', text: 'Checking…', canAccept: false };
  if (check.error !== null) return { tone: 'danger', text: check.error, canAccept: false };
  const r = check.result;
  if (!r) return { tone: 'neutral', text: 'Checking…', canAccept: false };
  if (r.taken) return { tone: 'danger', text: `${n} is already used in ${r.scopeLabel}.`, canAccept: false };
  if (r.problems.length > 0) return { tone: 'danger', text: r.problems.join(' '), canAccept: false };
  if (!r.ok) return { tone: 'danger', text: 'This number cannot be used.', canAccept: false };
  const length = gstDoc ? ` · ${n.length} of ${GST_DOC_NUMBER_MAX_LENGTH} characters` : '';
  return { tone: 'success', text: `✓ Available in ${r.scopeLabel}${length}`, canAccept: true };
}

export interface ContinueSeriesState {
  enabled: boolean;
  /** Checkbox label: "Continue the series from here (next invoice will be INV/26-27/0142)". */
  label: string;
  /** Why it is disabled, else undefined. */
  reason: string | undefined;
}

/**
 * "Continue the series from here": only for automatically numbered series, only when the new number is
 * in the series' format on the voucher date (its sequence parses) and lies above the counter — the next
 * automatic number's sequence (the counter never goes back: commitNumber never lowers it).
 */
export function continueSeriesState(a: {
  method: NumberingMethod;
  scheme: Pick<NumberingScheme, 'prefix' | 'suffix' | 'width' | 'prefixRows' | 'suffixRows'> | null;
  /** The new number's sequence in the series (numberCheck `seq`), null when it does not parse. */
  seq: number | null;
  /** The next automatic number ('' / null when unknown). */
  nextNumber: string | null;
  date: string;
  fyStartMonth: number;
  noun: string;
}): ContinueSeriesState {
  const base = 'Continue the series from here';
  if (a.method === 'manual' || a.method === 'none') return { enabled: false, label: base, reason: 'This series is numbered by hand: there is no automatic number to continue.' };
  if (!a.scheme) return { enabled: false, label: base, reason: 'The series format is not known yet.' };
  if (a.seq === null) {
    const example = a.nextNumber ? ` (like ${a.nextNumber})` : '';
    return { enabled: false, label: base, reason: `Only a number in the series' format${example} can continue the series.` };
  }
  const nextSeq = a.nextNumber ? parseSchemeSeq(a.scheme, a.nextNumber, a.date, a.fyStartMonth) : null;
  if (nextSeq !== null && a.seq < nextSeq) {
    return { enabled: false, label: base, reason: `The next ${a.noun} already gets ${a.nextNumber}: the series never goes back.` };
  }
  const after = formatSchemeNumber(a.scheme, a.seq + 1, a.date, a.fyStartMonth);
  return { enabled: true, label: `${base} (next ${a.noun} will be ${after})`, reason: undefined };
}

/** The override the dialog hands back (trimmed; the reason only when given; continueSeries only when ticked and allowed). */
export function overrideOf(typed: string, reason: string, continueSeries: boolean): VoucherNumberOverride {
  const o: VoucherNumberOverride = { number: typed.trim() };
  const r = reason.trim().slice(0, RENUMBER_REASON_MAX);
  if (r !== '') o.reason = r;
  if (continueSeries) o.continueSeries = true;
  return o;
}

/** Toast after renumbering from the view: "Sales INV/26-27/0042 renumbered to INV/26-27/0141". */
export function renumberedText(typeName: string, from: string | null, to: string | null): string {
  return `${typeName} ${from ?? ''} renumbered to ${to ?? ''}`.replace(/\s+/g, ' ').trim();
}
