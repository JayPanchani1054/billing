import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySide, formatAmountText, formatNumberText, parseAmountText, parseNumberText, sideOf } from './numeric.ts';

test('parseAmountText: plain, grouped, currency, Dr/Cr', () => {
  assert.deepEqual(parseAmountText(''), { ok: true, paise: null, side: null });
  assert.deepEqual(parseAmountText('1,23,456.78'), { ok: true, paise: 12345678, side: null });
  assert.deepEqual(parseAmountText('₹ 50'), { ok: true, paise: 5000, side: null });
  assert.deepEqual(parseAmountText('Rs. 50'), { ok: true, paise: 5000, side: null });
  assert.deepEqual(parseAmountText('500 Cr'), { ok: true, paise: 50000, side: 'cr' });
  assert.deepEqual(parseAmountText('500dr'), { ok: true, paise: 50000, side: 'dr' });
});

test('parseAmountText: expressions evaluate in rupees and round to paise', () => {
  assert.deepEqual(parseAmountText('1200*3'), { ok: true, paise: 360000, side: null });
  assert.deepEqual(parseAmountText('1000+18%'), { ok: true, paise: 118000, side: null });
  assert.deepEqual(parseAmountText('10/3'), { ok: true, paise: 333, side: null });
  assert.deepEqual(parseAmountText('0.1+0.2'), { ok: true, paise: 30, side: null });
  assert.deepEqual(parseAmountText('100*3 cr'), { ok: true, paise: 30000, side: 'cr' });
  const r = parseAmountText('12/0');
  assert.equal(r.ok, false);
  assert.equal(parseAmountText('abc').ok, false);
});

test('parseNumberText: decimals rounding and expressions', () => {
  assert.deepEqual(parseNumberText('12.3456', { decimals: 2 }), { ok: true, value: 12.35 });
  assert.deepEqual(parseNumberText('2*1.5', { decimals: 3 }), { ok: true, value: 3 });
  assert.deepEqual(parseNumberText('', {}), { ok: true, value: null });
  assert.equal(parseNumberText('2*3', { expressions: false }).ok, false);
  assert.deepEqual(parseNumberText('1,000'), { ok: true, value: 1000 });
});

test('formatting helpers', () => {
  assert.equal(formatAmountText(12345678), '1,23,456.78');
  assert.equal(formatAmountText(-500, { absolute: true }), '5.00');
  assert.equal(formatAmountText(0, { blankZero: true }), '');
  assert.equal(formatAmountText(null), '');
  assert.equal(formatNumberText(1234567.5, 2), '12,34,567.50');
  assert.equal(formatNumberText(1234.5, 1, false), '1234.5');
  assert.equal(formatNumberText(null, 2), '');
});

test('Dr/Cr side helpers', () => {
  assert.equal(applySide(500, 'cr'), -500);
  assert.equal(applySide(-500, 'dr'), 500);
  assert.equal(applySide(0, 'cr'), 0);
  assert.equal(sideOf(-1, 'dr'), 'cr');
  assert.equal(sideOf(0, 'cr'), 'cr');
  assert.equal(sideOf(null, 'dr'), 'dr');
});
