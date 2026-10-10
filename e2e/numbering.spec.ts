// Pevqori 2.0 Invoice Numbering through the real UI of the built app (WP-07, SPEC §8.3):
//
//   wizard company → party + item (window.pevqori.api) → Home › Essentials › Invoice Numbering →
//   Sales: prefix INV/ + the {FY} chip + '/', 4 digits → the next sale is INV/<fy>/0001 →
//   next number 41 (Set, confirm the skipped numbers) → the next sale is INV/<fy>/0041 → gaps of the
//   year → "start again every financial year" off shows the FY-uniqueness note (Esc discards) →
//   Create series (Alt+C) "Cash Sales" CS/ → listed, and offered by F10 (Other vouchers).
//
// The API-level twin of the numbering itself is src/core/testing/e2e/renumber.test.ts (same routes and
// numbers). Sales are saved through window.pevqori.api (same IPC and core as the entry screen); the
// numbering is changed only through the screen.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { api, firstLaunchCreateCompany, localToday, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Numbering Traders E2E', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
/** Fictional, checksum-valid (as e2e/first-day.spec.ts). */
const PARTY = { name: 'Ravi Traders', gstin: '27AAAPA0002A1Z5' } as const;

let launched: LaunchedApp | undefined;
let page: Page;
const today = localToday();
const pageErrors: string[] = [];
const ids = { party: 0, item: 0, sales: 0 };

/** '26-27' — the {FY} token for today (the wizard's books start in April). */
function fyShort(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}
const FY = fyShort(today);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-numbering-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

async function saleNumber(): Promise<string> {
  const saved = await api<{ number: string }>(page, 'vouchers.save', {
    voucherTypeId: ids.sales,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: ids.party,
    items: [{ itemId: ids.item, qty: 2, rate: 500 }],
    acknowledgeWarnings: true,
  });
  return saved.number;
}

/** Home › Essentials › Company › Invoice Numbering. */
async function openNumbering(): Promise<Locator> {
  await toGateway(page);
  await page.getByRole('navigation', { name: 'Gateway menu' }).locator('button[data-text-value="Invoice Numbering"]').click();
  const s = screen(page, 'accounts.numbering');
  await expect(s.getByRole('heading', { name: 'Invoice Numbering', level: 1 })).toBeVisible();
  return s;
}

/** The Sales row of the list (its first cell is exactly "Sales": "Cash Sales" is another row). */
function salesRow(s: Locator): Locator {
  return s
    .getByRole('treegrid', { name: 'Number series' })
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Sales', exact: true }) });
}

async function openSalesEditor(s: Locator): Promise<Locator> {
  await salesRow(s).click();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Sales — invoice numbers' });
  await expect(drawer).toBeVisible();
  return drawer;
}

test('a GST company with a customer and an item', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  const groups = await api<{ rows: Array<{ id: number; name: string }> }>(page, 'accounts.group.list', {});
  const debtors = groups.rows.find((g) => g.name === 'Sundry Debtors');
  expect(debtors).toBeTruthy();
  ids.party = (await api<{ id: number }>(page, 'accounts.ledger.save', { name: PARTY.name, groupId: debtors?.id, gstin: PARTY.gstin, stateCode: '27', registrationType: 'regular' })).id;
  const units = await api<{ rows: Array<{ id: number; symbol: string }> }>(page, 'inventory.unit.list', {});
  const nos = units.rows.find((u) => u.symbol === 'Nos');
  expect(nos).toBeTruthy();
  ids.item = (await api<{ item: { id: number } }>(page, 'inventory.item.save', { name: 'Steel Bolt M8', unitId: nos?.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7318', openings: [{ qty: 1000, rate: 100 }] })).item.id;
  const types = await api<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>(page, 'accounts.voucherType.list', {});
  ids.sales = types.rows.find((t) => t.baseType === 'sales' && t.isPredefined)?.id ?? 0;
  expect(ids.sales).toBeGreaterThan(0);
});

test('Sales: prefix INV/{FY}/ with the code chip, 4 digits → the next sale is INV/<fy>/0001', async () => {
  const s = await openNumbering();
  // Invoices & notes come first and are open; Sales starts at 1 with no prefix.
  await expect(salesRow(s)).toContainText('Every financial year');
  const drawer = await openSalesEditor(s);
  const prefix = drawer.getByLabel(/^Prefix/);
  await expect(prefix).toBeFocused();
  await prefix.fill('INV/');
  // The chip's accessible name starts with its visible text ("FY 26-27") and names the code it inserts.
  await drawer.getByRole('button', { name: `FY ${FY} (insert {FY})`, exact: true }).click();
  await expect(prefix).toBeFocused();
  await expect(prefix).toHaveValue('INV/{FY}');
  await page.keyboard.type('/');
  await expect(prefix).toHaveValue('INV/{FY}/');
  await drawer.getByLabel('Digits').selectOption('4');
  const preview = drawer.getByRole('status', { name: 'Numbering preview' });
  await expect(preview).toContainText(`INV/${FY}/0001`);
  await expect(preview).toContainText('of 16 characters');
  await expect(drawer.getByText('Valid GST invoice number')).toBeVisible();

  await page.keyboard.press('Control+a');
  await expect(page.getByText('Sales numbering saved').first()).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(salesRow(s)).toContainText(`INV/${FY}/0001`);

  expect(await saleNumber()).toBe(`INV/${FY}/0001`);
});

test('set the next number to 41 (confirm the skipped numbers) → the next sale is INV/<fy>/0041; the gaps are listed', async () => {
  const s = await openNumbering();
  const drawer = await openSalesEditor(s);
  const next = drawer.getByRole('textbox', { name: 'Next number', exact: true });
  await expect(next).toHaveValue('2');
  await next.fill('41');
  await next.press('Tab');
  await expect(drawer.getByRole('status', { name: 'Numbering preview' })).toContainText(`INV/${FY}/0041`);
  await drawer.getByRole('button', { name: 'Set next number', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Set the next number?' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Numbers 2–40 will not be issued; report them in GSTR-1 Table 13');
  await ask.getByRole('button', { name: 'Set next number' }).click();
  await expect(page.getByText(`Next Sales number: INV/${FY}/0041`).first()).toBeVisible();
  // Nothing left unsaved: Esc closes at once.
  await next.focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  expect(await saleNumber()).toBe(`INV/${FY}/0041`);

  const again = await openSalesEditor(s);
  await expect(again.getByText(/Gaps in \d{4}(-\d\d)?: 39 missing \(INV\//)).toBeVisible();
  await again.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(again.getByLabel('Missing numbers')).toContainText(`INV/${FY}/0002`);
  await page.keyboard.press('Escape');
  await expect(again).toBeHidden();
});

test('turning "start again every financial year" off on a GST series shows the FY-uniqueness note; Esc asks to discard', async () => {
  const s = await openNumbering();
  const drawer = await openSalesEditor(s);
  const yearly = drawer.getByRole('switch', { name: /^Start again from the first number every financial year/ });
  await expect(yearly).toHaveAttribute('aria-checked', 'true');
  await yearly.click();
  await expect(yearly).toHaveAttribute('aria-checked', 'false');
  await expect(drawer.getByText('Numbers must still be unique within each financial year — Pevqori checks this.')).toBeVisible();
  // A series that never restarts continues its own counter: the next number is known only once saved.
  await expect(drawer.getByRole('status', { name: 'Numbering preview' })).toContainText('the next number is worked out when you save');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard the changes to this series?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard changes' }).click();
  await expect(drawer).toBeHidden();
  // Nothing was saved: the series still starts again every year.
  await expect(salesRow(s)).toContainText('Every financial year');
});

test('Create series (Alt+C): "Cash Sales" with its own prefix is listed and offered by F10', async () => {
  const s = await openNumbering();
  await salesRow(s).click();
  await page.keyboard.press('Alt+c');
  const drawer = page.getByRole('dialog', { name: 'Create a series based on Sales' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(/^Name of the series/).fill('Cash Sales');
  await drawer.getByLabel(/^Prefix/).fill('CS/');
  await expect(drawer.getByRole('status', { name: 'Numbering preview' })).toContainText('CS/0001'); // the parent's 4 digits, its own prefix
  await page.keyboard.press('Control+a');
  await expect(page.getByText('Series “Cash Sales” created').first()).toBeVisible();
  await expect(drawer).toBeHidden();
  const grid = s.getByRole('treegrid', { name: 'Number series' });
  await expect(grid.getByRole('gridcell', { name: /^Cash Sales/ })).toBeVisible();

  const types = await api<{ rows: Array<{ name: string; baseType: string; parentName: string | null; numbering: { prefix: string | null } }> }>(page, 'accounts.voucherType.list', {});
  const cash = types.rows.find((t) => t.name === 'Cash Sales');
  expect([cash?.baseType, cash?.parentName, cash?.numbering.prefix]).toEqual(['sales', 'Sales', 'CS/']);

  await toGateway(page);
  await page.keyboard.press('F10');
  const picker = page.getByRole('dialog', { name: 'Other Vouchers' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option', { name: /Cash Sales/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await toGateway(page);
  expect(pageErrors).toEqual([]);
});
