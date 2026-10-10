/**
 * The graph catalogue against the real screens (SPEC-21 §4.8, §5): every catalogued id is a
 * registered screen; every screen file rendering `<ReportScreen` (or `<Screen … graph=`) has its ids
 * in the catalogue; graph ids are wired through `graph={reportGraph(…)}` built from a `lib/charts.ts`
 * builder (no arithmetic in JSX) unless still in PENDING_GRAPH; detail ids pass graphKind="detail";
 * screens with no graph pass none; every 'none' row and every stat exception says why.
 * Source scan: the module screens import React, so they are read as text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GRAPH_CATALOGUE, GRAPHS_STRICT, PENDING_GRAPH, STAT_TOTAL_ALLOWED, catalogueRows, graphClassOf, graphRows, statTotalAllowed } from './chartCatalogue.ts';

const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modulesDir = path.join(rendererDir, 'modules');
const rel = (p: string) => path.relative(rendererDir, p).split(path.sep).join('/');

const textCache = new Map<string, string>();
function read(file: string): string {
  let t = textCache.get(file);
  if (t === undefined) {
    t = fs.readFileSync(file, 'utf8');
    textCache.set(file, t);
  }
  return t;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Comments removed (keeps line structure irrelevant: we only match code). */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Relative imports of a file (static, re-exports and dynamic), resolved to absolute paths. */
function relativeImports(file: string): string[] {
  const out: string[] = [];
  for (const m of code(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const p = path.resolve(path.dirname(file), m[1]);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

interface Registered {
  id: string;
  module: string;
  component: string;
  file: string | null;
}

/** Per registry file: how many `component:` entries it has vs how many screens the id scan found. */
const registryCounts: Array<{ file: string; components: number; ids: number }> = [];

/** Component identifier → defining file, from a module index (lazyScreen(import()) or a named import). */
function componentFiles(indexFile: string): Map<string, string> {
  const map = new Map<string, string>();
  const src = code(indexFile);
  const dir = path.dirname(indexFile);
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*lazyScreen\(\s*\(\)\s*=>\s*import\(['"](\.[^'"]+)['"]\)/g)) map.set(m[1], path.resolve(dir, m[2]));
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    for (const spec of m[1].split(',')) {
      const parts = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0]).trim();
      if (local) map.set(local, path.resolve(dir, m[2]));
    }
  }
  return map;
}

function registeredScreens(): Registered[] {
  const out: Registered[] = [];
  const sources: Array<{ module: string; file: string }> = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(modulesDir, e.name, 'index.ts')))
    .map((e) => ({ module: e.name, file: path.join(modulesDir, e.name, 'index.ts') }));
  sources.push({ module: 'app', file: path.join(rendererDir, 'app', 'shellModule.ts') });
  const rootId = /ROOT_SCREEN\s*=\s*'([^']+)'/.exec(read(path.join(rendererDir, 'app', 'lib', 'navStack.ts')))?.[1];
  for (const s of sources) {
    const src = code(s.file).replace(/\bid:\s*ROOT_SCREEN\b/g, `id: '${rootId}'`);
    const files = componentFiles(s.file);
    const starts = [...src.matchAll(/\bid:\s*['"]([a-z]\w*(?:\.\w+)+)['"]\s*,\s*title:/g)];
    registryCounts.push({ file: rel(s.file), components: [...src.matchAll(/\bcomponent:\s*\w+/g)].length, ids: starts.length });
    starts.forEach((m, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
      const body = src.slice(m.index, end);
      const component = /\bcomponent:\s*(\w+)/.exec(body)?.[1] ?? '';
      out.push({ id: m[1], module: s.module, component, file: files.get(component) ?? null });
    });
  }
  return out;
}

const screens = registeredScreens();
const registeredIds = new Set(screens.map((s) => s.id));

/** A screen's component file plus every file it reaches by relative import inside the same module. */
function closure(s: Registered): string[] {
  if (!s.file) return [];
  const root = s.module === 'app' ? path.join(rendererDir, 'app') : path.join(modulesDir, s.module);
  const seen = new Set<string>();
  const stack = [s.file];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f) || !f.startsWith(root + path.sep) || path.basename(f) === 'index.ts' || !fs.existsSync(f)) continue;
    seen.add(f);
    stack.push(...relativeImports(f));
  }
  return [...seen];
}

const closures = new Map(screens.map((s) => [s.id, closure(s)]));

const rendersReport = (f: string) => /<ReportScreen[\s>]/.test(code(f));
const rendersScreenWithGraph = (f: string) => /<Screen[\s>]/.test(code(f)) && /\bgraph=\{/.test(code(f));
const reportFiles = walk(modulesDir).filter((f) => rendersReport(f) || rendersScreenWithGraph(f));

/** Registered ids whose component reaches `file`. */
function idsOf(file: string): string[] {
  return screens.filter((s) => closures.get(s.id)?.includes(file)).map((s) => s.id);
}

/** The `{…}` expression of every `graph=` attribute (balanced braces, comments removed). */
function graphExpressions(file: string): string[] {
  const src = code(file);
  const out: string[] = [];
  for (const m of src.matchAll(/\bgraph=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Arithmetic in a JSX graph expression (strings and arrows ignored). */
function hasArithmetic(expr: string): boolean {
  const bare = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''").replace(/=>/g, ' ');
  return /[+\-*/%]|\.reduce\(/.test(bare);
}

const BUILDER_IMPORT = /from\s*['"][^'"]*\/lib\/(?:charts|\w+Charts)\.ts['"]/;

describe('graph catalogue — data', () => {
  test('the registry scan sees the screens', () => {
    assert.ok(screens.length > 150, `only ${screens.length} screens scanned`);
    for (const id of ['app.gateway', 'reports.profitLoss', 'outstanding.receivables', 'gstrecon.home', 'dashboard.home', 'print.voucher']) assert.ok(registeredIds.has(id), id);
    const unresolved = screens.filter((s) => !s.file).map((s) => `${s.id} (${s.component || 'no component'})`);
    assert.deepEqual(unresolved, [], 'every screen component resolves to its file');
    // A registration written another way (title before id, a computed id) would slip past the id scan:
    // every `component:` of a registry file must belong to a scanned `id: '…', title:` entry.
    assert.deepEqual(registryCounts.filter((c) => c.components !== c.ids), [], 'screens registered in a form the scan does not read');
  });

  test('every catalogued id is a registered screen', () => {
    const unknown = [...new Set(GRAPH_CATALOGUE.map((r) => r.id))].filter((id) => !registeredIds.has(id));
    assert.deepEqual(unknown, []);
  });

  test('every registered screen has a decision (graph or deliberately none)', () => {
    const catalogued = new Set(GRAPH_CATALOGUE.map((r) => r.id));
    assert.deepEqual([...registeredIds].filter((id) => !catalogued.has(id)).sort(), []);
  });

  test('rows are unique per (id, view); a screen with views lists each view', () => {
    const keys = GRAPH_CATALOGUE.map((r) => `${r.id}#${r.view ?? ''}`);
    assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
    for (const id of new Set(GRAPH_CATALOGUE.map((r) => r.id))) {
      const rows = catalogueRows(id);
      if (rows.length > 1) assert.ok(rows.every((r) => r.view), `${id}: several rows must each name a view`);
    }
  });

  test("every 'none' row carries a reason; every graph row a class and no reason", () => {
    for (const r of GRAPH_CATALOGUE) {
      if (r.form === 'none') {
        assert.ok(r.reason && r.reason.trim().length > 3, `${r.id}: reason`);
        assert.equal(r.graphClass, undefined, `${r.id}: a 'none' row has no class`);
        assert.ok(!r.inline && !r.color && !r.via, `${r.id}: a 'none' row has no graph options`);
      } else {
        assert.ok(r.graphClass === 'report' || r.graphClass === 'detail', `${r.id}: class`);
        assert.equal(r.reason, undefined, `${r.id}: a graph row has no 'none' reason`);
        assert.ok(r.question && r.priority, `${r.id}: question and priority`);
      }
    }
  });

  test('a screen has at most one graph class (Ctrl+J folds one class per screen)', () => {
    for (const id of new Set(graphRows().map((r) => r.id))) {
      assert.equal(new Set(graphRows().filter((r) => r.id === id).map((r) => r.graphClass)).size, 1, id);
    }
    assert.equal(graphClassOf('reports.ledger'), 'detail');
    assert.equal(graphClassOf('reports.profitLoss'), 'report');
    assert.equal(graphClassOf('reports.trialBalance'), null);
  });

  test('form and colour combinations follow the kit (§4.1, D26, D29)', () => {
    for (const r of graphRows()) {
      if (r.inline) assert.equal(r.form, 'bar', `${r.id}: inline is a bar form`);
      if (r.color === 'polarity') assert.ok(r.form === 'column' || r.form === 'bar', `${r.id}: polarity`);
      if (r.color === 'ordinal') assert.ok(r.form === 'column' || r.form === 'share', `${r.id}: ordinal`);
      if (r.context) assert.ok(r.form === 'column' || r.form === 'line', `${r.id}: context series`);
      if (r.form === 'mini') assert.equal(r.via, 'MiniColumns', `${r.id}: mini is Home's MiniColumns`);
    }
  });

  test('the catalogue matches §5: 50 graph rows, 16 inline bars, 9 in the detail class', () => {
    const g = graphRows();
    assert.equal(g.length, 50);
    assert.equal(g.filter((r) => r.inline).length, 16);
    assert.equal(g.filter((r) => r.graphClass === 'detail').length, 9);
  });

  test('deliberate "none" for checks and statutory forms (D26)', () => {
    for (const id of ['reports.balanceSheet', 'reports.trialBalance', 'vouchers.daybook', 'gst.gstr1', 'gst.gstr4', 'gst.cmp08', 'mfg.itc04', 'reports.fundsFlow']) {
      assert.ok(catalogueRows(id).every((r) => r.form === 'none'), id);
    }
    assert.ok(catalogueRows('outstanding.receivables').some((r) => r.view === 'parties' && r.form === 'none'), 'the Parties view has no graph (D25)');
  });

  test('PENDING_GRAPH lists only graph ids, once each', () => {
    const graphIds = new Set(graphRows().map((r) => r.id));
    assert.deepEqual(PENDING_GRAPH.filter((id) => !graphIds.has(id)), [], 'not a graph id');
    assert.deepEqual(PENDING_GRAPH.filter((id, i) => PENDING_GRAPH.indexOf(id) !== i), [], 'duplicate');
  });

  test('strict mode (after integration): nothing pending', { skip: !GRAPHS_STRICT }, () => {
    assert.deepEqual(PENDING_GRAPH, []);
  });

  test('STAT_TOTAL_ALLOWED: catalogued screens with a stat, each with a reason', () => {
    assert.deepEqual(Object.keys(STAT_TOTAL_ALLOWED).sort(), ['gst.gstr3b', 'outstanding.payables', 'outstanding.receivables', 'reports.profitLoss']);
    for (const [id, reason] of Object.entries(STAT_TOTAL_ALLOWED)) {
      assert.ok(registeredIds.has(id) && catalogueRows(id).some((r) => r.stat), `${id}: catalogued with a stat`);
      assert.ok(reason.trim().length > 10, `${id}: reason`);
      assert.equal(statTotalAllowed(id), true);
    }
    assert.equal(statTotalAllowed('reports.trialBalance'), false);
    assert.equal(statTotalAllowed('toString'), false, 'own keys only');
  });
});

describe('graph catalogue — screen sources', () => {
  test('the scan sees the report screens', () => {
    assert.ok(reportFiles.length > 50, `only ${reportFiles.length} report files`);
  });

  test('every file rendering <ReportScreen (or <Screen graph=) belongs to catalogued screens', () => {
    const catalogued = new Set(GRAPH_CATALOGUE.map((r) => r.id));
    const orphan: string[] = [];
    const missing: string[] = [];
    for (const f of reportFiles) {
      const ids = idsOf(f);
      if (ids.length === 0) orphan.push(rel(f));
      for (const id of ids) if (!catalogued.has(id)) missing.push(`${rel(f)}: ${id}`);
    }
    assert.deepEqual(missing, [], 'screen ids missing from chartCatalogue.ts');
    assert.deepEqual(orphan, [], 'report files no registered screen reaches (register them, or import them from a screen)');
  });

  test('screens with no graph pass none', () => {
    const offenders: string[] = [];
    for (const f of reportFiles) {
      const ids = idsOf(f);
      if (ids.length && ids.every((id) => catalogueRows(id).every((r) => r.form === 'none')) && graphExpressions(f).some((e) => e.trim() !== 'null')) offenders.push(`${rel(f)} (${ids.join(', ')})`);
    }
    assert.deepEqual(offenders, []);
  });

  test('graph= is reportGraph(…) of a memoised spec — no arithmetic in JSX', () => {
    const offenders: string[] = [];
    for (const f of walk(modulesDir)) {
      for (const e of graphExpressions(f)) {
        if (e.trim() === 'null') continue;
        if (!/\breportGraph\(/.test(e) && !/^\s*[\w.]+\s*$/.test(e)) offenders.push(`${rel(f)}: graph={${e.trim()}} — use reportGraph(spec)`);
        if (hasArithmetic(e)) offenders.push(`${rel(f)}: graph={${e.trim()}} — arithmetic belongs in lib/charts.ts`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('wired graph ids (not pending) pass graph= from a lib/charts.ts builder; detail ids pass graphKind="detail"', () => {
    const pending = new Set(PENDING_GRAPH);
    const problems: string[] = [];
    const dashboardFiles = fs.existsSync(path.join(modulesDir, 'dashboard')) ? walk(path.join(modulesDir, 'dashboard')) : [];
    for (const id of new Set(graphRows().map((r) => r.id))) {
      if (pending.has(id)) continue;
      const row = graphRows().find((r) => r.id === id)!;
      if (row.via === 'MiniColumns' || row.via === 'LazyChart') {
        const needle = row.via === 'MiniColumns' ? /from\s*['"][^'"]*\/MiniColumns\.tsx['"]/ : /from\s*['"][^'"]*\/lazyChart\.tsx['"]/;
        if (!dashboardFiles.some((f) => needle.test(code(f)))) problems.push(`${id}: no import of ${row.via} under modules/dashboard`);
        continue;
      }
      const files = closures.get(id) ?? [];
      const exprs = files.flatMap((f) => graphExpressions(f)).filter((e) => /\breportGraph\(/.test(e));
      if (!exprs.length) problems.push(`${id}: no graph={reportGraph(…)} in ${files.map(rel).join(', ')}`);
      if (!files.some((f) => BUILDER_IMPORT.test(code(f)))) problems.push(`${id}: no import from a lib/charts.ts (or lib/*Charts.ts) builder`);
      if (row.graphClass === 'detail' && !files.some((f) => /\bgraphKind="detail"/.test(code(f)))) problems.push(`${id}: detail class needs graphKind="detail"`);
    }
    assert.deepEqual(problems, []);
  });

  test('graphKind="detail" appears only where a detail-class screen lives', () => {
    const offenders: string[] = [];
    for (const f of walk(modulesDir)) {
      if (!/\bgraphKind="detail"/.test(code(f))) continue;
      const ids = idsOf(f);
      if (!ids.some((id) => graphClassOf(id) === 'detail')) offenders.push(`${rel(f)} (${ids.join(', ') || 'no screen'})`);
    }
    assert.deepEqual(offenders, []);
  });
});
