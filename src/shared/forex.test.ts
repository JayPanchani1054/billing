import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateForex,
  amountInWordsForex,
  bookedPaise,
  defaultRateType,
  effectiveRate,
  formatExchangeRate,
  formatForex,
  formatForexDrCr,
  forexToPaise,
  paiseToForex,
  parseForex,
  pickRate,
  roundForex,
  sumForex,
  toMinor,
} from './forex.ts';

test('forexToPaise: exact to the paisa, half away from zero, no float noise', () => {
  assert.equal(forexToPaise(1000, 2, 83.25), 8_325_000);
  // $3.015 rounds to $3.02 first (2 decimals), × ₹83 = ₹250.66.
  assert.equal(forexToPaise(3.015, 2, 83), 25_066);
  // $1.01 × ₹82.5 = ₹83.325 → 8332.5 paise → 8333 (half away from zero).
  assert.equal(forexToPaise(1.01, 2, 82.5), 8333);
  assert.equal(forexToPaise(-1.01, 2, 82.5), -8333);
  // ¥ (0 decimals) at ₹0.5567: ¥12,345 = ₹6,872.4615 → 687246 paise.
  assert.equal(forexToPaise(12345, 0, 0.5567), 687_246);
  // Large: $1 billion at ₹83.123456.
  assert.equal(forexToPaise(1_000_000_000, 2, 83.123456), 8_312_345_600_000);
});

test('paiseToForex and effectiveRate', () => {
  assert.equal(paiseToForex(8_325_000, 83.25, 2), 1000);
  assert.equal(paiseToForex(756_000, 84, 2), 90);
  assert.equal(paiseToForex(-100, 3, 2), -0.33);
  assert.equal(effectiveRate(3_330_000, 400), 83.25);
  assert.equal(effectiveRate(100, 0), 0);
});

test('bookedPaise: part of a bill at the INR it carries; the last part takes the rest', () => {
  // Bill $1,000 / ₹83,250: $600 → ₹49,950; $400 of a $400 / ₹33,300 rest → ₹33,300.
  assert.equal(bookedPaise(8_325_000, 1000, 600, 2), 4_995_000);
  assert.equal(bookedPaise(3_330_000, 400, 400, 2), 3_330_000);
  // $1 of $3 / ₹250 → ₹83.33 (8333.33 → 8333).
  assert.equal(bookedPaise(25_000, 3, 1, 2), 8333);
  assert.equal(bookedPaise(-25_000, -3, 1, 2), -8333);
});

test('rounding, sums and allocation in minor units', () => {
  assert.equal(roundForex(12.345, 2), 12.35);
  assert.equal(roundForex(-12.345, 2), -12.35);
  assert.equal(toMinor(0.1 + 0.2, 2), 30);
  assert.equal(sumForex([0.1, 0.2], 2), 0.3);
  assert.deepEqual(allocateForex(100, [1, 1, 1], 2), [33.34, 33.33, 33.33]);
});

test('formatting and parsing', () => {
  assert.equal(formatForex(1234567.5, 2, '$'), '$ 1,234,567.50');
  assert.equal(formatForex(-12, 0, '¥'), '-¥ 12');
  assert.equal(formatForexDrCr(-1250, 2, '$'), '$ 1,250.00 Cr');
  assert.equal(formatForexDrCr(0, 2, '$'), '');
  assert.equal(formatExchangeRate(83.25), '83.25');
  assert.equal(formatExchangeRate(83.2567), '83.2567');
  assert.equal(formatExchangeRate(83), '83.00');
  assert.equal(parseForex('$ 1,250.50'), 1250.5);
  assert.equal(parseForex('-12'), -12);
  assert.equal(parseForex('abc'), null);
  assert.equal(amountInWordsForex(1250.5, 2, 'US Dollar'), 'US Dollar One Thousand Two Hundred Fifty and 50/100 Only');
  assert.equal(amountInWordsForex(7, 0, 'Japanese Yen'), 'Japanese Yen Seven Only');
});

test('rate type by voucher and fallbacks', () => {
  assert.equal(defaultRateType('sales'), 'buying');
  assert.equal(defaultRateType('receipt'), 'buying');
  assert.equal(defaultRateType('payment'), 'selling');
  assert.equal(defaultRateType('purchase'), 'selling');
  assert.equal(defaultRateType('journal'), 'standard');
  assert.equal(pickRate({ standard: 83, selling: null, buying: 82.5 }, 'buying'), 82.5);
  assert.equal(pickRate({ standard: 83, selling: null, buying: 82.5 }, 'selling'), 83);
  assert.equal(pickRate({ standard: null, selling: null, buying: 82.5 }, 'standard'), 82.5);
  assert.equal(pickRate(null, 'standard'), null);
});
