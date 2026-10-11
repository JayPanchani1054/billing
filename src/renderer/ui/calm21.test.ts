/**
 * The 2.1 visual contract of the generic components (SPEC-21 §2.1–§2.3, WP-A), checked from the
 * stylesheets and the component sources — React is not available to node:test, so the rules the eye
 * relies on are pinned where they are written: keys hidden at rest but revealed on focus and Ctrl-peek
 * (aria-keyshortcuts kept), flat surfaces, the focus-only row bar, no whole-table frame, no upper-case
 * captions, quiet hints, inline bars that fold with the graphs and never print, and the token values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const components = read('../styles/components.css');
const tokens = read('../styles/tokens.css');

interface Rule {
  selectors: string[];
  body: string;
  media: string | null;
}

/** Split a selector list at top-level commas (not inside :not(…, …) or :is(…)). */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, ' '));
}

/** Rules of a stylesheet (one level of @media nesting), comments removed, selectors normalised. */
function rulesOf(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude);
      else if (!prelude.startsWith('@')) out.push({ selectors: splitSelectors(prelude), body, media });
      i = j;
    }
  };
  walk(clean, null);
  return out;
}

const rules = rulesOf(components);
const find = (selector: string, media: string | null = null) => rules.filter((r) => r.media === media && r.selectors.includes(selector));
const decl = (selector: string, prop: string, media: string | null = null): string[] =>
  find(selector, media).flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim()));

test('the rule reader sees selectors, bodies and @media blocks', () => {
  const r = rulesOf('/* x */ .a, .b:hover { color: red; } @media print { .c { display: none; } } .d:not(.e, .f) { color: blue; }');
  assert.deepEqual(r.map((x) => [x.selectors, x.media]), [
    [['.a', '.b:hover'], null],
    [['.c'], '@media print'],
    [['.d:not(.e, .f)'], null],
  ]);
});

test('buttons: the key is hidden at rest, revealed on :focus-visible and while Ctrl is held; aria-keyshortcuts kept', () => {
  assert.deepEqual(decl('.bx-btn__kbd', 'display'), ['none']);
  assert.deepEqual(decl('.bx-btn:focus-visible > .bx-btn__kbd', 'display'), ['inline']);
  assert.deepEqual(decl('html[data-keys] .bx-btn__kbd', 'display'), ['inline']);
  const button = read('./Button.tsx');
  assert.match(button, /aria-keyshortcuts=\{ariaShortcut\(shortcut\)\}/);
  assert.match(button, /<Kbd keys=\{shortcut\} tone="subtle" className="bx-btn__kbd" aria-hidden="true" \/>/);
  assert.match(button, /keyTip\(children, shortcut\)/, 'the default tooltip names the key');
});

test('keys outside F1 are plain text: Kbd tone="subtle" renders one run, the boxed chip stays for F1', () => {
  const kbd = read('./Kbd.tsx');
  assert.match(kbd, /if \(tone === 'subtle'\)[\s\S]*?className=\{cx\('bx-kbd--plain'/);
  for (const prop of ['border', 'background']) assert.deepEqual(decl('.bx-kbd--plain', prop), [], `.bx-kbd--plain has no ${prop}`);
  assert.ok(find('.bx-kbd').length > 0, 'the boxed chip remains for the F1 card');
  assert.match(read('./Menu.tsx'), /<Kbd keys=\{entry\.shortcut\} tone="subtle"/);
});

test('tables: flat, content-sized, no whole-table frame; the cursor bar only while the grid has focus', () => {
  assert.ok(!rules.some((r) => r.selectors.some((s) => s.startsWith('.bx-table:has('))), 'the focus frame around whole tables is gone');
  for (const prop of ['border', 'background', 'border-radius', 'height']) assert.deepEqual(decl('.bx-table', prop), [], `.bx-table sets no ${prop}`);
  assert.deepEqual(decl('.bx-table', 'max-height'), ['100%']);
  assert.deepEqual(decl('.bx-tbody .bx-tr.is-active > .bx-td', 'background'), ['var(--row-selected)'], 'the active row keeps its fill always');
  assert.deepEqual(decl('.bx-table__grid:focus-within .bx-tr.is-active > .bx-td:first-child', 'box-shadow'), ['inset 2px 0 0 var(--row-selected-indicator)']);
  assert.ok(!rules.some((r) => r.selectors.includes('.bx-tbody .bx-tr.is-active > .bx-td:first-child')), 'no always-on bar');
  // WCAG 2.4.7: Tab into an empty or loading table (no cursor row) must still show where focus is.
  assert.deepEqual(decl('.bx-table__grid:focus-visible:not(:has(.bx-tr.is-active)) .bx-th:first-child', 'box-shadow'), ['inset 2px 0 0 var(--row-selected-indicator)']);
  assert.deepEqual(decl('.bx-table__grid:focus-visible', 'outline'), ['none'], 'the grid draws no frame of its own');
  assert.ok(!/--row-zebra|--row-group|var\(--dr\)|var\(--cr\)/.test(components), 'no zebra/group tints, Dr/Cr in muted text');
  assert.deepEqual(decl('.bx-drcr', 'color'), ['var(--text-muted)']);
  assert.deepEqual(decl('.bx-th', 'background'), ['var(--surface-1)'], 'header: the canvas colour (sticky, so opaque)');
  assert.deepEqual(decl('.bx-th__sort-icon', 'visibility'), ['hidden'], 'sort glyph only when sorted or on hover/focus');
});

test('inline bars: slot 1 / slot 2 for negatives, folded with the graphs, never printed', () => {
  assert.deepEqual(decl('.bx-td__bar', 'background'), ['var(--chart-1)']);
  assert.deepEqual(decl('.bx-td__bar--neg', 'background'), ['var(--chart-2)']);
  assert.deepEqual(decl('[data-graphs="off"] .bx-td__bar', 'display'), ['none']);
  assert.ok(find('.bx-td__bar', '@media print').some((r) => /display:\s*none/.test(r.body)), 'hidden in print');
  const table = read('./DataTable.tsx');
  assert.match(table, /className=\{cx\('bx-td__bar'[\s\S]*?aria-hidden="true"/);
  assert.match(table, /barWidths\(/);
});

test('flat surfaces: cards, panels and banners draw no border; no icon discs', () => {
  for (const sel of ['.bx-card', '.bx-panel', '.bx-banner']) {
    assert.deepEqual(decl(sel, 'border'), [], `${sel} has no border`);
  }
  for (const sel of ['.bx-card', '.bx-panel']) assert.deepEqual(decl(sel, 'background'), [], `${sel} has no fill`);
  for (const gone of ['.bx-empty__icon', '.bx-confirm__icon', '.bx-banner__icon', '.bx-card--elevated', '.bx-tabs--pill .bx-tab']) {
    assert.ok(!rules.some((r) => r.selectors.includes(gone)), `${gone} is gone`);
  }
  assert.doesNotMatch(read('./EmptyState.tsx'), /<Icon[\s/]/);
  assert.doesNotMatch(read('./Banner.tsx'), /<Icon[\s/]/);
  assert.deepEqual(decl('.bx-empty', 'align-items'), ['flex-start'], 'empty states are left-aligned');
});

test('captions are sentence case: no upper-case text in the generic components (only typed codes: GSTIN, PAN)', () => {
  const upper = rules.filter((r) => /text-transform:\s*uppercase/.test(r.body)).flatMap((r) => r.selectors);
  assert.deepEqual(upper, ['.bx-input__field--upper:not(:placeholder-shown)']);
  assert.doesNotMatch(components, /--tracking-caps/);
});

test('text tabs: segmented controls and tabs have no pill or track; the selection is 600 + a brand underline', () => {
  for (const prop of ['background', 'padding', 'border-radius']) assert.deepEqual(decl('.bx-segmented', prop), [], `.bx-segmented has no ${prop}`);
  const sel = rules.find((r) => r.media === null && r.selectors.includes('.bx-segmented__item.is-selected') && r.selectors.includes('.bx-tab.is-selected'));
  assert.ok(sel, 'one selected look for both');
  assert.match(sel.body, /font-weight:\s*var\(--fw-semibold\)/);
  assert.match(sel.body, /box-shadow:\s*inset 0 -2px var\(--brand\)/);
});

test('field hints show on focus; errors and status feedback always; never unmounted', () => {
  const sel = '.bx-field:has(input, select, textarea, button):not(:focus-within) > .bx-field__message:not(.bx-field__message--error, .bx-field__message--applies, :has(.bx-icon))';
  assert.deepEqual(decl(sel, 'visibility'), ['hidden']);
  // Its line stays reserved: collapsing it on blur moved everything below between mouse down and mouse up,
  // so a click on the control under a focused field (the numbering code chips) landed on nothing.
  const collapsed = sel.replace('.bx-field:has(', '.bx-field--stack:has(');
  assert.deepEqual(decl(collapsed, 'position'), [], 'a hidden hint keeps its height (no collapse on blur)');
  assert.deepEqual(decl(collapsed, 'height'), []);
  const field = read('./Field.tsx');
  assert.match(field, /<p className=\{cx\('bx-field__message', hintApplies && 'bx-field__message--applies'\)\} id=\{hintId\}>/, 'the hint stays in the DOM for aria-describedby');
  assert.match(field, /hintApplies = false,/, 'a hint that applies (a locked or future date) opts out of hiding');
});

test('pickers, menus and dialogs: no key footer by default, keepOpen menus, ✓ only for checkable items, Y̲/N̲', () => {
  assert.match(read('./Combobox.tsx'), /showHints = false,/);
  // A value changed from outside (Alt+C create, the form reset after a save) drops the typed draft.
  assert.match(read('./Combobox.tsx'), /if \(lastValueKey\.current === valueKey\) return;\n\s*lastValueKey\.current = valueKey;\n\s*if \(queryRef\.current !== null\) setQuery\(null\);/);
  const menu = read('./Menu.tsx');
  assert.match(menu, /if \(!item\.keepOpen\) onClose\?\.\(\);/);
  assert.doesNotMatch(menu, /entry\.icon \?/, 'no left icons');
  assert.match(menu, /\{checkable \? \(/);
  const confirm = read('./ConfirmDialog.tsx');
  assert.match(confirm, /accelLabel\(confirmLabel, 'Y', !!confirmText\)/, 'no underline while Y/N are typed letters');
  assert.match(confirm, /accelLabel\(cancelLabel, 'N', !!confirmText\)/);
  assert.match(confirm, /title=\{tips\.cancel\}/, 'the cancel tooltip names its button too');
  assert.match(confirm, /useHotkeys\(\s*confirmHotkeys\(/, 'keys unchanged');
  assert.deepEqual(decl('.bx-modal__title', 'font-size'), ['var(--text-title)']);
});

test('2.1 token values (§2.1): five sizes, two weights, radii 4/8, one flat canvas', () => {
  const v = (name: string) => new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(tokens)?.[1].trim();
  assert.equal(v('--fs-18'), '18px');
  assert.equal(v('--text-title'), 'var(--fs-18)');
  assert.equal(v('--text-subtitle'), 'var(--fs-14)');
  assert.equal(v('--text-body'), 'var(--fs-14)', 'inputs, pickers and the voucher grid stay 14');
  assert.equal(v('--fw-medium'), '400');
  assert.equal(v('--fw-bold'), '600');
  assert.equal(v('--radius-md'), '4px');
  assert.equal(v('--radius-xl'), '8px');
});

test('DataTable keeps `columns` stable: hidden and blank columns are memoised by their key lists', () => {
  const table = read('./DataTable.tsx');
  assert.match(table, /const hiddenKey = hiddenColumns && hiddenColumns\.length > 0 \? hiddenColumns\.join\(/);
  assert.match(table, /\}, \[allColumns, hiddenKey\]\);/, 'a fresh hiddenColumns array with the same keys does not re-render every row');
  assert.match(table, /\}, \[shownColumns, blankKey\]\);/, 'new rows that hide the same columns keep the columns identity');
});

test('FiltersPopover: the count is in the name, Clear filters closes and gives focus back to the button', () => {
  const src = read('./FiltersPopover.tsx');
  assert.match(src, /aria-label=\{label\.name\}/);
  assert.match(src, /onClear\(\);\s*setOpen\(false\);\s*anchorRef\.current\?\.focus\(\);/);
});
