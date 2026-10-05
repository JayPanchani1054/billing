import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rupeesToPaise } from './money.ts';
import { amountInWords, numberToWordsIndian, numberToWordsInternational } from './words.ts';

describe('numberToWordsIndian', () => {
  test('small numbers', () => {
    const cases: Array<[number, string]> = [
      [0, 'Zero'], [1, 'One'], [11, 'Eleven'], [19, 'Nineteen'], [20, 'Twenty'], [21, 'Twenty One'],
      [99, 'Ninety Nine'], [100, 'One Hundred'], [101, 'One Hundred One'], [110, 'One Hundred Ten'],
      [999, 'Nine Hundred Ninety Nine'], [1000, 'One Thousand'], [1001, 'One Thousand One'],
    ];
    for (const [n, w] of cases) assert.equal(numberToWordsIndian(n), w, String(n));
  });

  test('lakh and crore grouping', () => {
    assert.equal(numberToWordsIndian(100000), 'One Lakh');
    assert.equal(numberToWordsIndian(123456), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six');
    assert.equal(numberToWordsIndian(1005000), 'Ten Lakh Five Thousand');
    assert.equal(numberToWordsIndian(10000000), 'One Crore');
    assert.equal(numberToWordsIndian(10000001), 'One Crore One');
    assert.equal(numberToWordsIndian(999999999), 'Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine');
    // Above 99 crore the crore part is itself read in the Indian system.
    assert.equal(numberToWordsIndian(1_00_000_00_00_000), 'One Lakh Crore');
    assert.equal(numberToWordsIndian(12_34_56_78_901), 'One Thousand Two Hundred Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred One');
  });

  test('negatives and invalid input', () => {
    assert.equal(numberToWordsIndian(-7), 'Minus Seven');
    assert.throws(() => numberToWordsIndian(1.5), RangeError);
    assert.throws(() => numberToWordsIndian(Number.NaN), RangeError);
  });

  test('international system', () => {
    assert.equal(numberToWordsInternational(1234567), 'One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven');
    assert.equal(numberToWordsInternational(1_000_000_000), 'One Billion');
    assert.equal(numberToWordsInternational(0), 'Zero');
  });
});

describe('amountInWords', () => {
  test('the documented example', () => {
    // 12345678 paise = ₹1,23,456.78
    assert.equal(amountInWords(12345678), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
  });

  test('zero, paise-only and whole rupees', () => {
    assert.equal(amountInWords(0), 'Rupees Zero Only');
    assert.equal(amountInWords(1), 'One Paise Only');
    assert.equal(amountInWords(99), 'Ninety Nine Paise Only');
    assert.equal(amountInWords(100), 'Rupees One Only');
    assert.equal(amountInWords(10029), 'Rupees One Hundred and Twenty Nine Paise Only');
  });

  test('one crore and the largest documented amount', () => {
    assert.equal(amountInWords(1_00_00_000_00), 'Rupees One Crore Only'); // ₹1,00,00,000.00
    // ₹99,99,99,999.99
    assert.equal(
      amountInWords(99_99_99_999_99),
      'Rupees Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only',
    );
    // ₹99,99,99,99,999.99 (upper bound in the spec)
    assert.equal(
      amountInWords(99_99_99_99_999_99),
      'Rupees Nine Thousand Nine Hundred Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only',
    );
  });

  test('negatives', () => {
    assert.equal(amountInWords(-5000), 'Minus Rupees Fifty Only');
    assert.equal(amountInWords(-1), 'Minus One Paise Only');
  });

  test('paise are exact (no float division)', () => {
    // 1.15 × 100 = 114.99999999999999 in binary; via rupeesToPaise it is 115.
    assert.equal(amountInWords(rupeesToPaise(1.15)), 'Rupees One and Fifteen Paise Only');
    assert.equal(amountInWords(rupeesToPaise(0.29)), 'Twenty Nine Paise Only');
    assert.throws(() => amountInWords(10.5), RangeError);
  });

  test('currency none and international style', () => {
    assert.equal(amountInWords(12345678, { currency: 'none' }), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six Point Seven Eight');
    assert.equal(amountInWords(1205, { currency: 'none' }), 'Twelve Point Zero Five');
    assert.equal(amountInWords(1250, { currency: 'none' }), 'Twelve Point Five');
    assert.equal(amountInWords(0, { currency: 'none' }), 'Zero');
    assert.equal(amountInWords(-150, { currency: 'none' }), 'Minus One Point Five');
    assert.equal(
      amountInWords(12345678900, { style: 'international' }),
      'Rupees One Hundred Twenty Three Million Four Hundred Fifty Six Thousand Seven Hundred Eighty Nine Only',
    );
  });
});
