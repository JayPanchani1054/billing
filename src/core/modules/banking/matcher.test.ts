/**
 * The pure matching engine: eligibility, the score formula (README › Auto-match), reference / party
 * recognition, one-to-one assignment, ambiguity → suggestion, and determinism.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MATCH_OPTIONS,
  assignMatches,
  instrumentFromNarration,
  partyHit,
  referenceHit,
  scorePair,
  type MatchEntry,
  type MatchLine,
} from './matcher.ts';

const line = (id: number, txnDate: string, amount: number, description = '', reference = ''): MatchLine => ({ id, txnDate, amount, description, reference });
const entry = (id: number, date: string, amount: number, more: Partial<MatchEntry> = {}): MatchEntry => ({
  id,
  date,
  amount,
  instrumentType: null,
  instrumentNo: null,
  instrumentDate: null,
  bankDate: null,
  particulars: 'Office Rent',
  ...more,
});

describe('matcher: scoring', () => {
  it('exact amount and date with the party named and the same instrument kind scores 95', () => {
    const p = scorePair(line(1, '2026-04-10', -500000, 'NEFT DR SUPREME SUPPLIERS'), entry(9, '2026-04-10', -500000, { particulars: 'Supreme Suppliers', instrumentType: 'neft' }));
    // amount 50 + date 25 + party 15 (SUPREME = 1 of 1 significant word; SUPPLIERS is not a stop word → 2 of 2) + NEFT 5 = 95
    assert.equal(p?.score, 95);
    assert.deepEqual(p?.reasons.map((r) => [r.code, r.points]), [['amount', 50], ['date', 25], ['party', 15], ['instrument', 5]]);
    assert.equal(p?.dayGap, 0);
  });

  it('date points fall 3 per day late and 8 per day early; outside the window or > 2 days early is not eligible', () => {
    const e = entry(1, '2026-04-10', -100000);
    assert.equal(scorePair(line(1, '2026-04-13', -100000), e)?.score, 50 + 25 - 9); // 3 days late → 66
    assert.equal(scorePair(line(1, '2026-04-08', -100000), e)?.score, 50 + 25 - 16); // 2 days early → 59
    assert.equal(scorePair(line(1, '2026-04-07', -100000), e), null); // 3 days early
    assert.equal(scorePair(line(1, '2026-04-18', -100000), e), null); // 8 days late > 7-day window
    assert.equal(scorePair(line(1, '2026-04-18', -100000), e, { ...DEFAULT_MATCH_OPTIONS, dateWindowDays: 10 })?.score, 50 + 1); // 25 − 24
    assert.equal(scorePair(line(1, '2026-04-10', 100000), e), null, 'a deposit never matches a payment');
    assert.equal(scorePair(line(1, '2026-04-10', -100001), e), null, 'amounts must be equal to the paisa');
  });

  it('a cheque whose number is in the statement may be presented up to 92 days later; its cheque date sets the early limit', () => {
    const chq = entry(1, '2026-04-10', -100000, { instrumentType: 'cheque', instrumentNo: '000501', instrumentDate: '2026-04-05' });
    const late = scorePair(line(1, '2026-05-20', -100000, 'CHQ PAID 501'), chq);
    // 40 days late: date 0; amount 50 + reference 30 + cheque kind 5 = 85
    assert.equal(late?.score, 85);
    assert.equal(scorePair(line(1, '2026-05-20', -100000, 'CHQ PAID 777'), chq), null);
    // Cheque dated 05-Apr: a statement line on 04-Apr is 1 day before the cheque date → eligible.
    assert.ok(scorePair(line(1, '2026-04-04', -100000, 'CLG 000501'), chq));
  });

  it('a hand-entered bank date pins the match to ±2 days and adds 20 (same day) or 10 points', () => {
    const e = entry(1, '2026-04-10', -100000, { bankDate: '2026-04-12' });
    assert.equal(scorePair(line(1, '2026-04-12', -100000), e)?.score, 50 + 19 + 20);
    assert.equal(scorePair(line(1, '2026-04-13', -100000), e)?.score, 50 + 16 + 10);
    assert.equal(scorePair(line(1, '2026-04-15', -100000), e), null);
  });

  it('recognises references (leading zeros, UTR tails), party words (stop words ignored) and instrument kinds', () => {
    assert.equal(referenceHit('000501', { reference: '501', description: '' }), 'full');
    assert.equal(referenceHit('501', { reference: '', description: 'CHQ NO 0000501 CLEARING' }), 'full');
    assert.equal(referenceHit('12', { reference: '12', description: '' }), null, 'too short to be meaningful');
    assert.equal(referenceHit('412345678901', { reference: '', description: 'UPI/XX678901/BHARAT' }), 'partial');
    assert.equal(referenceHit('N091260001', { reference: '', description: 'NEFT CR-HDFC0000001-N091260001-ACME' }), 'full');
    assert.deepEqual(partyHit('Acme Traders Pvt Ltd', { reference: '', description: 'NEFT CR ACME TRAD' }), { matched: ['ACME'], total: 1 });
    assert.deepEqual(partyHit('Bharat Stores', { reference: '', description: 'IMPS SHARMA' }), { matched: [], total: 1 });
    assert.equal(instrumentFromNarration('BY CLG 000501'), 'cheque');
    assert.equal(instrumentFromNarration('UPI/412345678901/TEA'), 'upi');
    assert.equal(instrumentFromNarration('ATM WDL FORT'), 'cash');
    assert.equal(instrumentFromNarration('SMS CHARGES'), null);
  });
});

describe('matcher: assignment', () => {
  it('reference boost: the cheque named in the statement wins over a closer-dated entry of the same amount', () => {
    const l = line(1, '2026-04-10', -1500000, 'CHQ PAID-MICR CTS 000501', '000501');
    const e501 = entry(11, '2026-04-08', -1500000, { instrumentType: 'cheque', instrumentNo: '000501' });
    const e502 = entry(12, '2026-04-10', -1500000, { instrumentType: 'cheque', instrumentNo: '000502' });
    const a = assignMatches([l], [e502, e501]);
    // 501: 50 + (25 − 6) + 30 + 5 = 104 → capped 100; 502: 50 + 25 + 5 = 80; lead 20 ≥ 10 → applied.
    assert.deepEqual(a.applied.map((p) => [p.lineId, p.entryId, p.score]), [[1, 11, 100]]);
    assert.deepEqual(a.pending, []);
  });

  it('the uncapped score decides: a UTR-backed receipt beats a same-day same-party one although both show 100', () => {
    const l = line(1, '2026-04-02', 2500000, 'NEFT CR-HDFC0000001-ACME TRADERS-N091260001', 'N091260001');
    const withUtr = entry(61, '2026-04-02', 2500000, { particulars: 'Acme Traders', instrumentType: 'neft', instrumentNo: 'N091260001' });
    const plain = entry(62, '2026-04-02', 2500000, { particulars: 'Acme Traders', instrumentType: 'neft' });
    // With UTR: 50 + 25 + 30 + 15 + 5 = 125 → shown as 100. Without: 50 + 25 + 15 + 5 = 95.
    // Lead 125 − 95 = 30 ≥ 10 → applied. (Capped scores 100 vs 95 would have looked ambiguous.)
    const a = assignMatches([l], [plain, withUtr]);
    assert.deepEqual(a.applied.map((p) => [p.entryId, p.score, p.rawScore]), [[61, 100, 125]]);
    assert.deepEqual(a.pending, []);
    // Two entries that both carry the UTR (a duplicate voucher) stay ambiguous: 125 vs 125.
    const dup = entry(63, '2026-04-02', 2500000, { particulars: 'Acme Traders', instrumentType: 'neft', instrumentNo: 'N091260001' });
    const b = assignMatches([l], [withUtr, dup]);
    assert.deepEqual(b.applied, []);
    assert.deepEqual(b.pending.map((p) => [p.reason, p.candidates.map((c) => c.entryId)]), [['ambiguous', [61, 63]]]);
  });

  it('ambiguity: two equally good entries become a suggestion with both candidates, nothing applied', () => {
    const a = assignMatches([line(1, '2026-04-10', -100000)], [entry(21, '2026-04-10', -100000), entry(22, '2026-04-10', -100000)]);
    assert.deepEqual(a.applied, []);
    assert.equal(a.pending.length, 1);
    assert.equal(a.pending[0].reason, 'ambiguous');
    assert.deepEqual(a.pending[0].candidates.map((c) => [c.entryId, c.score]), [[21, 75], [22, 75]]);
  });

  it('one-to-one: two equal-amount lines take the entry of their own date; an entry is never used twice', () => {
    const lines = [line(1, '2026-04-10', -50000), line(2, '2026-04-15', -50000)];
    const entries = [entry(31, '2026-04-10', -50000), entry(32, '2026-04-15', -50000)];
    const a = assignMatches(lines, entries);
    // 1↔31: 75 vs best rival 2↔31 = 50 + (25 − 15) = 60 → lead 15. 2↔32: 75, its rival 1↔32 is 5 days early → not eligible.
    assert.deepEqual(a.applied.map((p) => [p.lineId, p.entryId]), [[1, 31], [2, 32]]);
    const one = assignMatches(lines, [entries[0]]);
    assert.deepEqual(one.applied.map((p) => [p.lineId, p.entryId]), [[1, 31]]);
    assert.deepEqual(one.withoutCandidates, [2]);
  });

  it('a lone candidate under the threshold is a low-score suggestion; lines without candidates are counted', () => {
    const a = assignMatches([line(1, '2026-04-16', -70000), line(2, '2026-04-16', -99)], [entry(41, '2026-04-10', -70000)]);
    // 6 days late: 50 + (25 − 18) = 57 < 70.
    assert.deepEqual(a.applied, []);
    assert.deepEqual(a.pending.map((p) => [p.lineId, p.reason, p.candidates[0].score]), [[1, 'low_score', 57]]);
    assert.deepEqual(a.withoutCandidates, [2]);
  });

  it('is deterministic whatever the input order', () => {
    const lines = [line(1, '2026-04-10', -100000), line(2, '2026-04-11', -100000), line(3, '2026-04-12', 200000, 'NEFT ACME')];
    const entries = [
      entry(51, '2026-04-10', -100000),
      entry(52, '2026-04-11', -100000),
      entry(53, '2026-04-11', 200000, { particulars: 'Acme Traders', instrumentType: 'neft' }),
    ];
    const a = assignMatches(lines, entries);
    const b = assignMatches([...lines].reverse(), [...entries].reverse());
    assert.deepEqual(a.applied, b.applied);
    assert.deepEqual(a.pending, b.pending);
    // 3↔53: 50 + 22 + 15 + 5 = 92, unrivalled → applied. 1↔51 = 75 but 2↔51 = 72 (lead 3 < 10) → both ambiguous.
    assert.deepEqual(a.applied.map((p) => [p.lineId, p.entryId, p.score]), [[3, 53, 92]]);
    assert.deepEqual(a.pending.map((p) => [p.lineId, p.reason, p.candidates.map((c) => c.entryId)]), [[1, 'ambiguous', [51, 52]], [2, 'ambiguous', [52, 51]]]);
  });
});
