/**
 * TDS / TCS computation for one deductee + nature on one voucher — pure (tested in engine.test.ts).
 *
 *   rate      PAN valid → the nature's rate for the deductee type (individual/HUF, company, others);
 *             no / invalid PAN → the higher of that rate and the nature's no-PAN rate (s.206AA / s.206CC).
 *   threshold liable when the single transaction exceeds `thresholdSingle`, or the period aggregate
 *             (earlier credits of the party under the nature in the FY — or the calendar month for
 *             194I from 1-Apr-2025 — plus this one) exceeds `thresholdAggregate`; no threshold → always.
 *   base      'whole': this amount, plus (when the aggregate threshold is crossed) the earlier credits
 *             of the period that were below the threshold and not yet taken in (catch-up);
 *             'excess' (194Q): only the part of the aggregate above the threshold.
 *   certificate (s.197 / s.206C(9)) valid on the date: its rate on the base up to its unused limit.
 *   amount    rounded to the nearest rupee (TDS/TCS setup › round to rupee; default on).
 */
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import { taxOn } from '../../../shared/tds/rules.ts';
import type { DeducteeType, TdsLineStatus, TdsNatureRate } from '../../../shared/types/tds.ts';

export interface ComputeInput {
  rate: TdsNatureRate;
  deducteeType: DeducteeType;
  panOk: boolean;
  /** This voucher's assessable amount (may be ≤ 0: nothing to deduct). */
  assessable: Paise;
  /** Σ assessable of earlier credits of the period (party + nature), any status. */
  prior: Paise;
  /** Earlier credits of the period not yet subjected to deduction (below threshold − caught up). */
  priorUndeducted: Paise;
  /** Certificate valid on the date for this nature: rate and unused limit (null = unlimited). */
  certificate: { number: string; rate: number; remaining: Paise | null } | null;
  roundToRupee: boolean;
  /** 'deduct' (TDS) / 'collect' (TCS) — wording only. */
  verb: 'deduct' | 'collect';
}

export interface ComputeResult {
  liable: boolean;
  base: Paise;
  catchUp: Paise;
  /** Rate applied (the certificate rate when the whole base is covered by one). */
  rate: number;
  amount: Paise;
  status: TdsLineStatus;
  note: string;
}

const inr = (p: Paise): string => formatMoney(p, { symbol: true });

export function rateFor(rate: TdsNatureRate, type: DeducteeType, panOk: boolean): number {
  const normal = type === 'individual' ? rate.rateIndividual : type === 'company' ? rate.rateCompany : rate.rateOthers;
  return panOk ? normal : Math.max(normal, rate.rateNoPan);
}

export function computeTds(x: ComputeInput): ComputeResult {
  const r = x.rate;
  const rate = rateFor(r, x.deducteeType, x.panOk);
  if (x.assessable <= 0) {
    return { liable: false, base: 0, catchUp: 0, rate, amount: 0, status: 'below_threshold', note: 'No amount to ' + x.verb + ' on.' };
  }
  const single = r.thresholdSingle;
  const agg = r.thresholdAggregate;
  const total = x.prior + x.assessable;
  const per = r.aggregatePeriod === 'month' ? 'month' : 'year';
  let base = x.assessable;
  let catchUp = 0;
  let why: string;
  if (single === null && agg === null) {
    why = 'No threshold.';
  } else {
    const singleHit = single !== null && x.assessable > single;
    const aggHit = agg !== null && total > agg;
    if (!singleHit && !aggHit) {
      const parts: string[] = [];
      if (single !== null) parts.push(`this amount ${inr(x.assessable)} is within ${inr(single)}`);
      if (agg !== null) parts.push(`the ${per}'s total ${inr(total)} is within ${inr(agg)}`);
      return { liable: false, base: 0, catchUp: 0, rate, amount: 0, status: 'below_threshold', note: `Below the threshold: ${parts.join(' and ')}.` };
    }
    if (aggHit && r.thresholdBasis === 'excess') {
      base = Math.min(x.assessable, total - (agg as number));
      why = `The ${per}'s total ${inr(total)} exceeds ${inr(agg as number)}: tax on the excess ${inr(base)}.`;
    } else if (aggHit) {
      catchUp = Math.max(0, x.priorUndeducted);
      base = x.assessable + catchUp;
      why =
        catchUp > 0
          ? `The ${per}'s total ${inr(total)} crossed ${inr(agg as number)}: earlier credits of ${inr(catchUp)} below the threshold are taken in now.`
          : `The ${per}'s total ${inr(total)} exceeds ${inr(agg as number)}.`;
    } else {
      why = `This amount ${inr(x.assessable)} exceeds the single-transaction limit ${inr(single as number)}.`;
    }
  }
  const cert = x.certificate;
  if (cert && x.panOk) {
    const covered = cert.remaining === null ? base : Math.max(0, Math.min(base, cert.remaining));
    if (covered > 0) {
      const rest = base - covered;
      const exact = (covered * cert.rate) / 100 + (rest * rate) / 100;
      const amount = x.roundToRupee ? Math.round(exact / 100) * 100 : Math.round(exact);
      const note =
        rest === 0
          ? `${why} Lower-deduction certificate ${cert.number}: ${cert.rate}%.`
          : `${why} Certificate ${cert.number} at ${cert.rate}% covers ${inr(covered)}; ${inr(rest)} at ${rate}%.`;
      return { liable: true, base, catchUp, rate: rest === 0 ? cert.rate : rate, amount, status: 'certificate', note };
    }
  }
  const amount = taxOn(base, rate, x.roundToRupee);
  const panNote = x.panOk ? '' : ` No valid PAN: higher rate ${rate}% (s.${x.verb === 'deduct' ? '206AA' : '206CC'}).`;
  return { liable: true, base, catchUp, rate, amount, status: 'deducted', note: `${why}${panNote}` };
}
