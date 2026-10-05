import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docNoKeys, exactDocNo, fyFreeDocNo, levenshtein, normalizeDocNo, stripFyFragments } from './docno.ts';

describe('document number normalisation', () => {
  it('level 1: case, separators and leading zeros per part', () => {
    const table: Array<[string, string]> = [
      ['INV/001/25-26', 'INV12526'],
      ['inv-1-2526', 'INV12526'],
      ['INV1', 'INV1'],
      ['INV 0001', 'INV1'],
      ['inv_00_7', 'INV07'],
      ['A0B01', 'A0B1'],
      ['  gst.2026.000042 ', 'GST202642'],
      ['000', '0'],
      ['INV\\12', 'INV12'],
      ['INV–12', 'INV12'], // en dash from a word processor
      ['', ''],
    ];
    for (const [raw, want] of table) assert.equal(normalizeDocNo(raw), want, raw);
  });

  it('zeros are stripped per part before joining, so different numbers stay apart', () => {
    assert.equal(normalizeDocNo('INV/1/02'), 'INV12');
    assert.equal(normalizeDocNo('INV/10/2'), 'INV102');
    assert.notEqual(normalizeDocNo('INV/1/02'), normalizeDocNo('INV/10/2'));
  });

  it("level 2 removes financial-year parts: 'INV/001/25-26' ≡ 'inv-1-2526' ≡ 'INV1'", () => {
    assert.equal(fyFreeDocNo('INV/001/25-26'), 'INV1');
    assert.equal(fyFreeDocNo('inv-1-2526'), 'INV1');
    assert.equal(fyFreeDocNo('INV1'), 'INV1');
    assert.equal(fyFreeDocNo('GST/2025-26/7'), 'GST7');
    assert.equal(fyFreeDocNo('2025-2026/INV/9'), 'INV9');
    assert.equal(fyFreeDocNo('INV/9/FY 25-26'), 'INV9');
    assert.equal(fyFreeDocNo('INV/9/FY2526'), 'INV9');
    assert.equal(fyFreeDocNo('S/202526/15'), 'S15');
  });

  it('keeps parts that are not a consecutive GST-era year pair, and never strips the only number', () => {
    assert.equal(stripFyFragments('INV/25-27/3'), null); // not consecutive
    assert.equal(stripFyFragments('INV/1213/3'), null); // 2012-13 predates GST
    assert.equal(stripFyFragments('INV/2526'), null); // would leave no digit: 2526 is the invoice number
    assert.equal(stripFyFragments('INV2526'), null); // not a stand-alone part
    assert.equal(fyFreeDocNo('INV/2526'), 'INV2526');
  });

  it('non-fuzzy keys only upper-case and drop whitespace', () => {
    assert.equal(exactDocNo(' inv / 001 '), 'INV/001');
    assert.deepEqual(docNoKeys('INV/001/25-26', false), { exact: 'INV/001/25-26', fy: 'INV/001/25-26' });
    assert.deepEqual(docNoKeys('INV/001/25-26', true), { exact: 'INV12526', fy: 'INV1' });
  });

  it('levenshtein distance with an early-exit bound', () => {
    assert.equal(levenshtein('BC79', 'BC97'), 2);
    assert.equal(levenshtein('INV1', 'INV12'), 1);
    assert.equal(levenshtein('', 'ABC'), 3);
    assert.equal(levenshtein('SAME', 'SAME'), 0);
    assert.equal(levenshtein('ABCDEFGH', 'ZZZZZZZZ', 2), 3); // bounded: max + 1
    assert.equal(levenshtein('A', 'ABCDEF', 2), 3);
  });
});
