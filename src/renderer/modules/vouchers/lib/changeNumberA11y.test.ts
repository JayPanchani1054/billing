/**
 * (2.0, V6 review) The live check of Change number (Ctrl+R) is heard by screen-reader users whatever its
 * verdict. The verdict used to sit in a status region inside the field's hint, which goes away when the
 * verdict is a problem ("INV/26-27/0005 is already used in FY 2026-27"): "Checking…" was announced, the
 * refusal never was. The dialog imports React, so its source is read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChangeNumberDialog.tsx');
const src = fs
  .readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('one always-present status region announces every verdict of the number check', () => {
  const regions = [...src.matchAll(/<(\w+)[^>]*role="status"[^>]*>([^<]*)</g)];
  assert.equal(regions.length, 1, 'exactly one status region');
  assert.match(regions[0][2], /\{message\.text\}/, 'it reads the verdict, problems included');
  const at = regions[0].index ?? 0;
  // Not inside a JSX expression that depends on the verdict's tone (it would be unmounted for problems).
  const before = src.slice(Math.max(0, at - 160), at);
  assert.doesNotMatch(before, /message\.tone[^\n]*\?[^\n]*$/, 'not rendered only for some tones');
  assert.ok(!/hint=\{[^}]*$/.test(before), 'not inside the field hint');
});
