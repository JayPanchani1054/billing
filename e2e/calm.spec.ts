// The calm gate (2.1, design/SPEC-21 §1.13): structural rules every screen keeps, checked on the real
// built app at the owner's laptop size (1366 × 690 content area) — and the P1 screens again at 1024 × 690.
//
//   wizard company → every F11 feature on → a few masters and vouchers (API) → Home, then EVERY screen
//   Go To opens (once per screen id, through the palette as screens.spec.ts does) → F8 (voucher entry) →
//   Day Book › a voucher view → the P1 screens again at 1024 × 690.
//
// Rules (facts are read from the DOM in one evaluate per screen; rules are applied here):
//   always ............ at most one `toolbar "Actions"`; the top screen's own scroller is not wider than
//                       its box (tables may scroll inside themselves)
//   per screen ........ (skipped while the id is in PENDING_CALM) at most one visible filled button
//                       (.bx-btn--primary) outside dialogs and the top bar; no visible boxed key chip
//                       (<kbd> with a border or a fill) outside the F1 overlay and the top bar; no two
//                       visible buttons with the same accessible name across the top bar, the title row,
//                       the toolbar row, the graph header and the command bar; exactly one visible h1 on
//                       a page screen (at most one on Home and under a dialog)
//   chrome ............ (skipped while CHROME_PENDING) the document is not wider than the window (the 2.0
//                       top bar overflows 1366 px on every screen); no footer.bx-statusbar, no .bx-shell__crumbs; the
//                       top bar holds at most 7 controls, no input, no key chip, no filled button; no
//                       `toolbar "Actions"` on Home, exactly one on a page screen — inside .bx-titlebar
//                       once the screen's id has left PENDING_CALM
//
// Registry lines (SPEC-21 §6.1): WP-B1 sets CHROME_PENDING = false (one line); WP-B3 deletes app.gateway
// and the app-owned ids from PENDING_CALM; each wave-2 package deletes its own ids once its screens
// comply; the integrator removes leftovers. Never add an id back. For a pending id the per-screen rules
// still run and are logged as `[calm] pending <id> …` (information for the owning package), not failed.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FEATURE_CATALOG } from '../src/renderer/app/lib/featureCatalog.ts';
import { GOTO_CATALOG_EVENT } from '../src/renderer/app/lib/gotoCatalog.ts';
import type { GotoCatalogEntry, GotoCatalogSnapshot } from '../src/renderer/app/lib/gotoCatalog.ts';
import { PARITY, seedParityMasters } from '../src/core/testing/e2e/parityFlow.ts';
import type { ApiCall } from '../src/core/testing/e2e/parityFlow.ts';
import { api, enableFeatures, firstLaunchCreateCompany, localToday, openGoto, openGotoItem, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

/** WP-B1 sets this to false when the 2.1 chrome (one top bar, title row, no status bar) lands. */
const CHROME_PENDING = true;

/** Screens not yet calm: only "≤ 1 toolbar Actions" and "no horizontal page scroll" are enforced for them. */
const PENDING_CALM: readonly string[] = [
  'accounts.chart',
  'accounts.costCentres',
  'accounts.currencies',
  'accounts.group.form',
  'accounts.group.list',
  'accounts.ledger.bulk',
  'accounts.ledger.form',
  'accounts.ledger.list',
  'accounts.numbering',
  'accounts.openingBalances',
  'accounts.voucherType.form',
  'accounts.voucherTypes',
  'app.gateway',
  'attachments.manage',
  'attachments.register',
  'banking.brs',
  'banking.cheques',
  'banking.depositSlip',
  'banking.import',
  'banking.match',
  'banking.pdc',
  'banking.summary',
  'cheques.bank',
  'cheques.book.form',
  'cheques.books',
  'cheques.epayments',
  'cheques.layout.form',
  'cheques.layouts',
  'cheques.payee.form',
  'cheques.payees',
  'cheques.print',
  'cheques.register',
  'company.about',
  'company.changePassword',
  'company.config',
  'company.features',
  'company.periodLock',
  'company.profile',
  'company.settings',
  'company.shortcuts',
  'dashboard.home',
  'data.backup',
  'data.export',
  'data.import',
  'data.restore',
  'data.verify',
  'data.xmlExport',
  'data.xmlImport',
  'documents.billsPending',
  'documents.budget.form',
  'documents.budget.variance',
  'documents.budgets',
  'documents.order.preclose',
  'documents.quotation.status',
  'documents.quotations',
  'documents.recurring',
  'documents.recurring.due',
  'documents.recurring.form',
  'documents.scenarios',
  'forex.ledger',
  'forex.opening',
  'forex.outstanding',
  'forex.revaluation',
  'forex.settings',
  'gst.advances',
  'gst.amendments',
  'gst.boe',
  'gst.cmp08',
  'gst.composition',
  'gst.einvoice',
  'gst.ewaybill',
  'gst.exceptions',
  'gst.filings',
  'gst.gstr1',
  'gst.gstr1.section',
  'gst.gstr3b',
  'gst.gstr3b.changes',
  'gst.gstr4',
  'gst.gstr9',
  'gst.hsn',
  'gst.itc',
  'gst.ledger.cash',
  'gst.ledger.credit',
  'gst.register',
  'gst.rule37',
  'gst.setoff',
  'gstrecon.home',
  'inventory.category.form',
  'inventory.category.list',
  'inventory.godown.form',
  'inventory.godown.list',
  'inventory.group.form',
  'inventory.group.list',
  'inventory.item.bulk',
  'inventory.item.form',
  'inventory.item.list',
  'inventory.priceList',
  'inventory.unit.form',
  'inventory.unit.list',
  'mfg.bom.form',
  'mfg.bom.list',
  'mfg.itc04',
  'mfg.jobWork.pending',
  'mfg.jobWorkOrder.form',
  'mfg.jobWorkOrder.list',
  'mfg.journal.entry',
  'mfg.production',
  'outstanding.interest',
  'outstanding.party',
  'outstanding.payables',
  'outstanding.receivables',
  'outstanding.reminders',
  'outstanding.statement',
  'pos.counter',
  'pos.return',
  'pos.settings',
  'pos.summary',
  'print.batch',
  'print.settings',
  'print.voucher',
  'reports.balanceSheet',
  'reports.cashBank',
  'reports.cashFlow',
  'reports.costCentres',
  'reports.exceptions',
  'reports.fundsFlow',
  'reports.groupSummary',
  'reports.ledger',
  'reports.monthlySummary',
  'reports.profitLoss',
  'reports.ratios',
  'reports.register',
  'reports.statistics',
  'reports.trialBalance',
  'security.audit',
  'security.role.form',
  'security.session',
  'security.settings',
  'security.user.form',
  'security.users',
  'stock.ageing',
  'stock.batches',
  'stock.categories',
  'stock.godowns',
  'stock.item',
  'stock.movement',
  'stock.negative',
  'stock.pendingOrders',
  'stock.physicalVariance',
  'stock.profitability',
  'stock.reorder',
  'stock.summary',
  'tds.challan',
  'tds.challans',
  'tds.computation',
  'tds.exceptions',
  'tds.ledger.form',
  'tds.ledgers',
  'tds.lines',
  'tds.nature.form',
  'tds.natures',
  'tds.outstanding',
  'tds.receivable',
  'tds.return',
  'tds.setup',
  'vouchers.daybook',
  'vouchers.entry',
  'vouchers.list',
  'vouchers.view',
];

/** The P1 screens (SPEC-21 §5: in the 2.0 snapshots or Home): checked again at 1024 × 690. */
const P1: readonly string[] = [
  'app.gateway',
  'gst.gstr1',
  'gst.gstr3b',
  'outstanding.payables',
  'outstanding.receivables',
  'reports.balanceSheet',
  'reports.cashBank',
  'reports.profitLoss',
  'reports.register',
  'reports.trialBalance',
  'stock.summary',
];

/** The owner's laptop: a maximised window on a 1366 × 768 screen leaves 1366 × 690 (SPEC-21 "Design window"). */
const LAPTOP = { width: 1366, height: 690 } as const;
const NARROW = { width: 1024, height: 690 } as const;

const COMPANY = { name: 'Calm Check Traders E2E', gstin: PARITY.company.gstin, state: PARITY.company.state } as const;

/** Every F11 feature the Features screen changes, prerequisites first (as screens.spec.ts). */
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

/** What one screen shows, read in the page (see calmFacts). */
interface CalmFacts {
  actionsToolbars: number;
  actionsInTitlebar: boolean;
  primaryButtons: string[];
  boxedKeys: string[];
  duplicateButtons: string[];
  h1: number;
  hScroll: string | null;
  statusbar: number;
  crumbs: number;
  topbarControls: number;
  topbarInputs: number;
  topbarKeys: number;
  topbarPrimary: number;
  dialogOpen: boolean;
}

/**
 * Runs in the renderer (page.evaluate): self-contained, no closure over spec code. "Visible" = rendered
 * with a box of at least 2 × 2 px and not visibility:hidden (a hidden screen is display:none).
 */
function calmFacts(): CalmFacts {
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && getComputedStyle(el).visibility !== 'hidden';
  };
  const all = (sel: string, root: ParentNode = document): Element[] => [...root.querySelectorAll(sel)].filter(shown);
  const inDialog = (el: Element): boolean => el.closest('[role=dialog], [role=alertdialog]') !== null;
  const inTopbar = (el: Element): boolean => el.closest('.bx-topbar') !== null;
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const name = (el: Element): string => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id) ?? document.createElement('i'))).join(' ').trim();
    const copy = el.cloneNode(true) as Element;
    for (const k of copy.querySelectorAll('kbd, [aria-hidden="true"]')) k.remove();
    return text(copy);
  };
  const boxed = (el: Element): boolean => {
    const s = getComputedStyle(el);
    // Computed colours: "rgba(0, 0, 0, 0)", or "color(srgb … / 0)" / "oklab(… / 0)" for color-mix() tokens.
    const transparent = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c) || /\/\s*0(\.0+)?\)$/.test(c);
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const w = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const style = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
      return w > 0 && style !== 'none' && style !== 'hidden' && !transparent(s.getPropertyValue(`border-${side.toLowerCase()}-color`));
    });
    return border || !transparent(s.backgroundColor);
  };

  const actions = all('[role=toolbar][aria-label="Actions"]');
  const regions = all(
    '.bx-topbar, .bx-titlebar, .bx-toolbar-row, .bx-report__graph-head, [role=toolbar][aria-label="Actions"], .bx-page-header, .bx-report__header, .bx-report__toolbar',
  );
  const buttons = new Set<Element>();
  for (const r of regions) for (const b of all('button, [role=button]', r)) if (!inDialog(b)) buttons.add(b);
  const seen = new Map<string, number>();
  for (const b of buttons) {
    const n = name(b).toLowerCase();
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const se = document.scrollingElement ?? document.documentElement;
  const screens = all('[data-screen]');
  const top = screens[screens.length - 1];
  let hScroll: string | null = null;
  if (se.scrollWidth > se.clientWidth + 1) hScroll = `the page is ${se.scrollWidth} px wide in ${se.clientWidth} px`;
  else if (top && top.scrollWidth > top.clientWidth + 1) hScroll = `${top.getAttribute('data-screen')} is ${top.scrollWidth} px wide in ${top.clientWidth} px`;
  const topbar = document.querySelector('.bx-topbar');
  return {
    actionsToolbars: actions.length,
    actionsInTitlebar: actions.length === 1 && actions[0].closest('.bx-titlebar') !== null,
    primaryButtons: all('.bx-btn--primary')
      .filter((b) => !inDialog(b) && !inTopbar(b))
      .map(name),
    boxedKeys: all('kbd')
      .filter((k) => !inTopbar(k) && k.closest('.bx-shortcuts-overlay') === null && boxed(k))
      .map((k) => `${text(k)} (in ${name(k.closest('button, [role=button], [role=menuitem], [role=option], [role=row], label') ?? k.parentElement ?? k) || '?'})`),
    duplicateButtons: [...seen].filter(([, n]) => n > 1).map(([n, c]) => `"${n}" × ${c}`),
    h1: all('h1').length,
    hScroll,
    statusbar: all('footer.bx-statusbar').length,
    crumbs: all('.bx-shell__crumbs').length,
    topbarControls: topbar ? all('button, a[href], input, select, [role=button], [role=combobox]', topbar).length : 0,
    topbarInputs: topbar ? all('input, select, textarea', topbar).length : 0,
    topbarKeys: topbar ? all('kbd', topbar).length : 0,
    topbarPrimary: topbar ? all('.bx-btn--primary', topbar).length : 0,
    dialogOpen: all('[role=dialog], [role=alertdialog]').length > 0,
  };
}

type Kind = 'home' | 'page' | 'dialog';

interface Violation {
  id: string;
  where: string;
  rule: string;
}

/** The rules of the file header, applied to one screen's facts. `strict` = the per-screen rules (id not pending). */
function rulesFor(f: CalmFacts, kind: Kind, strict: boolean): string[] {
  const out: string[] = [];
  if (f.actionsToolbars > 1) out.push(`${f.actionsToolbars} toolbars "Actions" (at most 1)`);
  // A whole-page overflow comes from the 2.0 chrome (the top bar is wider than 1366 px on every screen); it is a
  // chrome rule until WP-B1 replaces the top bar. A screen whose own content overflows fails at once.
  if (f.hScroll && !(CHROME_PENDING && f.hScroll.startsWith('the page is'))) out.push(`horizontal page scroll: ${f.hScroll}`);
  if (!CHROME_PENDING) {
    if (f.statusbar > 0) out.push('a status bar (footer.bx-statusbar) is shown');
    if (f.crumbs > 0) out.push('a breadcrumb row (.bx-shell__crumbs) is shown');
    if (f.topbarControls > 7) out.push(`the top bar holds ${f.topbarControls} controls (at most 7)`);
    if (f.topbarInputs > 0) out.push('the top bar holds an input');
    if (f.topbarKeys > 0) out.push(`the top bar shows ${f.topbarKeys} key chip(s)`);
    if (f.topbarPrimary > 0) out.push('the top bar holds a filled button');
    if (kind === 'home' && f.actionsToolbars !== 0) out.push('Home shows a toolbar "Actions"');
    if (kind === 'page' && f.actionsToolbars !== 1) out.push(`${f.actionsToolbars} toolbars "Actions" on a page screen (exactly 1)`);
  }
  if (!strict) return out;
  if (f.primaryButtons.length > 1) out.push(`${f.primaryButtons.length} filled buttons outside dialogs: ${f.primaryButtons.join(', ')}`);
  if (f.boxedKeys.length > 0) out.push(`boxed key chips outside F1: ${f.boxedKeys.slice(0, 6).join('; ')}${f.boxedKeys.length > 6 ? ' …' : ''}`);
  if (f.duplicateButtons.length > 0) out.push(`the same action shown twice: ${f.duplicateButtons.join(', ')}`);
  if (kind === 'page' && f.h1 !== 1) out.push(`${f.h1} visible h1 (exactly 1)`);
  if (kind !== 'page' && f.h1 > 1) out.push(`${f.h1} visible h1 (at most 1)`);
  if (!CHROME_PENDING && kind === 'page' && f.actionsToolbars === 1 && !f.actionsInTitlebar) out.push('the toolbar "Actions" is not in the title row (.bx-titlebar)');
  return out;
}

let launched: LaunchedApp | undefined;
let page: Page;
let dataDir: string;
const violations: Violation[] = [];
/** id → viewports it was checked at. */
const checked = new Map<string, Set<string>>();

// One pass, no retry: a second pass would find the same screens and double the time (≤ 4 min budget).
test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeAll(async () => {
  // No trace: the sweep is timed, and every violation names its screen and rule in the failure text.
  launched = await launchApp('pevqori-e2e-calm-', { trace: false });
  ({ page, dataDir } = launched);
  await stubNativeDialogs(launched.app);
  await page.setViewportSize(LAPTOP);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

/** Wait until the top screen's first load is over (no skeleton, nothing busy), then read and judge it. */
async function check(id: string, kind: Kind, viewport: { width: number; height: number }): Promise<void> {
  const where = `${viewport.width}×${viewport.height}`;
  await expect(page.locator('[data-screen]:not([hidden]) .bx-screen-skeleton, [data-screen]:not([hidden]) [aria-busy="true"]'))
    .toHaveCount(0, { timeout: 10_000 })
    .catch(() => console.log(`[calm] note: ${id} still loading after 10 s`));
  let facts = await page.evaluate(calmFacts);
  // A drawer or popover still sliding in can widen the scroller for a frame: judge the settled layout.
  if (facts.hScroll) {
    await page.waitForTimeout(400);
    facts = await page.evaluate(calmFacts);
  }
  const strict = !PENDING_CALM.includes(id);
  const found = rulesFor(facts, kind, strict);
  for (const rule of found) violations.push({ id, where, rule });
  if (!strict) for (const rule of rulesFor(facts, kind, true).filter((r) => !found.includes(r))) console.log(`[calm] pending ${id} @${where}: ${rule}`);
  const at = checked.get(id) ?? new Set<string>();
  at.add(where);
  checked.set(id, at);
}

/** The id of what is on top after opening a Go To item: a dialog screen's own id, or the visible full screen's. */
async function topId(item: GotoCatalogEntry): Promise<{ id: string; kind: Kind }> {
  const dialog = page.locator('[role=dialog]:visible, [role=alertdialog]:visible');
  const full = page.locator('[data-screen]:not([hidden]):not([data-screen="app.gateway"])');
  await expect(full.or(dialog).first()).toBeVisible({ timeout: 10_000 });
  if ((await dialog.count()) > 0) return { id: item.screen, kind: 'dialog' };
  return { id: (await full.last().getAttribute('data-screen')) ?? item.screen, kind: 'page' };
}

/** Read the palette's catalogue (the palette must be open to answer); waits until it stops growing. */
async function readCatalog(): Promise<GotoCatalogSnapshot> {
  await openGoto(page);
  await expect(page.getByRole('option').first()).toBeVisible();
  const ask = () =>
    page.evaluate((eventName) => {
      const detail: { catalog?: unknown } = {};
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
      return (detail.catalog ?? null) as GotoCatalogSnapshot | null;
    }, GOTO_CATALOG_EVENT);
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

/** One Go To item per screen id (the first one listed): the screens the sweep opens. */
function oneItemPerScreen(catalog: GotoCatalogSnapshot): GotoCatalogEntry[] {
  const seen = new Set<string>();
  const out: GotoCatalogEntry[] = [];
  for (const item of catalog.items) {
    if (item.screen === '' || item.screen === 'app.gateway' || seen.has(item.screen)) continue;
    seen.add(item.screen);
    out.push(item);
  }
  return out;
}

const report = (list: readonly Violation[]): string[] => list.map((v) => `${v.id} @${v.where}: ${v.rule}`);

let catalog: GotoCatalogSnapshot | undefined;

test('setup: a GST company with every F11 feature and a few vouchers', async () => {
  test.setTimeout(180_000);
  await firstLaunchCreateCompany(page, dataDir, COMPANY);
  await enableFeatures(page, ALL_FEATURES);
  const today = localToday();
  const call: ApiCall = <T>(route: string, input?: unknown) => api<T>(page, route, input);
  const m = await seedParityMasters(call, today);
  await call('vouchers.save', {
    voucherTypeId: m.types.sales,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: m.customer,
    items: [{ itemId: m.item, qty: 2, rate: 100 }],
    acknowledgeWarnings: true,
  });
  catalog = await readCatalog();
});

test('PENDING_CALM lists registered screens only, once each', () => {
  expect(catalog, 'the setup read the Go To catalogue').toBeDefined();
  const registered = new Set((catalog?.screens ?? []).map((s) => s.id));
  expect(PENDING_CALM.filter((id) => !registered.has(id)), 'ids that are not registered screens — delete them').toEqual([]);
  expect(PENDING_CALM.filter((id, i) => PENDING_CALM.indexOf(id) !== i), 'ids listed twice').toEqual([]);
  expect(P1.filter((id) => !registered.has(id)), 'P1 ids that are not registered screens').toEqual([]);
});

test('every screen Go To opens is calm at 1366 × 690', async () => {
  test.setTimeout(6 * 60_000);
  const started = Date.now();
  const items = oneItemPerScreen(catalog ?? { items: [], screens: [] });
  expect(items.length, 'the catalogue lists the screens').toBeGreaterThan(50);
  const before = violations.length;
  await toGateway(page);
  await check('app.gateway', 'home', LAPTOP);
  for (const item of items) {
    try {
      await openGotoItem(page, item);
      const { id, kind } = await topId(item);
      await check(id, kind, LAPTOP);
    } catch (err) {
      violations.push({ id: item.screen, where: 'open', rule: `could not open "${item.label}": ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
    }
    await toGateway(page).catch(() => undefined);
  }
  console.log(`[calm] ${items.length} screens checked at 1366×690 in ${Math.round((Date.now() - started) / 1000)} s`);
  expect(report(violations.slice(before)), 'screens that break a calm rule').toEqual([]);
});

test('F8 (voucher entry) and a voucher view are calm at 1366 × 690', async () => {
  const before = violations.length;
  await toGateway(page);
  await page.keyboard.press('F8');
  await expect(screen(page, 'vouchers.entry')).toBeVisible();
  await check('vouchers.entry', 'page', LAPTOP);
  await toGateway(page);

  const input = await openGoto(page);
  await input.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  const daybook = screen(page, 'vouchers.daybook');
  await expect(daybook).toBeVisible();
  await daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(PARITY.customer.name) }).first().click();
  await page.keyboard.press('Alt+Enter');
  await expect(screen(page, 'vouchers.view')).toBeVisible();
  await check('vouchers.view', 'page', LAPTOP);
  await toGateway(page);
  expect(report(violations.slice(before)), 'screens that break a calm rule').toEqual([]);
});

test('the P1 screens are calm at 1024 × 690 too', async () => {
  test.setTimeout(120_000);
  const before = violations.length;
  await page.setViewportSize(NARROW);
  try {
    await toGateway(page);
    await check('app.gateway', 'home', NARROW);
    const items = oneItemPerScreen(catalog ?? { items: [], screens: [] }).filter((i) => P1.includes(i.screen));
    for (const item of items) {
      await openGotoItem(page, item);
      const { id, kind } = await topId(item);
      await check(id, kind, NARROW);
      await toGateway(page);
    }
    const missing = P1.filter((id) => !checked.get(id)?.has(`${NARROW.width}×${NARROW.height}`));
    expect(missing, 'P1 screens Go To did not open at 1024 × 690').toEqual([]);
  } finally {
    await page.setViewportSize(LAPTOP);
  }
  expect(report(violations.slice(before)), 'screens that break a calm rule').toEqual([]);
});
