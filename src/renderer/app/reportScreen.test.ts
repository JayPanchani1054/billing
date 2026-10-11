/**
 * The 2.1 report template (SPEC-21 D24, §4.5, WP-B2), read from source: ReportScreen.tsx and
 * ui/ReportFrame.tsx import React, which node cannot load here. The behaviour behind each rule is
 * exercised by the e2e sweeps (screens, calm, perf, graphs specs); this pins the template's structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
const screen = read('./ReportScreen.tsx');
const frame = read('../ui/ReportFrame.tsx');
const strip = read('./graphStrip.tsx');
const css = read('../styles/report.css');
/** Source without comments (rules below are about code, not prose). */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('one place per action: Export and Print are screen actions only — no in-page buttons, no key chips', () => {
  assert.doesNotMatch(code(screen), /<Button\b/, 'ReportScreen renders no Export / Print buttons in the page');
  assert.doesNotMatch(code(screen), /<Kbd\b|shortcut=/);
  assert.match(screen, /key: 'Alt\+E', label: 'Export', icon: 'export', onClick: /);
  assert.match(screen, /key: 'Alt\+P', label: 'Print', icon: 'print', onClick: /);
  assert.match(screen, /key: 'Alt\+F2', label: 'Period'/);
  // outputInMore (master lists) sends both to More ▾; their keys stay registered (never `hidden`).
  assert.equal((screen.match(/demoted: outputInMore/g) ?? []).length, 2);
  assert.doesNotMatch(screen, /hidden: outputInMore/);
});

test('the frame: title row through PageHeader, no company name, no spinner, no key chip, body carries data-graphs', () => {
  const c = code(frame);
  assert.match(c, /<PageHeader title=\{title\} subtitle=\{run \?\? undefined\} meta=\{meta\} \/>/);
  assert.doesNotMatch(c, /<h1\b/, 'the h1 comes from PageHeader');
  assert.doesNotMatch(c, /\{companyName\}|<Spinner\b|<Kbd\b|<Icon\b/);
  assert.match(c, /className=\{cx\('bx-report__body', refreshing && 'is-refreshing'\)\} data-graphs=\{graphs\}/);
  // The period token: a quiet button with Alt+F2 when it can be changed, plain text otherwise.
  assert.match(c, /className="bx-report__token" onClick=\{onPeriodClick\} title="Change period · Alt\+F2" aria-keyshortcuts="Alt\+F2"/);
  // The stat sits on the toolbar row, right; the graph strip opens the body, above the table.
  assert.match(c, /<div className="bx-report__stat">/);
  assert.match(c, /\{graph\}\n\s*\{children\}/);
});

test('the graphs toggle is a screen action only while a graph is shown; About this report only with notes', () => {
  assert.match(screen, /const showGraph = content && graph !== null;/);
  assert.match(screen, /\.\.\.\(showGraph && graphs\.action \? \[graphs\.action\] : \[\]\)/);
  assert.match(screen, /graph=\{showGraph \? <GraphStrip graph=\{graph\} kind=\{graphKind\} \/> : null\}/);
  assert.match(screen, /\.\.\.\(about \? \[aboutItem\(\(\) => setAboutOpen\(true\), aboutLabel\)\] : \[\]\)/);
  assert.match(screen, /<Drawer open=\{aboutOpen\}/);
});

test('the strip: header line always, plot only when shown and not inline; no busy state; toggle key from graphsToggle.ts', () => {
  const c = code(strip);
  assert.match(c, /const plot = shown && !graph\.inline \? graph : null;/);
  // One deferral only — the plot's own (ui/lazyChart.tsx): `reportGraph()` is a new object each render.
  assert.doesNotMatch(c, /useDeferredValue/);
  assert.match(c, /aria-keyshortcuts=\{GRAPHS_ARIA_KEY\}/);
  assert.match(c, /title=\{graphsTooltip\(shown, kind\)\}/);
  assert.doesNotMatch(c, /aria-busy|bx-skeleton|Skeleton/);
  assert.match(c, /plot\.render\(\{ describedBy: takeawayId \}\)/);
  // The takeaway keeps its full text as a tooltip when the line ellipsizes.
  assert.match(c, /<span id=\{takeawayId\} className="bx-report__graph-takeaway" title=\{graph\.takeaway\}>/);
});

test('the Export dialog: one line per format, plain letters, no description', () => {
  const dialog = code(screen).slice(code(screen).indexOf('export function ExportDialog('));
  assert.doesNotMatch(dialog.slice(0, dialog.indexOf('</Modal>')), /description=|<Icon\b|<Kbd\b/);
  assert.match(dialog, /className="bx-export-choice__key" aria-hidden="true"/);
  for (const k of ['X', 'C', 'P']) assert.match(screen, new RegExp(`key: '${k}', label: '`));
});

test('report.css: the strip height token per density, the 2.0 period pill gone, graphs never print', () => {
  assert.match(css, /:root \{\n {2}--graph-h: 168px;\n\}/);
  assert.match(css, /\[data-density='compact'\] \{\n {2}--graph-h: 152px;\n\}/);
  assert.doesNotMatch(css, /bx-report__period|bx-report__title|bx-report__header/);
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.bx-report__graph \{\n\s*display: none !important;/);
});

/** The body of the first rule whose selector list is exactly `selector` (comments removed). */
function rule(src: string, selector: string): string {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = clean.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule ${selector}`);
  return clean.slice(at, clean.indexOf('}', at));
}

test('report.css: the stat rule reads the report column (never a toolbar-row container that would trap its popovers); filters wrap', () => {
  // The query container is the report column, whose content box is the toolbar row's width. A
  // size container on the toolbar row itself would wrap its tooltips and filter menus in their own
  // stacking context, under the table's sticky header.
  assert.match(rule(css, '.bx-report__main'), /container-type: inline-size;/);
  assert.equal((css.match(/container-type/g) ?? []).length, 1);
  // The labels hidden below 1200 px are StatLine's own label class (ui/StatLine.tsx renders it).
  const query = css.slice(css.indexOf('@container (width < 1200px)'));
  assert.match(query, /^@container \(width < 1200px\) \{\n {2}\.bx-report__stat \.bx-statline__label \{/);
  assert.match(read('../ui/StatLine.tsx'), /className="bx-statline__label"/);
  // A 2.0 report with many filters wraps them inside the row instead of widening the screen.
  assert.match(rule(css, '.bx-report__filters'), /flex-wrap: wrap;\n {2}min-width: 0;/);
  // The plot box takes the chart's own height (share 72, meter 64 …): no fixed strip height here.
  assert.doesNotMatch(css, /bx-report__graph-plot/);
});

test('report and Screen columns line up: the title row starts at the same inset', () => {
  assert.match(rule(css, '.bx-report__main'), /padding: var\(--space-2\) var\(--space-6\) var\(--space-6\);/);
});

test('Columns…: every ReportScreen hosts the checklist; focus starts on the first column that can be hidden', () => {
  const c = code(screen);
  assert.match(c, /<ColumnsHost \/>/);
  assert.match(c, /export function ColumnsHost\(\): ReactNode \{/);
  assert.match(c, /useEffect\(\(\) => \(isTop \? onColumnsRequest\(setRequest\) : undefined\), \[isTop\]\);/);
  assert.match(c, /const first = choices\.findIndex\(\(c\) => !c\.locked\);/);
  assert.match(c, /data-autofocus=\{i === first \? '' : undefined\}/);
});

test('Appearance: an explained row is a named group described by its hint (the Home view radios included); no visible hint line', () => {
  const panel = code(read('./AppearancePanel.tsx'));
  assert.match(panel, /role: 'group', 'aria-labelledby': `\$\{id\}-l`, 'aria-describedby': `\$\{id\}-d`, title: hint/);
  assert.match(panel, /<span id=\{`\$\{id\}-d`\} className="bx-sr-only">/);
  assert.doesNotMatch(panel, /bx-appearance__hint/);
  assert.match(panel, /label="Show graphs on reports and Home"/);
  assert.match(panel, /label="Show graphs on detail reports"/);
  assert.match(panel, /<Row label="Home view" hint=/);
});

test('folding with Ctrl+J while the graph has focus moves focus to the strip toggle, never to <body>', () => {
  const c = code(strip);
  assert.match(c, /const plotFocus = usePlotFocus\(shown, toggleRef\);/);
  assert.match(c, /<button ref=\{toggleRef\} type="button" className="bx-report__graph-toggle"/);
  assert.match(c, /<div className="bx-report__graph-plot" onFocus=\{plotFocus\.onFocus\} onBlur=\{plotFocus\.onBlur\}>/);
  assert.match(c, /if \(shown \|\| !inPlot\.current\) return;/);
  assert.match(c, /if \(active === null \|\| active === document\.body\) toggleRef\.current\?\.focus\(\);/);
});
