// Every screen, rendered: a fresh company with every F11 feature on and a few masters and vouchers,
// then EVERY item of the Go To catalogue is opened through the palette (Ctrl+G, its exact label, the
// option with its palette id) and checked:
//
//   - a new screen is shown — its [data-screen] region is visible with an h1 (a dialog screen: the
//     dialog with its heading);
//   - it is not the error boundary ("… ran into a problem" — also where it replaced a dialog screen),
//     has no "Something went wrong" and did not fail its first load ("This could not be loaded");
//   - no uncaught page error, no console error from React or the app ("[pevqori] …") while it was open;
//
// then Esc goes back to the Gateway. When the screen lists rows, Enter on the first row opens the next
// level once per screen (the alteration / drill-down screens that take an id), checked the same way.
//
// The catalogue is not a hand-kept list: the open palette answers a `pevqori:goto-catalog` event with its
// own items and the registered screens (src/renderer/app/lib/gotoCatalog.ts). Shell commands (working
// date, period, switch company, shortcuts, voucher-type picker) open shell dialogs, not screens, and are
// skipped with a logged reason; so are registered screens no Go To item or first-row Enter reaches
// (listed with their ids at the end). A failing screen does not stop the sweep: every failure is
// collected and reported together at the end.
//
// API twin (the same feature set, seed and vouchers through runtime.dispatch):
// src/core/testing/e2e/screens.test.ts.
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { FEATURE_CATALOG } from '../src/renderer/app/lib/featureCatalog.ts';
import { GOTO_CATALOG_EVENT } from '../src/renderer/app/lib/gotoCatalog.ts';
import type { GotoCatalogEntry, GotoCatalogSnapshot } from '../src/renderer/app/lib/gotoCatalog.ts';
import { chequePaymentInput, exportInvoiceInput, PARITY, quotationInput, seedParityMasters } from '../src/core/testing/e2e/parityFlow.ts';
import type { ApiCall } from '../src/core/testing/e2e/parityFlow.ts';
import { api, enableFeatures, firstLaunchCreateCompany, localToday, openGoto, openGotoItem, screen, stubNativeDialogs, toGateway, topScreen } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Every Screen Traders E2E', gstin: PARITY.company.gstin, state: PARITY.company.state } as const;

/**
 * Every F11 feature the Features screen changes (security is turned on elsewhere, with a password),
 * prerequisites first: a switch stays disabled until the feature it `requires` is on.
 */
const ALL_FEATURES = (() => {
  const byKey = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));
  const depth = (key: string): number => {
    let d = 0;
    for (let req = byKey.get(key as (typeof FEATURE_CATALOG)[number]['key'])?.requires; req; req = byKey.get(req)?.requires) d++;
    return d;
  };
  return FEATURE_CATALOG.filter((f) => !f.managedOn)
    .map((f, i) => ({ f, i, d: depth(f.key) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ f }) => f.label);
})();

/**
 * Screens where Enter on the first row may change data or start a long task (restore a backup, post
 * a due voucher, tick a payment for a bank file, set a bank date, open an attached file with the OS…):
 * opened, but not drilled into.
 */
const NO_DRILL = /^(attachments\.manage|data\.|banking\.|cheques\.(print|epayments)|documents\.recurring\.due|gst\.(setoff|einvoice|ewaybill|filings)|gstrecon\.|pos\.|security\.(users|settings)|tds\.(challan|return))/;

let launched: LaunchedApp | undefined;
let app: ElectronApplication;
let page: Page;
let dataDir: string;

/** Uncaught page errors and console errors, in order (each check looks at what arrived while its screen was open). */
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

/** Console errors that mean a broken screen: the app's own (error boundary, unhandled rejection) and React's. */
const BROKEN = /\[pevqori\]|React|Minified|Uncaught|Warning:/;

// No retry: the sweep reports every broken screen in one pass, a second pass would find the same ones
// and double the time of a job that has a hard limit (.github/workflows/ci.yml, e2e: 25 minutes).
test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-screens-');
  ({ app, page, dataDir } = launched);
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await stubNativeDialogs(app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('first launch: a GST company from the wizard', async () => {
  await firstLaunchCreateCompany(page, dataDir, COMPANY);
});

test('F11: every feature with screens is switched on', async () => {
  test.setTimeout(120_000);
  await enableFeatures(page, ALL_FEATURES);
  const features = await api<Record<string, boolean>>(page, 'company.features.get', {});
  for (const f of FEATURE_CATALOG.filter((x) => !x.managedOn)) expect(features[f.key], f.label).toBe(true);
});

test('minimum masters and a voucher of each kind (through the API)', async () => {
  const today = localToday();
  const call: ApiCall = <T>(route: string, input?: unknown) => api<T>(page, route, input);
  const m = await seedParityMasters(call, today);
  await call('vouchers.save', quotationInput(m, today));
  await call('vouchers.save', {
    voucherTypeId: m.types.sales,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: m.customer,
    items: [{ itemId: m.item, qty: 2, rate: 100 }],
    acknowledgeWarnings: true,
  });
  await call('vouchers.save', {
    voucherTypeId: m.types.purchase,
    date: today,
    mode: 'accounting_invoice',
    partyLedgerId: m.supplier,
    referenceNo: PARITY.tds.supplierInvoiceNo,
    ledgers: [{ ledgerId: m.expense, amount: PARITY.tds.amount }],
    acknowledgeWarnings: true,
  });
  await call('vouchers.save', exportInvoiceInput(m, today));
  await call('vouchers.save', chequePaymentInput(m, today));
});

interface ScreenProblem {
  item: string;
  problem: string;
}

/** Read the palette's catalogue (the palette must be open to answer). */
async function readCatalog(): Promise<GotoCatalogSnapshot> {
  await openGoto(page);
  await expect(page.getByRole('option').first()).toBeVisible();
  const ask = () =>
    page.evaluate((eventName) => {
      const detail: { catalog?: unknown } = {};
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
      return (detail.catalog ?? null) as GotoCatalogSnapshot | null;
    }, GOTO_CATALOG_EVENT);
  // The list grows once the company's voucher types (and the inactive base types) have loaded: read it
  // until two answers 400 ms apart agree.
  let snap = await ask();
  for (let i = 0; i < 20 && snap; i++) {
    await page.waitForTimeout(400);
    const again = await ask();
    if (again && JSON.stringify(again) === JSON.stringify(snap)) break;
    snap = again;
  }
  await page.keyboard.press('Escape');
  await toGateway(page);
  if (!snap) throw new Error('The Go To palette did not answer the catalogue request (src/renderer/app/GotoPalette.tsx)');
  return snap;
}

/** Number of nav-stack screens on the page: mounted full screens + open dialogs. */
async function depth(): Promise<number> {
  return (await page.locator('[data-screen]').count()) + (await page.locator('[role=dialog]:visible').count());
}

/** What a screen shows when its first load failed (ScreenError in src/renderer/app/Screen.tsx). */
const LOAD_FAILED = ['This could not be loaded', "You don't have access to this"] as const;

/** Text of a locator for a log line: whitespace collapsed, cut to `max` characters. */
async function brief(where: Locator, max = 300): Promise<string> {
  return (await where.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Check what is on top now: a dialog (a dialog screen, or a dialog the screen opened — with a heading)
 * or else the full screen (visible [data-screen] other than the Gateway, with an h1). Returns the
 * screen id ('dialog:<title>' for a dialog) and pushes problems. Errors that arrived while it was open
 * (uncaught page errors, [pevqori] / React console errors) are reported whatever was shown — also when
 * nothing opened, e.g. a dialog screen whose error boundary replaced the dialog itself.
 */
async function checkTop(label: string, problems: ScreenProblem[], since: { page: number; console: number }): Promise<string | null> {
  const full = page.locator('[data-screen]:not([hidden]):not([data-screen="app.gateway"])');
  const dialog = page.locator('[role=dialog]:visible').last();
  // A dialog screen renders its error boundary in place of its Modal: outside every [data-screen].
  const looseCrash = page.locator('.bx-crash:visible');
  let id: string | null = null;
  try {
    await expect(full.or(dialog).or(looseCrash).first()).toBeVisible({ timeout: 10_000 });
  } catch {
    problems.push({ item: label, problem: 'nothing opened (no new screen or dialog within 10 s)' });
  }
  if ((await looseCrash.count()) > 0 && !(await full.isVisible()) && !(await dialog.isVisible())) {
    problems.push({ item: label, problem: `error boundary — ${await brief(looseCrash.first())}` });
    id = 'crash';
  } else if (await dialog.isVisible()) {
    const title = (await dialog.getByRole('heading').first().innerText().catch(() => '')).trim();
    id = `dialog:${title || '(untitled)'}`;
    if (!title) problems.push({ item: label, problem: 'dialog without a heading' });
    if ((await dialog.locator('.bx-crash').count()) > 0) problems.push({ item: label, problem: `${id}: error boundary — ${await brief(dialog.locator('.bx-crash').first())}` });
    for (const text of LOAD_FAILED) {
      if ((await dialog.getByText(text).count()) > 0) problems.push({ item: label, problem: `${id}: "${text}" — ${await brief(dialog)}` });
    }
  } else if (await full.isVisible()) {
    id = (await full.getAttribute('data-screen')) ?? '?';
    try {
      await expect(full.locator('h1').first()).toBeVisible({ timeout: 5_000 });
    } catch {
      problems.push({ item: label, problem: `${id}: no visible h1` });
    }
    // Let the first load finish (skeleton gone, no grid still busy) before judging the content.
    await expect(full.locator('.bx-screen-skeleton, [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 }).catch(() => {
      console.log(`[screens] note: ${id} still loading after 15 s`);
    });
    if ((await full.locator('.bx-crash').count()) > 0) problems.push({ item: label, problem: `${id}: error boundary — ${await brief(full.locator('.bx-crash').first())}` });
    if ((await full.getByText('Something went wrong').count()) > 0) problems.push({ item: label, problem: `${id}: shows "Something went wrong" — ${await brief(full)}` });
    // A screen of a fresh company with every feature on, opened by its Owner, must load its data.
    for (const text of LOAD_FAILED) {
      if ((await full.getByText(text).count()) > 0) problems.push({ item: label, problem: `${id}: "${text}" — ${await brief(full)}` });
    }
  }
  // Give a failing effect a moment to report, then look at what arrived since the screen was opened.
  await page.waitForTimeout(150);
  const where = id ?? '(nothing opened)';
  for (const e of pageErrors.slice(since.page)) problems.push({ item: label, problem: `${where}: uncaught page error — ${e.slice(0, 300)}` });
  for (const e of consoleErrors.slice(since.console)) {
    if (BROKEN.test(e)) problems.push({ item: label, problem: `${where}: console error — ${e.slice(0, 300)}` });
    else console.log(`[screens] note: console error on ${where}: ${e.slice(0, 200)}`);
  }
  return id === 'crash' ? null : id;
}

test('every screen in Go To opens, renders and goes back', async () => {
  test.setTimeout(9 * 60_000);
  const started = Date.now();
  const catalog = await readCatalog();
  const registered = new Map(catalog.screens.map((s) => [s.id, s]));
  const opens = (i: GotoCatalogEntry) => i.screen !== '' || /^voucher(-type)?:/.test(i.command ?? '');
  const items = catalog.items.filter(opens);
  for (const i of catalog.items.filter((x) => !opens(x))) console.log(`[screens] skip "${i.label}" (command ${i.command}): a shell command opens a shell dialog, not a screen`);
  console.log(`[screens] Go To catalogue: ${catalog.items.length} items, ${items.length} to open; ${catalog.screens.length} registered screens`);
  expect(items.length, 'the catalogue lists the screens').toBeGreaterThan(50);

  const problems: ScreenProblem[] = [];
  const reached = new Set<string>();
  const drilled = new Set<string>();
  const discardAsked: string[] = [];

  for (const item of items) {
    const label = `${item.group} › ${item.label}${item.params ? ` ${JSON.stringify(item.params)}` : ''}`;
    await test.step(label, async () => {
      try {
        await toGateway(page);
        const since = { page: pageErrors.length, console: consoleErrors.length };
        await openGotoItem(page, item);
        const id = await checkTop(label, problems, since);
        if (id) reached.add(id);
        if (id && item.screen && id !== item.screen && !id.startsWith('dialog:')) console.log(`[screens] note: "${item.label}" (${item.screen}) handed over to ${id}`);

        // One level down: Enter on the first row (alteration / drill-down screens that take an id).
        if (id && !id.startsWith('dialog:') && !drilled.has(id) && !NO_DRILL.test(id)) {
          drilled.add(id);
          const grid = topScreen(page).locator('table[role=grid], table[role=treegrid]').first();
          if ((await grid.count()) > 0 && (await grid.locator('tbody tr[data-pos]').count()) > 0) {
            const before = await depth();
            await grid.focus();
            // Focusing the grid puts the cursor on the first row (DataTable); Enter activates it.
            await expect(grid.locator('tbody tr[aria-selected="true"]')).toHaveCount(1, { timeout: 1_000 }).catch(() => undefined);
            const since2 = { page: pageErrors.length, console: consoleErrors.length };
            await page.keyboard.press('Enter');
            const opened = await expect
              .poll(depth, { timeout: 1_500 })
              .toBeGreaterThan(before)
              .then(() => true)
              .catch(() => false);
            if (opened) {
              const sub = await checkTop(`${label} › Enter on the first row`, problems, since2);
              if (sub) reached.add(sub);
            }
          }
        }
        if (await toGateway(page)) discardAsked.push(label);
      } catch (err) {
        problems.push({ item: label, problem: `step failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
        await toGateway(page).catch(() => undefined);
      }
    });
  }

  const unreached = [...registered.keys()].filter((id) => id !== 'app.gateway' && !reached.has(id) && !reached.has(`dialog:${registered.get(id)?.title}`));
  console.log(
    [
      `[screens] opened ${items.length} Go To items in ${Math.round((Date.now() - started) / 1000)} s; ${reached.size} distinct screens reached (${drilled.size} lists drilled)`,
      ...discardAsked.map((l) => `[screens] note: Esc asked "Discard unsaved changes?" on an untouched screen: ${l}`),
      ...unreached.map((id) => `[screens] skip ${id} ("${registered.get(id)?.title}"): not in Go To and not reached by Enter on a first row — needs an id or opens from another screen (covered by first-day / parity specs or the screen's own flow)`),
    ].join('\n'),
  );
  expect(problems.map((p) => `${p.item}: ${p.problem}`), 'screens that did not render cleanly').toEqual([]);
});

test('screens that need a voucher id: Day Book → view → print preview', async () => {
  const daybook = await openFromGatewayDaybook();
  const row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(PARITY.customer.name) }).first();
  await row.click();
  await page.keyboard.press('Alt+Enter');
  const view = screen(page, 'vouchers.view');
  await expect(view).toBeVisible();
  await expect(view.locator('h1').first()).toBeVisible();
  await page.keyboard.press('Alt+p');
  const preview = screen(page, 'print.voucher');
  await expect(preview.getByRole('heading', { name: 'Print Preview', level: 1 })).toBeVisible();
  await expect(preview).toContainText(PARITY.customer.name);
  expect(pageErrors).toEqual([]);
  await toGateway(page);
});

async function openFromGatewayDaybook() {
  const input = await openGoto(page);
  await input.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  const s = screen(page, 'vouchers.daybook');
  await expect(s).toBeVisible();
  return s;
}
