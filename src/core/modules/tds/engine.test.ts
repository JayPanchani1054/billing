import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TdsNatureRate } from '../../../shared/types/tds.ts';
import { computeTds, rateFor, type ComputeInput } from './engine.ts';

const C194: TdsNatureRate = {
  applicableFrom: '2024-04-01',
  rateIndividual: 1,
  rateCompany: 2,
  rateOthers: 2,
  rateNoPan: 20,
  thresholdSingle: 30_000_00,
  thresholdAggregate: 1_00_000_00,
  aggregatePeriod: 'fy',
  thresholdBasis: 'whole',
  baseIncludesGst: false,
  note: null,
};
const Q194: TdsNatureRate = { ...C194, rateIndividual: 0.1, rateCompany: 0.1, rateOthers: 0.1, rateNoPan: 5, thresholdSingle: null, thresholdAggregate: 50_00_000_00, thresholdBasis: 'excess' };

const base = (over: Partial<ComputeInput>): ComputeInput => ({
  rate: C194,
  deducteeType: 'firm',
  panOk: true,
  assessable: 0,
  prior: 0,
  priorUndeducted: 0,
  certificate: null,
  roundToRupee: true,
  verb: 'deduct',
  ...over,
});

describe('tds engine', () => {
  it('rate by deductee type; no PAN → the higher of the rate and the s.206AA rate', () => {
    assert.equal(rateFor(C194, 'individual', true), 1);
    assert.equal(rateFor(C194, 'company', true), 2);
    assert.equal(rateFor(C194, 'others', false), 20);
    assert.equal(rateFor({ ...C194, rateNoPan: 1 }, 'company', false), 2);
  });

  it('194C: a single bill above ₹30,000 is liable even with a small aggregate', () => {
    // 2% of ₹40,000 = ₹800.
    const r = computeTds(base({ assessable: 40_000_00 }));
    assert.equal(r.liable, true);
    assert.equal(r.status, 'deducted');
    assert.equal(r.base, 40_000_00);
    assert.equal(r.amount, 800_00);
  });

  it('194C: below both thresholds → nothing, with the reason', () => {
    const r = computeTds(base({ assessable: 25_000_00, prior: 50_000_00 }));
    assert.equal(r.liable, false);
    assert.equal(r.amount, 0);
    assert.equal(r.status, 'below_threshold');
    assert.match(r.note, /within/);
  });

  it('194C: crossing ₹1,00,000 takes in the earlier credits below the threshold (catch-up)', () => {
    // Earlier: 4 × ₹25,000 = ₹1,00,000 (not deducted). Now ₹25,000 → ₹1,25,000 > ₹1,00,000.
    // Base = 25,000 + 1,00,000 = ₹1,25,000; individual 1% = ₹1,250.
    const r = computeTds(base({ deducteeType: 'individual', assessable: 25_000_00, prior: 1_00_000_00, priorUndeducted: 1_00_000_00 }));
    assert.equal(r.catchUp, 1_00_000_00);
    assert.equal(r.base, 1_25_000_00);
    assert.equal(r.amount, 1_250_00);
    assert.match(r.note, /taken in/);
  });

  it('194Q: tax only on purchases above ₹50 lakh in the year', () => {
    // Prior ₹48,00,000 + this ₹5,00,000 = ₹53,00,000 → excess ₹3,00,000 × 0.1% = ₹300.
    const r = computeTds(base({ rate: Q194, assessable: 5_00_000_00, prior: 48_00_000_00, priorUndeducted: 48_00_000_00 }));
    assert.equal(r.base, 3_00_000_00);
    assert.equal(r.catchUp, 0);
    assert.equal(r.amount, 300_00);
    // Already above: the whole bill. ₹2,00,000 × 0.1% = ₹200.
    assert.equal(computeTds(base({ rate: Q194, assessable: 2_00_000_00, prior: 60_00_000_00 })).amount, 200_00);
    // No PAN: 5% (s.206AA proviso for 194Q) on the excess ₹3,00,000 = ₹15,000.
    assert.equal(computeTds(base({ rate: Q194, panOk: false, assessable: 5_00_000_00, prior: 48_00_000_00 })).amount, 15_000_00);
  });

  it('lower-deduction certificate: its rate up to its unused limit, the normal rate beyond', () => {
    // ₹50,000 at 0.5% (certificate, ₹30,000 unused) = ₹150 + ₹20,000 at 2% = ₹400 → ₹550.
    const r = computeTds(base({ assessable: 50_000_00, certificate: { number: 'LDC-1', rate: 0.5, remaining: 30_000_00 } }));
    assert.equal(r.status, 'certificate');
    assert.equal(r.amount, 550_00);
    // Fully covered nil certificate → 0 at rate 0.
    const nil = computeTds(base({ assessable: 50_000_00, certificate: { number: 'NIL-1', rate: 0, remaining: null } }));
    assert.equal(nil.amount, 0);
    assert.equal(nil.rate, 0);
    assert.equal(nil.status, 'certificate');
  });

  it('no threshold (195 / 206C(1)): always liable; nothing on a negative amount', () => {
    const none = { ...C194, thresholdSingle: null, thresholdAggregate: null };
    assert.equal(computeTds(base({ rate: none, assessable: 1_000_00 })).amount, 20_00);
    assert.equal(computeTds(base({ rate: none, assessable: -1_000_00 })).liable, false);
  });
});
