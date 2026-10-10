/**
 * 2.0 — invoice number series as the Invoice Numbering screen sees them: the state of a series' counter
 * on a date, setting the next number, and the numbers missing from a series (GSTR-1 Table 13 hygiene).
 * Allocation itself lives in vouchers/numbering.ts and is unchanged; this module only reads the series
 * and (setNextNumber) writes the counter of one period.
 *
 *  - numberingStatus: per voucher type, the counter of the numbering period of `date`, the highest
 *    sequence used there, the next automatic number (taken numbers skipped) and the voucher count.
 *  - setNextNumber (vouchers.renumber): `last_number = next − 1` for that period — it may LOWER the
 *    counter (numbers already used are skipped automatically by allocation) — with confirm-level
 *    warnings for lowering below a used number and for skipping numbers, audited on the voucher type.
 *  - numberGaps (vouchers.view): first / last number, issued and cancelled counts and the missing
 *    sequences (≤ 200 listed) of vouchers dated in a range, per numbering period.
 */
import { formatIndianNumber } from '../../../shared/format.ts';
import { formatDate } from '../../../shared/dates.ts';
import { GST_NUMBERED_BASE_TYPES, gstDocNumberProblems } from '../../../shared/numbering.ts';
import type {
  NumberGapsInput,
  NumberGapsResult,
  NumberingStatusRow,
  SetNextNumberInput,
  SetNextNumberResult,
  VoucherRuleErrorDetails,
  VoucherWarning,
} from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { forbidden, rule, validation } from '../../lib/errors.ts';
import { getFeatures } from '../company/service.ts';
import {
  formatVoucherNumber,
  isGstSeriesOutward,
  loadVoucherType,
  nextFree,
  periodKey,
  periodKeyLabel,
  periodRange,
  type VoucherTypeInfo,
} from '../vouchers/numbering.ts';

/** Highest sequence the counter may be set to. */
export const MAX_NEXT_NUMBER = 999_999_999;
/** Missing numbers listed by numberGaps (the count is always exact). */
export const MAX_GAPS_LISTED = 200;

const fyStartMonthOf = (db: Db): number => db.value<number>('SELECT fy_start_month FROM company WHERE id = 1') ?? 4;

const COUNTER_SQL = 'SELECT last_number FROM voucher_counters WHERE voucher_type_id = :vt AND period_key = :key';

/**
 * Vouchers of a type in a date range: count and highest stored sequence (idx_vouchers_type_date range;
 * the app's statements never scan the vouchers table).
 */
const PERIOD_USE_SQL = `SELECT COUNT(*) AS n, MAX(number_seq) AS hi FROM vouchers
  WHERE voucher_type_id = :vt AND date BETWEEN :from AND :to`;

function periodUse(db: Db, vt: VoucherTypeInfo, from: string, to: string): { count: number; highest: number | null } {
  const r = db.get<{ n: number; hi: number | null }>(PERIOD_USE_SQL, { vt: vt.id, from, to });
  return { count: r?.n ?? 0, highest: r?.hi ?? null };
}

/** Distinct sequences used in a period between two sequences (idx_vouchers_type_date range). */
const USED_SEQS_SQL = `SELECT COUNT(DISTINCT number_seq) FROM vouchers
  WHERE voucher_type_id = :vt AND date BETWEEN :from AND :to AND number_seq BETWEEN :lo AND :hi`;

const automatic = (vt: VoucherTypeInfo): boolean => vt.numberingMethod === 'automatic' || vt.numberingMethod === 'automatic_override';

function statusOf(db: Db, vt: VoucherTypeInfo, date: string, fyStartMonth: number, gst: boolean): NumberingStatusRow {
  const key = periodKey(vt, date, fyStartMonth);
  const { from, to } = periodRange(vt, date, fyStartMonth);
  const counter = db.value<number>(COUNTER_SQL, { vt: vt.id, key }) ?? 0;
  const use = periodUse(db, vt, from, to);
  const next = automatic(vt) ? nextFree(db, vt, date, fyStartMonth, isGstSeriesOutward(vt, gst)) : null;
  return {
    id: vt.id,
    periodKey: key,
    periodLabel: periodKeyLabel(vt.numberingRestart, key),
    counter,
    highestUsed: use.highest,
    nextSeq: next ? next.seq : Math.max(counter, vt.numberingStart - 1) + 1,
    next: next ? next.number : '',
    vouchersInPeriod: use.count,
  };
}

/** 'accounts.voucherType.numberingStatus' — every voucher type (or `ids`) on `date`. */
export function numberingStatus(db: Db, input: { ids?: number[]; date: string }): NumberingStatusRow[] {
  const fyStartMonth = fyStartMonthOf(db);
  const gst = getFeatures(db).gst;
  const ids = input.ids ?? db.all<{ id: number }>('SELECT id FROM voucher_types ORDER BY id').map((r) => r.id);
  return [...new Set(ids)].map((id) => statusOf(db, loadVoucherType(db, id), input.date, fyStartMonth, gst));
}

const confirmWarning = (message: string): VoucherWarning => ({ code: 'numbering', level: 'confirm', blocking: false, message, path: 'next' });

const range = (a: number, b: number): string => (a === b ? formatIndianNumber(a, 0) : `${formatIndianNumber(a, 0)}–${formatIndianNumber(b, 0)}`);

/**
 * 'accounts.voucherType.setNextNumber' — the next automatic number of the period of `date` becomes
 * `next` (`last_number = next − 1`, which may lower the counter). Confirm warnings (resubmit with
 * acknowledgeWarnings): lowering to or below a number already used ("skipped automatically"), and
 * raising past unused numbers (they will not be issued — GSTR-1 Table 13 for GST documents).
 */
export function setNextNumber(ctx: CompanyCtx, input: SetNextNumberInput): SetNextNumberResult {
  const { db } = ctx;
  if (!ctx.session.isOwner && !ctx.session.permissions.has('vouchers.renumber')) {
    throw forbidden('Setting the next number of a series needs "Change voucher numbers and the next number" (Users & Roles).');
  }
  const vt = loadVoucherType(db, input.id);
  if (!automatic(vt)) {
    throw rule(`${vt.name} is numbered ${vt.numberingMethod === 'manual' ? 'manually' : 'without numbers'}: there is no next number to set. Choose automatic numbering first.`);
  }
  const next = input.next;
  if (!Number.isSafeInteger(next) || next < 1 || next > MAX_NEXT_NUMBER) {
    throw validation([{ path: 'next', message: `The next number must be a whole number from 1 to ${formatIndianNumber(MAX_NEXT_NUMBER, 0)}.` }]);
  }
  if (next < vt.numberingStart) {
    throw validation([{ path: 'next', message: `${vt.name} numbers start at ${formatIndianNumber(vt.numberingStart, 0)}. Lower the starting number first to go below it.` }]);
  }
  const fyStartMonth = fyStartMonthOf(db);
  const formatted = formatVoucherNumber(vt, next, input.date, fyStartMonth);
  if (getFeatures(db).gst && GST_NUMBERED_BASE_TYPES.includes(vt.baseType)) {
    const problems = gstDocNumberProblems(formatted);
    if (problems.length > 0) throw validation(problems.map((message) => ({ path: 'next', message: `${formatted}: ${message}` })));
  }

  const key = periodKey(vt, input.date, fyStartMonth);
  const { from, to } = periodRange(vt, input.date, fyStartMonth);
  const counter = db.value<number>(COUNTER_SQL, { vt: vt.id, key }) ?? 0;
  const highest = periodUse(db, vt, from, to).highest;
  const gst = getFeatures(db).gst;
  // The sequence the series would give next today (taken numbers skipped): raising past it skips numbers.
  const current = nextFree(db, vt, input.date, fyStartMonth, isGstSeriesOutward(vt, gst)).seq;
  const warnings: VoucherWarning[] = [];
  if (highest !== null && next <= highest) {
    warnings.push(confirmWarning(`Numbers up to ${formatVoucherNumber(vt, highest, input.date, fyStartMonth)} are already used in ${periodKeyLabel(vt.numberingRestart, key)}. Numbers already used will be skipped automatically.`));
  }
  if (next > current) {
    const gstDoc = GST_NUMBERED_BASE_TYPES.includes(vt.baseType) && gst;
    const used = db.value<number>(USED_SEQS_SQL, { vt: vt.id, from, to, lo: current, hi: next - 1 }) ?? 0;
    warnings.push(
      confirmWarning(
        current === next - 1
          ? `Number ${range(current, current)} will not be issued${gstDoc ? '; report it in GSTR-1 Table 13' : ''}.`
          : `${used > 0 ? 'Unused numbers' : 'Numbers'} ${range(current, next - 1)} will not be issued${gstDoc ? '; report them in GSTR-1 Table 13' : ''}.`,
      ),
    );
  }
  if (warnings.length > 0 && input.acknowledgeWarnings !== true) {
    const details: VoucherRuleErrorDetails = { needsConfirmation: true, warnings };
    throw rule(warnings.length === 1 ? `Please confirm: ${warnings[0].message}` : `Please confirm ${warnings.length} warnings. ${warnings[0].message} …`, details);
  }

  db.run(
    `INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:vt, :key, :last)
     ON CONFLICT(voucher_type_id, period_key) DO UPDATE SET last_number = excluded.last_number`,
    { vt: vt.id, key, last: next - 1 },
  );
  const guid = db.value<string>('SELECT guid FROM voucher_types WHERE id = :id', { id: vt.id }) ?? undefined;
  ctx.audit({
    action: 'alter',
    entityType: 'voucher_type',
    entityId: vt.id,
    entityGuid: guid,
    entityLabel: `${vt.name} — next number ${formatted} (${periodKeyLabel(vt.numberingRestart, key)}, from ${formatDate(input.date)})`,
    before: { counter: { periodKey: key, lastNumber: counter } },
    after: { counter: { periodKey: key, lastNumber: next - 1, from: counter, to: next - 1 }, nextNumber: formatted },
  });
  return { next: formatted, warnings: warnings.map((w) => w.message) };
}

/**
 * 'accounts.voucherType.numberGaps' — vouchers of the type dated from…to whose number is in the
 * type's format (a stored sequence). Sequences restart per numbering period, so gaps are found per
 * period key (each between its own lowest and highest number); a missing number is formatted with the
 * date of the voucher just before it. Read-only.
 */
export function numberGaps(db: Db, input: NumberGapsInput): NumberGapsResult {
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The end date must be on or after the start date.' }]);
  const vt = loadVoucherType(db, input.id);
  const fyStartMonth = fyStartMonthOf(db);
  const rows = db.all<{ number: string | null; number_seq: number; date: string; is_cancelled: number }>(
    `SELECT number, number_seq, date, is_cancelled FROM vouchers
      WHERE voucher_type_id = :vt AND date BETWEEN :from AND :to AND number_seq IS NOT NULL
      ORDER BY date, id`,
    { vt: vt.id, from: input.from, to: input.to },
  );
  const byPeriod = new Map<string, Map<number, { number: string | null; date: string }>>();
  let first: { seq: number; key: string; number: string | null } | null = null;
  let cancelled = 0;
  const keysInOrder: string[] = [];
  for (const r of rows) {
    if (r.is_cancelled === 1) cancelled++;
    const key = periodKey(vt, r.date, fyStartMonth);
    let seqs = byPeriod.get(key);
    if (!seqs) {
      byPeriod.set(key, (seqs = new Map()));
      keysInOrder.push(key);
    }
    if (!seqs.has(r.number_seq)) seqs.set(r.number_seq, { number: r.number, date: r.date });
    // First = the lowest sequence of the first period (rows come in date order).
    if (!first || (key === first.key && r.number_seq < first.seq)) first = { seq: r.number_seq, key, number: r.number };
  }
  // Last = the highest sequence of the last period (not the last row read).
  let last: { seq: number; key: string; number: string | null } | null = null;
  if (keysInOrder.length > 0) {
    const lastKey = keysInOrder[keysInOrder.length - 1];
    const seqs = byPeriod.get(lastKey) as Map<number, { number: string | null; date: string }>;
    const hi = Math.max(...seqs.keys());
    last = { seq: hi, key: lastKey, number: seqs.get(hi)?.number ?? null };
  }
  const missing: string[] = [];
  let missingCount = 0;
  for (const key of keysInOrder) {
    const seqs = byPeriod.get(key) as Map<number, { number: string | null; date: string }>;
    const sorted = [...seqs.keys()].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1] - 1;
      if (gap <= 0) continue;
      missingCount += gap;
      const date = seqs.get(sorted[i - 1])?.date ?? input.from;
      for (let s = sorted[i - 1] + 1; s < sorted[i] && missing.length < MAX_GAPS_LISTED; s++) missing.push(formatVoucherNumber(vt, s, date, fyStartMonth));
    }
  }
  return { first: first?.number ?? null, last: last?.number ?? null, issued: rows.length, cancelled, missing, missingCount };
}
