// Pevqori 2.0 keyboard review (V6) through the real UI of the built app: Ctrl+S — the "save" alias of
// Ctrl+A — never answers a Yes/No question. After an accidental Esc on a form with changes, a user who
// reaches for Ctrl+S to save must not confirm "Discard changes".
//
//   wizard company → Create ▾ › Customer, type a name → Esc → "Discard unsaved changes?" → Ctrl+S (the
//   question stays, the form stays) → N (keep editing) → Ctrl+S saves the customer
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { firstLaunchCreateCompany, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Keys Check Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
const CUSTOMER = 'Ravi Kirana';

let launched: LaunchedApp | undefined;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-keyboard-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('Ctrl+S does not answer "Discard unsaved changes?"; N keeps editing and Ctrl+S then saves', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  await toGateway(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Customer/ }).click();
  const form = screen(page, 'accounts.ledger.form');
  await expect(form.getByRole('heading', { name: 'Ledger Creation', level: 1 })).toBeVisible();
  await expect(form.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.type(CUSTOMER);

  await page.keyboard.press('Escape');
  const question = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(question).toBeVisible();
  await page.keyboard.press('Control+s');
  // Still asked; nothing discarded, nothing saved.
  await expect(question).toBeVisible();
  await expect(form).toBeVisible();
  await expect(form.getByLabel(/^Name/)).toHaveValue(CUSTOMER);

  await page.keyboard.press('n');
  await expect(question).toHaveCount(0);
  await expect(form.getByLabel(/^Name/)).toHaveValue(CUSTOMER);
  await page.keyboard.press('Control+s');
  await expect(page.getByText(`Ledger “${CUSTOMER}” created`).first()).toBeVisible();
  await toGateway(page);
  expect(pageErrors).toEqual([]);
});
