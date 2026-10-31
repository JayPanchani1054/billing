/**
 * DataTable (ui/DataTable.tsx) — the row height of a windowed table, and the tables that must not be windowed.
 * React is not available to node:test, so the component is read from source and its measure → window cycle is
 * driven through the pure windowing math it uses (lib/virtual.ts).
 *
 * measure() takes THE row height of a windowed table from one <tr> of its body. Once the window starts below the
 * first row, the first <tr> of the body is the top spacer, whose height is that of every row above the window:
 * taken as the row height, it put the next window far from the rows on screen (a blank table after a resize
 * while scrolled; End looping in a table as tall as its rows). The test matches the selector measure() uses
 * against the classes the body's rows are rendered with, so renaming a class breaks it here, not on screen.
 *
 * The windowing has one row height, so a table whose rows differ in height (2.2: a line description under the
 * name) and that is as tall as its rows — the voucher view's Items and Accounting entries — is not windowed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeVirtualWindow } from './lib/virtual.ts';
import type { VirtualWindow } from './lib/virtual.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
const table = read('./DataTable.tsx');

/** The selector measure() reads the row height with (a string literal, or the constant it names). */
function measureSelector(src: string): string {
  const body = src.slice(src.indexOf('const measure = useCallback('), src.indexOf('}, [rowHeightProp]);'));
  const arg = /scroller\.querySelector<HTMLElement>\(([^)]+)\)/.exec(body)?.[1].trim();
  assert.ok(arg, 'measure() reads one row of the body');
  const literal = /^'([^']+)'$/.exec(arg);
  if (literal) return literal[1];
  const constant = new RegExp(`const ${arg} = '([^']+)';`).exec(src)?.[1];
  assert.ok(constant, `${arg} is a string constant of DataTable.tsx`);
  return constant;
}

/** `tbody tr.a.b:not(.c):not(.d, .e)` → does a <tr> with these classes match? Anything else fails loudly. */
function rowMatcher(selector: string): (classes: readonly string[]) => boolean {
  const m = /^tbody tr((?:\.[\w-]+)*)((?::not\(\.[\w-]+(?:,\s*\.[\w-]+)*\))*)$/.exec(selector.trim());
  assert.ok(m, `a selector this test cannot read: ${selector}`);
  const need = [...m[1].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  const not = [...m[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  return (classes) => need.every((c) => classes.includes(c)) && !not.some((c) => classes.includes(c));
}

/** Classes of the rows DataTable renders in its body, read from its JSX. */
function bodyRowClasses(src: string): { spacer: string[][]; empty: string[]; skeleton: string[]; row: string[] } {
  const tbody = src.slice(src.indexOf('<tbody className="bx-tbody"'), src.indexOf('</tbody>'));
  const spacer = [...tbody.matchAll(/<tr className="([^"]+)" aria-hidden="true" style=\{\{ height: win\.pad(?:Top|Bottom) \}\}>/g)].map((m) => m[1].split(' '));
  const empty = /<tr className="([^"]+)">\s*<td colSpan=\{columns\.length\} className="bx-td bx-td--empty">/.exec(tbody)?.[1].split(' ');
  const skeleton = /<tr key=\{`sk\$\{i\}`\} className="([^"]+)" aria-hidden="true">/.exec(tbody)?.[1].split(' ');
  // BodyRow: cx('bx-tr', active && 'is-active', group && 'is-group', className) — its constant class.
  const row = /className=\{cx\('([\w-]+)', active && 'is-active'/.exec(src)?.[1];
  assert.equal(spacer.length, 2, 'a spacer above and below the window');
  assert.ok(empty && skeleton && row, 'the empty-state, skeleton and body rows are found');
  assert.match(tbody, /<BodyRow<T>/, 'the body rows are BodyRow');
  return { spacer, empty, skeleton, row: [row] };
}

interface Tr {
  classes: readonly string[];
  height: number;
}

/** The <tr>s of a window: the top spacer, the rows start..end−1, the bottom spacer (as the tbody renders them). */
function renderedRows(win: VirtualWindow, heights: readonly number[], spacer: readonly string[], row: readonly string[]): Tr[] {
  const out: Tr[] = [];
  if (win.padTop > 0) out.push({ classes: spacer, height: win.padTop });
  for (let i = win.start; i < win.end; i++) out.push({ classes: row, height: heights[i] });
  if (win.padBottom > 0) out.push({ classes: spacer, height: win.padBottom });
  return out;
}

/** measure(): the height of the first <tr> the selector matches (32 when none, the component's last fallback). */
const measuredRow = (selector: string, rows: readonly Tr[]): number => {
  const matches = rowMatcher(selector);
  return rows.find((r) => matches(r.classes))?.height ?? 32;
};

const OVERSCAN = 10;

describe('DataTable — the row height of a windowed table', () => {
  const classes = bodyRowClasses(table);
  const selector = measureSelector(table);

  it('measure() reads a body row, never a window spacer or the empty-state row', () => {
    const matches = rowMatcher(selector);
    for (const s of classes.spacer) assert.equal(matches(s), false, `a spacer (${s.join(' ')}) is never the row height`);
    assert.equal(matches(classes.empty), false, 'nor the empty-state row');
    assert.equal(matches(classes.row), true, 'a body row is');
    assert.equal(matches([...classes.row, 'is-active', 'bx-vch-view__row--multiline']), true, 'with its state and caller classes too');
    assert.equal(matches(classes.skeleton), true, 'and so is a loading (skeleton) row, as tall as a row');
    assert.match(table, /const row = rowHeightProp \?\? \(measured > 0 \? measured : varH > 0 \? varH : 32\);/, 'a fixed rowHeight still wins');
  });

  it('a resize while scrolled keeps the window on the rows on screen (it went blank when the top spacer was measured)', () => {
    // A ledger of 10,000 rows of 30 px in a 600 px table, scrolled to row 1,000; then the window grows to 640 px.
    const count = 10_000;
    const heights = Array.from({ length: count }, () => 30);
    const scrollTop = 30_000;
    const before = computeVirtualWindow({ count, rowHeight: 30, scrollTop, viewportHeight: 600, overscan: OVERSCAN });
    assert.ok(before.padTop > 0, 'the window starts below the first row: the top spacer is the first <tr>');
    const rows = renderedRows(before, heights, classes.spacer[0], classes.row);
    const window = (rowHeight: number) => computeVirtualWindow({ count, rowHeight, scrollTop, viewportHeight: 640, overscan: OVERSCAN });

    const row = measuredRow(selector, rows);
    assert.equal(row, 30);
    const after = window(row);
    assert.ok(after.start <= 1000 && after.end >= 1000 + 640 / 30, `rows ${after.start}–${after.end - 1} hold rows 1000–1021 on screen`);

    // The 2.2 regression: the first <tr> of the body — the spacer — was taken as the row height.
    const old = measuredRow('tbody tr.bx-tr', rows);
    assert.equal(old, before.padTop);
    assert.ok(window(old).end < 1000, 'the old measurement rendered the first rows only: blank at the scroll position');
  });

  it('one row height cannot window rows of different heights in a table as tall as its rows: such a table is not windowed', () => {
    // The voucher view (2.2): 250 lines, the first with a description (46.5 px), the rest 26 px; the table grows
    // with its rows (its scroller's height is its content's), so every render re-measures.
    const heights = Array.from({ length: 250 }, (_, i) => (i === 0 ? 46.5 : 26));
    let metrics = { viewport: 0, row: 32 };
    let win = computeVirtualWindow({ count: heights.length, rowHeight: metrics.row, scrollTop: 0, viewportHeight: metrics.viewport, overscan: OVERSCAN });
    for (let pass = 0; pass < 40; pass++) {
      win = computeVirtualWindow({ count: heights.length, rowHeight: metrics.row, scrollTop: 0, viewportHeight: metrics.viewport, overscan: OVERSCAN });
      const rows = renderedRows(win, heights, classes.spacer[0], classes.row);
      metrics = { viewport: Math.round(26 + rows.reduce((s, r) => s + r.height, 0)), row: measuredRow(selector, rows) };
    }
    assert.ok(win.end < heights.length, `windowed, lines ${win.end + 1}–${heights.length} are never rendered`);

    // So the voucher view's two tables of such rows render every row.
    const view = read('../modules/vouchers/VoucherViewScreen.tsx');
    for (const rowType of ['PreviewInventoryLine', 'ViewEntryRow']) {
      const at = view.indexOf(`<DataTable<${rowType}>`);
      assert.ok(at > 0, `the ${rowType} table`);
      const tag = view.slice(at, view.indexOf('/>', at));
      assert.match(tag, /getRowClassName=\{\(r\) => \([^\n]*MULTILINE_ROW/, `${rowType}: some rows have a second line`);
      assert.match(tag, /\n\s*virtualize=\{false\}\n/, `${rowType}: not windowed`);
    }
  });
});
