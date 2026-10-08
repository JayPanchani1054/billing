import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  altToBase,
  altUnitText,
  compoundSymbolPreview,
  conversionText,
  formatConversion,
  uqcSelectOptions,
  uqcSuggestion,
  validateCompoundUnit,
  validateSimpleUnit,
} from './units.ts';

test('formatConversion trims zeros and groups the Indian way', () => {
  assert.equal(formatConversion(12), '12');
  assert.equal(formatConversion(2.5), '2.5');
  assert.equal(formatConversion(100000), '1,00,000');
  assert.equal(formatConversion(1 / 3), '0.333333');
  assert.equal(formatConversion(0), '');
  assert.equal(formatConversion(-1), '');
  assert.equal(formatConversion(null), '');
  assert.equal(formatConversion(Number.NaN), '');
});

test('conversion text reads "1 Box = 12 Nos"', () => {
  assert.equal(conversionText('Box', 12, 'Nos'), '1 Box = 12 Nos');
  assert.equal(conversionText(' Kg ', 1000, 'Gms'), '1 Kg = 1,000 Gms');
  assert.equal(conversionText('Box', null, 'Nos'), '');
  assert.equal(conversionText('', 12, 'Nos'), '');
  // Item alternate unit: altConversion base units make one alternate unit.
  assert.equal(altUnitText('Nos', 'Box', 12), '1 Box = 12 Nos');
  assert.equal(altUnitText('Nos', null, 12), '');
});

test('compound symbol mirrors the core', () => {
  assert.equal(compoundSymbolPreview('Box', 12, 'Nos'), 'Box of 12 Nos');
  assert.equal(compoundSymbolPreview('Dozen', 0.1 + 0.2, 'Kg'), 'Dozen of 0.3 Kg'); // float noise removed by toPrecision(12)
  assert.equal(compoundSymbolPreview('Box', 0, 'Nos'), '');
});

test('altToBase converts and rounds to the base unit decimals', () => {
  assert.equal(altToBase(3, 12, 0), 36); // 3 Box × 12 = 36 Nos
  assert.equal(altToBase(1.5, 0.333, 2), 0.5); // 0.4995 → 0.50
  assert.equal(altToBase(2, 2.5, 0), 5);
});

test('UQC suggestion from symbol, then formal name, with OTH fallback', () => {
  const kg = uqcSuggestion('Kg');
  assert.equal(kg.code, 'KGS');
  assert.equal(kg.isFallback, false);
  assert.equal(kg.label, 'KGS – Kilograms');
  assert.match(kg.hint, /Suggested from 'Kg': KGS – Kilograms/);
  // Unknown symbol, formal name decides.
  assert.equal(uqcSuggestion('Bx', 'Boxes').code, 'BOX');
  // Nothing known: Others, and the hint says so.
  const odd = uqcSuggestion('Thaan');
  assert.equal(odd.code, 'OTH');
  assert.equal(odd.isFallback, true);
  assert.match(odd.hint, /No standard GST code matches 'Thaan'/);
  assert.match(uqcSuggestion('').hint, /Type the symbol first/);
});

test('UQC options put the suggestion first, once', () => {
  const opts = uqcSelectOptions('KGS');
  assert.equal(opts[0].value, 'KGS');
  assert.match(opts[0].label, /\(suggested\)$/);
  assert.equal(opts.filter((o) => o.value === 'KGS').length, 1);
  const plain = uqcSelectOptions('nonsense');
  assert.equal(plain[0].value, 'BAG');
  assert.equal(plain.length, opts.length);
});

test('unit draft validation', () => {
  assert.deepEqual(validateSimpleUnit({ symbol: 'Nos', decimalPlaces: 0 }), {});
  assert.match(validateSimpleUnit({ symbol: ' ', decimalPlaces: 0 }).symbol ?? '', /Enter the unit symbol/);
  assert.match(validateSimpleUnit({ symbol: 'Kg', decimalPlaces: 5 }).decimalPlaces ?? '', /0 to 4/);
  assert.deepEqual(validateCompoundUnit({ firstUnitId: 1, conversion: 12, secondUnitId: 2 }), {});
  const same = validateCompoundUnit({ firstUnitId: 1, conversion: 0, secondUnitId: 1 });
  assert.match(same.secondUnitId ?? '', /different/);
  assert.match(same.conversion ?? '', /more than 0/);
});
