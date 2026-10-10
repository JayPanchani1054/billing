import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deducteeTypeFromPan,
  depositDueDate,
  interestAmount,
  interestMonths,
  lateDepositInterest,
  lateFee234E,
  nonDeductionInterest,
  panStatus,
  periodRange,
  quarterOf,
  quarterRange,
  statementDueDate,
  taxOn,
  taxYearOf,
} from './rules.ts';

describe('tds rules: PAN', () => {
  it('validates the format and the holder-status letter', () => {
    assert.equal(panStatus('AAAPA1234A'), 'valid');
    assert.equal(panStatus(' aaapa1234a '), 'valid');
    assert.equal(panStatus('AAAXA1234A'), 'invalid'); // X is not a status letter
    assert.equal(panStatus('AAAPA12345'), 'invalid');
    assert.equal(panStatus(''), 'missing');
    assert.equal(panStatus(null), 'missing');
    assert.equal(panStatus('PANNOTAVBL'), 'missing');
  });
  it('suggests the deductee type from the 4th letter', () => {
    assert.equal(deducteeTypeFromPan('AAACA1234A'), 'company');
    assert.equal(deducteeTypeFromPan('AAAPA1234A'), 'individual');
    assert.equal(deducteeTypeFromPan('AAAHA1234A'), 'individual');
    assert.equal(deducteeTypeFromPan('AAAFA1234A'), 'firm');
    assert.equal(deducteeTypeFromPan('AAATA1234A'), 'others');
    assert.equal(deducteeTypeFromPan('bad'), null);
  });
});

describe('tds rules: dates', () => {
  it('income-tax year is April–March', () => {
    assert.deepEqual(taxYearOf('2026-03-31'), { startYear: 2025, start: '2025-04-01', end: '2026-03-31', label: '2025-26' });
    assert.equal(taxYearOf('2026-04-01').label, '2026-27');
  });
  it('deposit due dates: 7th of next month; TDS of March by 30 April, TCS of March by 7 April', () => {
    assert.equal(depositDueDate('tds', '2026-04-15'), '2026-05-07');
    assert.equal(depositDueDate('tds', '2026-12-31'), '2027-01-07');
    assert.equal(depositDueDate('tds', '2027-03-10'), '2027-04-30');
    assert.equal(depositDueDate('tcs', '2027-03-10'), '2027-04-07');
  });
  it('quarters and statement due dates (Rule 31A / 31AA)', () => {
    assert.equal(quarterOf('2026-04-01'), 1);
    assert.equal(quarterOf('2026-09-30'), 2);
    assert.equal(quarterOf('2026-12-01'), 3);
    assert.equal(quarterOf('2027-03-31'), 4);
    assert.deepEqual(quarterRange(2026, 4), { from: '2027-01-01', to: '2027-03-31' });
    assert.deepEqual(quarterRange(2026, 2), { from: '2026-07-01', to: '2026-09-30' });
    assert.equal(statementDueDate('26Q', 2026, 1), '2026-07-31');
    assert.equal(statementDueDate('26Q', 2026, 3), '2027-01-31');
    assert.equal(statementDueDate('27Q', 2026, 4), '2027-05-31');
    assert.equal(statementDueDate('27EQ', 2026, 2), '2026-10-15');
    assert.deepEqual(periodRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('tds rules: interest and fees', () => {
  it('counts months or part of a month in calendar months, both ends included', () => {
    assert.equal(interestMonths('2026-01-15', '2026-02-10'), 2);
    assert.equal(interestMonths('2026-03-31', '2026-04-01'), 2);
    assert.equal(interestMonths('2026-04-05', '2026-04-30'), 1);
    assert.equal(interestMonths('2026-05-01', '2026-04-30'), 0);
  });
  it('s.201(1A)(ii): 1.5% per month from deduction to payment, only when paid late', () => {
    // ₹10,000 deducted 15-Apr, paid 7-May (due date): no interest.
    assert.equal(lateDepositInterest('tds', 10_000_00, '2026-04-15', '2026-05-07').interest, 0);
    // Paid 8-May: April + May = 2 months × 1.5% × ₹10,000 = ₹300.
    assert.deepEqual(lateDepositInterest('tds', 10_000_00, '2026-04-15', '2026-05-08'), { months: 2, rate: 1.5, interest: 300_00 });
    // TCS s.206C(7): 1% → ₹200.
    assert.equal(lateDepositInterest('tcs', 10_000_00, '2026-04-15', '2026-05-08').interest, 200_00);
  });
  it('s.201(1A)(i): 1% per month from deductible to deducted; interest in whole rupees', () => {
    // ₹1,234 × 1% × 3 = ₹37.02 → ₹37.
    assert.deepEqual(nonDeductionInterest(1_234_00, '2026-04-20', '2026-06-01'), { months: 3, interest: 37_00 });
    assert.equal(interestAmount(0, 1.5, 3), 0);
  });
  it('s.234E: ₹200 per day, capped at the tax of the statement', () => {
    assert.deepEqual(lateFee234E('2026-07-31', '2026-08-10', 50_000_00), { days: 10, fee: 2_000_00 });
    assert.deepEqual(lateFee234E('2026-07-31', '2026-12-31', 5_000_00), { days: 153, fee: 5_000_00 });
    assert.deepEqual(lateFee234E('2026-07-31', '2026-07-31', 5_000_00), { days: 0, fee: 0 });
  });
  it('tax is rounded to the nearest rupee (or the paisa when asked)', () => {
    // 2% of ₹1,23,456.78 = ₹2,469.1356 → ₹2,469.
    assert.equal(taxOn(1_23_456_78, 2), 2_469_00);
    assert.equal(taxOn(1_23_456_78, 2, false), 2_469_14);
    // 0.1% of ₹10,50,000 = ₹1,050.
    assert.equal(taxOn(10_50_000_00, 0.1), 1_050_00);
    assert.equal(taxOn(-5, 2), 0);
  });
});
