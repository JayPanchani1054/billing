/**
 * (2.0, V6 review) Keyboard and screen-reader rules of the print layout editor (Alt+L on Print Preview), read
 * from the React sources:
 *
 *   - the preview pane keeps its place in the tree when the panel opens or closes. Rendered in two
 *     different parents, React remounts it on every Alt+L: the focus `toggleEditing` gives back to the
 *     preview lands on the removed element and keyboard users are dropped on <body>;
 *   - a part that always prints says so to a screen reader (the lock is not decoration only).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const printDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel: string): string =>
  fs
    .readFileSync(path.resolve(printDir, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('Print Preview: the preview is rendered in one place, so Alt+L never remounts it (focus returns to it)', () => {
  const src = code('PrintVoucherScreen.tsx');
  assert.match(src, /const preview = doc \? \(\s*<PreviewPane/, 'the preview element');
  assert.equal(src.split('{preview}').length - 1, 1, '{preview} is placed once');
  assert.doesNotMatch(src, /:\s*\(\s*preview\s*\)/, 'no second branch rendering the preview elsewhere');
  // Closing the panel hands the focus to the preview before it goes.
  assert.match(src, /const toggleEditing = \(\): void => \{\s*if \(editing\) paneRef\.current\?\.focus\(\);/);
});

test('Customize what prints: a locked part has a lock with an accessible name', () => {
  const src = code('LayoutEditor.tsx');
  const locked = /\{row\.locked \? \(([\s\S]*?)\) : \(/.exec(src);
  assert.ok(locked, 'the locked-row branch');
  assert.match(locked[1], /<Icon name="lock"[^>]*\blabel="[^"]+"/);
});
