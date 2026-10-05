/**
 * Ageing buckets (pure). Default limits [30, 60, 90, 180] give, on the due-date basis:
 *   Not due (age ≤ 0) · 1–30 · 31–60 · 61–90 · 91–180 · > 180 days
 * and on the bill-date basis (age = asOf − bill date, never negative): 0–30 · 31–60 · … · > 180
 * (the "Not due" bucket stays at index 0 so the shape is stable; it is always zero there).
 * A bill exactly 30 days old/overdue falls in the first range; 31 days in the second.
 */
import { diffDays } from '../../../shared/dates.ts';
import type { AgeingBasis, AgeingBucket } from '../../../shared/types/outstanding.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import type { OsBill } from './engine.ts';

/** Validation message for bucket limits, or null when fine. */
export function bucketLimitsProblem(limits: readonly number[]): string | null {
  if (limits.length === 0 || limits.length > 12) return 'Enter between 1 and 12 ageing periods';
  for (let i = 0; i < limits.length; i++) {
    const n = limits[i];
    if (!Number.isSafeInteger(n) || n < 1 || n > 3650) return 'Each ageing period must be a whole number of days from 1 to 3650';
    if (i > 0 && n <= limits[i - 1]) return 'Ageing periods must be in increasing order (e.g. 30, 60, 90, 180)';
  }
  return null;
}

export function makeBuckets(limits: readonly number[] = DEFAULT_AGEING_BUCKETS, basis: AgeingBasis = 'due_date'): AgeingBucket[] {
  const out: AgeingBucket[] = [{ index: 0, label: 'Not due', minDays: null, maxDays: 0 }];
  let min = basis === 'due_date' ? 1 : 0;
  limits.forEach((max, i) => {
    out.push({ index: i + 1, label: `${min}–${max} days`, minDays: min, maxDays: max });
    min = max + 1;
  });
  const last = limits[limits.length - 1];
  out.push({ index: limits.length + 1, label: `> ${last} days`, minDays: last + 1, maxDays: null });
  return out;
}

/**
 * Bucket index for an age in days. Due-date basis: age ≤ 0 → 0 (not due). Bill-date basis: age 0 is
 * the first range (a negative age — a bill dated after asOf — counts as not due).
 */
export function bucketIndex(ageDays: number, buckets: readonly AgeingBucket[]): number {
  for (let i = 1; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.minDays !== null && ageDays < b.minDays) continue;
    if (b.maxDays === null || ageDays <= b.maxDays) return i;
  }
  return 0;
}

/** Age of a bill on `asOf` for the basis; null when the bill is not aged (advance / On Account / undated). */
export function billAge(b: Pick<OsBill, 'refType' | 'billDate' | 'dueDate'>, asOf: string, basis: AgeingBasis): number | null {
  if (b.refType === 'advance' || b.refType === 'on_account') return null;
  const ref = basis === 'due_date' ? (b.dueDate ?? b.billDate) : b.billDate;
  return ref ? diffDays(ref, asOf) : null;
}
