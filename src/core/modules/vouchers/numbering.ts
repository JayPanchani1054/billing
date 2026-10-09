/**
 * Voucher types and numbering.
 *
 *  - Series per voucher type; counters in voucher_counters keyed by the restart period:
 *    yearly → FY label ('2026-27'), monthly → 'YYYY-MM', never → 'all'.
 *  - Display number = prefix + zero-padded sequence (numbering_width) + suffix.
 *  - automatic: the next free sequence (numbers already used in the period are skipped).
 *  - automatic_override: as automatic, but the user may type a number (the counter is not consumed).
 *  - manual: the user types the number (required); unique within the period when prevent_duplicates.
 *  - none: no number.
 *  Allocation runs inside the save transaction, so a rolled-back save leaves no gap.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { endOfMonth, financialYear, monthKey, startOfMonth } from '../../../shared/dates.ts';
import type { NumberingMethod, NumberingRestart, VoucherTypeView } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import { conflict, notFound, validation, type AppError } from '../../lib/errors.ts';

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

export function loadVoucherType(db: Db, id: number): VoucherTypeInfo {
  const r = db.get<VoucherTypeRow>('SELECT * FROM voucher_types WHERE id = :id', { id });
  if (!r) throw notFound('Voucher type', id);
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

export function formatVoucherNumber(vt: VoucherTypeInfo, seq: number): string {
  const body = vt.numberingWidth > 0 ? String(seq).padStart(vt.numberingWidth, '0') : String(seq);
  return `${vt.numberingPrefix ?? ''}${body}${vt.numberingSuffix ?? ''}`;
}

/** Numeric part of a number typed in this type's format ('INV/0012/26' → 12), else null. */
export function parseVoucherSeq(vt: VoucherTypeInfo, number: string): number | null {
  const prefix = vt.numberingPrefix ?? '';
  const suffix = vt.numberingSuffix ?? '';
  if (!number.startsWith(prefix) || !number.endsWith(suffix) || number.length <= prefix.length + suffix.length) return null;
  const body = number.slice(prefix.length, number.length - suffix.length);
  if (!/^\d{1,15}$/.test(body)) return null;
  const n = Number(body);
  return Number.isSafeInteger(n) ? n : null;
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
  return db.value(NUMBER_TAKEN_SQL, { vt: vt.id, number, from, to, ex: excludeId ?? 0 }) !== undefined;
}

const MAX_SKIP = 100_000;

function nextFree(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number): { number: string; seq: number } {
  const key = periodKey(vt, date, fyStartMonth);
  const last = db.value<number>('SELECT last_number FROM voucher_counters WHERE voucher_type_id = :vt AND period_key = :key', { vt: vt.id, key });
  let seq = Math.max(last ?? 0, vt.numberingStart - 1) + 1;
  for (let i = 0; i < MAX_SKIP; i++, seq++) {
    const number = formatVoucherNumber(vt, seq);
    if (!numberTaken(db, vt, number, date, fyStartMonth, null)) return { number, seq };
  }
  throw conflict(`Could not find a free voucher number for ${vt.name}`);
}

/** Next automatic number without consuming it ('' for manual / none). */
export function previewNextNumber(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number): string {
  if (vt.numberingMethod === 'manual' || vt.numberingMethod === 'none') return '';
  return nextFree(db, vt, date, fyStartMonth).number;
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
}

/**
 * Decide the number of a voucher being created or altered. Pure decision + uniqueness checks; the
 * counter is only advanced by `commitNumber(decision.seq)` (save path, same transaction) when `consume`
 * is true — the decided number was found free inside that transaction, so it is not probed again.
 */
export function decideNumber(
  db: Db,
  vt: VoucherTypeInfo,
  args: {
    date: string;
    fyStartMonth: number;
    typed: string | undefined;
    existing: { id: number; number: string | null; seq: number | null; date: string } | null;
  },
): NumberDecision {
  const typed = args.typed?.trim() || undefined;
  const { existing } = args;
  // CONFLICT details carry the field path (like VALIDATION issues) so the entry screen can highlight it.
  const check = (number: string): void => {
    if (vt.preventDuplicates && numberTaken(db, vt, number, args.date, args.fyStartMonth, existing?.id ?? null)) {
      const message = `${vt.name} number ${number} is already used in this period. Enter a different number.`;
      throw conflict(message, [{ path: 'number', message }]);
    }
  };
  const required = (message: string): AppError => validation([{ path: 'number', message }]);
  if (vt.numberingMethod === 'none') return { number: existing?.number ?? null, seq: existing?.seq ?? null, consume: false };

  if (existing) {
    const userChanged = typed !== undefined && typed !== existing.number;
    if (userChanged && (vt.numberingMethod === 'manual' || vt.numberingMethod === 'automatic_override')) {
      check(typed);
      return { number: typed, seq: parseVoucherSeq(vt, typed), consume: false };
    }
    if (vt.numberingMethod === 'manual' && !existing.number && !typed) throw required(`Enter the ${vt.name} number.`);
    // Moving the voucher into another numbering period keeps its number — unless that period already uses it.
    if (
      existing.number &&
      periodKey(vt, existing.date, args.fyStartMonth) !== periodKey(vt, args.date, args.fyStartMonth) &&
      vt.preventDuplicates &&
      numberTaken(db, vt, existing.number, args.date, args.fyStartMonth, existing.id)
    ) {
      const message = `${vt.name} number ${existing.number} is already used in the period of the new date. Keep the old date or renumber the voucher.`;
      throw conflict(message, [{ path: 'date', message }]);
    }
    return { number: existing.number, seq: existing.seq, consume: false };
  }

  if (vt.numberingMethod === 'manual') {
    if (!typed) throw required(`Enter the ${vt.name} number (this voucher type is numbered manually).`);
    check(typed);
    return { number: typed, seq: parseVoucherSeq(vt, typed), consume: false };
  }
  if (vt.numberingMethod === 'automatic_override' && typed !== undefined) {
    const next = previewNextNumber(db, vt, args.date, args.fyStartMonth);
    if (typed !== next) {
      check(typed);
      return { number: typed, seq: parseVoucherSeq(vt, typed), consume: false };
    }
  }
  const next = nextFree(db, vt, args.date, args.fyStartMonth);
  return { number: next.number, seq: next.seq, consume: true };
}
