/**
 * 2.1 Home menu, Go To, F1 and the user menu (SPEC-21 WP-B3, §1.3, §1.12, D9, D32, D34) — read from
 * source, as screenFiles.test.ts does (these files import React, which node cannot load here). The
 * behaviour behind them is tested in lib/essentials.test.ts, lib/shortcuts.test.ts and
 * lib/userMenu.test.ts; e2e/home.spec.ts and e2e/calm.spec.ts check them in the built app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
const gateway = read('./Gateway.tsx');
const goto = read('./GotoPalette.tsx');
const f1 = read('./ShortcutsOverlay.tsx');
const userMenu = read('./UserMenu.tsx');
const css = read('../styles/gateway.css');

/** Declarations of every rule whose selector list contains `selector` exactly, in order (later ones win). */
function rule(selector: string): string {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some((s) => s.trim() === selector)) out.push(m[2]);
  }
  assert.ok(out.length > 0, `no rule for ${selector} in gateway.css`);
  return out.join('\n');
}

test('Home menu: one line per item, keys as plain text, the description only as tooltip + aria-describedby', () => {
  assert.doesNotMatch(gateway, /\bKbd\b/, 'no key chips on Home (D4)');
  assert.doesNotMatch(gateway, /bx-gateway__desc|--detailed/, 'no description line under an item');
  assert.match(gateway, /data-text-value=\{item\.label\}/, 'items keep data-text-value (home.spec, first-day.spec)');
  assert.match(gateway, /aria-describedby=\{item\.description \? descId : undefined\}/);
  assert.match(gateway, /<span id=\{descId\} hidden>/, 'the description stays in the accessibility tree via aria-describedby');
  assert.match(gateway, /aria-label="Gateway menu"/);
  assert.match(gateway, /<h1 className="bx-gateway__title">Home<\/h1>/, 'the quiet visible h1 "Home" stays');
  assert.doesNotMatch(gateway, /PageHeader|data-actions-slot/, 'Home renders no title row and no actions slot (D2)');
  // Ctrl+1 / Ctrl+2 and the letters stay registered.
  assert.match(gateway, /'Ctrl\+1': \(\) => setView\('essentials'\)/);
  assert.match(gateway, /'Ctrl\+2': \(\) => setView\('all'\)/);
  assert.match(gateway, /if \(it\.accelerator\) map\[it\.accelerator\] = \(\) => open\(it\)/);
});

test('Home view switch: two text radios "Essentials · All", names "Essentials" and "All menus"', () => {
  assert.match(gateway, /role="radiogroup" aria-label="Home view"/);
  assert.match(gateway, /\{ value: 'essentials', text: 'Essentials', name: 'Essentials', key: 'Ctrl\+1' \}/);
  assert.match(gateway, /\{ value: 'all', text: 'All', name: 'All menus', key: 'Ctrl\+2' \}/);
  assert.match(gateway, /role="radio"\s+aria-checked=\{selected\}\s+aria-label=\{v\.text === v\.name \? undefined : v\.name\}/);
  assert.match(rule('.bx-gateway__views > * + *::before'), /content: '·'/);
  // The Ctrl+1 / Ctrl+2 tooltip opens leftwards inside the column. components.css places a tooltip with
  // `.bx-tooltip-anchor[data-placement="bottom"] > .bx-tooltip` (0,3,0): the override must be more specific,
  // or "All menus · Ctrl+2" is centred on "All" and cut off by the column's edge.
  const leftwards = rule('.bx-gateway__views .bx-tooltip-anchor[data-placement] > .bx-tooltip');
  assert.match(leftwards, /right: 0/);
  assert.match(leftwards, /transform: none/);
});

test('Home description tooltip: on hover and keyboard moves only, follows the scrolling column, keeps its text while fading', () => {
  // Focus Home gives by itself (open, Esc back, Ctrl+1 / Ctrl+2) comes from no element: no tooltip (lib/homeTip.ts).
  assert.match(gateway, /tipOnFocus\(lastInput\.current, from instanceof Element && from !== document\.body\)/);
  assert.match(gateway, /onScroll=\{onMenuScroll\}/, 'scrolling with ↑/↓ moves the tip with its item instead of dropping it');
  assert.match(gateway, /data-open=\{tip\.open \? '' : undefined\}/);
  assert.match(gateway, /\{tip\.text\}/, 'the text stays while the tip fades out');
  assert.match(gateway, /onMouseLeave: hideTipSoon/, 'moving to the next item does not fade the tip out and in');
  assert.match(gateway, /if \(e\.key === 'Escape'\) hideTip\(\)/, 'Esc dismisses it (WCAG 1.4.13)');
});

test('the menu column fits a 1366 × 690 window: 280 px wide, 20 Essentials in 36 + 5 × 24 + 20 × 24 px', () => {
  assert.match(rule(':root'), /--gateway-menu-w: 280px/);
  assert.match(rule("[data-density='compact']"), /--gateway-menu-w: 256px/);
  assert.match(rule('.bx-gateway__head'), /min-height: 36px/);
  assert.match(rule('.bx-gateway__item'), /height: 24px/);
  // A group caption: 4 px above + a 20 px line.
  assert.match(rule('.bx-gateway__section-title'), /padding: var\(--space-1\) var\(--space-2\) 0/);
  assert.match(rule('.bx-gateway__section-title'), /line-height: 20px/);
  assert.ok(36 + 5 * 24 + 20 * 24 <= 650, 'the budget of SPEC-21 §1.3');
  // Never a sideways scrollbar in the column; the description tooltip lives outside it.
  assert.match(rule('.bx-gateway__menu'), /overflow: hidden auto/);
  assert.match(rule('.bx-gateway'), /position: relative/);
  assert.match(gateway, /className="bx-tooltip bx-gateway__tip"/);
});

test('captions are sentence case: no uppercase or letter-spaced captions in gateway.css', () => {
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
  assert.doesNotMatch(css, /--tracking-caps/);
  assert.match(rule('.bx-gateway__accel'), /text-decoration: underline/);
  assert.doesNotMatch(rule('.bx-gateway__accel'), /font-weight/, 'the letter is underlined, not bold');
});

test('Go To: the input is the header (name unchanged, placeholder "Go To"), one-line results, no footer', () => {
  assert.match(goto, /aria-label="Search screens, reports, masters and vouchers"/, 'e2e/flows.ts openGoto() reads this name');
  assert.match(goto, /placeholder="Go To"/);
  assert.match(goto, /title="Go To"/, 'the dialog keeps its accessible name');
  assert.match(rule('.bx-goto .bx-modal__header'), /display: none/);
  assert.doesNotMatch(goto, /footerStart|\bKbd\b/, 'no key legend, no key chips');
  assert.match(goto, /role="option"/);
  assert.match(goto, /data-goto-id=\{item\.id\}/);
  assert.match(goto, /\{active && item\.description \? <span className="bx-goto__note">\{` \$\{item\.description\}`\}<\/span>/, 'the description only on the active row, after a space (its accessible name reads "Day Book All vouchers…")');
  // The F10 voucher picker shares these styles and shows its keys the same way.
  const picker = read('./VoucherPicker.tsx');
  assert.doesNotMatch(picker, /\bKbd\b/, 'no key chips in the F10 picker either');
  assert.match(picker, /<span className="bx-goto__key">\{t\.hotkey\}<\/span>/);
  // D34: the label is one block line (2.0 split "Led" / "gers" into lines).
  assert.match(rule('.bx-goto__label'), /display: block/);
  assert.match(rule('.bx-goto__label'), /white-space: nowrap/);
  assert.doesNotMatch(rule('.bx-goto__label'), /flex-direction/);
});

test('F1: "Keyboard shortcuts", no description line, boxed keys only here, "This screen" from the hint', () => {
  assert.match(f1, /title="Keyboard shortcuts"/);
  assert.doesNotMatch(f1, /description=/);
  assert.match(f1, /placeholder="Find a key"/);
  assert.match(f1, /aria-label="Search shortcuts"/);
  assert.match(f1, /useTopScreenHint\(\)/);
  assert.match(f1, /className="bx-shortcuts__hint"/);
  assert.doesNotMatch(f1, /bx-shortcuts__desc/);
  assert.match(css, /^\.bx-shortcuts-overlay \{/m, 'e2e/calm.spec.ts exempts the F1 overlay by this class');
  assert.match(f1, /<div className="bx-shortcuts-overlay">/);
});

test('user menu: built by lib/userMenu.ts (≤ 9 rows), the Appearance dialog has no description line', () => {
  assert.match(userMenu, /buildUserMenu\(/);
  assert.doesNotMatch(userMenu, /setPreferences|theme-|density-|home-essentials/);
  assert.match(userMenu, /title="Appearance" size="sm"/);
  assert.match(userMenu, /aria-label="User menu"/);
});
