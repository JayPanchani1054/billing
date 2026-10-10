// Pevqori 2.0 print preview editor (R5) through the real UI of the built app:
//
//   wizard company → a customer, an item, a bank account printed on invoices, one sales invoice (API)
//   → Day Book › Ctrl+P → Alt+L "Customize what prints" → hide Bank details (this print only: the
//   account number leaves the preview) → Esc, Esc and reopen → shown again, the earlier change offered
//   → apply it and "Save for Sales" → reopen and batch print (Print Vouchers) hide it too → click-to-select
//   a part in the preview → hide HSN/SAC column and summary: the Rule 46(g) warning, printing not blocked
//   → Reset ▾ › Saved for Sales → bank details back.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { api, firstLaunchCreateCompany, lit, localToday, openFromGateway, screen, stubNativeDialogs, toGateway, topScreen } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Layout Check Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
const CUSTOMER = { name: 'Asha Retail', gstin: '27AAAPA0002A1Z5' } as const;
const ACCOUNT_NO = '50100012345678';

let launched: LaunchedApp | undefined;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-print-layout-');
  page = launched.page;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

interface Row {
  id: number;
  name: string;
}

/** Day Book › the invoice › Ctrl+P: the print preview of the one sales invoice. */
async function openPreview(): Promise<Locator> {
  const daybook = await openFromGateway(page, 'Day Book', 'vouchers.daybook');
  const row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(lit(CUSTOMER.name)) });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.keyboard.press('Control+p');
  const preview = screen(page, 'print.voucher');
  await expect(preview.getByRole('heading', { name: 'Print Preview', level: 1 })).toBeVisible();
  await expect(preview.locator('.bp-doc').first()).toContainText(CUSTOMER.name);
  return preview;
}

/** Alt+L: the "Customize what prints" panel. */
async function openPanel(): Promise<Locator> {
  await page.keyboard.press('Alt+l');
  const panel = page.getByRole('complementary', { name: 'Customize what prints' });
  await expect(panel).toBeVisible();
  return panel;
}

/** The switch of a part, its group opened first when it is closed. */
async function partSwitch(panel: Locator, group: RegExp, label: string): Promise<Locator> {
  const sw = panel.getByRole('switch', { name: label, exact: true });
  if ((await sw.count()) === 0) await panel.getByRole('button', { name: group }).click();
  await expect(sw).toBeVisible();
  return sw;
}

test('company, customer, item, bank details on invoices and one sales invoice', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  const today = localToday();
  const groups = (await api<{ rows: Row[] }>(page, 'accounts.group.list', {})).rows;
  const group = (name: string): number => {
    const g = groups.find((x) => x.name === name);
    if (!g) throw new Error(`Group ${name} is missing`);
    return g.id;
  };
  const types = (await api<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>(page, 'accounts.voucherType.list', {})).rows;
  const sales = types.find((t) => t.isPredefined && t.baseType === 'sales');
  const units = (await api<{ rows: Array<{ id: number; symbol: string }> }>(page, 'inventory.unit.list', {})).rows;
  const nos = units.find((u) => u.symbol === 'Nos');
  expect(sales && nos).toBeTruthy();

  const customer = await api<Row>(page, 'accounts.ledger.save', { name: CUSTOMER.name, groupId: group('Sundry Debtors'), gstin: CUSTOMER.gstin, stateCode: '27', registrationType: 'regular' });
  const bank = await api<Row>(page, 'accounts.ledger.save', { name: 'HDFC Bank', groupId: group('Bank Accounts'), bankAccountNo: ACCOUNT_NO, bankIfsc: 'HDFC0001234' });
  await api(page, 'company.config.save', { invoice: { showBankDetails: true, bankLedgerId: bank.id, showHsnSummary: true } });
  const item = await api<{ item: Row }>(page, 'inventory.item.save', { name: 'Steel Bolt M8', unitId: nos?.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7318' });
  await api(page, 'vouchers.save', {
    voucherTypeId: sales?.id,
    date: today,
    mode: 'item_invoice',
    partyLedgerId: customer.id,
    items: [{ itemId: item.item.id, qty: 10, rate: 100 }],
    acknowledgeWarnings: true,
  });
});

test('Alt+L hides Bank details for this print only; reopening offers the change again', async () => {
  const preview = await openPreview();
  const docs = preview.locator('.bp-docs');
  await expect(docs).toContainText(ACCOUNT_NO);

  const panel = await openPanel();
  const bank = await partSwitch(panel, /^Payment/, 'Bank details');
  await expect(bank).toHaveAttribute('aria-checked', 'true');
  await bank.click();
  await expect(bank).toHaveAttribute('aria-checked', 'false');
  await expect(panel).toContainText('This print');
  await expect(docs).not.toContainText(ACCOUNT_NO);
  await expect(preview.locator('.bp-docs .bp-editing, .bp-docs[class*="bp-editing"]')).toHaveCount(0); // the outline class stays outside what prints

  // Esc in the panel gives focus back to the preview; the next Esc leaves the screen as before.
  await page.keyboard.press('Escape');
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(screen(page, 'vouchers.daybook')).toBeVisible();

  const again = await openPreview();
  await expect(again.locator('.bp-docs')).toContainText(ACCOUNT_NO); // per-print: not saved
  const panel2 = await openPanel();
  await expect(panel2.getByText('Earlier changes in this session')).toBeVisible();
  await panel2.getByRole('button', { name: 'Apply them' }).click();
  await expect(again.locator('.bp-docs')).not.toContainText(ACCOUNT_NO);
});

test('"Save for Sales" keeps it hidden on reopening and in batch printing', async () => {
  const preview = topScreen(page);
  const panel = page.getByRole('complementary', { name: 'Customize what prints' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Save for Sales' }).click();
  await expect(page.getByText('Saved for Sales').first()).toBeVisible();
  await expect(preview.locator('.bp-docs')).not.toContainText(ACCOUNT_NO);
  await toGateway(page);

  const reopened = await openPreview();
  await expect(reopened.locator('.bp-docs')).not.toContainText(ACCOUNT_NO);
  await expect(reopened.locator('.bp-docs')).toContainText('7318'); // the rest of the invoice is there

  const picker = await openFromGateway(page, 'Print Vouchers', 'print.batch');
  const tick = picker.getByRole('checkbox', { name: /^Print Sales/ });
  await expect(tick).toHaveCount(1);
  // The box's larger hit area (::after, the label) sits over the input; check() still asserts the tick.
  await tick.check({ force: true });
  await page.keyboard.press('Control+a');
  const batch = topScreen(page);
  await expect(batch.getByRole('heading', { name: 'Print Vouchers', level: 1 })).toBeVisible();
  await expect(batch.locator('.bp-docs')).toContainText(CUSTOMER.name);
  await expect(batch.locator('.bp-docs')).not.toContainText(ACCOUNT_NO);
  await toGateway(page);
});

test('click-to-select, the Rule 46(g) warning when HSN is hidden, and Reset › Saved for Sales', async () => {
  const preview = await openPreview();
  const panel = await openPanel();
  // A click on the printed title selects its switch.
  await preview.locator('.bp-docs [data-part="title"]').first().click();
  await expect(panel.getByRole('switch', { name: 'Document title', exact: true })).toBeFocused();

  const hsn = await partSwitch(panel, /^Item columns/, 'HSN/SAC');
  await hsn.click();
  const summary = await partSwitch(panel, /^Totals and words/, 'HSN/SAC summary');
  await summary.click();
  await expect(summary).toHaveAttribute('aria-checked', 'false');
  const warning = /HSN\/SAC codes — required on a tax invoice \(Rule 46\(g\)\)/;
  await expect(panel.getByText(warning)).toBeVisible();
  await expect(preview.getByText(warning).first()).toBeVisible(); // the "Before you print" banner
  await expect(page.getByRole('toolbar', { name: 'Actions' }).getByRole('button', { name: /^Print/ }).first()).toBeEnabled(); // never blocked

  // Reset this print, then what is saved for Sales: the bank details print again.
  await panel.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('menuitem', { name: /^This print/ }).click();
  const undo = page.getByRole('dialog', { name: 'Undo the changes made to this print?' });
  await expect(undo).toBeVisible();
  await undo.getByRole('button', { name: 'Undo changes', exact: true }).click();
  await expect(panel.getByText(warning)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('menuitem', { name: /^Saved for Sales/ }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('Sales prints as set for all documents').first()).toBeVisible();
  await expect(preview.locator('.bp-docs')).toContainText(ACCOUNT_NO);
  await toGateway(page);
  expect(pageErrors).toEqual([]);
});
