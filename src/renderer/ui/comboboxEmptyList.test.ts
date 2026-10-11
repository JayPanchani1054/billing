/**
 * 2.1: a picker never opens an empty list on focus. An open list with no options, nothing typed and
 * nothing loading only said "No matching …" — over the next fields (the stock group under Unit on a
 * new company covered the GST switch). The popup, `aria-expanded`, `is-open` and Esc all follow the
 * list being shown, so a closed-looking picker never swallows Esc or a click.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./Combobox.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the list is shown only with options, a load in progress or error, or typed text', () => {
  assert.match(src, /const listShown = open && \(options\.length > 0 \|\| loading \|\| loadError !== null \|\| \(query !== null && query\.trim\(\) !== ''\)\);/);
});

test('popup, aria-expanded, is-open and Esc follow the shown list, not the open flag', () => {
  assert.match(src, /\{listShown \? \(\n\s*<Portal>/);
  assert.match(src, /aria-expanded=\{listShown\}/);
  assert.match(src, /aria-controls=\{listShown \? listId : undefined\}/);
  assert.match(src, /listShown && 'is-open'/);
  assert.match(src, /case 'Escape': \{\n\s*if \(listShown\) \{/);
  assert.doesNotMatch(src, /aria-expanded=\{open\}/);
});
