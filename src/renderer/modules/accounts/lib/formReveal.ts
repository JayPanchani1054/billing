/**
 * "More details" auto-reveal of the Group and Voucher Type forms (2.1, SPEC-21 D23). Pure — tested in
 * formReveal.test.ts and, against the real seeded books, in coreContract.test.ts.
 *
 * The section opens by itself when a field inside holds an error, or a value the user (or an import) chose
 * — never because of what the books fill in by themselves, or the form would be open on every alteration
 * and the disclosure would hide nothing:
 *
 *   group ......... the alias and the three "Display and behaviour" switches; NOT "Position in reports"
 *                   (the books number every group — built-in 10…280, a new one the next free number — so
 *                   it always holds a value); its error still reveals it
 *   voucher type .. the alias, "inactive", the behaviour switches, the defaults and the printing texts;
 *                   NOT the abbreviation the books give (a built-in's own, or the first 10 letters of the
 *                   name), "Prevent duplicate numbers" in its usual state (on for a built-in type; either
 *                   state for your own types — both create paths are in use), the default sales / purchase
 *                   ledger (the books give it to the built-in Sales, Purchase and note types, and a new type
 *                   takes its parent's; it shows on every new voucher of the type anyway), or the print-
 *                   layout options edited from the print preview (kept as loaded, not shown in this form)
 */
import { hasValue, sameValue } from '../../../ui/lib/disclosure.ts';

type Errors = Readonly<Record<string, string | undefined>>;

const anyError = (errors: Errors, keys: readonly string[]): boolean =>
  Object.entries(errors).some(([k, msg]) => !!msg && keys.some((f) => k === f || k.startsWith(`${f}.`) || k.startsWith(`${f}[`)));

// ───────────────────────────── Group ─────────────────────────────

/** What sits behind the group form's "More details" (in screen order). */
export const GROUP_MORE_FIELDS = ['alias', 'isSubledger', 'netBalances', 'usedForCalculation', 'sortOrder'] as const;

export interface GroupRevealDraft {
  alias: string;
  isSubledger: boolean;
  netBalances: boolean;
  usedForCalculation: boolean;
  sortOrder: number | null;
}

/** True when the group form's "More details" must be open whatever the user chose. */
export function groupMoreRevealed(d: GroupRevealDraft, errors: Errors): boolean {
  if (anyError(errors, GROUP_MORE_FIELDS)) return true;
  // sortOrder is left out on purpose: the books give every group one (see the file header).
  return hasValue(d.alias) || d.isSubledger || d.netBalances || d.usedForCalculation;
}

// ───────────────────────────── Voucher type ─────────────────────────────

/** The behaviour switches of a voucher type (the form's FLAGS, in screen order). */
export const VOUCHER_TYPE_FLAGS = ['preventDuplicates', 'useEffectiveDate', 'allowZeroValue', 'optionalByDefault', 'narrationPerEntry', 'printAfterSave'] as const;
export type VoucherTypeFlag = (typeof VOUCHER_TYPE_FLAGS)[number];

/** Print-layout settings edited from the print preview: kept as loaded, never a reason to open More details. */
export const PRINT_LAYOUT_KEYS: ReadonlySet<string> = new Set(['showHsnSummary', 'showBankDetails', 'showUpiQr', 'itemwiseTax', 'printLayout']);

export interface VoucherTypeRevealDraft extends Record<VoucherTypeFlag, boolean> {
  name: string;
  alias: string;
  abbreviation: string;
  isActive: boolean;
  config: Readonly<Record<string, unknown>>;
}

/** The type as loaded (null for a new one): what the books gave it is "usual", not data to show. */
export interface VoucherTypeOrigin {
  name: string;
  isPredefined: boolean;
  abbreviation: string | null;
}

/** The abbreviation the books give a type they create without one: the first 10 letters of its name. */
export function automaticAbbreviation(name: string): string {
  return name.trim().slice(0, 10).trim();
}

/** The usual (not revealing) values of the fields the books fill in by themselves. */
export interface VoucherTypeUsual {
  abbreviation: readonly string[];
  preventDuplicates: readonly boolean[];
}

export function voucherTypeUsual(origin: VoucherTypeOrigin | null, name: string): VoucherTypeUsual {
  const abbreviation = ['', automaticAbbreviation(name)];
  if (origin) {
    abbreviation.push(automaticAbbreviation(origin.name));
    if (origin.isPredefined) abbreviation.push((origin.abbreviation ?? '').trim());
  }
  return {
    abbreviation,
    preventDuplicates: origin?.isPredefined ? [true] : [true, false],
  };
}

/** The fields behind the voucher type form's "More details" whose error opens it. */
const VT_MORE_KEYS = ['abbreviation', 'alias', 'isActive', ...VOUCHER_TYPE_FLAGS, 'config'] as const;

/** True when the voucher type form's "More details" must be open whatever the user chose. */
export function voucherTypeMoreRevealed(d: VoucherTypeRevealDraft, errors: Errors, usual: VoucherTypeUsual): boolean {
  if (anyError(errors, VT_MORE_KEYS)) return true;
  if (hasValue(d.alias) || !d.isActive) return true;
  if (!usual.abbreviation.some((a) => sameValue(a, d.abbreviation))) return true;
  if (!usual.preventDuplicates.includes(d.preventDuplicates)) return true;
  for (const f of VOUCHER_TYPE_FLAGS) if (f !== 'preventDuplicates' && d[f]) return true;
  for (const [k, v] of Object.entries(d.config)) {
    if (PRINT_LAYOUT_KEYS.has(k) || k === 'defaultLedgerId') continue;
    // A switch-like option set to false ("Do not print MRP") is a choice too; only "not set" is empty.
    if (v === false || hasValue(v)) return true;
  }
  return false;
}
