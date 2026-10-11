/**
 * V3 calm audit (SPEC-21 §10, §1.13) — what the 2.1 snapshots of the seeded shop (1366 × 768) showed the
 * owner that the spec does not allow, pinned where it is written. React cannot load under node:test, so
 * the layout rules are read from the stylesheets and the screen sources; the GSTR-3B primary rule is pure.
 *
 *   10-ledgers / 12-stock-items .... the type / group filter wrapped UNDER the search box (two rows where
 *                                    §1.7 draws one): the filters box was as narrow as its content, so a
 *                                    search with a flex basis wider than its own content pushed the filter
 *                                    to a second line.
 *   13-receivables / 24-payables ... the header "Advances & on account" was cut to "Advances & on ac…".
 *   12-stock-items ................. the header "In stock (11-Oct-26)" was cut to "In stock (11-O…".
 *   20-gstr3b ...................... a disabled filled "Save entries" was the loudest thing on the screen
 *                                    (D5: the filled button is the commit that is due — Export JSON when
 *                                    nothing is typed, Save entries while figures are changed).
 *   09-print-editor ................ the "Customize what prints" group toggles were centred in the panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layoutCommandBar } from './lib/commandBar.ts';
import { gstr3bPrimary } from '../modules/gst/lib/gstr3b.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}
/** The numeric `width` of the column declared with `key: '<key>'` in a screen source. */
function columnWidth(src: string, key: string): number {
  const at = src.indexOf(`key: '${key}'`);
  assert.ok(at >= 0, `no column ${key}`);
  // The column's own declaration: from its key to the next column's `key:` (a header may hold `${…}`).
  const next = src.indexOf("key: '", at + 1);
  const m = /\bwidth: (\d+)/.exec(src.slice(at, next < 0 ? undefined : next));
  assert.ok(m, `column ${key} has no width`);
  return Number(m[1]);
}

test('10-ledgers / 12-stock-items: the toolbar-row filters take the row, so the filter sits beside the search', () => {
  const report = read('../styles/report.css');
  assert.match(rule(report, '.bx-report__filters'), /flex: 1 1 auto;/);
  // Stock Items wraps its fields in one box (shared with the Price List form): in the toolbar row that box grows too.
  const items = read('../modules/inventory/ItemList.tsx');
  assert.match(items, /<div className="bx-inv-filters bx-inv-filters--row">/);
  assert.match(rule(read('../modules/inventory/inventory.css'), '.bx-inv-filters--row'), /flex: 1 1 auto;/);
  // The Price List form keeps the plain box (a column Stack: growing there would stretch it down).
  assert.match(read('../modules/inventory/PriceList.tsx'), /<div className="bx-inv-filters" data-enter-ignore="">/);
});

test('13-receivables / 12-stock-items: column headers are not cut at 1366 px (13/600 label + 16 px sort glyph + 24 px padding)', () => {
  // "Advances & on account" measures ≈ 165 px at 13/600; "In stock (30-Sep-26)" ≈ 160 px.
  assert.ok(columnWidth(read('../modules/outstanding/OutstandingReport.tsx'), 'unadjusted') >= 216);
  assert.ok(columnWidth(read('../modules/inventory/ItemList.tsx'), 'stockQty') >= 210);
});

test('20-gstr3b: the filled button is the commit that is due — never a disabled Save entries at rest', () => {
  assert.equal(gstr3bPrimary({ dirty: false, canFile: true }), 'json');
  assert.equal(gstr3bPrimary({ dirty: true, canFile: true }), 'save');
  assert.equal(gstr3bPrimary({ dirty: false, canFile: false }), null, 'no filing permission: nothing to commit, no filled button');
  const src = read('../modules/gst/Gstr3bScreen.tsx');
  assert.match(src, /label: 'Save entries',[\s\S]{0,80}primary: primary === 'save',/);
  assert.match(src, /label: 'Export JSON',[\s\S]{0,80}primary: primary === 'json',/);
  // What the command bar then draws at rest: Export JSON filled and enabled; Save entries (disabled) in More.
  const atRest = [
    { key: 'Ctrl+A', label: 'Save entries', primary: gstr3bPrimary({ dirty: false, canFile: true }) === 'save', disabled: true },
    { key: 'Alt+J', label: 'Export JSON', primary: gstr3bPrimary({ dirty: false, canFile: true }) === 'json', disabled: false },
  ];
  const bar = layoutCommandBar(atRest, [], 3);
  assert.equal(bar.primary?.label, 'Export JSON');
  assert.equal(bar.primary?.disabled, false);
  assert.ok(bar.more.some((a) => a.label === 'Save entries'), 'Save entries (Ctrl+A) stays reachable in More');
});

test('09-print-editor: the group toggles of "Customize what prints" sit at the start of the panel, not centred', () => {
  const editor = read('../modules/print/LayoutEditor.tsx');
  assert.match(editor, /aria-expanded=\{isOpen\} aria-controls=\{bodyId\} style=\{\{ alignSelf: 'flex-start' \}\}/);
});

test('07-voucher-view: the title row reads "Alter · Print · More ▾" (§1.5) — Share (Alt+W) is a panel key in More', () => {
  const panel = read('../modules/print/VoucherSharePanel.tsx');
  assert.match(panel, /key: 'Alt\+W',\n {6}label: 'Share \(e-mail[^']*',[\s\S]{0,200}demoted: true,/);
  const view = [
    { key: 'Alt+A', label: 'Alter', primary: true },
    { key: 'Alt+P', label: 'Print' },
    { key: 'Alt+W', label: 'Share (e-mail)', demoted: true },
    { key: 'Alt+2', label: 'Duplicate' },
  ];
  const bar = layoutCommandBar(view, [], 3);
  assert.equal(bar.primary?.label, 'Alter');
  assert.deepEqual(bar.buttons.map((b) => b.label), ['Print']);
  assert.ok(bar.more.some((a) => a.key === 'Alt+W'), 'Share stays in More with its key');
});
