import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasValue, revealingFields, sameValue, shouldReveal } from './disclosure.ts';

const FIELDS = ['alias', 'creditLimit', 'contact', 'tds'] as const;

test('collapsed: every field empty → the section may stay closed', () => {
  const values = { alias: '', creditLimit: 0, contact: { phone: '', email: '  ' }, tds: false, name: 'Asha Retail' };
  assert.equal(shouldReveal(FIELDS, values), false);
  assert.equal(shouldReveal(FIELDS, values, {}), false);
  assert.equal(shouldReveal(FIELDS, {}, null), false, 'missing values are empty');
  assert.deepEqual(revealingFields(FIELDS, values), []);
});

test('value: any non-empty field inside reveals (alteration never hides data)', () => {
  assert.equal(shouldReveal(FIELDS, { alias: 'Asha' }), true);
  assert.equal(shouldReveal(FIELDS, { creditLimit: 5_000_000 }), true, 'a credit limit in paise');
  assert.equal(shouldReveal(FIELDS, { creditLimit: -1 }), true, 'negative numbers are values');
  assert.equal(shouldReveal(FIELDS, { contact: { phone: '98200 00000', email: '' } }), true, 'a nested object with one value');
  assert.equal(shouldReveal(FIELDS, { tds: true }), true, 'a switched-on option');
  assert.deepEqual(revealingFields(FIELDS, { contact: { phone: '1' }, alias: 'A' }), ['alias', 'contact'], 'in the given field order');
});

test('fields outside the section never reveal it', () => {
  assert.equal(shouldReveal(FIELDS, { name: 'Asha Retail', gstin: '27AAAPA0002A1Z5' }), false);
  assert.equal(shouldReveal(FIELDS, {}, { name: 'Enter a name' }), false);
});

test('error: a field with an error reveals even when its value is empty', () => {
  assert.equal(shouldReveal(FIELDS, { alias: '' }, { alias: 'This alias is used by Cash' }), true);
  assert.equal(shouldReveal(FIELDS, {}, { creditLimit: 'Must not be negative' }), true);
  assert.equal(shouldReveal(FIELDS, {}, { alias: '' }), false, 'an empty error string is no error');
  assert.equal(shouldReveal(FIELDS, {}, { alias: null }), false);
});

test('forced: the caller can always reveal', () => {
  assert.equal(shouldReveal(FIELDS, {}, null, { forced: true }), true);
  assert.equal(shouldReveal([], {}, null, { forced: true }), true);
  assert.equal(shouldReveal(FIELDS, {}, null, { forced: false }), false);
});

test('defaults: a field left at its default counts as empty', () => {
  const defaults = { tds: 'inherit', alias: '' };
  assert.equal(shouldReveal(['tds'], { tds: 'inherit' }, null, { defaults }), false);
  assert.equal(shouldReveal(['tds'], { tds: ' inherit ' }, null, { defaults }), false, 'strings compare trimmed');
  assert.equal(shouldReveal(['tds'], { tds: '194C' }, null, { defaults }), true);
  assert.equal(shouldReveal(['tds'], { tds: 'inherit' }, { tds: 'Choose a nature' }, { defaults }), true, 'an error beats the default');
  assert.equal(shouldReveal(['tags'], { tags: ['a'] }, null, { defaults: { tags: ['a'] } }), false, 'arrays compare by value');
});

test('hasValue and sameValue edge cases', () => {
  assert.equal(hasValue(Number.NaN), false);
  assert.equal(hasValue(0n), false);
  assert.equal(hasValue(1n), true);
  assert.equal(hasValue([]), false);
  assert.equal(hasValue(['', null]), false);
  assert.equal(hasValue([0, 2]), true);
  assert.equal(hasValue({}), false);
  assert.equal(hasValue(() => 1), true);
  assert.equal(sameValue(1, 1), true);
  assert.equal(sameValue(Number.NaN, Number.NaN), true);
  assert.equal(sameValue({ a: 1 }, { a: 1 }), true);
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false);
  assert.equal(sameValue('1', 1), false);
});
