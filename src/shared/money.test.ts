import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatMoney } from './format.ts';
import {
  allocate,
  isCredit,
  isDebit,
  lineAmount,
  paiseToRupees,
  parseAmount,
  parseDecimal,
  percentOf,
  roundPaise,
  roundTo,
  roundToUnit,
  rupeesToPaise,
  sumPaise,
} from './money.ts';

describe('roundPaise', () => {
  test('half away from zero in both directions', () => {
    assert.equal(roundPaise(0.5), 1);
    assert.equal(roundPaise(-0.5), -1);
    assert.equal(roundPaise(1.4999), 1);
    assert.equal(roundPaise(-2.5), -3);
    assert.ok(Object.is(roundPaise(-0.4), 0), 'never returns -0');
  });

  test('binary noise does not flip the rounding', () => {
    // 1.005 × 100 = 100.49999999999999 in binary floating point
    assert.equal(roundPaise(1.005 * 100), 101);
    assert.equal(roundPaise(0.1 * 3 * 100), 30);
  });

  test('large amounts keep exact halves (regression: 6-decimal snap overflowed 2^53)', () => {
    assert.equal(roundPaise(331560320190.5), 331560320191);
    assert.equal(roundPaise(-331560320190.5), -331560320191);
    assert.equal(roundPaise(67363101337208.49), 67363101337208);
    assert.equal(roundPaise(9e15), 9e15);
  });

  test('non-finite input throws', () => {
    assert.throws(() => roundPaise(Number.NaN), RangeError);
    assert.throws(() => roundPaise(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe('conversions and arithmetic', () => {
  test('rupees ↔ paise', () => {
    assert.equal(rupeesToPaise(1.15), 115);
    assert.equal(rupeesToPaise(1234.505), 123451);
    assert.equal(paiseToRupees(123450), 1234.5);
  });

  test('lineAmount rounds once at the end', () => {
    // 3 × 33.33 = 99.99 → 9999 paise
    assert.equal(lineAmount(3, 33.33), 9999);
    // 10 × 100 less 10% → 900.00
    assert.equal(lineAmount(10, 100, 10), 90000);
    // 1 × 10.05 less 10% = 9.045 → 905 paise (half away from zero)
    assert.equal(lineAmount(1, 10.05, 10), 905);
  });

  test('percentOf, sumPaise, isDebit/isCredit', () => {
    assert.equal(percentOf(1010, 5), 51);
    assert.equal(percentOf(-1010, 5), -51);
    assert.equal(sumPaise([100, -40, 5]), 65);
    assert.equal(isDebit(1), true);
    assert.equal(isCredit(-1), true);
    assert.equal(isDebit(0) || isCredit(0), false);
  });

  test('roundTo for quantities and rates', () => {
    assert.equal(roundTo(1.005, 2), 1.01);
    assert.equal(roundTo(-1.005, 2), -1.01);
    assert.equal(roundTo(2.4445, 3), 2.445);
    assert.ok(Object.is(roundTo(-0.0001, 2), 0));
  });
});

describe('allocate', () => {
  test('parts always sum exactly to the total (largest remainder)', () => {
    assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocate(76, [1010, 1010, 1010]), [26, 25, 25]);
    assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
    assert.deepEqual(allocate(10, [3, 0, 7]), [3, 0, 7]);
    const parts = allocate(999_999, [17, 23, 31, 29]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 999_999);
  });

  test('degenerate weights', () => {
    assert.deepEqual(allocate(50, []), []);
    assert.deepEqual(allocate(50, [0, 0]), [50, 0]);
    assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  });
});

describe('roundToUnit', () => {
  test('nearest / up / down to the rupee', () => {
    assert.equal(roundToUnit(47555, 100, 'nearest'), 47600);
    assert.equal(roundToUnit(47549, 100, 'nearest'), 47500);
    assert.equal(roundToUnit(47550, 100, 'nearest'), 47600);
    assert.equal(roundToUnit(47501, 100, 'up'), 47600);
    assert.equal(roundToUnit(47599, 100, 'down'), 47500);
    assert.equal(roundToUnit(47500, 100, 'up'), 47500);
  });

  test('negative and zero amounts', () => {
    assert.equal(roundToUnit(-1250, 100, 'nearest'), -1300); // half away from zero
    assert.equal(roundToUnit(-1250, 100, 'up'), -1200); // toward +∞
    assert.equal(roundToUnit(-1250, 100, 'down'), -1300); // toward −∞
    assert.ok(Object.is(roundToUnit(-40, 100, 'nearest'), 0));
    assert.equal(roundToUnit(0, 100, 'up'), 0);
  });

  test('exact for any unit size (regression: float division with a 1e-9 fudge)', () => {
    // 1 paise up to a ₹10 crore unit used to give 0 (ceil(1e-10 − 1e-9) = 0).
    assert.equal(roundToUnit(1, 1e10, 'up'), 1e10);
    assert.equal(roundToUnit(-1, 1e10, 'down'), -1e10);
    assert.equal(roundToUnit(4999999999, 1e10, 'nearest'), 0);
    assert.equal(roundToUnit(5000000000, 1e10, 'nearest'), 1e10);
    assert.equal(roundToUnit(47555, 500, 'nearest'), 47500); // nearest ₹5
    assert.equal(roundToUnit(47750, 500, 'nearest'), 48000); // exact half → away from zero
  });

  test('unit ≤ 1 leaves the amount unchanged', () => {
    assert.equal(roundToUnit(12345, 1, 'nearest'), 12345);
    assert.equal(roundToUnit(12345, 0, 'up'), 12345);
  });
});

describe('parseAmount', () => {
  test('grouping, symbols and decimals', () => {
    assert.equal(parseAmount('1,23,456.789'), 12345679);
    assert.equal(parseAmount('123,456.78'), 12345678);
    assert.equal(parseAmount('₹ 50'), 5000);
    assert.equal(parseAmount('Rs. 1,000'), 100000);
    assert.equal(parseAmount('INR 12'), 1200);
    assert.equal(parseAmount('.5'), 50);
    assert.equal(parseAmount('  42  '), 4200);
  });

  test('signs, Dr/Cr and parentheses', () => {
    assert.equal(parseAmount('100 Cr'), -10000);
    assert.equal(parseAmount('100 Dr'), 10000);
    assert.equal(parseAmount('100 cr.'), -10000);
    assert.equal(parseAmount('-25.50'), -2550);
    assert.equal(parseAmount('+25'), 2500);
    assert.equal(parseAmount('(1,000)'), -100000);
    assert.equal(parseAmount('₹ -50'), -5000);
  });

  test("round-trips formatMoney's own output (regression: '-₹ …' was rejected)", () => {
    for (const p of [0, 1, -1, 12345650, -12345650, 99999999999]) {
      assert.equal(parseAmount(formatMoney(p, { symbol: true })), p, String(p));
      assert.equal(parseAmount(formatMoney(p)), p, String(p));
    }
  });

  test('rejects non-numbers', () => {
    for (const s of ['', '   ', 'abc', '1.2.3', '1e5', '.', '-', '₹', '+-5', '12abc']) assert.equal(parseAmount(s), null, s);
  });

  test('rejects amounts too large to hold exactly (regression: returned 1e22)', () => {
    assert.equal(parseAmount('99999999999999999999'), null);
    assert.equal(parseAmount('-1,00,00,00,00,00,00,000'), null); // ₹10^17 → 10^19 paise > 2^53
    // ₹90,07,19,92,54,74,09.91 = 2^53 − 1 paise is the largest amount that parses.
    assert.equal(parseAmount('90071992547409.91'), Number.MAX_SAFE_INTEGER);
    assert.equal(parseAmount('90071992547409.92'), null);
  });

  test('decimal text is converted exactly (regression: float multiply + 6-decimal snap)', () => {
    // In floating point 40000000000000.02 × 100 = 4000000000000003 and 90071992547359.99 × 100 = …998.
    assert.equal(parseAmount('40000000000000.02'), 4000000000000002);
    assert.equal(parseAmount('90071992547359.99'), 9007199254735999);
    assert.equal(parseAmount('1.0049999'), 100, 'the snap used to round this up to 101');
    assert.equal(parseAmount('1.005'), 101);
    assert.equal(parseAmount('-1.005'), -101);
    assert.equal(parseAmount('0.004'), 0);
    assert.ok(Object.is(parseAmount('-0.004'), 0), 'never -0');
    assert.equal(parseAmount('12345678901234.56'), 1234567890123456);
  });
});

describe('hostile input', () => {
  test('long text is rejected quickly (regression: quadratic regex backtracking)', () => {
    // '1' + 50 000 spaces + 'x' took ~3 s and 50 000 digits + 'x' ~2 s before the fix.
    const start = performance.now();
    assert.equal(parseAmount(`1${' '.repeat(50_000)}x`), null);
    assert.equal(parseAmount(`${'1'.repeat(50_000)}x`), null);
    assert.equal(parseDecimal(`${'1'.repeat(50_000)}x`), null);
    assert.equal(parseAmount(`${'1'.repeat(40)}x`), null); // under the length cap: linear regexes
    assert.equal(parseDecimal(`${'1'.repeat(40)}x`), null);
    assert.ok(performance.now() - start < 200, 'parsing stays linear');
  });

  test('accepted forms are unchanged', () => {
    assert.equal(parseAmount('12.'), 1200);
    assert.equal(parseDecimal('12.'), 12);
    assert.equal(parseDecimal('+.5'), 0.5);
    assert.equal(parseDecimal('+-5'), null);
  });
});

describe('parseDecimal', () => {
  test('valid and invalid', () => {
    assert.equal(parseDecimal('1,000.25'), 1000.25);
    assert.equal(parseDecimal('-3'), -3);
    assert.equal(parseDecimal('+.5'), 0.5);
    assert.equal(parseDecimal(''), null);
    assert.equal(parseDecimal('-'), null);
    assert.equal(parseDecimal('1/2'), null);
  });
});
