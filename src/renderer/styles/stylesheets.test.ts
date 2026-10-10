/**
 * 2.1 stylesheet split (SPEC-21 §2.4, WP-0b): each global stylesheet holds the classes its owner renders,
 * so the 2.1 lanes never edit the same file. The rules were moved unchanged; these checks keep the moved
 * families from drifting back, pin the import order (the cascade order of the moved rules) and the two
 * deliberate visible changes: the report company eyebrow is gone, and `--chart-other` is set per theme.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractBlock, parseDeclarations } from '../ui/lib/contrast.ts';

/** Class names a stylesheet's selectors define (comments and strings ignored) — as cssUsage.test.ts reads them. */
function definedClasses(css: string): Set<string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '').replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
  const names = new Set<string>();
  for (const m of clean.matchAll(/([^{}]+)\{/g)) {
    if (m[1].trim().startsWith('@')) continue;
    for (const c of m[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(c[1]);
  }
  return names;
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
const classes = (rel: string): string[] => [...definedClasses(read(rel))];

test('styles/index.css imports tokens, base, components, charts, shell, report, gateway — in that order', () => {
  const imports = [...read('./index.css').matchAll(/^@import "\.\/([\w-]+)\.css";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['tokens', 'base', 'components', 'charts', 'shell', 'report', 'gateway']);
});

test('the renderer entry loads the global styles once, through styles/index.css', () => {
  const entry = read('../main.tsx');
  assert.deepEqual([...entry.matchAll(/^import '(\.\/styles\/[^']+)';$/gm)].map((m) => m[1]), ['./styles/index.css']);
});

test('moved families stay out of the files they left', () => {
  const left: Array<[string, RegExp]> = [
    ['./components.css', /^bx-(page-header|report|chart|sparkline|kpi)(\b|_|-)/],
    ['./shell.css', /^bx-(report|gateway|goto|shortcuts|export-choices?|appearance)(\b|_|-)/],
  ];
  for (const [file, family] of left) assert.deepEqual(classes(file).filter((c) => family.test(c)), [], file);
  assert.ok(classes('./charts.css').includes('bx-kpi') && classes('./charts.css').includes('bx-chart'), 'charts.css holds the chart and KPI rules');
  assert.ok(classes('./shell.css').includes('bx-page-header'), 'shell.css holds the page header');
  assert.ok(classes('./report.css').includes('bx-report'), 'report.css holds the report frame');
  // ReportScreen's Export dialog and AppearancePanel have the report template's owner (WP-B2), so their rules sit in report.css.
  assert.ok(classes('./report.css').includes('bx-export-choice') && classes('./report.css').includes('bx-appearance__row'), 'report.css holds the Export and Appearance dialogs');
  assert.ok(classes('./gateway.css').includes('bx-gateway') && classes('./gateway.css').includes('bx-goto__input'), 'gateway.css holds Home and Go To');
});

test('--gateway-menu-w lives in gateway.css only', () => {
  const decl = /--gateway-menu-w\s*:/;
  assert.match(read('./gateway.css'), decl);
  for (const file of ['./tokens.css', './components.css', './charts.css', './shell.css', './report.css']) assert.doesNotMatch(read(file), decl, file);
});

test('the vouchers and GST stylesheets are split by screen, each class in one file', () => {
  const pairs: Array<[string, string]> = [
    ['../modules/vouchers/vouchers-entry.css', '../modules/vouchers/vouchers-view.css'],
    ['../modules/gst/gst-returns.css', '../modules/gst/gst.css'],
  ];
  for (const [a, b] of pairs) {
    const inA = new Set(classes(a));
    assert.deepEqual(classes(b).filter((c) => c.startsWith('bx-') && inA.has(c)), [], `${a} / ${b}`);
  }
  assert.ok(classes('../modules/vouchers/vouchers-entry.css').includes('bx-vch-grid'));
  assert.ok(classes('../modules/vouchers/vouchers-view.css').includes('bx-vch-view__head'));
  assert.ok(classes('../modules/gst/gst-returns.css').includes('bx-gst-tile'));
  assert.ok(classes('../modules/gst/gst.css').includes('bx-gst-issue'));
  const vouchers = read('../modules/vouchers/index.ts');
  assert.match(vouchers, /^import '\.\/vouchers-entry\.css';\nimport '\.\/vouchers-view\.css';$/m);
  assert.match(read('../modules/gst/index.ts'), /^import '\.\/gst-returns\.css';\nimport '\.\/gst\.css';$/m);
});

test('the report company eyebrow is gone: no rule styles it and ReportFrame does not render companyName', () => {
  for (const file of ['./components.css', './report.css']) assert.ok(!classes(file).includes('bx-report__company'), file);
  const frame = read('../ui/ReportFrame.tsx');
  assert.doesNotMatch(frame, /bx-report__company/);
  assert.doesNotMatch(frame, /\{companyName\}/, 'print and export take the company from TableExportDef');
  assert.match(frame, /companyName\?: ReactNode;/, 'the prop is still accepted');
});

test('--chart-other is set per theme: light #808897 (slate-450), dark #6e7686', () => {
  const tokens = read('./tokens.css');
  const palette = parseDeclarations(extractBlock(tokens, ':root') ?? '');
  const light = parseDeclarations(extractBlock(tokens, '[data-theme="light"]') ?? '');
  const dark = parseDeclarations(extractBlock(tokens, '[data-theme="dark"]') ?? '');
  assert.equal(palette.get('--slate-450'), '#808897');
  assert.equal(palette.has('--chart-other'), false, 'not in the theme-independent block');
  assert.equal(light.get('--chart-other'), 'var(--slate-450)');
  assert.equal(dark.get('--chart-other'), '#6e7686');
});
