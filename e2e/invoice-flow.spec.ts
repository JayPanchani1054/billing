// Pevqori 2.0 invoice flow through the real UI of the built app (docs/USER_GUIDE.md §4.2):
//
//   wizard company → item (window.pevqori.api) → F8 → Alt+C in the party field: "Create customer"
//   (quick dialog, GSTIN fills state and PAN) → item, qty, rate → Ctrl+A → "Sales 1 saved" + the Saved bar
//   → Record payment opens a Receipt with the customer on the first line → Esc → × dismisses the bar →
//   Ctrl+I: Reference tab (the reference left the header) → Ctrl+R: A-100 with a reason → saved as
//   "Sales A-100" → Day Book › view → Ctrl+R renumbers it to A-200 → Alt+H shows the number change.
//
// The API-level twin of the numbering rules is src/core/testing/e2e/renumber.test.ts.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { api, firstLaunchCreateCompany, lit, openGoto, pick, saveAnywayIfAsked, screen, stubNativeDialogs, toGateway, topScreen } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Invoice Flow Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
/** Fictional, checksum-valid (as e2e/numbering.spec.ts). */
const PARTY = { name: 'Ravi Traders', gstin: '27AAAPA0002A1Z5', pan: 'AAAPA0002A' } as const;
const ITEM = 'Steel Bolt M8';

let launched: LaunchedApp | undefined;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-invoice-flow-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

/** Item line: item → quantity → rate (the Enter chain of voucher entry). */
async function enterItemLine(entry: Locator): Promise<void> {
  await entry.getByLabel('Item, line 1', { exact: true }).focus();
  await pick(page, 'Steel', new RegExp(lit(ITEM)));
  const qty = entry.getByLabel('Quantity, line 1', { exact: true });
  await expect(qty).toBeFocused();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  const rate = entry.getByLabel('Rate, line 1', { exact: true });
  await expect(rate).toBeFocused();
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await expect(entry.getByLabel('Amount, line 1', { exact: true })).toHaveValue(/^1,?000(\.00)?$/);
}

test('a GST company with a stock item', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  const units = await api<{ rows: Array<{ id: number; symbol: string }> }>(page, 'inventory.unit.list', {});
  const nos = units.rows.find((u) => u.symbol === 'Nos');
  expect(nos).toBeTruthy();
  await api(page, 'inventory.item.save', { name: ITEM, unitId: nos?.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7318', openings: [{ qty: 1000, rate: 100 }] });
});

test('F8 → Alt+C in the party field creates the customer in the quick dialog; the sale shows the Saved bar', async () => {
  await toGateway(page);
  await page.keyboard.press('F8');
  const entry = screen(page, 'vouchers.entry');
  await expect(entry).toBeVisible();
  const party = entry.getByLabel(/^Party A\/c name/);
  await expect(party).toBeFocused();
  // Sales-side reference fields wait in More details (Ctrl+I) until they hold a value.
  await expect(entry.getByLabel(/^Reference no\./)).toHaveCount(0);

  await page.keyboard.type(PARTY.name);
  await page.keyboard.press('Alt+c');
  const quick = page.getByRole('dialog', { name: 'Create customer' });
  await expect(quick).toBeVisible();
  await expect(quick.getByLabel(/^Name/)).toHaveValue(PARTY.name);
  await quick.getByLabel(/^GSTIN/).fill(PARTY.gstin);
  await expect(quick).toContainText(`PAN ${PARTY.pan}`);
  await expect(quick).toContainText('Maharashtra');
  await page.keyboard.press('Control+a');
  await expect(page.getByText(`Ledger “${PARTY.name}” created`).first()).toBeVisible();
  await expect(quick).toHaveCount(0);
  await expect(party).toHaveValue(PARTY.name);

  await enterItemLine(entry);
  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Sales 1 saved').first()).toBeVisible();

  // The Saved bar above the blank form: the voucher, its amount, Print / Share / Record payment.
  const bar = entry.getByRole('status', { name: 'Voucher saved' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Saved Sales 1');
  await expect(bar).toContainText('1,180.00');
  await expect(bar.getByRole('button', { name: /^Print/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Share/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await expect(party).toHaveValue('');
});

test('Record payment opens a Receipt with the customer on the first line; Esc comes back; × hides the bar', async () => {
  const sales = screen(page, 'vouchers.entry');
  const bar = sales.getByRole('status', { name: 'Voucher saved' });
  await bar.getByRole('button', { name: 'Record payment' }).click();
  const receipt = topScreen(page);
  await expect(receipt.getByRole('heading', { name: 'Receipt Creation', level: 1 })).toBeVisible();
  await expect(receipt.getByLabel('Ledger, line 1', { exact: true })).toHaveValue(PARTY.name);
  // Nothing typed yet: Esc goes back without asking (a first Esc may only close the open Account list).
  const salesHeading = topScreen(page).getByRole('heading', { name: 'Sales Creation', level: 1 });
  for (let i = 0; i < 3 && !(await salesHeading.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await salesHeading.waitFor({ state: 'visible', timeout: 700 }).catch(() => undefined);
  }
  await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toHaveCount(0);
  const top = topScreen(page);
  await expect(top.getByRole('heading', { name: 'Sales Creation', level: 1 })).toBeVisible();
  await expect(top.getByRole('status', { name: 'Voucher saved' })).toBeVisible();
  await top.getByRole('status', { name: 'Voucher saved' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(top.getByRole('status', { name: 'Voucher saved' })).toHaveCount(0);
});

test('Ctrl+I opens More details on its Reference tab; Ctrl+R sets A-100 with a reason; it saves as Sales A-100', async () => {
  const entry = topScreen(page);
  await expect(entry.getByRole('heading', { name: 'Sales Creation', level: 1 })).toBeVisible();
  await entry.getByLabel(/^Party A\/c name/).focus();

  await page.keyboard.press('Control+i');
  const more = page.getByRole('dialog', { name: 'More details' });
  await expect(more).toBeVisible();
  await expect(more.getByRole('tab', { name: 'Reference' })).toHaveAttribute('aria-selected', 'true');
  await expect(more.getByLabel(/^Reference no\./)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveCount(0);

  await page.keyboard.press('Control+r');
  const dlg = page.getByRole('dialog', { name: 'Change invoice number' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Next number');
  const number = dlg.getByLabel(/^New number/);
  await expect(number).toBeFocused();
  await page.keyboard.type('A-100');
  await expect(dlg).toContainText(/Available in FY \d{4}-\d{2} · 5 of 16 characters/);
  await dlg.getByLabel(/^Reason/).fill('Matching the paper bill book');
  await page.keyboard.press('Control+a');
  await expect(dlg).toHaveCount(0);
  await expect(entry.getByLabel(/^No\./)).toHaveValue('A-100');
  await expect(entry.getByText('changed', { exact: true })).toBeVisible();

  await entry.getByLabel(/^Party A\/c name/).focus();
  await pick(page, 'Ravi', new RegExp(lit(PARTY.name)));
  await enterItemLine(entry);
  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Sales A-100 saved').first()).toBeVisible();
  await expect(entry.getByRole('status', { name: 'Voucher saved' })).toContainText('Saved Sales A-100');
});

test('Day Book › view: Ctrl+R renumbers A-100 to A-200; the edit history shows the number change', async () => {
  const input = await openGoto(page);
  await input.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  const daybook = screen(page, 'vouchers.daybook');
  await expect(daybook).toBeVisible();
  const row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: /A-100/ });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.keyboard.press('Alt+Enter');
  const view = screen(page, 'vouchers.view');
  await expect(view.getByRole('heading', { name: 'Sales A-100', level: 1 })).toBeVisible();

  await page.keyboard.press('Control+r');
  const dlg = page.getByRole('dialog', { name: 'Change invoice number' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Current number');
  await expect(dlg).toContainText('A-100');
  await page.keyboard.type('A-200');
  await expect(dlg).toContainText(/Available in FY/);
  await dlg.getByLabel(/^Reason/).fill('Paper book page 12');
  await page.keyboard.press('Control+a');
  await expect(page.getByText('Sales A-100 renumbered to A-200').first()).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await expect(view.getByRole('heading', { name: 'Sales A-200', level: 1 })).toBeVisible();

  await page.keyboard.press('Alt+h');
  const history = screen(page, 'security.audit');
  await expect(history).toBeVisible();
  await expect(history).toContainText('Number change');
  await expect(history).toContainText('A-200');
  await expect(history).toContainText('Paper book page 12');
  await toGateway(page);
  expect(pageErrors).toEqual([]);
});
