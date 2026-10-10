// Pevqori 2.0 onboarding through the real UI of the built app (WP-09):
//
//   first launch → Create Company: business, GST & tax → "Create with recommended settings" (≤ 3 clicks
//   after the GST details: recommended, password protection off, Create company) → Home (Get started
//   lists the 2.0 steps; "Show more insights" mounts the other cards) → ⚙ Settings hub: topics, Ctrl+F
//   search, keyboard moves between the search box, topics and settings, Invoice numbering opens its screen.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { lit, pick, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Quick Start Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;

let launched: LaunchedApp | undefined;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-onboarding-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('create a company with recommended settings: three clicks after the GST details', async () => {
  test.setTimeout(120_000);
  await expect(page.getByRole('heading', { name: 'Where should Pevqori keep your data?' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Pevqori' })).toBeVisible();
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Create Company', level: 1 })).toBeVisible();
  await page.getByLabel(/^Business name/).fill(COMPANY.name);
  await page.getByLabel(/^State/).focus();
  await pick(page, COMPANY.state, new RegExp(`\\d\\d - ${lit(COMPANY.state)}`));
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'GST and tax' })).toBeVisible();
  await page.getByLabel(/^GSTIN/).fill(COMPANY.gstin);
  await expect(page.getByLabel(/^PAN/)).toHaveValue(COMPANY.gstin.slice(2, 12));

  // Click 1: the recommended path skips Books, Features and Security.
  await page.getByRole('button', { name: 'Create with recommended settings' }).click();
  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  const books = page.getByRole('region', { name: 'Books' });
  await expect(books).toContainText('April to March');
  // The password choice sits on Review on this path — the same switch as the Security step.
  const protect = page.getByRole('switch', { name: /^Protect this company with a password/ });
  await expect(protect).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel(/^Password/).first()).toBeVisible();
  // Click 2: no password for this company. Click 3: create.
  await protect.click();
  await expect(page.getByText('Not protected')).toBeVisible();
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(screen(page, 'app.gateway')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
});

test('Home: Get started lists the 2.0 steps; "Record a payment" opens a Receipt; more insights on demand', async () => {
  await toGateway(page);
  const steps = page.getByRole('list', { name: 'First steps' });
  await expect(steps).toBeVisible();
  await expect(steps).toContainText('Choose what prints on your invoice');
  await expect(steps).toContainText('Record a payment');
  // The four tiles of the Home variant.
  const tiles = page.getByRole('group', { name: 'Key figures' });
  for (const label of ['To collect', 'To pay', 'Cash & bank', 'Sales this month']) await expect(tiles).toContainText(label);

  const payment = steps.getByRole('listitem').filter({ hasText: 'Record a payment' });
  await payment.getByRole('button', { name: /^Receipt/ }).click();
  await expect(screen(page, 'vouchers.entry')).toBeVisible();
  await toGateway(page);

  // The chart card's heading (the chart itself repeats the title in its SVG once it has data).
  const trend = page.getByRole('heading', { name: 'Sales and purchases — last 12 months' });
  const more = page.getByRole('button', { name: 'Show more insights' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(trend).toHaveCount(0);
  await more.click();
  await expect(page.getByRole('button', { name: 'Show fewer insights' })).toHaveAttribute('aria-expanded', 'true');
  await expect(trend).toBeVisible();
  await page.getByRole('button', { name: 'Show fewer insights' }).click();
  await expect(trend).toHaveCount(0);
});

test('Settings hub (⚙): topics, search, and Invoice numbering opens its screen', async () => {
  await toGateway(page);
  // The topbar gear (Home's Essentials also lists "Settings" under Company).
  await expect(page.getByRole('navigation', { name: 'Gateway menu' }).locator('button[data-text-value="Settings"]')).toBeVisible();
  await page.locator('.bx-topbar__end').getByRole('button', { name: 'Settings', exact: true }).click();
  const hub = screen(page, 'company.settings');
  await expect(hub).toBeVisible();
  await expect(hub.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const search = hub.getByRole('textbox', { name: 'Search settings' });
  await expect(search).toBeFocused();

  const topics = hub.getByRole('navigation', { name: 'Settings topics' });
  for (const t of ['Business', 'Invoices & printing', 'Users & security', 'Data & backup', 'Appearance', 'About & updates']) {
    await expect(topics.getByRole('button', { name: t, exact: true })).toBeVisible();
  }
  // A feature that is off leaves no trace: POS and multi-currency are off on a new company.
  await expect(topics.getByRole('button', { name: 'Modules', exact: true })).toHaveCount(0);

  // Ctrl+F search across every topic; nothing found → Clear search.
  await search.fill('logo');
  const results = hub.getByRole('list', { name: 'Matching settings' });
  await expect(results.getByRole('button', { name: /^Company details/ })).toBeVisible();
  await expect(results.getByRole('button', { name: /^Invoice printing/ })).toBeVisible();
  await search.fill('zzzz');
  await expect(hub.getByText('No results for “zzzz”')).toBeVisible();
  await hub.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');

  // Keyboard: ↓ from the empty search box into the topics, ↓ chooses the next topic, → moves into its
  // settings; a letter typed there continues in the search box.
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(topics.getByRole('button', { name: 'Business', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const invoices = topics.getByRole('button', { name: 'Invoices & printing', exact: true });
  await expect(invoices).toBeFocused();
  await expect(invoices).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(hub.getByRole('list', { name: 'Invoices & printing settings' }).getByRole('button').first()).toBeFocused();
  await page.keyboard.press('p');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('p');
  await search.fill('');

  // Topic → its settings → open one (Enter on the row, as from the keyboard).
  await topics.getByRole('button', { name: 'Invoices & printing', exact: true }).click();
  const rows = hub.getByRole('list', { name: 'Invoices & printing settings' });
  const numbering = rows.getByRole('button', { name: /^Invoice numbering/ });
  await expect(numbering).toBeVisible();
  await expect(rows.getByRole('button', { name: /^Invoice printing/ })).toBeVisible();
  await numbering.focus();
  await page.keyboard.press('Enter');
  await expect(screen(page, 'accounts.numbering')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hub).toBeVisible();

  // Appearance is inline (per user): the Home view switch is there.
  await topics.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(hub.getByRole('radiogroup', { name: 'Home view' })).toBeVisible();

  // V7: topic names keep no trace of features that are off (TDS / TCS and cheque printing are off on a
  // recommended company), and the search finds the inline Appearance topic ("dark").
  await expect(topics.getByRole('button', { name: 'GST', exact: true })).toBeVisible();
  await expect(topics.getByRole('button', { name: 'Banking', exact: true })).toBeVisible();
  await expect(topics.getByRole('button', { name: 'GST & TDS', exact: true })).toHaveCount(0);
  await topics.getByRole('button', { name: 'Business', exact: true }).click();
  await search.fill('dark');
  await hub.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /^Appearance/ }).click();
  await expect(search).toHaveValue('');
  await expect(hub.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await toGateway(page);
  expect(pageErrors).toEqual([]);
});
