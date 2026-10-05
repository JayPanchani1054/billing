import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gstinCheckChar, gstinStateCode, isValidGstin, normalizeGstin, panFromGstin, validateGstin } from './gstin.ts';

/*
 * Hand verification of the check character (values: 0–9 → 0–9, A=10 … Z=35; factor 1 at even
 * positions, 2 at odd; addend = floor(p/36) + p mod 36; check = (36 − Σ mod 36) mod 36).
 *
 * 27AAPFU0939F1Z → V   (GSTN API documentation sample)
 *   chars   2  7  A  A  P  F  U  0  9  3  9  F  1  Z
 *   values  2  7 10 10 25 15 30  0  9  3  9 15  1 35
 *   × f     2 14 10 20 25 30 30  0  9  6  9 30  1 70
 *   addend  2 14 10 20 25 30 30  0  9  6  9 30  1 35   (70 → 1 + 34)
 *   Σ = 221; 221 mod 36 = 5; 36 − 5 = 31 → 'V' ✓
 *
 * 29AAGCB7383J1Z → 4
 *   values  2  9 10 10 16 12 11  7  3  8  3 19  1 35
 *   × f     2 18 10 20 16 24 11 14  3 16  3 38  1 70
 *   addend  2 18 10 20 16 24 11 14  3 16  3  3  1 35   (38 → 1 + 2)
 *   Σ = 176; 176 mod 36 = 32; 36 − 32 = 4 → '4' ✓
 *
 * 27AAACR5055K1Z → 7
 *   values  2  7 10 10 10 12 27  5  0  5  5 20  1 35
 *   × f     2 14 10 20 10 24 27 10  0 10  5 40  1 70
 *   addend  2 14 10 20 10 24 27 10  0 10  5  5  1 35   (40 → 1 + 4)
 *   Σ = 173; 173 mod 36 = 29; 36 − 29 = 7 → '7' ✓
 *
 * 07AAACR5055K1Z → 9, NOT 8: the sample '07AAACR5055K1Z8' from the task brief does not carry a valid
 * check character. Same PAN as above with state 07: addends 0 + 14 instead of 2 + 14 → Σ = 171;
 * 171 mod 36 = 27; 36 − 27 = 9 → '9'. The algorithm itself is confirmed by the three samples above
 * (and by the UIN sample below), so '…Z8' is rejected and '…Z9' accepted.
 *
 * 0717UNO00157UNO (UIN) → O
 *   values  0  7  1  7 30 23 24  0  0  1  5  7 30 23
 *   × f     0 14  1 14 30 46 24  0  0  2  5 14 30 46
 *   addend  0 14  1 14 30 11 24  0  0  2  5 14 30 11   (46 → 1 + 10)
 *   Σ = 156; 156 mod 36 = 12; 36 − 12 = 24 → 'O' ✓
 */

describe('GSTIN check character', () => {
  test('hand-verified samples are valid', () => {
    for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '27AAACR5055K1Z7', '07AAACR5055K1Z9']) {
      const r = validateGstin(g);
      assert.equal(r.valid, true, `${g}: ${r.error ?? ''}`);
      assert.equal(r.kind, 'regular');
      assert.equal(r.special, false);
    }
    assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
    assert.equal(gstinCheckChar('29AAGCB7383J1Z'), '4');
    assert.equal(gstinCheckChar('07AAACR5055K1Z'), '9');
  });

  test('07AAACR5055K1Z8 fails the checksum (correct check character is 9)', () => {
    const r = validateGstin('07AAACR5055K1Z8');
    assert.equal(r.valid, false);
    assert.match(r.error ?? '', /check character/);
    assert.equal(r.stateCode, '07');
  });

  test('every single-character typo is detected', () => {
    const good = '27AAPFU0939F1ZV';
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 15; i++) {
      for (const c of charset) {
        if (c === good[i]) continue;
        const typo = good.slice(0, i) + c + good.slice(i + 1);
        assert.equal(isValidGstin(typo), false, typo);
      }
    }
  });

  test('gstinCheckChar rejects malformed input', () => {
    assert.equal(gstinCheckChar('27AAPFU0939F1'), '');
    assert.equal(gstinCheckChar('27aapfu0939f1z'), '');
  });
});

describe('validateGstin', () => {
  test('reports state code and PAN', () => {
    assert.deepEqual(validateGstin('27AAPFU0939F1ZV'), {
      valid: true,
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      kind: 'regular',
      special: false,
      pan: 'AAPFU0939F',
    });
  });

  test('normalises case and whitespace', () => {
    assert.equal(normalizeGstin('  27aapfu0939f1zv '), '27AAPFU0939F1ZV');
    assert.equal(normalizeGstin('27 AAPFU 0939F 1ZV'), '27AAPFU0939F1ZV');
    assert.equal(validateGstin(' 27aapfu0939f1zv').valid, true);
    assert.equal(normalizeGstin(null), '');
  });

  test('length, characters, format and state errors', () => {
    assert.match(validateGstin('').error ?? '', /empty/);
    assert.match(validateGstin('27AAPFU0939F1Z').error ?? '', /15 characters/);
    assert.match(validateGstin('27AAPFU0939F1Z#').error ?? '', /letters A–Z and digits/);
    assert.match(validateGstin('27AAPFU0939F1XV').error ?? '', /format is invalid/);
    // State 40 does not exist; 96 is a place-of-supply code only.
    const s40 = `40AAPFU0939F1Z${gstinCheckChar('40AAPFU0939F1Z')}`;
    assert.match(validateGstin(s40).error ?? '', /unknown state code \(40\)/);
    const s96 = `96AAPFU0939F1Z${gstinCheckChar('96AAPFU0939F1Z')}`;
    assert.equal(validateGstin(s96).valid, false);
  });

  test('special registrations are valid but flagged with their kind', () => {
    assert.deepEqual(
      [validateGstin('0717UNO00157UNO').valid, validateGstin('0717UNO00157UNO').kind, validateGstin('0717UNO00157UNO').special],
      [true, 'uin', true],
    );
    // Format classification (check characters generated with the verified algorithm).
    const make = (first14: string): string => first14 + gstinCheckChar(first14);
    assert.equal(validateGstin(make('27MUMA12345B1D')).kind, 'tds');
    assert.equal(validateGstin(make('27AAPFU0939F1C')).kind, 'tcs');
    assert.equal(validateGstin(make('9917USA29001OS')).kind, 'oidar');
    assert.equal(validateGstin(make('2717USA12345NR')).kind, 'nri');
    assert.equal(validateGstin(make('27MUMA12345B1D')).pan, undefined, 'TDS GSTINs carry a TAN, not a PAN');
    assert.equal(validateGstin(make('27AAPFU0939F1C')).pan, 'AAPFU0939F');
  });

  test('helpers', () => {
    assert.equal(gstinStateCode('29AAGCB7383J1Z4'), '29');
    assert.equal(gstinStateCode('ab'), '');
    assert.equal(panFromGstin('29aagcb7383j1z4'), 'AAGCB7383J');
    assert.equal(panFromGstin('0717UNO00157UNO'), '');
  });
});
