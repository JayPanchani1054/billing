/**
 * Voucher types and numbering.
 *
 *  - Series per voucher type; counters in voucher_counters keyed by the restart period:
 *    yearly → FY label ('2026-27'), monthly → 'YYYY-MM', never → 'all'.
 *  - Display number = prefix + zero-padded sequence (numbering_width) + suffix. Prefix / suffix may hold
 *    the tokens {FY} {FYYYYY} {YY} {MM} {MMM} and dated rows (voucher_type_numbering_rows) replace them
 *    from a date (dataplus; src/shared/numbering.ts) — all expanded with the voucher date.
 *  - automatic: the next free sequence (numbers already used in the period are skipped).
 *  - automatic_override: as automatic, but the user may type a number (the counter is not consumed).
 *  - manual: the user types the number (required); unique within the period when prevent_duplicates.
 *  - none: no number.
 *  - 2.0 override (VoucherInput.numberOverride, permission vouchers.renumber): an authorised user's own
 *    number on create or alter, whatever the method (except none); format-checked and always unique.
 *  - 2.0 GST rule (CGST Rule 46(b)): an outward GST document (sales, credit note, debit note to a customer
 *    of a GST company) is unique within its FINANCIAL YEAR on every save path, even with
 *    prevent_duplicates off or a monthly / never restart.
 *  Allocation runs inside the save transaction, so a rolled-back save leaves no gap.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { endOfMonth, financialYear, monthKey, MONTH_NAMES, startOfMonth } from '../../../shared/dates.ts';
import { formatSchemeNumber, GST_NUMBERED_BASE_TYPES, parseSchemeSeq, voucherNumberProblems, type NumberingTextRow } from '../../../shared/numbering.ts';
import type { NumberingMethod, NumberingRestart, VoucherMode, VoucherNumberOverride, VoucherTypeView } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import { conflict, forbidden, notFound, validation, type AppError } from '../../lib/errors.ts';
import { classFromChain, groupChain } from '../accounts/books.ts';

interface VoucherTypeRow {
  id: number;
  guid: string;
  name: string;
  abbreviation: string | null;
  base_type: string;
  is_active: number;
  numbering_method: string;
  numbering_prefix: string | null;
  numbering_suffix: string | null;
  numbering_start: number;
  numbering_width: number;
  numbering_restart: string;
  prevent_duplicates: number;
  use_effective_date: number;
  allow_zero_value: number;
  optional_by_default: number;
  narration_per_entry: number;
  print_after_save: number;
  config: string;
}

export type VoucherTypeInfo = VoucherTypeView;

const METHODS: readonly NumberingMethod[] = ['automatic', 'automatic_override', 'manual', 'none'];
const RESTARTS: readonly NumberingRestart[] = ['yearly', 'monthly', 'never'];

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Dated prefix / suffix rows of a voucher type, oldest first (dataplus, migration 221). */
export function loadNumberingRows(db: Db, voucherTypeId: number): { prefix: NumberingTextRow[]; suffix: NumberingTextRow[] } {
  const out = { prefix: [] as NumberingTextRow[], suffix: [] as NumberingTextRow[] };
  for (const r of db.all<{ kind: 'prefix' | 'suffix'; applicable_from: string; text: string | null }>(
    'SELECT kind, applicable_from, text FROM voucher_type_numbering_rows WHERE voucher_type_id = :id ORDER BY applicable_from',
    { id: voucherTypeId },
  )) {
    (r.kind === 'prefix' ? out.prefix : out.suffix).push({ applicableFrom: r.applicable_from, text: r.text });
  }
  return out;
}

export function loadVoucherType(db: Db, id: number): VoucherTypeInfo {
  const r = db.get<VoucherTypeRow>('SELECT * FROM voucher_types WHERE id = :id', { id });
  if (!r) throw notFound('Voucher type', id);
  const rows = loadNumberingRows(db, id);
  return {
    id: r.id,
    name: r.name,
    abbreviation: r.abbreviation,
    baseType: r.base_type as VoucherBaseType,
    isActive: r.is_active === 1,
    numberingMethod: METHODS.includes(r.numbering_method as NumberingMethod) ? (r.numbering_method as NumberingMethod) : 'automatic',
    numberingPrefix: r.numbering_prefix,
    numberingSuffix: r.numbering_suffix,
    numberingStart: Number.isSafeInteger(r.numbering_start) && r.numbering_start > 0 ? r.numbering_start : 1,
    numberingWidth: Math.max(0, Math.min(12, r.numbering_width | 0)),
    numberingRestart: RESTARTS.includes(r.numbering_restart as NumberingRestart) ? (r.numbering_restart as NumberingRestart) : 'yearly',
    numberingPrefixRows: rows.prefix,
    numberingSuffixRows: rows.suffix,
    preventDuplicates: r.prevent_duplicates === 1,
    useEffectiveDate: r.use_effective_date === 1,
    allowZeroValue: r.allow_zero_value === 1,
    optionalByDefault: r.optional_by_default === 1,
    narrationPerEntry: r.narration_per_entry === 1,
    printAfterSave: r.print_after_save === 1,
    config: parseConfig(r.config),
  };
}

export function periodKey(vt: VoucherTypeInfo, date: string, fyStartMonth: number): string {
  if (vt.numberingRestart === 'monthly') return monthKey(date);
  if (vt.numberingRestart === 'never') return 'all';
  return financialYear(date, fyStartMonth).label;
}

/** Date range of the numbering period containing `date` (uniqueness scope). */
export function periodRange(vt: VoucherTypeInfo, date: string, fyStartMonth: number): { from: string; to: string } {
  if (vt.numberingRestart === 'monthly') return { from: startOfMonth(date), to: endOfMonth(date) };
  if (vt.numberingRestart === 'never') return { from: '0000-01-01', to: '9999-12-31' };
  const fy = financialYear(date, fyStartMonth);
  return { from: fy.start, to: fy.end };
}

const schemeOf = (vt: VoucherTypeInfo) => ({
  prefix: vt.numberingPrefix,
  suffix: vt.numberingSuffix,
  width: vt.numberingWidth,
  prefixRows: vt.numberingPrefixRows,
  suffixRows: vt.numberingSuffixRows,
});

/**
 * The number for sequence `seq` of a voucher dated `date` (tokens and dated rows resolved for that
 * date). Without a date (legacy callers) the base prefix / suffix are used with today's tokens.
 */
export function formatVoucherNumber(vt: VoucherTypeInfo, seq: number, date?: string, fyStartMonth = 4): string {
  if (date === undefined) {
    const body = vt.numberingWidth > 0 ? String(seq).padStart(vt.numberingWidth, '0') : String(seq);
    return `${vt.numberingPrefix ?? ''}${body}${vt.numberingSuffix ?? ''}`;
  }
  return formatSchemeNumber(schemeOf(vt), seq, date, fyStartMonth);
}

/**
 * Numeric part of a number typed in this type's format ('INV/0012/26' → 12), else null. With the
 * voucher date the prefix / suffix in force on that date (tokens expanded) is matched.
 */
export function parseVoucherSeq(vt: VoucherTypeInfo, number: string, date?: string, fyStartMonth = 4): number | null {
  if (date !== undefined) return parseSchemeSeq(schemeOf(vt), number, date, fyStartMonth);
  return parseSchemeSeq({ prefix: vt.numberingPrefix, suffix: vt.numberingSuffix }, number, '2000-01-01', fyStartMonth);
}

/**
 * SQL probe: is `number` used by a voucher of a type within a date range? It must look the number up in
 * idx_vouchers_number (voucher_type_id, number), which finds the one or two vouchers holding it. Without
 * statistics (the app never runs ANALYZE) SQLite prefers idx_vouchers_type_date for `voucher_type_id = ?
 * AND date BETWEEN …` and scans every voucher of the type in the year — O(n) per probe, O(n²) for an
 * import. INDEXED BY pins the plan (it fails loudly if the index were ever dropped).
 */
export const NUMBER_TAKEN_SQL = `SELECT 1 FROM vouchers INDEXED BY idx_vouchers_number
  WHERE voucher_type_id = :vt AND number = :number AND date BETWEEN :from AND :to AND id <> :ex LIMIT 1`;

/** Another voucher of this type already uses `number` in the period of `date`? */
export function numberTaken(db: Db, vt: VoucherTypeInfo, number: string, date: string, fyStartMonth: number, excludeId: number | null): boolean {
  const { from, to } = periodRange(vt, date, fyStartMonth);
  return numberTakenIn(db, vt.id, number, from, to, excludeId);
}

/** Another voucher of type `voucherTypeId` dated `from`…`to` uses `number`? (idx_vouchers_number) */
export function numberTakenIn(db: Db, voucherTypeId: number, number: string, from: string, to: string, excludeId: number | null): boolean {
  return db.value(NUMBER_TAKEN_SQL, { vt: voucherTypeId, number, from, to, ex: excludeId ?? 0 }) !== undefined;
}

/** Financial year of `date` (the GST uniqueness scope of an outward GST document). */
export function fyRange(date: string, fyStartMonth: number): { from: string; to: string; label: string } {
  const fy = financialYear(date, fyStartMonth);
  return { from: fy.start, to: fy.end, label: fy.label };
}

/**
 * Where a number of this type would clash with another voucher — the one uniqueness rule of the save
 * path (decideNumber) and of 'vouchers.numberCheck':
 *  - an outward GST document (`gstOutward`) is unique within the financial year of `date`, whatever
 *    prevent_duplicates and the restart say (CGST Rule 46(b)); a series that never restarts and refuses
 *    duplicates is also unique over all years;
 *  - any other voucher is unique within its numbering period when the type refuses duplicates or
 *    `always` (a number typed through numberOverride).
 * null when the number is free.
 */
export function numberClash(
  db: Db,
  vt: VoucherTypeInfo,
  number: string,
  date: string,
  fyStartMonth: number,
  excludeId: number | null,
  opts: { gstOutward: boolean; always: boolean },
): { scope: 'fy'; fyLabel: string } | { scope: 'period' } | null {
  if (opts.gstOutward) {
    const fy = fyRange(date, fyStartMonth);
    if (numberTakenIn(db, vt.id, number, fy.from, fy.to, excludeId)) return { scope: 'fy', fyLabel: fy.label };
    if (vt.preventDuplicates && vt.numberingRestart === 'never' && numberTaken(db, vt, number, date, fyStartMonth, excludeId)) return { scope: 'period' };
    return null;
  }
  return (vt.preventDuplicates || opts.always) && numberTaken(db, vt, number, date, fyStartMonth, excludeId) ? { scope: 'period' } : null;
}

/** Plain label of a numbering period key of a series: 'FY 2026-27', 'Apr 2026', 'All years'. */
export function periodKeyLabel(restart: NumberingRestart, key: string): string {
  if (restart === 'never' || key === 'all') return 'All years';
  if (restart === 'monthly') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : key;
  }
  return `FY ${key}`;
}

/**
 * The uniqueness scope of a number: the financial year for an outward GST document when its series
 * restarts monthly (a yearly series' period IS the financial year; a series that never restarts is
 * unique over all years, which includes it), else the numbering period.
 */
function allocationRange(vt: VoucherTypeInfo, date: string, fyStartMonth: number, gstFy: boolean): { from: string; to: string } {
  return gstFy && vt.numberingRestart === 'monthly' ? fyRange(date, fyStartMonth) : periodRange(vt, date, fyStartMonth);
}

const MAX_SKIP = 100_000;

/**
 * The next free sequence of the period of `date`. `gstFy`: skip numbers already used in the financial
 * year too (outward GST documents of a monthly series whose prefix carries the month — see allocationRange).
 */
export function nextFree(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number, gstFy = false): { number: string; seq: number } {
  const key = periodKey(vt, date, fyStartMonth);
  const last = db.value<number>('SELECT last_number FROM voucher_counters WHERE voucher_type_id = :vt AND period_key = :key', { vt: vt.id, key });
  const { from, to } = allocationRange(vt, date, fyStartMonth, gstFy);
  let seq = Math.max(last ?? 0, vt.numberingStart - 1) + 1;
  for (let i = 0; i < MAX_SKIP; i++, seq++) {
    const number = formatVoucherNumber(vt, seq, date, fyStartMonth);
    if (!numberTakenIn(db, vt.id, number, from, to, null)) return { number, seq };
  }
  throw conflict(`Could not find a free voucher number for ${vt.name}`);
}

/** Next automatic number without consuming it ('' for manual / none). */
export function previewNextNumber(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number, gstFy = false): string {
  if (vt.numberingMethod === 'manual' || vt.numberingMethod === 'none') return '';
  return nextFree(db, vt, date, fyStartMonth, gstFy).number;
}

/** Sales, credit note or debit note of a GST company: its number follows CGST Rule 46(b) (format). */
export function isGstNumberedType(vt: Pick<VoucherTypeInfo, 'baseType'>, gstEnabled: boolean): boolean {
  return gstEnabled && GST_NUMBERED_BASE_TYPES.includes(vt.baseType);
}

/**
 * The series of an outward GST document whatever the party: sales and credit notes of a GST company
 * (a debit note is outward only to a customer — isGstOutwardDocument). Used where no voucher is at
 * hand (next-number previews) so they show what the save allocates.
 */
export function isGstSeriesOutward(vt: Pick<VoucherTypeInfo, 'baseType'>, gstEnabled: boolean): boolean {
  return isGstNumberedType(vt, gstEnabled) && vt.baseType !== 'debit_note';
}

/**
 * Is this voucher an OUTWARD GST document of a GST company (unique per financial year)? Sales and
 * credit notes always; a debit note only in an invoice mode to a customer (Sundry Debtors) — a debit
 * note to a supplier is a purchase return, not a document of ours in GSTR-1 (posting.ts › decideDirection).
 */
export function isGstOutwardDocument(db: Db, vt: Pick<VoucherTypeInfo, 'baseType'>, gstEnabled: boolean, input: { mode: VoucherMode; partyLedgerId?: number }): boolean {
  if (!isGstNumberedType(vt, gstEnabled)) return false;
  if (vt.baseType !== 'debit_note') return true;
  if ((input.mode !== 'item_invoice' && input.mode !== 'accounting_invoice') || input.partyLedgerId === undefined) return false;
  const groupId = db.value<number>('SELECT group_id FROM ledgers WHERE id = :id', { id: input.partyLedgerId });
  if (groupId === undefined) return false;
  const chain = groupChain(db, groupId);
  return chain.length > 0 && classFromChain(chain).isDebtor;
}

/** Advance the counter of the numbering period of `date` to at least `seq`. */
export function commitNumber(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number, seq: number): void {
  db.run(
    `INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:vt, :key, :seq)
     ON CONFLICT(voucher_type_id, period_key) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
    { vt: vt.id, key: periodKey(vt, date, fyStartMonth), seq },
  );
}

/** Find and consume the next automatic number (call inside the save transaction). */
export function allocateNextNumber(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number): { number: string; seq: number } {
  const out = nextFree(db, vt, date, fyStartMonth);
  commitNumber(db, vt, date, fyStartMonth, out.seq);
  return out;
}

export interface NumberDecision {
  number: string | null;
  seq: number | null;
  /** The automatic counter must be consumed when the voucher is written. */
  consume: boolean;
  /** numberOverride with continueSeries: advance the counter to this sequence (commitNumber never lowers it). */
  continueSeq?: number | null;
  /** The number came from numberOverride (permission checked); `next` = the automatic number it replaced. */
  override?: { next: string | null; reason: string | null };
}

const SAME_PERIOD_MSG = (vt: VoucherTypeInfo, number: string): string => `${vt.name} number ${number} is already used in this period. Enter a different number.`;
const SAME_FY_MSG = (vt: VoucherTypeInfo, number: string, fyLabel: string): string =>
  `${vt.name} number ${number} is already used in FY ${fyLabel}. GST invoice numbers must be unique within the financial year: enter a different number.`;

/**
 * Decide the number of a voucher being created or altered. Pure decision + uniqueness checks; the
 * counter is only advanced by `commitNumber(decision.seq)` (save path, same transaction) when `consume`
 * is true — the decided number was found free inside that transaction, so it is not probed again — and
 * by `commitNumber(decision.continueSeq)` for an override that continues the series.
 *
 *  - `gstOutward`: an outward GST document (isGstOutwardDocument) — unique within the financial year
 *    whatever prevent_duplicates / the restart say (CONFLICT, path 'number').
 *  - `gstDoc`: a GST-numbered type of a GST company (isGstNumberedType) — the format rule of an override.
 *  - `override` / `canRenumber`: VoucherInput.numberOverride and whether the user holds vouchers.renumber.
 */
export function decideNumber(
  db: Db,
  vt: VoucherTypeInfo,
  args: {
    date: string;
    fyStartMonth: number;
    typed: string | undefined;
    existing: { id: number; number: string | null; seq: number | null; date: string } | null;
    override?: VoucherNumberOverride;
    canRenumber?: boolean;
    gstOutward?: boolean;
    gstDoc?: boolean;
  },
): NumberDecision {
  const typed = args.typed?.trim() || undefined;
  const { existing } = args;
  const gstOutward = args.gstOutward === true;
  const exclude = existing?.id ?? null;
  // CONFLICT details carry the field path (like VALIDATION issues) so the entry screen can highlight it.
  const taken = (path: 'number' | 'date', message: string): AppError => conflict(message, [{ path, message }]);
  /** `always`: an override is unique in its scope even when the type allows duplicates (numberClash). */
  const check = (number: string, always = false): void => {
    const clash = numberClash(db, vt, number, args.date, args.fyStartMonth, exclude, { gstOutward, always });
    if (clash) throw taken('number', clash.scope === 'fy' ? SAME_FY_MSG(vt, number, clash.fyLabel) : SAME_PERIOD_MSG(vt, number));
  };
  const required = (message: string): AppError => validation([{ path: 'number', message }]);

  if (args.override) {
    const decided = decideOverride(db, vt, args, check);
    if (decided) return decided;
    // The override repeats the voucher's own number: the plain alter path decides (date-move checks
    // included), with the saved number as typed so a stale `number` in the input cannot change it.
    return decideNumber(db, vt, { ...args, override: undefined, typed: existing?.number ?? undefined });
  }
  if (vt.numberingMethod === 'none') return { number: existing?.number ?? null, seq: existing?.seq ?? null, consume: false };

  if (existing) {
    const userChanged = typed !== undefined && typed !== existing.number;
    if (userChanged && (vt.numberingMethod === 'manual' || vt.numberingMethod === 'automatic_override')) {
      check(typed);
      return { number: typed, seq: parseVoucherSeq(vt, typed, args.date, args.fyStartMonth), consume: false };
    }
    if (vt.numberingMethod === 'manual' && !existing.number && !typed) throw required(`Enter the ${vt.name} number.`);
    // Moving the voucher into another numbering period keeps its number — unless that period already uses it.
    if (
      existing.number &&
      periodKey(vt, existing.date, args.fyStartMonth) !== periodKey(vt, args.date, args.fyStartMonth) &&
      vt.preventDuplicates &&
      numberTaken(db, vt, existing.number, args.date, args.fyStartMonth, existing.id)
    ) {
      throw taken('date', `${vt.name} number ${existing.number} is already used in the period of the new date. Keep the old date or renumber the voucher.`);
    }
    // GST: moving an outward document into another financial year where its number is taken.
    if (existing.number && gstOutward && fyRange(existing.date, args.fyStartMonth).label !== fyRange(args.date, args.fyStartMonth).label) {
      const fy = fyRange(args.date, args.fyStartMonth);
      if (numberTakenIn(db, vt.id, existing.number, fy.from, fy.to, existing.id)) {
        throw taken('date', `${vt.name} number ${existing.number} is already used in FY ${fy.label}. Keep the old date or renumber the voucher.`);
      }
    }
    return { number: existing.number, seq: existing.seq, consume: false };
  }

  if (vt.numberingMethod === 'manual') {
    if (!typed) throw required(`Enter the ${vt.name} number (this voucher type is numbered manually).`);
    check(typed);
    return { number: typed, seq: parseVoucherSeq(vt, typed, args.date, args.fyStartMonth), consume: false };
  }
  if (vt.numberingMethod === 'automatic_override' && typed !== undefined) {
    const next = previewNextNumber(db, vt, args.date, args.fyStartMonth, gstOutward);
    if (typed !== next) {
      check(typed);
      return { number: typed, seq: parseVoucherSeq(vt, typed, args.date, args.fyStartMonth), consume: false };
    }
  }
  const next = nextFree(db, vt, args.date, args.fyStartMonth, gstOutward);
  return { number: next.number, seq: next.seq, consume: true };
}

/** decideNumber for VoucherInput.numberOverride (create or alter); null when an alter keeps its own number. */
function decideOverride(
  db: Db,
  vt: VoucherTypeInfo,
  args: Parameters<typeof decideNumber>[2],
  check: (number: string, always?: boolean) => void,
): NumberDecision | null {
  const o = args.override as VoucherNumberOverride;
  const { existing } = args;
  if (args.canRenumber !== true) throw forbidden('Changing a voucher number needs "Change voucher numbers and the next number" (Users & Roles).');
  if (vt.numberingMethod === 'none') {
    throw validation([{ path: 'number', message: `${vt.name} vouchers are not numbered (numbering "None"). Change the numbering of the voucher type first.` }]);
  }
  const number = o.number.trim();
  const reason = o.reason?.trim() || null;
  // Unchanged number on an alter: nothing to record — the caller runs the plain alter path.
  if (existing && existing.number === number) return null;
  const problems = voucherNumberProblems(number, args.gstDoc === true);
  if (problems.length > 0) throw validation(problems.map((message) => ({ path: 'number', message })));
  check(number, true);
  const seq = parseVoucherSeq(vt, number, args.date, args.fyStartMonth);
  const continueSeq = o.continueSeries === true && seq !== null ? seq : null;
  if (existing) return { number, seq, consume: false, continueSeq, override: { next: null, reason } };
  const next = previewNextNumber(db, vt, args.date, args.fyStartMonth, args.gstOutward === true) || null;
  // Typing the number the series would give anyway consumes it, exactly like automatic numbering.
  return { number, seq, consume: next !== null && number === next && seq !== null, continueSeq, override: { next, reason } };
}
