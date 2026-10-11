import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accelSplit, confirmTips, keyTip, plainKeys } from './keyText.ts';

test('plainKeys: one text run, lists joined with "or", display names kept', () => {
  assert.equal(plainKeys('Ctrl+F8'), 'Ctrl+F8');
  assert.equal(plainKeys('alt+p'), 'Alt+P');
  assert.equal(plainKeys('Ctrl+G, Ctrl+K'), 'Ctrl+G or Ctrl+K');
  assert.match(plainKeys('Alt+ArrowDown'), /^Alt\+/);
  assert.equal(plainKeys('F1'), 'F1');
});

test('keyTip: "Label · Key", or the label alone for a keyless (NO_KEY) action', () => {
  assert.equal(keyTip('Print', 'Alt+P'), 'Print · Alt+P');
  assert.equal(keyTip('Save', 'ctrl+a'), 'Save · Ctrl+A');
  assert.equal(keyTip('About this report', ''), 'About this report');
  assert.equal(keyTip('Columns…'), 'Columns…');
  assert.equal(keyTip('Go To', null), 'Go To');
  assert.equal(keyTip('Find', '  '), 'Find');
});

test('accelSplit: underline the first letter only when it is the key', () => {
  assert.deepEqual(accelSplit('Yes', 'Y'), ['Y', 'es']);
  assert.deepEqual(accelSplit('No', 'N'), ['N', 'o']);
  assert.deepEqual(accelSplit('yes, delete', 'Y'), ['y', 'es, delete']);
  assert.equal(accelSplit('Delete', 'Y'), null, 'a label that does not start with the key stays as it is');
  assert.equal(accelSplit('Cancel', 'N'), null);
  assert.equal(accelSplit('', 'Y'), null);
  const [a, rest] = accelSplit('Yes, delete', 'Y') ?? ['', ''];
  assert.equal(a + rest, 'Yes, delete', 'the accessible name is unchanged');
});

test('confirmTips: both buttons read "Label · keys"; Y / N only while nothing has to be typed', () => {
  assert.deepEqual(confirmTips('Yes, delete', 'No', false), { confirm: 'Yes, delete · Y or Ctrl+A', cancel: 'No · N or Esc' });
  assert.deepEqual(confirmTips('Delete company', 'Cancel', true), { confirm: 'Delete company · Ctrl+A', cancel: 'Cancel · Esc' });
});
