import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_UNITS } from '../constants.ts';
import {
  GST_RATES,
  isRetiredSlabOn,
  isStandardRate,
  isValidCessRate,
  isValidRate,
  rateOptions,
  splitRate,
} from './rates.ts';
import {
  findState,
  getState,
  GST_STATES,
  isKnownStateCode,
  isUtgstState,
  normalizeStateCode,
  stateLabel,
  stateName,
  stateOptions,
} from './states.ts';
import { isValidUqc, suggestUqc, UQC_LIST, uqcDescription, uqcOptions } from './uqc.ts';

describe('states', () => {
  test('all codes 01–38 plus 96, 97, 99 are present', () => {
    const codes = GST_STATES.map((s) => s.code);
    for (let i = 1; i <= 38; i++) assert.ok(codes.includes(String(i).padStart(2, '0')), `code ${i}`);
    for (const c of ['96', '97', '99']) assert.ok(codes.includes(c));
    assert.equal(GST_STATES.length, 41);
    assert.equal(new Set(codes).size, codes.length, 'codes are unique');
  });

  test('UTGST applies exactly to UTs without legislature', () => {
    assert.deepEqual(
      GST_STATES.filter((s) => s.utgst).map((s) => s.code),
      ['04', '25', '26', '31', '35', '38', '97'],
    );
    assert.equal(isUtgstState('04'), true);
    assert.equal(isUtgstState('07'), false); // Delhi has a legislature
    assert.equal(isUtgstState('34'), false); // Puducherry
    assert.equal(getState('07')?.isUnionTerritory, true);
    assert.equal(getState('01')?.isUnionTerritory, true);
    assert.equal(getState('27')?.isUnionTerritory, false);
  });

  test('legacy codes are flagged and hidden from pickers', () => {
    assert.equal(getState('28')?.legacy, true);
    assert.equal(getState('25')?.legacy, true);
    assert.equal(getState('37')?.name, 'Andhra Pradesh');
    const opts = stateOptions();
    assert.ok(!opts.some((o) => o.value === '28' || o.value === '25'));
    assert.ok(!opts.some((o) => o.value === '96' || o.value === '97' || o.value === '99'));
    assert.equal(opts.length, 36);
    assert.ok(stateOptions({ includeForeign: true }).some((o) => o.value === '96'));
    assert.ok(stateOptions({ includeSpecial: true }).some((o) => o.value === '97'));
    // Sorted by name
    assert.equal(opts[0].label, '35 - Andaman and Nicobar Islands');
    assert.equal(opts.find((o) => o.value === '27')?.alpha, 'MH');
  });

  test('lookups normalise codes', () => {
    assert.equal(normalizeStateCode('7'), '07');
    assert.equal(normalizeStateCode(7), '07');
    assert.equal(normalizeStateCode(' 27 '), '27');
    assert.equal(normalizeStateCode('MH'), '');
    assert.equal(normalizeStateCode(null), '');
    assert.equal(getState(4)?.name, 'Chandigarh');
    assert.equal(isKnownStateCode('39'), false);
    assert.equal(stateName('29'), 'Karnataka');
    assert.equal(stateLabel('27'), '27-Maharashtra');
    assert.equal(stateLabel('00'), '');
    assert.equal(findState('maharashtra')?.code, '27');
    assert.equal(findState('ka')?.code, '29');
    assert.equal(findState('Andhra Pradesh')?.code, '37');
    assert.equal(findState(''), undefined);
  });
});

describe('UQC', () => {
  test('contains the full GST UQC list', () => {
    const expected =
      'BAG BAL BDL BKL BOU BOX BTL BUN CAN CBM CCM CMS CTN DOZ DRM GGK GMS GRS GYD KGS KLR KME LTR MLT MTR MTS NOS OTH PAC PCS PRS QTL ROL SET SQF SQM SQY TBS TGM THD TON TUB UGS UNT YDS'.split(
        ' ',
      );
    assert.deepEqual(UQC_LIST.map((u) => u.code), expected);
    assert.ok(UQC_LIST.every((u) => u.description.length > 0));
    assert.equal(uqcDescription('kgs'), 'Kilograms');
    assert.equal(isValidUqc('NA'), false);
    assert.equal(uqcOptions()[0].label, 'BAG - Bags');
  });

  test('suggestUqc maps common unit names', () => {
    const cases: Array<[string, string]> = [
      ['Kg', 'KGS'], ['kgs', 'KGS'], ['Pcs', 'PCS'], ['Nos', 'NOS'], ['Ltr', 'LTR'], ['ml', 'MLT'],
      ['Mtr', 'MTR'], ['sq. ft', 'SQF'], ['Dozen', 'DOZ'], ['Pkt', 'PAC'], ['Quintal', 'QTL'],
      ['MT', 'MTS'], ['Tonne', 'TON'], ['Pair', 'PRS'], ['Hrs', 'OTH'], ['widget', 'OTH'], ['', 'OTH'],
      ['ctn', 'CTN'], ['BOX', 'BOX'],
    ];
    for (const [unit, uqc] of cases) assert.equal(suggestUqc(unit), uqc, unit);
  });

  test('every default unit suggests the UQC it is seeded with', () => {
    for (const u of DEFAULT_UNITS) assert.equal(suggestUqc(u.symbol), u.uqc, u.symbol);
  });
});

describe('rates', () => {
  test('standard slabs', () => {
    assert.deepEqual([...GST_RATES], [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);
    assert.equal(isStandardRate(18), true);
    assert.equal(isStandardRate(0.1), true);
    assert.equal(isStandardRate(0.1 + 0.2 - 0.2), true, 'tolerates float noise');
    assert.equal(isStandardRate(0.11), false);
    assert.equal(isStandardRate(18.5), false);
    assert.equal(isStandardRate(Number.NaN), false);
  });

  test('validity, split and options', () => {
    assert.equal(isValidRate(-1), false);
    assert.equal(isValidRate(101), false);
    assert.equal(isValidRate(40), true);
    assert.equal(isValidCessRate(290), true);
    assert.deepEqual(splitRate(18), { cgst: 9, sgst: 9 });
    assert.deepEqual(splitRate(0.25), { cgst: 0.125, sgst: 0.125 });
    assert.deepEqual(rateOptions([18, 5])[0], { value: 5, label: '5%' });
  });

  test('retired slabs only warn on/after 22-Sep-2025', () => {
    assert.equal(isRetiredSlabOn(12, '2025-09-22'), true);
    assert.equal(isRetiredSlabOn(28, '2026-01-01'), true);
    assert.equal(isRetiredSlabOn(12, '2025-09-21'), false);
    assert.equal(isRetiredSlabOn(18, '2026-01-01'), false);
  });
});
