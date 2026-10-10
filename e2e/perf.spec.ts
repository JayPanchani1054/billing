// Performance harness (docs/ARCHITECTURE.md §9a): measures a build, never builds one.
//
//   sizes       scripts/size-report.mjs against out/ (initial JS = entry + modulepreloads, totals)
//   start-up    the app is launched twice on the same folders: the first run creates the company, the
//               second is timed — `pevqori:boot` → `pevqori:first-screen` (the company list) and Enter
//               on the list → `pevqori:shell-ready` (src/renderer/app/lib/perfMarks.ts), so the test
//               driver's own wait at the list is not part of the number
//   screen open key press → visible h1 of the screen, for F8 (Sales), Day Book, Balance Sheet,
//               Receivables and GSTR-1 (the last four through Go To, Enter on the item): first open,
//               then a few warm re-opens; also key press → the screen with its data (no skeleton or
//               busy region left), reported and warn-only
//
// Everything is timed inside the page (the app's marks, event.timeStamp of the key press, a
// MutationObserver for the result), so the Playwright round trip is not part of a number. No trace is recorded (tracing slows
// the app). The result is attached as perf-report.json and printed to the log as one `[perf] report`
// line, compared with build/perf-budget.json: with `enforce: false` (until the integration step) the
// spec only reports; with `enforce: true` a failed ceiling fails it, except the warn-only screen-open
// ones. `node scripts/size-report.mjs --baseline linux.json win32.json` turns the reports of one CI run
// into the budget's baseline block.
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BOOT_MARK, FIRST_SCREEN_MARK, SHELL_READY_MARK } from '../src/renderer/app/lib/perfMarks.ts';
import { firstLaunchCreateCompany, openGoto, screen, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp, repoRoot } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Perf Traders E2E', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;

/** The screens timed (spec §10): F8 by its key, the others through Go To (by their menu label). */
const SCREENS: readonly { id: string; label: string; key?: 'F8' }[] = [
  { id: 'vouchers.entry', label: 'Sales (F8)', key: 'F8' },
  { id: 'vouchers.daybook', label: 'Day Book' },
  { id: 'reports.balanceSheet', label: 'Balance Sheet' },
  { id: 'outstanding.receivables', label: 'Receivables' },
  { id: 'gst.gstr1', label: 'GSTR-1' },
];
/** Warm re-opens per screen after the first open. */
const WARM_REPEATS = 3;
/** Inside a screen, what says its data is still loading (app/Screen.tsx skeleton, ui/Skeleton, aria-busy regions). */
const BUSY = '.bx-screen-skeleton, .bx-skeleton, [aria-busy="true"]';
/** How long to wait for a screen's data before reporting it as not ready (null). */
const READY_TIMEOUT_MS = 15_000;

// The subset of scripts/size-report.mjs used here (a plain .mjs: imported like src/main/ci-workflows.test.ts does).
interface SizeTotal {
  raw: number;
  gzip: number;
  count: number;
}
interface SizeReport {
  totals: Record<'initialJs' | 'initialCss' | 'rendererJs' | 'rendererCss' | 'rendererOther' | 'main' | 'preload', SizeTotal>;
}
interface GateTimings {
  startupMs: number | null;
  launchMs: number | null;
  screenOpenMs: Record<string, number>;
  screenOpenP95Ms: number | null;
  screenReadyMs?: Record<string, number>;
}
interface BudgetCheck {
  id: string;
  label: string;
  actual: number;
  limit: number;
}
interface BudgetResult {
  enforce: boolean;
  failures: BudgetCheck[];
  warnings: BudgetCheck[];
}
interface SizeReportModule {
  buildSizeReport(outDir: string): SizeReport;
  formatSizeReport(report: SizeReport): string;
  percentile(values: readonly number[], p: number): number | null;
  readBudget(file?: string): unknown;
  compareBudget(run: { sizes: SizeReport; timings?: GateTimings | null; platform?: string }, budget: unknown): BudgetResult;
  formatBudgetResult(result: BudgetResult): string;
}

interface StartupDetail {
  /** Navigation start → `pevqori:boot` (HTML + entry bundle download, parse, evaluation). */
  navigationToBootMs: number;
  /** `pevqori:boot` → `pevqori:first-screen` (the company list committed). */
  bootToFirstScreenMs: number;
  /** Enter on the company list → `pevqori:shell-ready`. */
  openToShellReadyMs: number;
  /** `pevqori:boot` → `pevqori:shell-ready` as marked, including the test driver's wait before Enter. */
  bootToShellReadyRawMs: number;
}

interface ProbeResult {
  /** timeStamp of the start key's keydown (null: no start key, or it never reached the page). */
  start: number | null;
  /** performance.now() when the target was first rendered. */
  at: number;
  /** performance.now() when the target was rendered with nothing busy left in `readyWithin` (null: not yet / not asked). */
  readyAt: number | null;
}

let sizeModule: SizeReportModule;
let sizes: SizeReport | undefined;
let launched: LaunchedApp | undefined;
/** The folders kept between the two launches (deleted by the last closeApp, or here when a relaunch failed). */
let keptFolders: string | undefined;
let page: Page;
let startup: StartupDetail | undefined;
const firstOpen: Record<string, number> = {};
const firstReady: Record<string, number> = {};
const warmOpen: Record<string, number[]> = {};

test.describe.configure({ mode: 'serial' });

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
  if (!launched && keptFolders) rmSync(keptFolders, { recursive: true, force: true });
});

/**
 * Install an in-page probe under `key`: `at` = performance.now() when an element matching `selector`
 * is first rendered (has a layout box) after the first keydown of `startKey` (its timeStamp is
 * `start`); with `readyWithin`, `readyAt` = the first moment that element is rendered and the
 * `readyWithin` element holds nothing busy (BUSY). Nothing here waits on Playwright.
 */
async function installProbe(p: Page, key: string, opts: { selector: string; startKey: string; readyWithin?: string }): Promise<void> {
  await p.evaluate(
    ([probeKey, selector, startKey, readyWithin, busy, readyTimeout]) => {
      const w = window as unknown as Record<string, unknown>;
      const probe: { start: number | null; at: number | null; readyAt: number | null } = { start: null, at: null, readyAt: null };
      w[probeKey] = probe;
      const shown = () => Array.from(document.querySelectorAll(selector)).some((el) => el.getClientRects().length > 0);
      const idle = () => {
        const root = document.querySelector(readyWithin);
        return root !== null && root.querySelector(busy) === null;
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== startKey || probe.start !== null) return;
        probe.start = e.timeStamp;
        window.removeEventListener('keydown', onKey, true);
      };
      window.addEventListener('keydown', onKey, true);
      const obs = new MutationObserver(() => {
        if (probe.start === null) return;
        const now = performance.now();
        if (probe.at === null) {
          if (!shown()) return;
          probe.at = now;
        }
        if (readyWithin === '') {
          obs.disconnect();
          return;
        }
        if (probe.readyAt === null && shown() && idle()) {
          probe.readyAt = now;
          obs.disconnect();
        }
      });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      // A screen whose data never settles is reported as not ready; the observer does not outlive it.
      setTimeout(() => obs.disconnect(), readyTimeout);
    },
    [key, opts.selector, opts.startKey, opts.readyWithin ?? '', BUSY, READY_TIMEOUT_MS + 5_000] as const,
  );
}

/** Wait for the probe's target (and, when asked, for its data: null after READY_TIMEOUT_MS). */
async function readProbe(p: Page, key: string, opts: { timeout?: number; ready?: boolean } = {}): Promise<ProbeResult> {
  type Probe = { start: number | null; at: number | null; readyAt: number | null };
  await p.waitForFunction((k) => ((window as unknown as Record<string, Probe | undefined>)[k]?.at ?? null) !== null, key, { timeout: opts.timeout ?? 30_000 });
  if (opts.ready) {
    await p
      .waitForFunction((k) => ((window as unknown as Record<string, Probe | undefined>)[k]?.readyAt ?? null) !== null, key, { timeout: READY_TIMEOUT_MS })
      .catch(() => undefined);
  }
  const probe = await p.evaluate((k) => {
    const v = (window as unknown as Record<string, Probe | undefined>)[k];
    return v ? { start: v.start, at: v.at, readyAt: v.readyAt } : null;
  }, key);
  if (!probe || probe.at === null) throw new Error(`probe ${key} vanished`);
  return { start: probe.start, at: probe.at, readyAt: probe.readyAt };
}

/** The Go To option of a timed screen: its menu item ('menu:<module>:<screen>:<label>') or its screen entry. */
function gotoOption(p: Page, target: (typeof SCREENS)[number]) {
  const label = target.label.replace(/["\\]/g, '\\$&');
  return p.locator(`[data-goto-id^="menu:"][data-goto-id*=":${target.id}:"][data-goto-id$=":${label}"], [data-goto-id="screen:${target.id}"]`).first();
}

/**
 * Open one timed screen from Home; returns key press → visible h1 and, `withData`, key press → the
 * screen with its data (null: it did not settle within READY_TIMEOUT_MS).
 */
async function timeOpen(target: (typeof SCREENS)[number], probeKey: string, withData: boolean): Promise<{ openMs: number; readyMs: number | null }> {
  const root = `[data-screen="${target.id}"]:not([hidden])`;
  const probeOpts = { selector: `${root} h1`, readyWithin: root };
  if (target.key) {
    await toGateway(page);
    await installProbe(page, probeKey, { ...probeOpts, startKey: target.key });
    await page.keyboard.press(target.key);
  } else {
    const input = await openGoto(page);
    await input.fill(target.label);
    // Let the debounced ledger/item/voucher search settle: its results re-rank the list and reset the
    // highlighted row, which must not happen between the check below and Enter.
    await page.waitForTimeout(300);
    const palette = page.getByRole('dialog').filter({ has: input });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('status')).toHaveCount(0, { timeout: 10_000 }); // its "Searching" spinner
    const option = gotoOption(page, target);
    await expect(option).toBeVisible();
    for (let i = 0; i < 40 && (await option.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await installProbe(page, probeKey, { ...probeOpts, startKey: 'Enter' });
    await page.keyboard.press('Enter');
  }
  const probe = await readProbe(page, probeKey, { ready: withData });
  await expect(screen(page, target.id).locator('h1').first()).toBeVisible();
  expect(probe.start, `the ${target.key ?? 'Enter'} key press reached the page`).not.toBeNull();
  const start = probe.start ?? probe.at;
  return { openMs: Math.max(0, probe.at - start), readyMs: probe.readyAt === null ? null : Math.max(0, probe.readyAt - start) };
}

const round = (ms: number) => Math.round(ms * 10) / 10;

test('build sizes: renderer assets, main bundles, initial JS (scripts/size-report.mjs)', async () => {
  sizeModule = (await import(pathToFileURL(path.join(repoRoot, 'scripts/size-report.mjs')).href)) as SizeReportModule;
  sizes = sizeModule.buildSizeReport(path.join(repoRoot, 'out'));
  console.log(`[perf] sizes\n${sizeModule.formatSizeReport(sizes)}`);
  expect(sizes.totals.initialJs.count, 'the entry script is found in out/renderer/index.html').toBeGreaterThan(0);
  expect(sizes.totals.main.count).toBeGreaterThan(0);
});

test('first launch: create the company (not timed)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp('pevqori-e2e-perf-', { trace: false });
  page = launched.page;
  await firstLaunchCreateCompany(page, launched.dataDir, COMPANY);
  await toGateway(page);
});

test('second launch on the same folders: boot → shell-ready', async ({}, testInfo) => {
  const first = launched;
  if (!first) throw new Error('the first launch did not run');
  await closeApp(first, testInfo, { keepFolders: true });
  launched = undefined;
  keptFolders = first.tmp;
  test.setTimeout(150_000);
  launched = await launchApp('pevqori-e2e-perf-', { trace: false, reuse: first });
  page = launched.page;

  // The company list (no company opens by itself on start): App.tsx marks it as the first screen.
  await page.waitForFunction((name) => performance.getEntriesByName(name, 'mark').length > 0, FIRST_SCREEN_MARK, { timeout: 60_000 });
  await expect(page.getByText(COMPANY.name, { exact: true }).first()).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search companies' });
  await expect(search).toBeVisible();
  if (!(await search.evaluate((el) => el === document.activeElement))) await search.focus();
  await installProbe(page, '__perfOpen', { selector: '[data-screen="app.gateway"]', startKey: 'Enter' });
  await page.keyboard.press('Enter');
  await page.waitForFunction((name) => performance.getEntriesByName(name, 'mark').length > 0, SHELL_READY_MARK, { timeout: 60_000 });
  const open = await readProbe(page, '__perfOpen', { timeout: 60_000 });
  await expect(screen(page, 'app.gateway')).toBeVisible();

  const marks = await page.evaluate(
    ([boot, first, ready]) => {
      const at = (name: string) => performance.getEntriesByName(name, 'mark')[0]?.startTime ?? null;
      return { boot: at(boot), first: at(first), ready: at(ready) };
    },
    [BOOT_MARK, FIRST_SCREEN_MARK, SHELL_READY_MARK] as const,
  );
  expect(marks.boot, `${BOOT_MARK} is marked (src/renderer/main.tsx)`).not.toBeNull();
  expect(marks.first, `${FIRST_SCREEN_MARK} is marked (src/renderer/app/App.tsx)`).not.toBeNull();
  expect(marks.ready, `${SHELL_READY_MARK} is marked (src/renderer/app/App.tsx)`).not.toBeNull();
  expect(open.start, 'the Enter key press reached the page').not.toBeNull();
  const boot = marks.boot ?? 0;
  const firstScreen = marks.first ?? 0;
  const ready = marks.ready ?? 0;
  expect(firstScreen, 'boot ≤ first screen ≤ Enter ≤ shell-ready').toBeGreaterThanOrEqual(boot);
  expect(open.start ?? 0).toBeGreaterThanOrEqual(firstScreen);
  expect(ready).toBeGreaterThanOrEqual(open.start ?? 0);
  startup = {
    navigationToBootMs: round(boot),
    bootToFirstScreenMs: round(firstScreen - boot),
    openToShellReadyMs: round(ready - (open.start ?? ready)),
    bootToShellReadyRawMs: round(ready - boot),
  };
  console.log(`[perf] start-up ${JSON.stringify(startup)}`);
});

test('screen open: key press → visible h1 (F8, Day Book, Balance Sheet, Receivables, GSTR-1)', async () => {
  test.setTimeout(300_000);
  let n = 0;
  for (const target of SCREENS) {
    const t = await timeOpen(target, `__perfScreen${n++}`, true);
    firstOpen[target.id] = round(t.openMs);
    if (t.readyMs !== null) firstReady[target.id] = round(t.readyMs);
    await toGateway(page);
  }
  for (let r = 0; r < WARM_REPEATS; r++) {
    for (const target of SCREENS) {
      (warmOpen[target.id] ??= []).push(round((await timeOpen(target, `__perfScreen${n++}`, false)).openMs));
      await toGateway(page);
    }
  }
  console.log(`[perf] first open (ms) ${JSON.stringify(firstOpen)}`);
  console.log(`[perf] first open with data (ms) ${JSON.stringify(firstReady)}`);
  console.log(`[perf] warm opens (ms) ${JSON.stringify(warmOpen)}`);
});

test('report: perf-report.json against build/perf-budget.json', async ({}, testInfo) => {
  if (!sizes) throw new Error('the size report did not run');
  const s = startup;
  const gate: GateTimings | null = s
    ? {
        // Boot → shell-ready without the driver's wait at the company list; launch adds navigation → boot.
        startupMs: round(s.bootToFirstScreenMs + s.openToShellReadyMs),
        launchMs: round(s.navigationToBootMs + s.bootToFirstScreenMs + s.openToShellReadyMs),
        screenOpenMs: { ...firstOpen },
        screenOpenP95Ms: sizeModule.percentile(Object.values(firstOpen), 95),
        // Screens whose data never settled within READY_TIMEOUT_MS are left out (not judged).
        screenReadyMs: { ...firstReady },
      }
    : null;
  const warm = Object.fromEntries(
    Object.entries(warmOpen).map(([id, samples]) => [id, { samples, p50: sizeModule.percentile(samples, 50), p95: sizeModule.percentile(samples, 95) }]),
  );
  const result = sizeModule.compareBudget({ sizes, timings: gate, platform: process.platform }, sizeModule.readBudget());
  const versions = launched ? await launched.app.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron })) : null;
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    appVersion: versions?.app ?? null,
    electron: versions?.electron ?? null,
    commit: process.env.GITHUB_SHA ?? null,
    ci: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : null,
    sizes,
    timings: gate ? { ...gate, startup: s, screenOpenWarm: warm } : null,
    budget: result,
  };
  const file = testInfo.outputPath('perf-report.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach('perf-report.json', { path: file, contentType: 'application/json' });
  console.log(sizeModule.formatBudgetResult(result));
  // One line the integrator can copy from the CI job log (the HTML report is uploaded only on failure).
  console.log(`[perf] report ${JSON.stringify(report)}`);
  for (const w of result.warnings) testInfo.annotations.push({ type: 'warning', description: `${w.label}: ${w.actual} (limit ${w.limit})` });
  if (result.enforce) {
    expect(result.failures.map((f) => `${f.label}: ${f.actual} > ${f.limit}`), sizeModule.formatBudgetResult(result)).toEqual([]);
  }
});
