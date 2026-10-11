// Pevqori 2.0 shell through the real UI of the built app: Home (Essentials / All menus), the Create
// menu, Ctrl+S as an alias of Ctrl+A, the command bar of the screen bar (primary button, "More" with
// every other action and its key) and the optional shortcut bar.
//
//   wizard company → Home on Essentials (a new profile) → Ctrl+2 / Ctrl+1 → Create ▾ › Sales invoice
//   → Create ▾ › Customer, Ctrl+S → a payment (API) → Day Book › voucher view › More lists Alt+H →
//   one top bar (2.1): ‹ back, mouse Back = Esc, "Not saved" + "• " title while dirty, hold Ctrl to peek →
//   user menu › Show shortcut bar
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, firstLaunchCreateCompany, lit, localToday, openGoto, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, holdKey, launchApp, mouseBack } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Home Check Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
const CUSTOMER = 'Meera Stores';

let launched: LaunchedApp | undefined;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-home-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

const homeMenu = () => page.getByRole('navigation', { name: 'Gateway menu' });

test('a new profile opens Home on Essentials; Ctrl+2 / Ctrl+1 switch to All menus and back', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  // 2.1: no breadcrumb row — the top bar's Home button, and no back button on Home itself.
  await expect(page.locator('.bx-topbar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Back to/ })).toHaveCount(0);
  await expect(homeMenu().getByRole('radio', { name: 'Essentials' })).toHaveAttribute('aria-checked', 'true');
  // Essentials: the everyday entries with their descriptions; the long tail stays in All menus.
  await expect(homeMenu().locator('button[data-text-value="Day Book"]')).toBeVisible();
  await expect(homeMenu().locator('button[data-text-value="Balance Sheet"]')).toBeVisible();
  await expect(homeMenu().locator('button[data-text-value="Post-dated Vouchers"]')).toHaveCount(0);
  // No shortcut bar for a new user; the decision is stored once.
  await expect(page.getByRole('toolbar', { name: 'Shortcut bar' })).toHaveCount(0);
  const stored = await page.evaluate(() => window.localStorage.getItem('pevqori.ui'));
  expect(JSON.parse(stored ?? '{}')).toMatchObject({ v: 1, homeView: 'essentials', shortcutBar: false, upgraded: false });

  await page.keyboard.press('Control+2');
  await expect(homeMenu().getByRole('radio', { name: 'All menus' })).toHaveAttribute('aria-checked', 'true');
  await expect(homeMenu().locator('button[data-text-value="Post-dated Vouchers"]')).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(homeMenu().getByRole('radio', { name: 'Essentials' })).toHaveAttribute('aria-checked', 'true');
  await expect(homeMenu().locator('button[data-text-value="Post-dated Vouchers"]')).toHaveCount(0);
});

test('Create ▾ › Sales invoice opens voucher entry', async () => {
  await toGateway(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Sales invoice/ }).click();
  const entry = screen(page, 'vouchers.entry');
  await expect(entry).toBeVisible();
  await expect(entry.getByLabel(/^Party A\/c name/)).toBeVisible();
  await toGateway(page);
});

test('Create ▾ › Customer; the command bar shows the primary action; Ctrl+S saves the form', async () => {
  await toGateway(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Customer/ }).click();
  const form = screen(page, 'accounts.ledger.form');
  await expect(form.getByRole('heading', { name: 'Ledger Creation', level: 1 })).toBeVisible();
  const actions = page.getByRole('toolbar', { name: 'Actions' });
  await expect(actions.getByRole('button', { name: /^Save & create next/ })).toBeVisible();
  await expect(form.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.type(CUSTOMER);
  await page.keyboard.press('Control+s');
  await expect(page.getByText(`Ledger “${CUSTOMER}” created`).first()).toBeVisible();
  await toGateway(page);
});

test('voucher view: More lists every other action with its key (Alt+H edit history)', async () => {
  const today = localToday();
  const types = (await api<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>(page, 'accounts.voucherType.list', {})).rows;
  const payment = types.find((t) => t.isPredefined && t.baseType === 'payment');
  const ledger = async (name: string) => (await api<{ rows: Array<{ id: number; name: string }> }>(page, 'accounts.ledger.list', { search: name })).rows.find((l) => l.name === name);
  const cash = await ledger('Cash');
  const customer = await ledger(CUSTOMER);
  expect(payment && cash && customer).toBeTruthy();
  await api(page, 'vouchers.save', {
    voucherTypeId: payment?.id,
    date: today,
    mode: 'ledger',
    acknowledgeWarnings: true,
    ledgers: [
      { ledgerId: customer?.id, amount: 50_000 },
      { ledgerId: cash?.id, amount: -50_000 },
    ],
  });

  const input = await openGoto(page);
  await input.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  const daybook = screen(page, 'vouchers.daybook');
  await expect(daybook).toBeVisible();
  const row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(lit(CUSTOMER)) });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.keyboard.press('Alt+Enter');
  const view = screen(page, 'vouchers.view');
  await expect(view).toBeVisible();

  const actions = page.getByRole('toolbar', { name: 'Actions' });
  await expect(actions.getByRole('button', { name: /^Alter/ })).toBeVisible(); // the primary
  await actions.getByRole('button', { name: 'More actions' }).click();
  const more = page.getByRole('menu', { name: 'More actions' });
  await expect(more).toBeVisible();
  const history = more.getByRole('menuitem', { name: /^Edit history/ });
  await expect(history).toBeVisible();
  await expect(history).toContainText('Alt');
  await expect(history).toContainText('H');
  await page.keyboard.press('Escape');
  await expect(more).toHaveCount(0);
  // The key works whether or not a button shows the action.
  await page.keyboard.press('Alt+h');
  await expect(screen(page, 'security.audit')).toBeVisible();
  await toGateway(page);
});

test('2.1 chrome: ‹ back and the top bar\'s Home button; mouse Back is Esc; "Not saved" while dirty; hold Ctrl to peek', async () => {
  test.setTimeout(90_000);
  // ‹ back names the screen it returns to and goes there.
  const input = await openGoto(page);
  await input.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  const daybook = screen(page, 'vouchers.daybook');
  await expect(daybook).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Actions' })).toHaveCount(1);
  await expect(daybook.locator('.bx-titlebar').getByRole('toolbar', { name: 'Actions' })).toBeVisible();
  await daybook.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await expect(screen(page, 'app.gateway')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Actions' })).toHaveCount(0); // none on Home

  // The mouse's Back button (button 3) does what Esc does.
  const again = await openGoto(page);
  await again.fill('Day Book');
  await page.getByRole('option', { name: /^Day Book/ }).first().click();
  await expect(daybook).toBeVisible();
  await mouseBack(page);
  await expect(screen(page, 'app.gateway')).toBeVisible();

  // Hold Ctrl (alone, ≥ 900 ms): every visible button shows its key; releasing hides them.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Customer/ }).click();
  const form = screen(page, 'accounts.ledger.form');
  await expect(form.getByLabel(/^Name/)).toBeFocused();
  await holdKey(page, 'Control', 1_000, async () => {
    await expect(page.locator('html')).toHaveAttribute('data-keys', /^(fade|static)$/);
    // The top bar's own keys too: Go To (Ctrl+G), the working date (F2), and ‹ (Esc).
    await expect(page.locator('.bx-topbar__goto').getByText('Ctrl+G', { exact: true })).toBeVisible();
    await expect(page.locator('.bx-topbar__date').getByText('F2', { exact: true })).toBeVisible();
    await expect(form.locator('.bx-titlebar__back').getByText('Esc', { exact: true })).toBeVisible();
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-keys', /.*/);
  await expect(page.locator('.bx-topbar__goto').getByText('Ctrl+G', { exact: true })).toBeHidden();
  await expect(page.locator('.bx-topbar').getByRole('button', { name: /^Working date / })).toBeVisible(); // named, not only "Sat 10-Oct-26"

  // Unsaved work: "Not saved" in the title row and "• " before the window title; mouse Back asks first, like Esc.
  await page.keyboard.type('Peek Traders');
  // Its own run after the context words, so a long subtitle never ellipsizes it away.
  await expect(form.locator('.bx-titlebar__state')).toBeVisible();
  await expect(form.locator('.bx-titlebar__state')).toContainText('Not saved');
  await expect(page).toHaveTitle(/^• Ledger Creation/);
  await mouseBack(page);
  const question = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(question).toBeVisible();
  await page.keyboard.press('n');
  await expect(question).toHaveCount(0);
  await expect(form.getByLabel(/^Name/)).toHaveValue('Peek Traders');
  // The top bar's Home button returns to Home with the same question.
  await page.locator('.bx-topbar').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(question).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(screen(page, 'app.gateway')).toBeVisible();
  await expect(page).not.toHaveTitle(/^•/);
});

test('user menu › Show shortcut bar shows the right-hand toolbar named "Shortcut bar", and hides it again', async () => {
  await toGateway(page);
  const userMenu = page.getByRole('button', { name: 'User menu' });
  await userMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Show shortcut bar' }).click();
  const bar = page.getByRole('toolbar', { name: 'Shortcut bar' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: /Features/ })).toBeVisible();
  await userMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Show shortcut bar' }).click();
  await expect(bar).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
