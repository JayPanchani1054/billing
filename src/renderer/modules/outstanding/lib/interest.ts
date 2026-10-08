/**
 * Interest screen helpers (pure): building the 'outstanding.interest' input from the screen's
 * choices, and splitting a bill's interest across its balance segments for the detail drawer.
 *
 * The server rounds interest ONCE per bill:  round(Σ balance × days × rate ÷ 100 ÷ 365).
 * The drawer shows one line per segment, so the per-segment amounts are allocated from that total
 * with the largest-remainder method — they always add up to the bill's interest to the paisa.
 */
import { addDays } from '../../../../shared/dates.ts';
import type { AgeingBasis, InterestBillRow, InterestInput } from '../../../../shared/types/outstanding.ts';

export type InterestScope = 'party' | 'group' | 'all';

export interface InterestChoices {
  scope: InterestScope;
  ledgerId: number | null;
  groupId: number | undefined;
  from: string;
  to: string;
  /** % p.a.; null = each ledger's own rate. */
  ratePercent: number | null;
  basis: AgeingBasis;
  graceDays: number | null;
}

/** The route input, or a plain-English reason why the report cannot run yet. */
export function interestInput(c: InterestChoices): { ok: true; input: InterestInput } | { ok: false; reason: string } {
  if (c.scope === 'party' && c.ledgerId === null) return { ok: false, reason: 'Choose the party to calculate interest for.' };
  if (c.scope === 'group' && c.groupId === undefined) return { ok: false, reason: 'Choose the group of parties.' };
  if (c.to < c.from) return { ok: false, reason: 'The period ends before it starts — change it with Alt+F2.' };
  if (c.ratePercent !== null && (c.ratePercent < 0.01 || c.ratePercent > 100)) return { ok: false, reason: 'Enter a rate from 0.01% to 100% a year, or leave it blank to use each ledger’s rate.' };
  const grace = c.graceDays ?? 0;
  if (!Number.isInteger(grace) || grace < 0 || grace > 3650) return { ok: false, reason: 'Grace days must be a whole number from 0 to 3650.' };
  const input: InterestInput = { from: c.from, to: c.to, basis: c.basis, graceDays: grace, method: 'simple_365' };
  if (c.scope === 'party' && c.ledgerId !== null) input.ledgerId = c.ledgerId;
  if (c.scope === 'group' && c.groupId !== undefined) input.groupId = c.groupId;
  if (c.ratePercent !== null) input.ratePercent = c.ratePercent;
  return { ok: true, input };
}

export interface SegmentLine {
  key: string;
  /** First interest-bearing day (segment.from is exclusive). */
  firstDay: string;
  lastDay: string;
  days: number;
  balance: number;
  /** Paise; Σ = row.interest. */
  interest: number;
}

/**
 * One line per segment with its share of the bill's interest. Exact shares are
 * balance × days × rate ÷ 36,500 (BigInt, rate to 1/10,000 %), floored, then the paise left over to
 * reach row.interest go to the largest remainders.
 *
 * Example (README §3.3 ex. 2, 18%): 31 days × ₹1,00,000 → 1,52,876.71 paise; 14 days × ₹60,000 →
 * 41,424.66 paise; floors 1,52,876 + 41,424 = 1,94,300; the bill's interest is 1,94,301 (rounded
 * once), so the extra paisa goes to the larger remainder (.71) → 1,52,877 + 41,424.
 */
export function interestSegmentLines(row: Pick<InterestBillRow, 'segments' | 'ratePercent' | 'interest'>): SegmentLine[] {
  const rate = BigInt(Math.round(row.ratePercent * 10_000));
  const den = 36_500n * 10_000n;
  const exact = row.segments.map((s) => BigInt(s.balance) * BigInt(s.days) * rate);
  const floors = exact.map((n) => n / den);
  const rems = exact.map((n, i) => n - floors[i] * den);
  const lines: SegmentLine[] = row.segments.map((s, i) => ({
    key: `${i}|${s.from}`,
    firstDay: addDays(s.from, 1),
    lastDay: s.to,
    days: s.days,
    balance: s.balance,
    interest: Number(floors[i]),
  }));
  let left = row.interest - lines.reduce((sum, l) => sum + l.interest, 0);
  if (left > 0 && left <= lines.length) {
    const order = rems.map((r, i) => ({ r, i })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
    for (const o of order) {
      if (left <= 0) break;
      lines[o.i].interest += 1;
      left -= 1;
    }
  }
  return lines;
}

/** "18% p.a." / "18.5% p.a." */
export function rateText(rate: number): string {
  return `${Number(rate.toFixed(4))}% p.a.`;
}

/** The basis sentence under the KPIs. */
export function interestBasisText(basis: AgeingBasis, graceDays: number): string {
  const from = basis === 'due_date' ? 'the due date' : 'the bill date';
  const grace = graceDays > 0 ? ` plus ${graceDays} grace ${graceDays === 1 ? 'day' : 'days'}` : '';
  return `Simple interest on a 365-day year, counted from ${from}${grace} up to the day of payment.`;
}
