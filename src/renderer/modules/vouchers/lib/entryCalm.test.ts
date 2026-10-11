/**
 * Voucher entry 2.1 (SPEC-21 §1.4, D13–D20): the screen wiring that the pure builders (strip.ts, gridNav.ts,
 * savedBar.ts, disclosure.ts) cannot prove on their own. The entry screen is TSX (not loadable by the
 * node test runner), so these read its source and stylesheet; the e2e twins are e2e/invoice-flow.spec.ts
 * (Charges & discounts in the Enter chain, the Saved bar) and e2e/calm.spec.ts (one primary, no boxed keys).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');
const screen = read('entry/VoucherEntryScreen.tsx');
const css = read('vouchers-entry.css');

/** The body of `const name = (…) => { … };` / `function name(…) { … }` up to its closing brace at `indent`. */
function bodyOf(src: string, start: RegExp, indent: string): string {
  const m = start.exec(src);
  assert.ok(m, `found ${start}`);
  const from = m.index;
  const end = src.indexOf(`\n${indent}};`, from) >= 0 ? src.indexOf(`\n${indent}};`, from) : src.indexOf(`\n${indent}}`, from);
  assert.ok(end > from, `the end of ${start}`);
  return src.slice(from, end);
}

describe('voucher entry 2.1 wiring', () => {
  it('one Save, no footer, no mode switch row, no badges (D13, D14, D18)', () => {
    assert.doesNotMatch(screen, /\bfooter=/);
    assert.doesNotMatch(screen, /\btoolbar=/);
    assert.doesNotMatch(screen, /SegmentedControl/);
    assert.doesNotMatch(screen, /<Badge\b/);
    assert.equal(screen.match(/primary: true/g)?.length, 1, 'one primary action');
    assert.match(screen, /aria-label=\{`Entry mode: \$\{MODE_LABEL\[form\.mode\]\}`\}/, 'the mode menu button says "Entry mode: …" (label in name)');
  });

  it('what left the title row keeps its key: Ctrl+I, Alt+W and (while the Saved bar shows) Print are demoted, never hidden by it', () => {
    const action = (key: string) => {
      const i = screen.indexOf(`key: '${key}'`);
      assert.ok(i >= 0, key);
      return screen.slice(i, screen.indexOf('}', screen.indexOf('onClick', i)) + 400);
    };
    assert.match(action('Ctrl+I'), /demoted: true/);
    assert.match(action('Alt+W'), /demoted: true/);
    assert.match(action('Alt+P'), /demoted: barShown/);
    assert.doesNotMatch(action('Alt+B'), /prominent: true/);
  });

  it('Enter into Charges & discounts opens the section before the cursor moves; a charge keeps it open (D17)', () => {
    const enter = bodyOf(screen, /const enterSection = \(/, '  ');
    const opens = enter.indexOf('opensBeforeFocus(');
    assert.ok(opens > 0, 'enterSection asks opensBeforeFocus');
    assert.match(enter.slice(opens, enter.indexOf('\n', opens)), /setChargesOpen\(true\)/);
    assert.ok(opens < enter.indexOf('focusId(cellId('), 'it opens before it focuses a grid cell');
    assert.match(screen, /useEffect\(\(\) => \{\s*if \(hasCharge\) setChargesOpen\(true\);\s*\}, \[hasCharge\]\);/, 'removing the last charge does not hide the row under the cursor');
    // The region opens in the next render; focusId keeps trying until the field really has the focus.
    const focus = bodyOf(screen, /export function focusId\(/, '');
    assert.match(focus, /document\.activeElement === el/);
  });

  it('"Saved" is said once: the "… saved" toast only where the screen leaves (no Saved bar) (D20)', () => {
    const save = bodyOf(screen, /const doSave = async \(\) => \{/, '  ');
    assert.equal(save.match(/saved`, \{/g)?.length, 1, 'one "… saved" toast');
    assert.match(
      save,
      /if \(f\.docLinks\) \{\s*(\/\/[^\n]*\s*)*toast\.success\(`\$\{voucherRefLabel\(saved\)\} saved`[\s\S]*?\} else \{\s*(\/\/[^\n]*\s*)*const note = barToast\(/,
      'the "saved" toast sits inside `if (f.docLinks)`; otherwise only the notes (barToast)',
    );
  });

  it('row tools hide the button itself, so a pressed tool (inside its tooltip wrapper) stays visible', () => {
    const rule = /\.bx-vch-row:not\(:hover, :focus-within\) \.bx-vch-rowtools ([^{]+)\{\s*opacity: 0;/.exec(css);
    assert.ok(rule, 'the hover / focus reveal rule');
    assert.equal(rule[1].trim(), 'button:not([aria-pressed="true"])');
  });

  it('the totals strip sits at the bottom of the window on a short form, sticky once it scrolls (D13)', () => {
    assert.match(css, /\.bx-screen-layout__body:has\(> \.bx-vch\) \{\s*display: flex;\s*flex-direction: column;/);
    assert.match(css, /\.bx-vch-strip \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*margin-top: auto;/);
  });
});
