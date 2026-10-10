#!/usr/bin/env node
// Build size report and performance budget (docs/ARCHITECTURE.md §9a). node:* only; reads a finished
// build (`npm run build` → out/), never builds.
//
//   node scripts/size-report.mjs                         table of out/renderer/assets/* and out/main/*.cjs
//                                                        (+ out/preload/*.cjs): raw and gzip bytes, totals
//   node scripts/size-report.mjs --out size.json         … and write the report as JSON
//   node scripts/size-report.mjs --json                  print the JSON instead of the table
//   node scripts/size-report.mjs --dir path/to/out       another build folder
//   node scripts/size-report.mjs --budget                compare the sizes with build/perf-budget.json
//                                                        (exit 1 only when the budget says enforce: true)
//   node scripts/size-report.mjs --baseline linux.txt win32.txt [--from "CI run <id> @ <sha>"]
//                                                        print the `baseline` block for build/perf-budget.json
//                                                        from the perf report of each CI platform: a
//                                                        perf-report.json (e2e/perf.spec.ts attaches it) or
//                                                        the e2e job log / its `[perf] report {…}` line
//
// "Initial JS" is what the renderer must fetch and evaluate before the first screen: the entry
// <script type="module"> plus every <link rel="modulepreload"> of the built index.html. Lazy chunks
// are in the total only. The pure helpers below are unit-tested (src/main/size-report.test.ts) and
// used by e2e/perf.spec.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const REPORT_VERSION = 1;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = path.join(root, 'out');
export const DEFAULT_BUDGET_FILE = path.join(root, 'build', 'perf-budget.json');

/**
 * @typedef {{ raw: number, gzip: number }} Size
 * @typedef {{ raw: number, gzip: number, count: number }} SizeTotal
 * @typedef {{ file: string, area: 'renderer' | 'main' | 'preload', kind: 'js' | 'css' | 'other', raw: number, gzip: number, initial: boolean }} FileSize
 * @typedef {{ entry: string[], modulepreload: string[], stylesheets: string[] }} IndexRefs
 * @typedef {{
 *   version: number,
 *   files: FileSize[],
 *   initial: { js: string[], css: string[] },
 *   totals: { initialJs: SizeTotal, initialCss: SizeTotal, rendererJs: SizeTotal, rendererCss: SizeTotal, rendererOther: SizeTotal, main: SizeTotal, preload: SizeTotal }
 * }} SizeReport
 * @typedef {{
 *   startupMs: number | null,
 *   launchMs: number | null,
 *   screenOpenMs: Record<string, number>,
 *   screenOpenP95Ms: number | null,
 *   screenReadyMs?: Record<string, number>
 * }} GateTimings
 * @typedef {{
 *   capturedFrom: string,
 *   sizes: { initialJs: Size, rendererJs: Size, rendererCss: Size, main: Size },
 *   timings: Record<string, GateTimings>
 * }} Baseline
 * @typedef {{
 *   initialJsRatio: number | null,
 *   startupRatio: number | null,
 *   screenOpenSlackMs: number | null,
 *   screenOpenWarnOnly: boolean,
 *   rendererJsMaxBytes: number | null,
 *   rendererCssMaxBytes: number | null
 * }} Ceilings
 * @typedef {{ enforce: boolean, baseline: Baseline | null, ceilings: Ceilings }} Budget
 * @typedef {{ id: string, label: string, unit: 'bytes' | 'ms', actual: number, limit: number, ok: boolean, warnOnly: boolean }} BudgetCheck
 * @typedef {{ enforce: boolean, hasBaseline: boolean, checks: BudgetCheck[], failures: BudgetCheck[], warnings: BudgetCheck[], notes: string[] }} BudgetResult
 */

/** Gzip size (level 9, what a CDN would serve; the app reads from disk — gzip is a weight proxy). */
export function gzipBytes(/** @type {Uint8Array | string} */ data) {
  return gzipSync(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { level: 9 }).length;
}

/** @returns {Size} */
export function sizeOf(/** @type {Uint8Array | string} */ data) {
  const raw = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
  return { raw, gzip: gzipBytes(data) };
}

/** Attributes of one start tag (`<script type="module" crossorigin src="./x.js">`). */
function attributes(/** @type {string} */ tag) {
  /** @type {Record<string, string>} */
  const out = {};
  const body = tag.replace(/^<\s*[a-zA-Z]+/, '').replace(/\/?>$/, '');
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** './assets/a.js?x#y' → 'assets/a.js'; null for absolute URLs (http:, data: …), which are not in out/. */
export function localRef(/** @type {string} */ ref) {
  const clean = ref.trim().split(/[?#]/)[0];
  if (clean === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith('//')) return null;
  return path.posix.normalize(clean.replace(/^(\.\/|\/)+/, '')).replace(/^(\.\.\/)+/, '');
}

/**
 * The files the built index.html loads up front: entry module scripts, modulepreloads and
 * stylesheets, as paths relative to out/renderer (deduplicated, in document order).
 * @returns {IndexRefs}
 */
export function parseIndexHtml(/** @type {string} */ html) {
  /** @type {IndexRefs} */
  const refs = { entry: [], modulepreload: [], stylesheets: [] };
  const add = (/** @type {string[]} */ list, /** @type {string | undefined} */ ref) => {
    const p = ref === undefined ? null : localRef(ref);
    if (p && !list.includes(p)) list.push(p);
  };
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of withoutComments.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    if (m[1].toLowerCase() === 'script') {
      if ((a.type ?? '').toLowerCase() === 'module') add(refs.entry, a.src);
      continue;
    }
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('modulepreload')) add(refs.modulepreload, a.href);
    else if (rel.includes('stylesheet')) add(refs.stylesheets, a.href);
  }
  return refs;
}

/** @returns {'js' | 'css' | 'other'} */
function kindOf(/** @type {string} */ file) {
  if (/\.(m|c)?js$/i.test(file)) return 'js';
  if (/\.css$/i.test(file)) return 'css';
  return 'other';
}

/** Files under `dir` (recursive), relative to it with '/' separators; [] when it does not exist. */
function walk(/** @type {string} */ dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

/** @returns {SizeTotal} */
function total(/** @type {FileSize[]} */ files) {
  return files.reduce((t, f) => ({ raw: t.raw + f.raw, gzip: t.gzip + f.gzip, count: t.count + 1 }), { raw: 0, gzip: 0, count: 0 });
}

/**
 * Size report of a build folder: out/renderer/assets/** (initial = loaded by index.html up front),
 * out/main/*.cjs, out/preload/*.cjs. Source maps are not shipped and are left out.
 * @returns {SizeReport}
 */
export function buildSizeReport(outDir = DEFAULT_OUT_DIR) {
  const indexFile = path.join(outDir, 'renderer', 'index.html');
  if (!existsSync(indexFile)) throw new Error(`${indexFile} not found — run \`npm run build\` first`);
  const refs = parseIndexHtml(readFileSync(indexFile, 'utf8'));
  const initialJs = [...refs.entry, ...refs.modulepreload.filter((p) => !refs.entry.includes(p))].map((p) => `renderer/${p}`);
  const initialCss = refs.stylesheets.map((p) => `renderer/${p}`);
  if (refs.entry.length === 0) throw new Error(`${indexFile} has no <script type="module"> entry`);

  /** @type {FileSize[]} */
  const files = [];
  const add = (/** @type {'renderer' | 'main' | 'preload'} */ area, /** @type {string} */ rel) => {
    const data = readFileSync(path.join(outDir, ...rel.split('/')));
    const s = sizeOf(data);
    files.push({ file: rel, area, kind: kindOf(rel), raw: s.raw, gzip: s.gzip, initial: initialJs.includes(rel) || initialCss.includes(rel) });
  };
  for (const f of walk(path.join(outDir, 'renderer', 'assets'))) if (!f.endsWith('.map')) add('renderer', `renderer/assets/${f}`);
  for (const area of /** @type {const} */ (['main', 'preload'])) {
    for (const f of walk(path.join(outDir, area))) if (/\.cjs$/i.test(f) && !f.includes('/')) add(area, `${area}/${f}`);
  }
  const listed = new Set(files.map((f) => f.file));
  const missing = [...initialJs, ...initialCss].filter((f) => !listed.has(f));
  if (missing.length > 0) throw new Error(`index.html loads files that are not in ${path.join(outDir, 'renderer', 'assets')}: ${missing.join(', ')}`);

  const renderer = files.filter((f) => f.area === 'renderer');
  return {
    version: REPORT_VERSION,
    files,
    initial: { js: initialJs, css: initialCss },
    totals: {
      initialJs: total(renderer.filter((f) => initialJs.includes(f.file))),
      initialCss: total(renderer.filter((f) => initialCss.includes(f.file))),
      rendererJs: total(renderer.filter((f) => f.kind === 'js')),
      rendererCss: total(renderer.filter((f) => f.kind === 'css')),
      rendererOther: total(renderer.filter((f) => f.kind === 'other')),
      main: total(files.filter((f) => f.area === 'main')),
      preload: total(files.filter((f) => f.area === 'preload')),
    },
  };
}

function kb(/** @type {number} */ bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The report as a plain-text table (CI logs). */
export function formatSizeReport(/** @type {SizeReport} */ report) {
  const width = Math.max(40, ...report.files.map((f) => f.file.length));
  const line = (/** @type {string} */ name, /** @type {number} */ raw, /** @type {number} */ gzip, mark = '') =>
    `${name.padEnd(width)}  ${kb(raw).padStart(10)}  ${kb(gzip).padStart(10)}  ${mark}`.trimEnd();
  const rows = [`${'File'.padEnd(width)}  ${'raw'.padStart(10)}  ${'gzip'.padStart(10)}`];
  for (const f of report.files) rows.push(line(f.file, f.raw, f.gzip, f.initial ? 'initial' : ''));
  rows.push('');
  const t = report.totals;
  rows.push(line(`Initial JS (entry + ${Math.max(0, t.initialJs.count - 1)} modulepreload)`, t.initialJs.raw, t.initialJs.gzip));
  rows.push(line(`Initial CSS (${t.initialCss.count})`, t.initialCss.raw, t.initialCss.gzip));
  rows.push(line(`Renderer JS total (${t.rendererJs.count})`, t.rendererJs.raw, t.rendererJs.gzip));
  rows.push(line(`Renderer CSS total (${t.rendererCss.count})`, t.rendererCss.raw, t.rendererCss.gzip));
  if (t.rendererOther.count > 0) rows.push(line(`Renderer other assets (${t.rendererOther.count})`, t.rendererOther.raw, t.rendererOther.gzip));
  rows.push(line(`Main process (${t.main.count})`, t.main.raw, t.main.gzip));
  if (t.preload.count > 0) rows.push(line(`Preload (${t.preload.count})`, t.preload.raw, t.preload.gzip));
  return rows.join('\n');
}

/** Nearest-rank percentile (p in 0–100) of the values; null for none. */
export function percentile(/** @type {readonly number[]} */ values, /** @type {number} */ p) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const rank = Math.min(finite.length, Math.max(1, Math.ceil((p / 100) * finite.length)));
  return finite[rank - 1];
}

const isNum = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (/** @type {unknown} */ v) => v === null || isNum(v);
const isObj = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Problems with a parsed build/perf-budget.json ([] when it is well-formed):
 * `{ enforce: boolean, baseline: null | Baseline, ceilings: Ceilings }`.
 * @returns {string[]}
 */
export function budgetProblems(/** @type {unknown} */ budget) {
  /** @type {string[]} */
  const out = [];
  if (!isObj(budget)) return ['the budget is not an object'];
  const b = /** @type {Record<string, unknown>} */ (budget);
  if (typeof b.enforce !== 'boolean') out.push('enforce must be true or false');
  const c = /** @type {Record<string, unknown>} */ (b.ceilings);
  if (!isObj(c)) out.push('ceilings must be an object');
  else {
    for (const k of ['initialJsRatio', 'startupRatio', 'screenOpenSlackMs', 'rendererJsMaxBytes', 'rendererCssMaxBytes']) {
      if (!isNumOrNull(c[k])) out.push(`ceilings.${k} must be a number or null`);
    }
    if (typeof c.screenOpenWarnOnly !== 'boolean') out.push('ceilings.screenOpenWarnOnly must be true or false');
  }
  if (b.baseline !== null) {
    const base = /** @type {Record<string, unknown>} */ (b.baseline);
    if (!isObj(base)) out.push('baseline must be null or an object');
    else {
      if (typeof base.capturedFrom !== 'string' || base.capturedFrom === '') out.push('baseline.capturedFrom must name the CI run / commit');
      const sizes = /** @type {Record<string, unknown>} */ (base.sizes);
      if (!isObj(sizes)) out.push('baseline.sizes must be an object');
      else {
        for (const k of ['initialJs', 'rendererJs', 'rendererCss', 'main']) {
          const s = /** @type {Record<string, unknown>} */ (sizes[k]);
          if (!isObj(s) || !isNum(s.raw) || !isNum(s.gzip)) out.push(`baseline.sizes.${k} must be { raw, gzip }`);
        }
      }
      const timings = /** @type {Record<string, unknown>} */ (base.timings);
      if (!isObj(timings)) out.push('baseline.timings must be an object keyed by platform');
      else {
        for (const [platform, raw] of Object.entries(timings)) {
          const t = /** @type {Record<string, unknown>} */ (raw);
          if (!isObj(t) || !isNumOrNull(t.startupMs) || !isNumOrNull(t.launchMs) || !isNumOrNull(t.screenOpenP95Ms) || !isObj(t.screenOpenMs)) {
            out.push(`baseline.timings.${platform} must be { startupMs, launchMs, screenOpenMs: {…}, screenOpenP95Ms }`);
          } else if (!Object.values(/** @type {Record<string, unknown>} */ (t.screenOpenMs)).every(isNum)) {
            out.push(`baseline.timings.${platform}.screenOpenMs must map screen ids to ms`);
          } else if (t.screenReadyMs !== undefined && (!isObj(t.screenReadyMs) || !Object.values(/** @type {Record<string, unknown>} */ (t.screenReadyMs)).every(isNum))) {
            out.push(`baseline.timings.${platform}.screenReadyMs must map screen ids to ms`);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Compare a run with the budget. Without a baseline only the absolute ceilings apply. With
 * `enforce: false` the caller only reports; `failures` are the checks that would fail an enforced
 * run, `warnings` the warn-only ones (screen-open timings on noisy runners).
 * @param {{ sizes: SizeReport, timings?: GateTimings | null, platform?: string }} run
 * @param {Budget} budget
 * @returns {BudgetResult}
 */
export function compareBudget(run, budget) {
  /** @type {BudgetCheck[]} */
  const checks = [];
  /** @type {string[]} */
  const notes = [];
  const c = budget.ceilings;
  const base = budget.baseline;
  const push = (/** @type {Omit<BudgetCheck, 'ok'>} */ check) => checks.push({ ...check, ok: check.actual <= check.limit });
  const t = run.sizes.totals;

  if (c.rendererJsMaxBytes !== null) push({ id: 'rendererJs', label: 'Renderer JS total (raw)', unit: 'bytes', actual: t.rendererJs.raw, limit: c.rendererJsMaxBytes, warnOnly: false });
  if (c.rendererCssMaxBytes !== null) push({ id: 'rendererCss', label: 'Renderer CSS total (raw)', unit: 'bytes', actual: t.rendererCss.raw, limit: c.rendererCssMaxBytes, warnOnly: false });

  if (!base) {
    notes.push('No baseline in build/perf-budget.json yet: only absolute ceilings are checked.');
  } else {
    if (c.initialJsRatio !== null) {
      push({ id: 'initialJs', label: `Initial JS (raw) ≤ ${c.initialJsRatio} × baseline`, unit: 'bytes', actual: t.initialJs.raw, limit: Math.round(base.sizes.initialJs.raw * c.initialJsRatio), warnOnly: false });
    }
    const platform = run.platform ?? 'unknown';
    const bt = base.timings[platform];
    const rt = run.timings ?? null;
    if (!rt) notes.push('No timings in this run: timing ceilings skipped.');
    else if (!bt) notes.push(`No baseline timings for platform "${platform}": timing ceilings skipped.`);
    else {
      if (c.startupRatio !== null) {
        if (isNum(bt.startupMs) && isNum(rt.startupMs)) {
          push({ id: 'startup', label: `Start-up (boot → shell-ready) ≤ ${c.startupRatio} × baseline`, unit: 'ms', actual: /** @type {number} */ (rt.startupMs), limit: Math.round(/** @type {number} */ (bt.startupMs) * c.startupRatio), warnOnly: false });
        }
        if (isNum(bt.launchMs) && isNum(rt.launchMs)) {
          push({ id: 'launch', label: `Launch (navigation → shell-ready) ≤ ${c.startupRatio} × baseline`, unit: 'ms', actual: /** @type {number} */ (rt.launchMs), limit: Math.round(/** @type {number} */ (bt.launchMs) * c.startupRatio), warnOnly: false });
        }
      }
      if (c.screenOpenSlackMs !== null) {
        const slack = c.screenOpenSlackMs;
        for (const [screen, ms] of Object.entries(rt.screenOpenMs)) {
          const b = bt.screenOpenMs[screen];
          if (isNum(b)) push({ id: `screenOpen:${screen}`, label: `First open of ${screen} ≤ baseline + ${slack} ms`, unit: 'ms', actual: ms, limit: b + slack, warnOnly: c.screenOpenWarnOnly });
        }
        if (isNum(bt.screenOpenP95Ms) && isNum(rt.screenOpenP95Ms)) {
          push({ id: 'screenOpenP95', label: `Screen open p95 (first opens) ≤ baseline + ${slack} ms`, unit: 'ms', actual: /** @type {number} */ (rt.screenOpenP95Ms), limit: /** @type {number} */ (bt.screenOpenP95Ms) + slack, warnOnly: c.screenOpenWarnOnly });
        }
        // Key press → the screen's data shown (no skeleton or busy region left): what a lazy screen's
        // Suspense fallback must not hide. Always warn-only: it includes the API call.
        for (const [screen, ms] of Object.entries(rt.screenReadyMs ?? {})) {
          const b = (bt.screenReadyMs ?? {})[screen];
          if (isNum(b) && isNum(ms)) push({ id: `screenReady:${screen}`, label: `First open of ${screen} with its data ≤ baseline + ${slack} ms`, unit: 'ms', actual: ms, limit: b + slack, warnOnly: true });
        }
      }
    }
  }
  return {
    enforce: budget.enforce,
    hasBaseline: base !== null,
    checks,
    failures: checks.filter((x) => !x.ok && !x.warnOnly),
    warnings: checks.filter((x) => !x.ok && x.warnOnly),
    notes,
  };
}

/** The comparison as text lines (CI logs). */
export function formatBudgetResult(/** @type {BudgetResult} */ result) {
  const fmt = (/** @type {BudgetCheck} */ x) => (x.unit === 'bytes' ? kb : (/** @type {number} */ v) => `${Math.round(v)} ms`);
  const lines = [`Performance budget (${result.enforce ? 'enforced' : 'report only'}${result.hasBaseline ? '' : ', no baseline yet'})`];
  for (const x of result.checks) lines.push(`  ${x.ok ? 'ok  ' : x.warnOnly ? 'WARN' : 'FAIL'}  ${x.label}: ${fmt(x)(x.actual)} (limit ${fmt(x)(x.limit)})`);
  for (const n of result.notes) lines.push(`  note  ${n}`);
  return lines.join('\n');
}

/** The marker e2e/perf.spec.ts prints before the one-line JSON report in the job log. */
export const PERF_REPORT_MARKER = '[perf] report ';

/**
 * A perf report from what the integrator has: perf-report.json itself, the `[perf] report {…}` line
 * copied from the CI job log (with or without the log's timestamp prefix), or the whole job log.
 * @returns {unknown}
 */
export function parsePerfReport(/** @type {string} */ text) {
  const at = text.lastIndexOf(PERF_REPORT_MARKER);
  if (at < 0) return JSON.parse(text);
  const line = text.slice(at + PERF_REPORT_MARKER.length).split(/\r?\n/)[0];
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('the `[perf] report` line is not complete JSON — copy the whole line from the job log');
  }
}

/**
 * The `baseline` block of build/perf-budget.json from the perf reports of one CI run (one per
 * platform: e2e/perf.spec.ts attaches perf-report.json and prints it to the job log). Sizes come from
 * the Linux report when there is one, else the first: the gate compares initial JS by ratio, and the
 * bundles of the platforms differ by a few bytes at most.
 * @param {readonly unknown[]} reports
 * @param {string} capturedFrom e.g. 'CI run 1234 @ abc1234 (1.0)'
 * @returns {Baseline}
 */
export function makeBaseline(reports, capturedFrom) {
  if (reports.length === 0) throw new Error('makeBaseline needs at least one perf-report.json');
  /** @type {Record<string, GateTimings>} */
  const timings = {};
  /** @type {SizeReport | null} */
  let sizes = null;
  for (const raw of reports) {
    const r = /** @type {{ platform?: unknown, sizes?: SizeReport, timings?: Partial<GateTimings> | null }} */ (raw);
    if (!isObj(r) || typeof r.platform !== 'string' || !r.sizes || !isObj(r.sizes.totals)) throw new Error('not a perf-report.json (platform, sizes, timings)');
    if (sizes === null || r.platform === 'linux') sizes = r.sizes;
    const t = r.timings ?? null;
    timings[r.platform] = {
      startupMs: t && isNum(t.startupMs) ? /** @type {number} */ (t.startupMs) : null,
      launchMs: t && isNum(t.launchMs) ? /** @type {number} */ (t.launchMs) : null,
      screenOpenMs: t && isObj(t.screenOpenMs) ? { .../** @type {Record<string, number>} */ (t.screenOpenMs) } : {},
      screenOpenP95Ms: t && isNum(t.screenOpenP95Ms) ? /** @type {number} */ (t.screenOpenP95Ms) : null,
      screenReadyMs: t && isObj(t.screenReadyMs) ? Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (t.screenReadyMs)).filter(([, v]) => isNum(v))) : {},
    };
  }
  const s = /** @type {SizeReport} */ (sizes).totals;
  const pick = (/** @type {SizeTotal} */ x) => ({ raw: x.raw, gzip: x.gzip });
  return { capturedFrom, sizes: { initialJs: pick(s.initialJs), rendererJs: pick(s.rendererJs), rendererCss: pick(s.rendererCss), main: pick(s.main) }, timings };
}

/** Read and check build/perf-budget.json. @returns {Budget} */
export function readBudget(file = DEFAULT_BUDGET_FILE) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const problems = budgetProblems(parsed);
  if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
  return /** @type {Budget} */ (parsed);
}

function argValue(/** @type {string[]} */ argv, /** @type {string} */ flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  return v;
}

function main(/** @type {string[]} */ argv) {
  if (argv.includes('--baseline')) {
    /** @type {string[]} */
    const files = [];
    for (let i = argv.indexOf('--baseline') + 1; i < argv.length; i++) {
      if (argv[i] === '--from') i++; // its value is not a report
      else if (!argv[i].startsWith('--')) files.push(argv[i]);
    }
    if (files.length === 0) throw new Error('--baseline needs the perf report of each platform (perf-report.json or the e2e job log)');
    const reports = files.map((f) => {
      try {
        return parsePerfReport(readFileSync(f, 'utf8'));
      } catch (err) {
        throw new Error(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const from = argValue(argv, '--from') ?? reports.map((r) => (isObj(r) && typeof r.commit === 'string' ? r.commit : '')).find((c) => c !== '') ?? 'unknown';
    console.log(JSON.stringify({ baseline: makeBaseline(reports, from) }, null, 2));
    return 0;
  }
  const outDir = path.resolve(argValue(argv, '--dir') ?? DEFAULT_OUT_DIR);
  const report = buildSizeReport(outDir);
  const outFile = argValue(argv, '--out');
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatSizeReport(report));
  if (argv.includes('--budget')) {
    const result = compareBudget({ sizes: report, timings: null, platform: process.platform }, readBudget());
    console.log(`\n${formatBudgetResult(result)}`);
    if (result.enforce && result.failures.length > 0) return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`size-report: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
