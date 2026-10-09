/**
 * Job work rules (CGST Act s.143, CGST Rules 45 and 55) as effective-dated DATA, plus the pure date
 * arithmetic the core reports and the renderer share. Nothing here reads the database.
 *
 * Seeded with what is settled law as at 09-Oct-2026; anything marked UNCERTAIN in a comment should be
 * confirmed with the company's tax adviser (the README says so too). The limits are data, not code:
 * a change in law is a new row with a later `effectiveFrom`.
 */
import { addDays, addMonths, diffDays, financialYear } from '../dates.ts';

/** What was sent to the job worker — decides the return time limit under s.143. */
export const JOB_WORK_GOODS_TYPES = ['inputs', 'capital_goods', 'tools'] as const;
export type JobWorkGoodsType = (typeof JOB_WORK_GOODS_TYPES)[number];

export const JOB_WORK_GOODS_LABELS: Readonly<Record<JobWorkGoodsType, string>> = {
  inputs: 'Inputs',
  capital_goods: 'Capital goods',
  tools: 'Moulds, dies, jigs, fixtures, tools',
};

export interface ReturnLimitRule {
  goodsType: JobWorkGoodsType;
  /** Months within which the goods must come back (or be supplied from the job worker's premises); null = no limit. */
  months: number | null;
  effectiveFrom: string;
  source: string;
  note: string;
}

/**
 * s.143(1)(a) CGST Act (in force since 01-Jul-2017): inputs within one year, capital goods within three
 * years of being sent out; moulds and dies, jigs and fixtures, or tools are outside the time limit.
 * s.143(3)/(4): goods not back in time are deemed SUPPLIED by the principal to the job worker on the
 * day they were sent out (GST payable with interest). The Commissioner may extend the periods by up to
 * one and two years on sufficient cause (proviso) — record an extension on the challan line.
 */
export const RETURN_LIMIT_RULES: readonly ReturnLimitRule[] = [
  {
    goodsType: 'inputs',
    months: 12,
    effectiveFrom: '2017-07-01',
    source: 'CGST Act s.143(1)(a), 143(3)',
    note: 'Inputs must be received back (or supplied from the job worker’s premises) within one year of being sent out.',
  },
  {
    goodsType: 'capital_goods',
    months: 36,
    effectiveFrom: '2017-07-01',
    source: 'CGST Act s.143(1)(a), 143(4)',
    note: 'Capital goods must be received back within three years of being sent out.',
  },
  {
    goodsType: 'tools',
    months: null,
    effectiveFrom: '2017-07-01',
    source: 'CGST Act s.143(1)(a) (exclusion), 143(4)',
    note: 'Moulds and dies, jigs and fixtures, or tools are not subject to the return time limit.',
  },
];

/** The rule in force for goods of this type sent out on `sentOn` (latest effectiveFrom ≤ sentOn). */
export function returnLimitFor(goodsType: JobWorkGoodsType, sentOn: string, rules: readonly ReturnLimitRule[] = RETURN_LIMIT_RULES): ReturnLimitRule | null {
  let best: ReturnLimitRule | null = null;
  for (const r of rules) {
    if (r.goodsType !== goodsType || r.effectiveFrom > sentOn) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

/**
 * Last day by which goods sent on `sentOn` must be back: the same calendar date `months` later (the day
 * of sending is excluded when counting the period, General Clauses Act s.9; 31-Jan + 1 month = 28/29-Feb).
 * An extension granted by the Commissioner replaces it. null = no time limit.
 */
export function returnDueDate(goodsType: JobWorkGoodsType, sentOn: string, extendedTo?: string | null, rules?: readonly ReturnLimitRule[]): string | null {
  if (extendedTo) return extendedTo;
  const rule = returnLimitFor(goodsType, sentOn, rules);
  if (!rule || rule.months === null) return null;
  return addMonths(sentOn, rule.months);
}

export type ReturnStatus = 'no_limit' | 'ok' | 'due_soon' | 'overdue';

/** Status of goods still with the job worker on `asOf` (due_soon: within `warnDays`, default 30). */
export function returnStatus(dueDate: string | null, asOf: string, warnDays = 30): { status: ReturnStatus; daysLeft: number | null } {
  if (dueDate === null) return { status: 'no_limit', daysLeft: null };
  const daysLeft = diffDays(asOf, dueDate);
  if (daysLeft < 0) return { status: 'overdue', daysLeft };
  if (daysLeft <= warnDays) return { status: 'due_soon', daysLeft };
  return { status: 'ok', daysLeft };
}

// ───────────────────────────── ITC-04 periods ─────────────────────────────

export type Itc04Frequency = 'quarterly' | 'half_yearly' | 'annual';

export interface Itc04FrequencyRule {
  effectiveFrom: string;
  /** Applies to periods starting on or after effectiveFrom. */
  frequency: (aatoAbove5Cr: boolean) => Itc04Frequency;
  /** Day of the month after the period by which the form is due. */
  dueDay: number;
  source: string;
}

/**
 * Rule 45(3) CGST Rules. Quarterly (by the 25th after the quarter) until 30-Sep-2021; from 01-Oct-2021
 * half-yearly (Apr–Sep by 25-Oct, Oct–Mar by 25-Apr) when annual aggregate turnover in the preceding
 * year exceeds ₹5 crore, otherwise annually (by 25-Apr after the year). Due dates are frequently
 * extended by notification — check the portal (UNCERTAIN for any given period).
 */
export const ITC04_FREQUENCY_RULES: readonly Itc04FrequencyRule[] = [
  { effectiveFrom: '2017-07-01', frequency: () => 'quarterly', dueDay: 25, source: 'CGST Rules r.45(3) (original)' },
  { effectiveFrom: '2021-10-01', frequency: (big) => (big ? 'half_yearly' : 'annual'), dueDay: 25, source: 'CGST Rules r.45(3) as amended w.e.f. 01-Oct-2021' },
];

export interface Itc04Period {
  key: string;
  label: string;
  from: string;
  to: string;
  frequency: Itc04Frequency;
  dueDate: string;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (iso: string): string => `${MONTH_ABBR[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** ITC-04 periods of the financial year containing `date` (FY April–March, as the return is). */
export function itc04Periods(date: string, aatoAbove5Cr: boolean, rules: readonly Itc04FrequencyRule[] = ITC04_FREQUENCY_RULES): Itc04Period[] {
  const fy = financialYear(date, 4);
  const out: Itc04Period[] = [];
  let start = fy.start;
  while (start <= fy.end) {
    let rule = rules[0];
    for (const r of rules) if (r.effectiveFrom <= start && r.effectiveFrom >= rule.effectiveFrom) rule = r;
    const frequency = rule.frequency(aatoAbove5Cr);
    const months = frequency === 'quarterly' ? 3 : frequency === 'half_yearly' ? 6 : 12;
    let end = addDays(addMonths(start, months), -1);
    if (end > fy.end) end = fy.end;
    // A rule change inside the period (Oct-2021) starts a new period on its effective date.
    const change = rules.find((r) => r.effectiveFrom > start && r.effectiveFrom <= end);
    if (change) end = addDays(change.effectiveFrom, -1);
    const due = `${addDays(end, 1).slice(0, 8)}${String(rule.dueDay).padStart(2, '0')}`;
    out.push({
      key: `${start}_${end}`,
      label: `${monthLabel(start)} – ${monthLabel(end)} (${frequency.replace('_', '-')})`,
      from: start,
      to: end,
      frequency,
      dueDate: due,
    });
    start = addDays(end, 1);
  }
  return out;
}
