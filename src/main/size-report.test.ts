// scripts/size-report.mjs (docs/ARCHITECTURE.md §9a): the pure helpers behind the size report and the
// performance budget — gzip sizing, the initial-JS list from the built index.html, the report of a
// build folder, budget validation and comparison — and the committed build/perf-budget.json.
// Plain Node: imports the .mjs the way ci-workflows.test.ts imports scripts; nothing is built here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Size {
  raw: number;
  gzip: number;
}
interface SizeTotal extends Size {
  count: number;
}
interface FileSize extends Size {
  file: string;
  area: 'renderer' | 'main' | 'preload';
  kind: 'js' | 'css' | 'other';
  initial: boolean;
}
interface SizeReport {
  version: number;
  files: FileSize[];
  initial: { js: string[]; css: string[] };
  totals: Record<'initialJs' | 'initialCss' | 'rendererJs' | 'rendererCss' | 'rendererOther' | 'main' | 'preload', SizeTotal>;
}
interface GateTimings {
  startupMs: number | null;
  launchMs: number | null;
  screenOpenMs: Record<string, number>;
  screenOpenP95Ms: number | null;
  screenReadyMs?: Record<string, number>;
}
interface Budget {
  enforce: boolean;
  baseline: null | { capturedFrom: string; sizes: Record<'initialJs' | 'rendererJs' | 'rendererCss' | 'main', Size>; timings: Record<string, GateTimings> };
  ceilings: {
    initialJsRatio: number | null;
    startupRatio: number | null;
    screenOpenSlackMs: number | null;
    screenOpenWarnOnly: boolean;
    rendererJsMaxBytes: number | null;
    rendererCssMaxBytes: number | null;
  };
}
interface BudgetCheck {
  id: string;
  actual: number;
  limit: number;
  ok: boolean;
  warnOnly: boolean;
}
interface BudgetResult {
  enforce: boolean;
  hasBaseline: boolean;
  checks: BudgetCheck[];
  failures: BudgetCheck[];
  warnings: BudgetCheck[];
  notes: string[];
}
interface SizeReportModule {
  gzipBytes(data: Uint8Array | string): number;
  sizeOf(data: Uint8Array | string): Size;
  localRef(ref: string): string | null;
  parseIndexHtml(html: string): { entry: string[]; modulepreload: string[]; stylesheets: string[] };
  buildSizeReport(outDir: string): SizeReport;
  formatSizeReport(report: SizeReport): string;
  percentile(values: readonly number[], p: number): number | null;
  budgetProblems(budget: unknown): string[];
  compareBudget(run: { sizes: SizeReport; timings?: GateTimings | null; platform?: string }, budget: Budget): BudgetResult;
  formatBudgetResult(result: BudgetResult): string;
  makeBaseline(reports: readonly unknown[], capturedFrom: string): NonNullable<Budget['baseline']>;
  parsePerfReport(text: string): unknown;
  readBudget(file?: string): Budget;
}

let m: SizeReportModule;
before(async () => {
  m = (await import(pathToFileURL(path.join(root, 'scripts/size-report.mjs')).href)) as SizeReportModule;
});

/** What Vite 8 writes for this app (relative base, modulepreload links, one stylesheet). */
const BUILT_INDEX = `<!doctype html>
<html lang="en-IN" data-theme="system" data-density="comfortable">
  <head>
    <meta charset="UTF-8" />
    <title>Pevqori</title>
    <script type="module" crossorigin src="./assets/index-Ab12Cd.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/react-Xy98.js">
    <link rel="modulepreload" crossorigin href="./assets/ui-Qw34.js?v=1">
    <!-- <link rel="modulepreload" href="./assets/commented-out.js"> -->
    <link rel="stylesheet" crossorigin href="./assets/index-Ef56.css">
    <link rel="icon" href="data:,">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('size report helpers (scripts/size-report.mjs)', () => {
  it('gzip sizing: the gzip byte count of the data (level 9), raw = byte length', () => {
    const text = 'const x = 1;\n'.repeat(500);
    const s = m.sizeOf(text);
    assert.equal(s.raw, Buffer.byteLength(text));
    assert.ok(s.gzip > 0 && s.gzip < s.raw / 10, 'repetitive JS compresses well');
    assert.equal(m.gzipBytes(Buffer.from(text)), s.gzip, 'string and bytes agree');
    // The size is that of a real gzip stream of the data.
    const z = gzipSync(Buffer.from(text), { level: 9 });
    assert.equal(z.length, s.gzip);
    assert.equal(gunzipSync(z).toString(), text);
    assert.equal(m.sizeOf('₹').raw, 3, 'raw counts UTF-8 bytes, not characters');
  });

  it('modulepreload parsing: entry script, modulepreloads and stylesheets of the built index.html', () => {
    assert.deepEqual(m.parseIndexHtml(BUILT_INDEX), {
      entry: ['assets/index-Ab12Cd.js'],
      modulepreload: ['assets/react-Xy98.js', 'assets/ui-Qw34.js'],
      stylesheets: ['assets/index-Ef56.css'],
    });
  });

  it('modulepreload parsing: attribute order, quoting, case, duplicates and non-module scripts', () => {
    const html = `<SCRIPT src='/assets/a.js' TYPE=module></SCRIPT>
      <script src="./assets/classic.js"></script>
      <link href=./assets/b.js rel="modulepreload">
      <link rel="modulepreload" href="./assets/b.js">
      <link rel="preload stylesheet" href="assets/c.css">
      <link rel="modulepreload" href="https://cdn.example/x.js">`;
    assert.deepEqual(m.parseIndexHtml(html), { entry: ['assets/a.js'], modulepreload: ['assets/b.js'], stylesheets: ['assets/c.css'] });
    assert.equal(m.localRef('../../assets/x.js'), 'assets/x.js', 'never escapes the renderer folder');
    assert.equal(m.localRef('data:text/javascript,1'), null);
    assert.equal(m.localRef('//host/x.js'), null);
  });

  it('percentile: nearest rank; null for no values', () => {
    assert.equal(m.percentile([], 95), null);
    assert.equal(m.percentile([120], 95), 120);
    assert.equal(m.percentile([50, 10, 40, 20, 30], 50), 30);
    assert.equal(m.percentile([50, 10, 40, 20, 30], 95), 50);
    assert.equal(m.percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
    assert.equal(m.percentile([10, Number.NaN, 20], 100), 20, 'non-finite samples are ignored');
  });
});

describe('size report of a build folder', () => {
  let out: string;
  const write = (rel: string, body: string) => {
    const file = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-size-'));
    write('renderer/index.html', BUILT_INDEX);
    write('renderer/assets/index-Ab12Cd.js', 'export const a = 1;\n'.repeat(40));
    write('renderer/assets/react-Xy98.js', 'export const r = 2;\n'.repeat(30));
    write('renderer/assets/ui-Qw34.js', 'export const u = 3;\n'.repeat(20));
    write('renderer/assets/BalanceSheet-Lazy1.js', 'export const lazy = 4;\n'.repeat(10));
    write('renderer/assets/BalanceSheet-Lazy1.js.map', '{"mappings":""}');
    write('renderer/assets/index-Ef56.css', '.bx{color:red}\n'.repeat(25));
    write('renderer/assets/fonts/inter.woff2', 'font-bytes');
    write('main/index.cjs', 'module.exports = 1;\n'.repeat(50));
    write('main/core-worker.cjs', 'module.exports = 2;\n'.repeat(60));
    write('main/index.cjs.map', '{}');
    write('preload/index.cjs', 'module.exports = 3;\n');
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  it('lists renderer assets (no source maps), main and preload bundles with raw and gzip bytes', () => {
    const r = m.buildSizeReport(out);
    assert.equal(r.version, 1);
    assert.deepEqual(
      r.files.map((f) => `${f.area}:${f.kind}:${f.file}${f.initial ? ':initial' : ''}`),
      [
        'renderer:js:renderer/assets/BalanceSheet-Lazy1.js',
        'renderer:other:renderer/assets/fonts/inter.woff2',
        'renderer:js:renderer/assets/index-Ab12Cd.js:initial',
        'renderer:css:renderer/assets/index-Ef56.css:initial',
        'renderer:js:renderer/assets/react-Xy98.js:initial',
        'renderer:js:renderer/assets/ui-Qw34.js:initial',
        'main:js:main/core-worker.cjs',
        'main:js:main/index.cjs',
        'preload:js:preload/index.cjs',
      ],
    );
    for (const f of r.files) {
      const data = fs.readFileSync(path.join(out, ...f.file.split('/')));
      assert.equal(f.raw, data.length, f.file);
      assert.equal(f.gzip, m.gzipBytes(data), f.file);
    }
  });

  it('totals: initial JS = entry + modulepreloads; lazy chunks only in the renderer JS total', () => {
    const r = m.buildSizeReport(out);
    const raw = (rel: string) => fs.statSync(path.join(out, ...rel.split('/'))).size;
    const initial = raw('renderer/assets/index-Ab12Cd.js') + raw('renderer/assets/react-Xy98.js') + raw('renderer/assets/ui-Qw34.js');
    assert.deepEqual(r.initial.js, ['renderer/assets/index-Ab12Cd.js', 'renderer/assets/react-Xy98.js', 'renderer/assets/ui-Qw34.js']);
    assert.equal(r.totals.initialJs.raw, initial);
    assert.equal(r.totals.initialJs.count, 3);
    assert.equal(r.totals.rendererJs.raw, initial + raw('renderer/assets/BalanceSheet-Lazy1.js'));
    assert.equal(r.totals.rendererJs.count, 4);
    assert.equal(r.totals.rendererCss.raw, raw('renderer/assets/index-Ef56.css'));
    assert.equal(r.totals.initialCss.count, 1);
    assert.equal(r.totals.rendererOther.count, 1);
    assert.equal(r.totals.main.raw, raw('main/index.cjs') + raw('main/core-worker.cjs'));
    assert.equal(r.totals.preload.count, 1);
    const text = m.formatSizeReport(r);
    assert.match(text, /Initial JS \(entry \+ 2 modulepreload\)/);
    assert.match(text, /renderer\/assets\/index-Ab12Cd\.js\s+[\d.]+ KB\s+[\d.]+ KB\s+initial/);
  });

  it('command line: --out writes the JSON report; --baseline turns perf reports into the budget block', () => {
    const script = path.join(root, 'scripts/size-report.mjs');
    const json = path.join(out, 'report', 'size.json');
    const table = execFileSync(process.execPath, [script, '--dir', out, '--out', json], { encoding: 'utf8' });
    assert.match(table, /Initial JS \(entry \+ 2 modulepreload\)/);
    const written = JSON.parse(fs.readFileSync(json, 'utf8')) as SizeReport;
    assert.deepEqual(written, m.buildSizeReport(out));
    const perf = path.join(out, 'report', 'linux.json');
    fs.writeFileSync(perf, JSON.stringify({ platform: 'linux', commit: 'abc1234', sizes: written, timings: { startupMs: 400, launchMs: 900, screenOpenMs: { 'gst.gstr1': 150 }, screenOpenP95Ms: 150 } }));
    // The Windows report as the integrator gets it: the e2e job log, timestamps and all.
    const winLog = path.join(out, 'report', 'win32.log');
    const winReport = { platform: 'win32', commit: 'abc1234', sizes: written, timings: { startupMs: 700, launchMs: 1500, screenOpenMs: { 'gst.gstr1': 210 }, screenOpenP95Ms: 210, screenReadyMs: { 'gst.gstr1': 480 } } };
    fs.writeFileSync(
      winLog,
      ['2026-10-10T10:00:00.0000000Z Running 5 tests using 1 worker', `2026-10-10T10:02:00.0000000Z [perf] report ${JSON.stringify(winReport)}`, '2026-10-10T10:02:01.0000000Z   5 passed (2.1m)', ''].join('\r\n'),
    );
    const printed = JSON.parse(execFileSync(process.execPath, [script, '--baseline', perf, winLog, '--from', 'CI run 7 @ abc1234'], { encoding: 'utf8' })) as { baseline: NonNullable<Budget['baseline']> };
    assert.deepEqual(m.budgetProblems({ enforce: false, baseline: printed.baseline, ceilings: m.readBudget().ceilings }), []);
    assert.equal(printed.baseline.capturedFrom, 'CI run 7 @ abc1234');
    assert.deepEqual(Object.keys(printed.baseline.timings), ['linux', 'win32']);
    assert.equal(printed.baseline.timings.win32.startupMs, 700);
    assert.deepEqual(printed.baseline.timings.win32.screenReadyMs, { 'gst.gstr1': 480 });
    // Without --from: the commit recorded in the reports.
    const fromCommit = JSON.parse(execFileSync(process.execPath, [script, '--baseline', perf], { encoding: 'utf8' })) as { baseline: { capturedFrom: string } };
    assert.equal(fromCommit.baseline.capturedFrom, 'abc1234');
    // A truncated log line or no file at all is a clear error, not a stack trace.
    const cut = path.join(out, 'report', 'cut.log');
    fs.writeFileSync(cut, `[perf] report ${JSON.stringify(winReport).slice(0, 200)}\n`);
    assert.throws(() => execFileSync(process.execPath, [script, '--baseline', cut], { encoding: 'utf8', stdio: 'pipe' }), (err: { status: number; stderr: string }) => err.status === 1 && /cut\.log: the `\[perf\] report` line is not complete JSON/.test(err.stderr));
    assert.throws(() => execFileSync(process.execPath, [script, '--baseline'], { encoding: 'utf8', stdio: 'pipe' }), (err: { status: number; stderr: string }) => err.status === 1 && /--baseline needs the perf report/.test(err.stderr));
  });

  it('fails clearly without a build, or when index.html loads a file that is not there', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-size-empty-'));
    try {
      assert.throws(() => m.buildSizeReport(empty), /run `npm run build` first/);
      fs.mkdirSync(path.join(empty, 'renderer'), { recursive: true });
      fs.writeFileSync(path.join(empty, 'renderer', 'index.html'), BUILT_INDEX);
      assert.throws(() => m.buildSizeReport(empty), /index\.html loads files that are not in/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('performance budget', () => {
  const sizes = (initialJs: number, rendererJs = initialJs * 2, rendererCss = 200_000): SizeReport => ({
    version: 1,
    files: [],
    initial: { js: [], css: [] },
    totals: {
      initialJs: { raw: initialJs, gzip: Math.round(initialJs / 4), count: 3 },
      initialCss: { raw: rendererCss, gzip: 30_000, count: 1 },
      rendererJs: { raw: rendererJs, gzip: Math.round(rendererJs / 4), count: 10 },
      rendererCss: { raw: rendererCss, gzip: 30_000, count: 1 },
      rendererOther: { raw: 0, gzip: 0, count: 0 },
      main: { raw: 900_000, gzip: 250_000, count: 2 },
      preload: { raw: 3_000, gzip: 1_000, count: 1 },
    },
  });
  const ceilings: Budget['ceilings'] = { initialJsRatio: 0.55, startupRatio: 1.15, screenOpenSlackMs: 30, screenOpenWarnOnly: true, rendererJsMaxBytes: null, rendererCssMaxBytes: null };
  const baselineTimings: GateTimings = { startupMs: 400, launchMs: 900, screenOpenMs: { 'vouchers.entry': 120, 'reports.balanceSheet': 200 }, screenOpenP95Ms: 200 };
  const budget = (enforce: boolean): Budget => ({
    enforce,
    baseline: { capturedFrom: 'CI run 1 @ 0ddf9b6', sizes: { initialJs: { raw: 1_000_000, gzip: 250_000 }, rendererJs: { raw: 1_000_000, gzip: 250_000 }, rendererCss: { raw: 200_000, gzip: 30_000 }, main: { raw: 900_000, gzip: 250_000 } }, timings: { linux: baselineTimings } },
    ceilings,
  });

  it('no baseline: only absolute ceilings, nothing fails', () => {
    const r = m.compareBudget({ sizes: sizes(2_000_000), timings: baselineTimings, platform: 'linux' }, { enforce: false, baseline: null, ceilings });
    assert.equal(r.hasBaseline, false);
    assert.deepEqual(r.checks, []);
    assert.deepEqual(r.failures, []);
    assert.match(r.notes.join(' '), /No baseline/);
    const capped = m.compareBudget({ sizes: sizes(100, 100, 190_000) }, { enforce: true, baseline: null, ceilings: { ...ceilings, rendererCssMaxBytes: 180_000 } });
    assert.deepEqual(capped.failures.map((f) => f.id), ['rendererCss']);
  });

  it('initial JS ≤ 0.55 × baseline; start-up and launch ≤ 1.15 × baseline on the same platform', () => {
    const within = m.compareBudget({ sizes: sizes(550_000), timings: { startupMs: 460, launchMs: 1_035, screenOpenMs: {}, screenOpenP95Ms: null }, platform: 'linux' }, budget(true));
    assert.deepEqual(within.checks.map((c) => [c.id, c.limit, c.ok]), [
      ['initialJs', 550_000, true],
      ['startup', 460, true],
      ['launch', 1_035, true],
    ]);
    const over = m.compareBudget({ sizes: sizes(550_001), timings: { startupMs: 461, launchMs: 1_000, screenOpenMs: {}, screenOpenP95Ms: null }, platform: 'linux' }, budget(true));
    assert.deepEqual(over.failures.map((c) => c.id), ['initialJs', 'startup']);
  });

  it('screen open: first open ≤ baseline + 30 ms, warn-only by default; p95 compared too', () => {
    const timings: GateTimings = { startupMs: 400, launchMs: 900, screenOpenMs: { 'vouchers.entry': 151, 'reports.balanceSheet': 230, 'gst.gstr1': 999 }, screenOpenP95Ms: 231 };
    const r = m.compareBudget({ sizes: sizes(500_000), timings, platform: 'linux' }, budget(true));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings.map((c) => c.id), ['screenOpen:vouchers.entry', 'screenOpenP95']);
    assert.ok(!r.checks.some((c) => c.id === 'screenOpen:gst.gstr1'), 'a screen without a baseline number is not judged');
    const strict = m.compareBudget({ sizes: sizes(500_000), timings, platform: 'linux' }, { ...budget(true), ceilings: { ...ceilings, screenOpenWarnOnly: false } });
    assert.deepEqual(strict.failures.map((c) => c.id), ['screenOpen:vouchers.entry', 'screenOpenP95']);
  });

  it('timings of another platform, or a run without timings, are never compared', () => {
    const win = m.compareBudget({ sizes: sizes(500_000), timings: { startupMs: 9_999, launchMs: 9_999, screenOpenMs: {}, screenOpenP95Ms: null }, platform: 'win32' }, budget(true));
    assert.deepEqual(win.checks.map((c) => c.id), ['initialJs']);
    assert.match(win.notes.join(' '), /platform "win32"/);
    const none = m.compareBudget({ sizes: sizes(500_000), timings: null, platform: 'linux' }, budget(true));
    assert.deepEqual(none.checks.map((c) => c.id), ['initialJs']);
    assert.match(m.formatBudgetResult(none), /enforced/);
  });

  it('perf report from perf-report.json, the copied log line or the whole job log (the last report wins)', () => {
    const r = { platform: 'linux', sizes: sizes(1), timings: null };
    assert.deepEqual(m.parsePerfReport(JSON.stringify(r, null, 2)), r);
    assert.deepEqual(m.parsePerfReport(`[perf] report ${JSON.stringify(r)}`), r);
    const retry = { ...r, platform: 'linux', commit: 'second attempt' };
    const log = [`2026-10-10T10:00:00Z [perf] report ${JSON.stringify(r)}`, '2026-10-10T10:00:01Z retrying', `2026-10-10T10:05:00Z [perf] report ${JSON.stringify(retry)}`, '2026-10-10T10:05:01Z done'].join('\n');
    assert.deepEqual(m.parsePerfReport(log), retry);
    assert.throws(() => m.parsePerfReport('[perf] report {"platform":'), /not complete JSON/);
    assert.throws(() => m.parsePerfReport('not json'), SyntaxError);
  });

  it('baseline sizes come from the Linux report whatever the order; timings from each platform', () => {
    const win = { platform: 'win32', sizes: sizes(1_000_010), timings: null };
    const linux = { platform: 'linux', sizes: sizes(1_000_000), timings: null };
    assert.equal(m.makeBaseline([win, linux], 'x').sizes.initialJs.raw, 1_000_000);
    assert.equal(m.makeBaseline([linux, win], 'x').sizes.initialJs.raw, 1_000_000);
    assert.equal(m.makeBaseline([win], 'x').sizes.initialJs.raw, 1_000_010, 'no Linux report: the first one');
    assert.deepEqual(m.makeBaseline([win, linux], 'x').timings.win32, { startupMs: null, launchMs: null, screenOpenMs: {}, screenOpenP95Ms: null, screenReadyMs: {} });
  });

  it('screen open with its data: compared per screen with the same slack, always warn-only, only where both runs have it', () => {
    const base = budget(true);
    const b = { ...base, baseline: { ...base.baseline!, timings: { linux: { ...baselineTimings, screenReadyMs: { 'reports.balanceSheet': 400, 'gst.gstr1': 300 } } } }, ceilings: { ...ceilings, screenOpenWarnOnly: false } };
    const r = m.compareBudget({ sizes: sizes(500_000), timings: { ...baselineTimings, screenReadyMs: { 'reports.balanceSheet': 431, 'vouchers.entry': 9_999 } }, platform: 'linux' }, b);
    assert.deepEqual(
      r.checks.filter((c) => c.id.startsWith('screenReady:')).map((c) => [c.id, c.limit, c.ok, c.warnOnly]),
      [['screenReady:reports.balanceSheet', 430, false, true]],
    );
    assert.deepEqual(r.failures, [], 'never fails a run, even with screenOpenWarnOnly: false');
    assert.deepEqual(r.warnings.map((c) => c.id), ['screenReady:reports.balanceSheet']);
    const bad = m.budgetProblems({ ...b, baseline: { ...b.baseline, timings: { linux: { ...baselineTimings, screenReadyMs: { x: 'slow' } } } } });
    assert.deepEqual(bad, ['baseline.timings.linux.screenReadyMs must map screen ids to ms']);
  });

  it('baseline from the per-platform perf reports of one CI run', () => {
    const report = (platform: string, startupMs: number) => ({ platform, sizes: sizes(1_000_000), timings: { startupMs, launchMs: startupMs * 2, screenOpenMs: { 'vouchers.entry': 100 }, screenOpenP95Ms: 100, extra: 'ignored' } });
    const b = m.makeBaseline([report('linux', 400), report('win32', 700)], 'CI run 42 @ abc1234');
    assert.deepEqual(m.budgetProblems({ enforce: false, baseline: b, ceilings }), []);
    assert.equal(b.sizes.initialJs.raw, 1_000_000);
    assert.deepEqual(Object.keys(b.timings), ['linux', 'win32']);
    assert.deepEqual(b.timings.win32, { startupMs: 700, launchMs: 1_400, screenOpenMs: { 'vouchers.entry': 100 }, screenOpenP95Ms: 100, screenReadyMs: {} });
    assert.throws(() => m.makeBaseline([], 'x'), /at least one/);
    assert.throws(() => m.makeBaseline([{ nope: 1 }], 'x'), /not a perf-report/);
  });

  it('budget validation names each malformed field', () => {
    assert.deepEqual(m.budgetProblems(null), ['the budget is not an object']);
    const p = m.budgetProblems({ enforce: 'yes', baseline: { capturedFrom: '', sizes: {}, timings: { linux: { startupMs: 'fast' } } }, ceilings: { initialJsRatio: '55%', screenOpenWarnOnly: 1 } });
    assert.ok(p.includes('enforce must be true or false'));
    assert.ok(p.includes('ceilings.initialJsRatio must be a number or null'));
    assert.ok(p.includes('ceilings.screenOpenWarnOnly must be true or false'));
    assert.ok(p.includes('baseline.capturedFrom must name the CI run / commit'));
    assert.ok(p.includes('baseline.sizes.initialJs must be { raw, gzip }'));
    assert.ok(p.some((x) => x.startsWith('baseline.timings.linux must be')));
  });

  it('the committed build/perf-budget.json is well-formed and carries the §10 ceilings', () => {
    const file = path.join(root, 'build', 'perf-budget.json');
    assert.deepEqual(m.budgetProblems(JSON.parse(fs.readFileSync(file, 'utf8'))), []);
    const b = m.readBudget(file);
    assert.equal(b.ceilings.initialJsRatio, 0.55);
    assert.equal(b.ceilings.startupRatio, 1.15);
    assert.equal(b.ceilings.screenOpenSlackMs, 30);
    if (!b.enforce) return;
    // Enforcing (integration step) only makes sense against a captured 1.0 baseline.
    assert.ok(b.baseline !== null, 'enforce: true needs the 1.0 baseline');
  });
});
