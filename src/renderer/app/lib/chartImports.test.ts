/**
 * Where graph code may go (SPEC-21 §4.6, §4.7, D27, D30):
 *  - never into printed documents — invoices, vouchers, statements, cheques, deposit slips, POS
 *    receipts (modules/print/**, every *PrintBlock.tsx, outstanding/lib/printHtml.ts,
 *    ReceiptPrinter.tsx, the cheque printer and the deposit slip), directly or through their
 *    relative imports;
 *  - never into the start-up bundle: `ui/Chart.tsx` is reachable only through `ui/lazyChart.tsx`'s
 *    dynamic `import()`, and the ui barrel exports none of `Chart`, `LazyChart`, `reportGraph`;
 *  - the pure graph contract (chartSpec, palette, the catalogue) stays React-free (node-testable).
 * Source scan (type-only imports are erased by the bundler and ignored).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiDir = path.join(rendererDir, 'ui');
const rel = (p: string) => path.relative(rendererDir, p).split(path.sep).join('/');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

interface ImportRef {
  spec: string;
  names: string[];
  dynamic: boolean;
  typeOnly: boolean;
}

/** Every import / re-export / dynamic import() of a file. */
function imports(file: string): ImportRef[] {
  const src = code(file);
  const out: ImportRef[] = [];
  for (const m of src.matchAll(/\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = (/\{([^}]*)\}/.exec(m[3])?.[1] ?? m[3])
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const allTypes = /\{([^}]*)\}/.test(m[3]) && names.length > 0 && (/\{([^}]*)\}/.exec(m[3])?.[1] ?? '').split(',').filter((s) => s.trim()).every((s) => /^\s*type\s/.test(s));
    out.push({ spec: m[4], names, dynamic: false, typeOnly: !!m[2] || allTypes });
  }
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1], names: [], dynamic: false, typeOnly: false });
  for (const m of src.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) out.push({ spec: m[1], names: [], dynamic: true, typeOnly: false });
  return out;
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(from), spec);
  return fs.existsSync(p) ? p : null;
}

/** Graph code by file (the kit, its adapters and pure parts). */
const CHART_FILE = /(?:^|\/)ui\/(?:Chart|lazyChart|MiniColumns|Sparkline|BarChart|LineChart|chartParts|KpiCard)\.tsx$|(?:^|\/)ui\/lib\/(?:chartSpec|chart)\.ts$/;
/** Graph code by exported name (also when imported through the ui barrel). */
const CHART_NAMES = new Set(['Chart', 'LazyChart', 'reportGraph', 'MiniColumns', 'Sparkline', 'BarChart', 'LineChart', 'KpiCard']);
const CHART_JSX = /<(?:Chart|LazyChart|MiniColumns|Sparkline|BarChart|LineChart|KpiCard)[\s/>]/;

/** Printed-document sources (§4.6). */
function printRoots(): string[] {
  const all = walk(rendererDir);
  const roots = new Set<string>();
  for (const f of all) {
    const r = rel(f);
    if (r.startsWith('modules/print/')) roots.add(f);
    if (/PrintBlock\.tsx$/.test(r)) roots.add(f);
    if (/(?:^|\/)ReceiptPrinter\.tsx$/.test(r)) roots.add(f);
    // Every other print source of a module (vouchers/lib/printing.ts, pos/lib/print.ts, forex/lib/print.ts, …).
    if (r.startsWith('modules/') && /print/i.test(path.basename(r))) roots.add(f);
  }
  for (const r of ['modules/outstanding/lib/printHtml.ts', 'modules/cheques/PrintChequesScreen.tsx', 'modules/cheques/lib/cheque.ts', 'modules/banking/DepositSlipScreen.tsx']) {
    const f = path.join(rendererDir, r);
    if (fs.existsSync(f)) roots.add(f);
  }
  return [...roots];
}

/** Roots plus everything they reach by relative (runtime) import, barrels (index.ts) excluded. */
function reach(roots: readonly string[]): Map<string, string> {
  const via = new Map<string, string>();
  const stack = roots.map((r) => [r, rel(r)] as const);
  while (stack.length) {
    const [f, chain] = stack.pop()!;
    if (via.has(f)) continue;
    via.set(f, chain);
    for (const i of imports(f)) {
      if (i.typeOnly) continue;
      const p = resolve(f, i.spec);
      if (p && path.basename(p) !== 'index.ts' && /\.tsx?$/.test(p)) stack.push([p, `${chain} → ${rel(p)}`]);
    }
  }
  return via;
}

describe('graphs never print (D30)', () => {
  const roots = printRoots();

  test('the scan sees the printed documents', () => {
    const names = roots.map(rel);
    assert.ok(names.filter((n) => n.startsWith('modules/print/')).length >= 10, `print files: ${names.length}`);
    for (const must of ['modules/outstanding/lib/printHtml.ts', 'modules/pos/ReceiptPrinter.tsx', 'modules/pos/PrintBlock.tsx', 'modules/forex/PrintBlock.tsx', 'modules/vouchers/lib/printing.ts', 'modules/cheques/PrintChequesScreen.tsx', 'modules/banking/DepositSlipScreen.tsx']) assert.ok(names.includes(must), must);
  });

  test('no printed document imports or renders graph code, directly or through its imports', () => {
    const offenders: string[] = [];
    for (const [f, chain] of reach(roots)) {
      const r = rel(f);
      if (CHART_FILE.test(r)) offenders.push(`${chain} (graph code)`);
      for (const i of imports(f)) {
        if (i.typeOnly) continue;
        const bad = i.names.filter((n) => CHART_NAMES.has(n));
        if (bad.length) offenders.push(`${chain}: imports ${bad.join(', ')} from '${i.spec}'`);
        if (/(?:^|\/)(?:Chart|lazyChart|MiniColumns|Sparkline|BarChart|LineChart|chartParts|KpiCard)\.tsx$|\/(?:chartSpec|chart)\.ts$/.test(i.spec)) offenders.push(`${chain}: imports '${i.spec}'`);
      }
      if (CHART_JSX.test(code(f))) offenders.push(`${chain}: renders a graph component`);
    }
    assert.deepEqual([...new Set(offenders)], []);
  });
});

describe('graph code stays out of the start-up bundle (D27, §4.7)', () => {
  const files = walk(rendererDir);
  const lazyChart = path.join(uiDir, 'lazyChart.tsx');

  test('only ui/lazyChart.tsx loads ui/Chart.tsx, and only through import()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (i.typeOnly || !/(?:^|\/)Chart\.tsx$/.test(i.spec)) continue;
        const target = resolve(f, i.spec);
        if (target && target !== path.join(uiDir, 'Chart.tsx')) continue; // another module's own Chart.tsx (none today)
        if (f !== lazyChart) offenders.push(`${rel(f)}: imports '${i.spec}'`);
        else if (!i.dynamic) offenders.push(`${rel(f)}: imports '${i.spec}' statically — use React.lazy(() => import('./Chart.tsx'))`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the ui barrel exports none of Chart, LazyChart, reportGraph (and does not re-export the kit files)', () => {
    const barrel = path.join(uiDir, 'index.ts');
    const offenders: string[] = [];
    for (const i of imports(barrel)) {
      const named = i.names.filter((n) => n === 'Chart' || n === 'LazyChart' || n === 'reportGraph');
      if (named.length && !i.typeOnly) offenders.push(`exports ${named.join(', ')} from '${i.spec}'`);
      if (/(?:^|\/)(?:Chart|lazyChart)\.tsx$/.test(i.spec) && !i.typeOnly) offenders.push(`re-exports '${i.spec}'`);
    }
    const src = code(barrel);
    if (/export\s+(?:const|function|let|var)\s+(?:Chart|LazyChart|reportGraph)\b/.test(src)) offenders.push('declares Chart/LazyChart/reportGraph');
    assert.deepEqual(offenders, []);
  });

  test('the scan reads real imports (self-check)', () => {
    const own = imports(fileURLToPath(import.meta.url));
    assert.ok(own.some((i) => i.spec === 'node:fs'));
    assert.ok(own.some((i) => i.spec === 'node:test' && i.names.includes('describe')), 'named imports are parsed');
    const barrel = imports(path.join(uiDir, 'index.ts'));
    assert.ok(barrel.length > 20 && barrel.some((i) => i.names.includes('BarChart')), 'the barrel scan sees its exports');
  });
});

describe('the graph contract is pure', () => {
  test('chartSpec, palette and the catalogue import no React and no DOM-bound code', () => {
    for (const r of ['ui/lib/chartSpec.ts', 'ui/lib/palette.ts', 'app/lib/chartCatalogue.ts']) {
      const f = path.join(rendererDir, r);
      for (const i of imports(f)) {
        assert.ok(!/^react(?:-dom)?(?:\/|$)/.test(i.spec), `${r} imports ${i.spec}`);
        assert.ok(!/\.tsx$/.test(i.spec), `${r} imports a component file ${i.spec}`);
      }
    }
  });
});
