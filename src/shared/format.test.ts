import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatCompactINR, formatDrCr, formatIndianNumber, formatMoney, formatPercent, formatQty, formatRate } from './format.ts';

describe('formatIndianNumber', () => {
  test('Indian digit grouping', () => {
    const cases: Array<[number, string]> = [
      [0, '0.00'],
      [999, '999.00'],
      [1000, '1,000.00'],
      [99999, '99,999.00'],
      [100000, '1,00,000.00'],
      [1234567.891, '12,34,567.89'],
      [123456789, '12,34,56,789.00'],
      [1000000000000, '10,00,00,00,00,000.00'],
    ];
    for (const [n, s] of cases) assert.equal(formatIndianNumber(n), s, String(n));
  });

  test('decimals, negatives and non-finite', () => {
    assert.equal(formatIndianNumber(1234567, 0), '12,34,567');
    assert.equal(formatIndianNumber(1234.5, 3), '1,234.500');
    assert.equal(formatIndianNumber(-1234567.5), '-12,34,567.50');
    assert.equal(formatIndianNumber(-0.001), '0.00', 'no "-0.00"');
    assert.equal(formatIndianNumber(Number.NaN), '');
  });
});

describe('money formatting', () => {
  test('formatMoney options', () => {
    assert.equal(formatMoney(12345650), '1,23,456.50');
    assert.equal(formatMoney(12345650, { symbol: true }), '₹ 1,23,456.50');
    assert.equal(formatMoney(-12345650, { symbol: true }), '-₹ 1,23,456.50');
    assert.equal(formatMoney(-500, { absolute: true }), '5.00');
    assert.equal(formatMoney(0, { blankZero: true }), '');
    assert.equal(formatMoney(1), '0.01');
    assert.equal(formatMoney(1005), '10.05');
  });

  test('formatMoney is exact for every safe integer (regression: float rupees misprinted paise near 2^53)', () => {
    // 9007199254640993 / 100 is not representable; toFixed used to print …409.94.
    assert.equal(formatMoney(9007199254640993), '9,00,71,99,25,46,409.93');
    assert.equal(formatMoney(-9007199254740991, { symbol: true }), '-₹ 9,00,71,99,25,47,409.91');
    assert.equal(formatDrCr(-9007199254640996), '9,00,71,99,25,46,409.96 Cr');
    assert.equal(formatMoney(-0), '0.00');
    assert.equal(formatMoney(-5), '-0.05');
  });

  test('formatDrCr', () => {
    assert.equal(formatDrCr(123450), '1,234.50 Dr');
    assert.equal(formatDrCr(-123450), '1,234.50 Cr');
    assert.equal(formatDrCr(0), '');
    assert.equal(formatDrCr(0, { keepZero: true }), '0.00');
  });

  test('formatCompactINR tiers (regression: ₹99,999.99 showed as ₹100.0 K)', () => {
    assert.equal(formatCompactINR(50000), '₹500');
    assert.equal(formatCompactINR(99960), '₹1.0 K');
    assert.equal(formatCompactINR(1234500), '₹12.3 K');
    assert.equal(formatCompactINR(9999999), '₹1.00 L');
    assert.equal(formatCompactINR(12345600), '₹1.23 L');
    assert.equal(formatCompactINR(999999999), '₹1.00 Cr');
    assert.equal(formatCompactINR(15000000000), '₹15.00 Cr'); // ₹15,00,00,000
    assert.equal(formatCompactINR(150000000000), '₹150.00 Cr');
    assert.equal(formatCompactINR(-12345600), '-₹1.23 L');
    assert.equal(formatCompactINR(-1), '₹0', 'no "-₹0"');
  });
});

describe('quantities, rates and percentages', () => {
  test('formatQty', () => {
    assert.equal(formatQty(12.5, 3, 'Kg'), '12.500 Kg');
    assert.equal(formatQty(1500), '1,500');
  });

  test('formatRate keeps 2–4 decimals', () => {
    assert.equal(formatRate(12.5), '12.50');
    assert.equal(formatRate(1.2345), '1.2345');
    assert.equal(formatRate(1.234), '1.234');
    assert.equal(formatRate(1250), '1,250.00');
  });

  test('formatPercent', () => {
    assert.equal(formatPercent(18), '18%');
    assert.equal(formatPercent(0.25), '0.25%');
    assert.equal(formatPercent(7.5), '7.5%');
  });

  test('formatPercent keeps GST rate precision (regression: CGST 0.125% printed as 0.13%)', () => {
    assert.equal(formatPercent(0.125), '0.125%'); // half of the 0.25% slab
    assert.equal(formatPercent(0.05), '0.05%'); // half of 0.1%
    assert.equal(formatPercent(1.5 / 2), '0.75%');
    assert.equal(formatPercent(100 / 3), '33.33%', 'long computed fractions still round to 2 decimals');
    assert.equal(formatPercent(-0), '0%');
    assert.equal(formatPercent(Number.NaN), '');
  });
});
