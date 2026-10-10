// UI steps shared by the Electron specs that need a company (screens.spec.ts, parity.spec.ts):
// first launch → Create Company wizard, F11 features, Go To, the API through the real IPC bridge,
// native dialogs stubbed in the main process. Selectors are the ones e2e/first-day.spec.ts proves.
import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ApiResult } from '../src/shared/api.ts';

/** A pushed screen of the navigation stack, by its registered id (lower screens stay mounted, hidden). */
export function screen(page: Page, id: string): Locator {
  return page.locator(`[data-screen="${id}"]`);
}

/** The full screen on top of the stack (only one [data-screen] is not hidden). */
export function topScreen(page: Page): Locator {
  return page.locator('[data-screen]:not([hidden])');
}

/** Escape a literal for a RegExp. */
export function lit(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Today's date as the app sees it ('YYYY-MM-DD', local time). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Esc back down the stack until the Gateway is the visible screen. A "Discard unsaved changes?"
 * question is answered "Discard changes" (returns true when one was asked); a crashed dialog screen
 * (its error boundary drawn in place of the dialog, which Esc does not close) is left with its
 * "Go back" button; the breadcrumb is the last resort.
 */
export async function toGateway(page: Page): Promise<boolean> {
  const gateway = screen(page, 'app.gateway');
  const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
  const crashBack = page.locator('.bx-crash:visible').getByRole('button', { name: 'Go back', exact: true });
  let asked = false;
  for (let i = 0; i < 10; i++) {
    if ((await gateway.isVisible()) && (await page.locator('[role=dialog]:visible, [role=alertdialog]:visible, .bx-crash:visible').count()) === 0) return asked;
    if (await discard.isVisible()) {
      asked = true;
      await discard.click();
    } else if ((await crashBack.count()) > 0) {
      await crashBack.first().click();
    } else {
      await page.keyboard.press('Escape');
    }
    await gateway.waitFor({ state: 'visible', timeout: 700 }).catch(() => undefined);
  }
  const crumb = page.locator('.bx-shell__breadcrumbs').getByRole('button', { name: 'Gateway' });
  if (await crumb.isVisible()) await crumb.click();
  if (await discard.isVisible()) {
    asked = true;
    await discard.click();
  }
  await expect(gateway).toBeVisible();
  return asked;
}

/** Open a Gateway menu item by its label (the keyboard-first menu on the left). */
export async function openFromGateway(page: Page, label: string, screenId: string): Promise<Locator> {
  await toGateway(page);
  await page
    .getByRole('navigation', { name: 'Gateway menu' })
    .getByRole('button', { name: new RegExp(`^${lit(label)}`) })
    .click();
  const s = screen(page, screenId);
  await expect(s).toBeVisible();
  return s;
}

/** Type into the focused combobox and accept the highlighted option once it is listed. */
export async function pick(page: Page, typed: string, option: RegExp): Promise<void> {
  await page.keyboard.type(typed);
  await expect(page.getByRole('option', { name: option }).first()).toBeVisible();
  await page.keyboard.press('Enter');
}

/**
 * Call a core route through the real preload → IPC → core worker path (what every screen does).
 * Allowed in e2e for seeding masters; throws with the accountant-facing message on failure.
 */
export async function api<T>(page: Page, route: string, input: unknown = {}): Promise<T> {
  const result = await page.evaluate(
    ([r, i]) => (globalThis as unknown as { pevqori: { api(route: string, input: unknown): Promise<unknown> } }).pevqori.api(r, i),
    [route, input] as const,
  );
  const res = result as ApiResult<T>;
  if (!res.ok) throw new Error(`${route} failed: ${res.error.code} ${res.error.message} ${JSON.stringify(res.error.details ?? null)}`);
  return res.data;
}

/**
 * Native dialogs answered "cancel" in the main process, so no step can ever wait on a real modal
 * (docs/BUILD.md §5.1). Opening a screen never needs one; this is a guard.
 */
export async function stubNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
}

export interface WizardCompany {
  name: string;
  gstin: string;
  /** State name as listed by the wizard ('Maharashtra'); its option reads '27 - Maharashtra'. */
  state: string;
}

/**
 * First launch: keep the PEVQORI_DATA_DIR folder, then the Create Company wizard with its defaults
 * (Regular GST, current financial year, stock + bill-wise on) and no password — as first-day.spec.ts.
 */
export async function firstLaunchCreateCompany(page: Page, dataDir: string, company: WizardCompany): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Where should Pevqori keep your data?' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(dataDir, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Pevqori' })).toBeVisible();

  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Create Company', level: 1 })).toBeVisible();
  await page.getByLabel(/^Business name/).fill(company.name);
  await page.getByLabel(/^State/).focus();
  await pick(page, company.state, new RegExp(`\\d\\d - ${lit(company.state)}`));
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'GST and tax' })).toBeVisible();
  await page.getByLabel(/^GSTIN/).fill(company.gstin);
  await expect(page.getByLabel(/^PAN/)).toHaveValue(company.gstin.slice(2, 12));
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Books of accounts' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Protect your books' })).toBeVisible();
  await page.getByRole('switch', { name: /^Protect this company with a password/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(screen(page, 'app.gateway')).toBeVisible({ timeout: 30_000 });
}

/**
 * Turn F11 features on through the Features screen, by their labels (src/renderer/app/lib/featureCatalog.ts),
 * in the order given (a feature's prerequisite first), then save (Ctrl+A) and return to the Gateway.
 */
export async function enableFeatures(page: Page, labels: readonly string[]): Promise<void> {
  const f = await openFromGateway(page, 'Features', 'company.features');
  await expect(f.getByRole('heading', { name: 'Features', level: 1 })).toBeVisible();
  let changed = 0;
  for (const label of labels) {
    const sw = f.getByRole('switch', { name: label, exact: true });
    await expect(sw).toBeVisible();
    if ((await sw.getAttribute('aria-checked')) !== 'true') {
      await expect(sw).toBeEnabled();
      await sw.click();
      changed++;
    }
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  }
  if (changed > 0) {
    await page.keyboard.press('Control+a');
    await expect(page.getByText('Features saved').first()).toBeVisible({ timeout: 30_000 });
  }
  await toGateway(page);
}

/** Open Go To (Ctrl+G) from the Gateway; returns its search box. */
export async function openGoto(page: Page): Promise<Locator> {
  await toGateway(page);
  await page.keyboard.press('Control+g');
  const input = page.getByRole('combobox', { name: 'Search screens, reports, masters and vouchers' });
  await expect(input).toBeVisible();
  return input;
}

/** Open a Go To item by its exact label and palette id (the option carries data-goto-id). */
export async function openGotoItem(page: Page, item: { id: string; label: string }): Promise<void> {
  const input = await openGoto(page);
  await input.fill(item.label);
  const option = page.locator(`[data-goto-id="${item.id.replace(/["\\]/g, '\\$&')}"]`);
  await expect(option).toBeVisible({ timeout: 5_000 });
  await option.click();
  await expect(input).toBeHidden(); // the palette has closed: what is on top now is the item's screen
}

/** "Please check before saving" (voucher warnings): confirm with "Save anyway" when it is asked. */
export async function saveAnywayIfAsked(page: Page, timeout = 1_500): Promise<boolean> {
  const check = page.getByRole('dialog', { name: 'Please check before saving' });
  const asked = await check
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (asked) await check.getByRole('button', { name: 'Save anyway' }).click();
  return asked;
}
