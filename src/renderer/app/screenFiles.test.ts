/**
 * 2.1 file splits of the screen templates (SPEC-21 WP-0b): `ReportScreen` + the Export dialog live in
 * ReportScreen.tsx, the helpers both templates use in screenParts.tsx, the user menu in UserMenu.tsx,
 * and the graph strip's contract in graphStrip.tsx. Every existing import from Screen.tsx keeps working,
 * and the two templates never import each other's file (no cycle). Read from source: these files import
 * React, which node cannot load here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRAPH_CATALOGUE } from './lib/chartCatalogue.ts';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
const importsOf = (src: string): string[] => [...src.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((m) => m[1]);

test('Screen.tsx re-exports what moved, so every existing import keeps working', () => {
  const screen = read('./Screen.tsx');
  assert.match(screen, /^export \{ ScreenError, ScreenSkeleton \} from '\.\/screenParts\.tsx';$/m);
  assert.match(screen, /^export \{ EXPORT_DENIED_HINT, ExportDialog, ReportScreen \} from '\.\/ReportScreen\.tsx';$/m);
  assert.match(screen, /^export type \{ ReportExportDef, ReportScreenProps \} from '\.\/ReportScreen\.tsx';$/m);
  assert.match(screen, /^export function Screen\(/m);
  assert.match(screen, /^export function ReadOnlyNotice\(/m);
});

test('ReportScreen.tsx and screenParts.tsx never import Screen.tsx (no import cycle)', () => {
  const report = read('./ReportScreen.tsx');
  assert.ok(!importsOf(report).includes('./Screen.tsx'));
  assert.ok(importsOf(report).includes('./screenParts.tsx'), 'the shared helpers come from screenParts.tsx');
  assert.match(report, /^export function ReportScreen\(/m);
  assert.match(report, /^export function ExportDialog\(/m);
  const parts = read('./screenParts.tsx');
  assert.deepEqual(importsOf(parts).filter((p) => /Screen\.tsx$/.test(p)), []);
  assert.match(parts, /^export function ScreenSkeleton\(/m);
  assert.match(parts, /^export function ScreenError\(/m);
  // The detector strings e2e/screens.spec.ts reads stay verbatim.
  assert.match(parts, /title = 'This could not be loaded'/);
  assert.match(parts, /"You don't have access to this"/);
});

test('the user menu has its own file, rendered by the top bar', () => {
  const workspace = read('./Workspace.tsx');
  assert.ok(importsOf(workspace).includes('./UserMenu.tsx'));
  assert.match(workspace, /<UserMenu \/>/);
  assert.doesNotMatch(workspace, /aria-label="User menu"/);
  const menu = read('./UserMenu.tsx');
  assert.match(menu, /^export function UserMenu\(/m);
  assert.match(menu, /aria-label="User menu"/);
  assert.match(menu, /label: 'Show shortcut bar'/, 'e2e/home.spec.ts toggles it from the user menu');
});

test('graphStrip.tsx declares the graph strip contract and holds no Ctrl+J literal', () => {
  const strip = read('./graphStrip.tsx');
  assert.match(strip, /^export interface ReportGraph \{\n {2}title: string;\n {2}takeaway: string;\n {2}inline: boolean;\n {2}render: \(ids: \{ describedBy: string \}\) => ReactNode;\n\}$/m);
  assert.match(strip, /^export function GraphStrip\(p: \{ graph: ReportGraph \| null; kind\?: GraphKind \}\): ReactNode \{$/m);
  assert.match(strip, /^export function useGraphsToggle\(kind: GraphKind\): GraphsToggle \{$/m);
  assert.match(strip, /^export type GraphKind = 'report' \| 'detail';$/m);
  assert.doesNotMatch(strip, /Ctrl\+J/, 'the only Ctrl+J literal lives in app/lib/graphsToggle.ts (SPEC-21 §4.5)');
});

// ── e2e/calm.spec.ts registry lines (SPEC-21 §6.1): lanes delete ids from PENDING_CALM as their screens comply.
// The spec checks them again against the live Go To catalogue in CI; this catches a typo or a stale id in seconds.
const repoFile = (rel: string): string => read(`../../../${rel}`);
const listIn = (src: string, name: string): string[] => {
  const body = new RegExp(`const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(src)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

/** Screen ids registered by the modules (`{ id: 'x.y', title: …, component }`) and the shell's Home. */
function registeredScreenIds(): Set<string> {
  const modulesDir = fileURLToPath(new URL('../modules/', import.meta.url));
  const files = readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${modulesDir}${e.name}/index.ts`))
    .map((e) => `${modulesDir}${e.name}/index.ts`);
  files.push(fileURLToPath(new URL('./shellModule.ts', import.meta.url)));
  const ids = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\bid:\s*ROOT_SCREEN\b/g, "id: 'app.gateway'");
    for (const m of src.matchAll(/\bid:\s*['"]([a-z]\w*(?:\.\w+)+)['"]\s*,\s*title:/g)) ids.add(m[1]);
  }
  return ids;
}

test('e2e/calm.spec.ts: PENDING_CALM and P1 name registered screens only, once each, in order', () => {
  const spec = repoFile('e2e/calm.spec.ts');
  const registered = registeredScreenIds();
  assert.ok(registered.has('app.gateway') && registered.has('reports.profitLoss') && registered.size > 150, `scan found ${registered.size} screens`);
  const pending = listIn(spec, 'PENDING_CALM');
  const p1 = listIn(spec, 'P1');
  assert.ok(p1.length >= 10, 'P1 list read');
  for (const [name, list] of [['PENDING_CALM', pending], ['P1', p1]] as const) {
    assert.deepEqual(list.filter((id) => !registered.has(id)), [], `${name}: ids that are not registered screens`);
    assert.deepEqual(list.filter((id, i) => list.indexOf(id) !== i), [], `${name}: ids listed twice`);
    assert.deepEqual(list, [...list].sort(), `${name}: keep it sorted (lanes delete their own lines)`);
  }
  // P1 = the catalogue's P1 rows (the screens of the 2.0 snapshots and Home).
  assert.deepEqual(p1, [...new Set(GRAPH_CATALOGUE.filter((r) => r.priority === 'P1').map((r) => r.id))].sort());
  assert.match(spec, /^const CHROME_PENDING = (true|false);$/m, 'WP-B1 flips this one line');
});
