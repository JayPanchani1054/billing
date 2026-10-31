/**
 * ui/TextArea `autoGrow` (2.2): one sizing rule, run after every render AND when the field's width changes. A
 * column that narrows or widens without a render of the field (the voucher's Checks / TDS side panel appears, a
 * dialog tab is shown) wraps the same text to another number of lines; the height fitted for the old width clipped
 * it (or left empty lines). TextArea.tsx is TSX, which the node test runner cannot load, so this reads its source
 * (as comboboxEmptyList.test.ts does). Checked in Chromium with the same code: one fit per field at mount (the
 * observer's first report is skipped), narrower → taller up to maxRows then scrolling, wider → lower, shown from
 * display: none → fitted, typing → no extra fit, no "ResizeObserver loop" error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./TextArea.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('one sizing function: the layout effect (after every render) and the width observer both call it', () => {
  assert.equal(src.match(/function fitToContent\(/g)?.length, 1);
  assert.equal(src.match(/fitToContent\(el, maxRows\)/g)?.length, 2);
  assert.match(src, /useLayoutEffect\(\(\) => \{\s*const el = innerRef\.current;\s*if \(el && autoGrow\) fittedWidth\.current = fitToContent\(el, maxRows\);\s*\}\);/, 'no dependency list: every render');
  assert.match(src, /el\.style\.overflowY = el\.scrollHeight > max \? 'auto' : 'hidden';\s*return el\.clientWidth;\n\}/, 'the fit records the width it fitted at');
});

test('a ResizeObserver on the textarea refits on a new width only — never on its own height — in the next frame, and is cleaned up', () => {
  const from = src.indexOf('useEffect(() => {');
  const effect = src.slice(from, src.indexOf('}, [autoGrow, maxRows]);', from));
  assert.ok(from > 0 && effect.length > 0, 'the observer effect');
  assert.match(effect, /if \(!el \|\| !autoGrow \|\| typeof ResizeObserver === 'undefined'\) return undefined;/, 'only for autoGrow, and only where ResizeObserver exists');
  assert.match(effect, /const ro = new ResizeObserver\(\(\) => \{\s*if \(el\.clientWidth === fittedWidth\.current\) return;/, 'the same width (its own height change, the first report): nothing');
  assert.match(effect, /cancelAnimationFrame\(frame\);\s*frame = requestAnimationFrame\(\(\) => \{\s*fittedWidth\.current = fitToContent\(el, maxRows\);\s*\}\);/, 'outside the callback: no "loop completed with undelivered notifications"');
  assert.match(effect, /ro\.observe\(el\);/);
  assert.match(effect, /return \(\) => \{\s*ro\.disconnect\(\);\s*cancelAnimationFrame\(frame\);\s*\};/);
  assert.match(src, /import \{ useEffect, useLayoutEffect, useRef \} from 'react';/);
});
