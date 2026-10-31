// 2.2 line descriptions through the real UI of the built app (docs/USER_GUIDE.md §4.2, §15.3):
//
//   wizard company → a customer, two stock items (one with a description in its master), an income and
//   an expense ledger (window.pevqori.api) → F8: Ctrl+E opens "Description, line 1" under the item, Enter
//   goes on to the quantity; line 2 without Ctrl+E goes item → quantity as before → Ctrl+A: the text is
//   saved on the line only (vouchers.get), the item master keeps its own → Day Book › Alt+Enter: the view
//   shows it under the item → Alt+P: printed under the item's name → Alt+A: the field shows the text;
//   emptied and saved, the line has none → F6 receipt: Ctrl+E under the ledger, Enter after it goes to the
//   next line, saved as the entry's narration → F5 payment with the type's "Description on every line" on
//   (set through the API, switched off again after): ledger → amount → description.
//
// Storage is pinned offline by src/core/modules/vouchers/descriptions.test.ts, the Enter chain and the
// visibility rule by src/renderer/modules/vouchers/lib/lineDescription.test.ts.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { VoucherTypeDetail } from '../src/shared/types/accounts.ts';
import type { StockItemDetail } from '../src/shared/types/inventory.ts';
import type { VoucherDetail, VoucherListResult } from '../src/shared/types/vouchers.ts';
import { api, firstLaunchCreateCompany, lit, localToday, openFromGateway, pick, saveAnywayIfAsked, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Line Description Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' } as const;
/** Fictional, checksum-valid (as e2e/first-day.spec.ts). */
const PARTY = { name: 'Kavya Traders', gstin: '27AAAPA0002A1Z5' } as const;
/** The item of line 1; its master has a description of its own, which no voucher line takes. */
const BOLT = { name: 'Steel Bolt M8', master: 'Zinc plated, box of 100' } as const;
const HINGE = 'Brass Hinge 4in';
/** Typed under item line 1. */
const ITEM_TEXT = 'Blue finish';
/** Typed under the receipt's ledger line (Ctrl+E) and under the payment's (every line). */
const RECEIPT_TEXT = 'Agency fee for Q2';
const PAYMENT_TEXT = 'Rent for shop 4';

let launched: LaunchedApp | undefined;
let page: Page;
const today = localToday();
const ids = { bolt: 0, hinge: 0, commission: 0, rent: 0, payment: 0, sale: 0 };
const pageErrors: string[] = [];
/** The app's own console errors: a screen's error boundary, an unhandled rejection (src/renderer/app). */
const appErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-line-descriptions-');
  page = launched.page;
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[pevqori]')) appErrors.push(msg.text());
  });
  await stubNativeDialogs(launched.app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

/** A line's description field. The row tool that opens a hidden one has the same name, as a button. */
function description(lines: Locator, n: number): Locator {
  return lines.getByRole('textbox', { name: `Description, line ${n}`, exact: true });
}

/** The row tool "Description" of a filled line whose description is hidden. */
function descriptionTool(lines: Locator, n: number): Locator {
  return lines.getByRole('button', { name: `Description, line ${n}`, exact: true });
}

/** The cell of a line's item / ledger picker: its description sits in it, under the name. */
function nameCell(lines: Locator, pickerLabel: string): Locator {
  return lines.getByRole('cell').filter({ has: page.getByLabel(pickerLabel, { exact: true }) });
}

/** The one voucher of this base type dated today, as vouchers.get returns it. */
async function savedToday(baseType: 'sales' | 'receipt' | 'payment'): Promise<VoucherDetail> {
  const list = await api<VoucherListResult>(page, 'vouchers.list', { from: today, to: today, baseTypes: [baseType] });
  expect(list.rows, `${baseType} vouchers dated today`).toHaveLength(1);
  return api<VoucherDetail>(page, 'vouchers.get', { id: list.rows[0].id });
}

test('a GST company with a customer, two stock items and two ledgers', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  const groups = (await api<{ rows: Array<{ id: number; name: string }> }>(page, 'accounts.group.list', {})).rows;
  const group = (name: string): number => {
    const g = groups.find((x) => x.name === name);
    if (!g) throw new Error(`Group ${name} is missing`);
    return g.id;
  };
  await api(page, 'accounts.ledger.save', { name: PARTY.name, groupId: group('Sundry Debtors'), gstin: PARTY.gstin, stateCode: '27', registrationType: 'regular' });
  ids.commission = (await api<{ id: number }>(page, 'accounts.ledger.save', { name: 'Commission Received', groupId: group('Indirect Incomes') })).id;
  ids.rent = (await api<{ id: number }>(page, 'accounts.ledger.save', { name: 'Shop Rent', groupId: group('Indirect Expenses') })).id;
  const units = (await api<{ rows: Array<{ id: number; symbol: string }> }>(page, 'inventory.unit.list', {})).rows;
  const nos = units.find((u) => u.symbol === 'Nos');
  expect(nos).toBeTruthy();
  const item = async (input: Record<string, unknown>): Promise<number> =>
    (await api<{ item: { id: number } }>(page, 'inventory.item.save', { unitId: nos?.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, ...input })).item.id;
  ids.bolt = await item({ name: BOLT.name, description: BOLT.master, hsnSac: '7318', openings: [{ qty: 1000, rate: 100 }] });
  ids.hinge = await item({ name: HINGE, hsnSac: '8302', openings: [{ qty: 500, rate: 40 }] });
  const types = (await api<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>(page, 'accounts.voucherType.list', {})).rows;
  ids.payment = types.find((t) => t.isPredefined && t.baseType === 'payment')?.id ?? 0;
  expect(ids.payment).toBeGreaterThan(0);
  // A new company's types start with "Description on every line" off: a description waits until asked for.
  expect((await api<VoucherTypeDetail>(page, 'accounts.voucherType.get', { id: ids.payment })).narrationPerEntry).toBe(false);
});

test('F8: Ctrl+E opens the description under item line 1 and Enter goes on to the quantity; line 2 goes item → quantity', async () => {
  await toGateway(page);
  await page.keyboard.press('F8');
  const entry = screen(page, 'vouchers.entry');
  await expect(entry.getByRole('heading', { name: 'Sales Creation', level: 1 })).toBeVisible();
  const party = entry.getByLabel(/^Party A\/c name/);
  await expect(party).toBeFocused();
  await pick(page, 'Kavya', new RegExp(lit(PARTY.name)));
  await expect(party).toHaveValue(PARTY.name);

  const lines = entry.getByRole('table', { name: 'Item lines', exact: true });
  await lines.getByLabel('Item, line 1', { exact: true }).focus();
  await pick(page, 'Steel', new RegExp(lit(BOLT.name)));
  const qty1 = lines.getByLabel('Quantity, line 1', { exact: true });
  // Nothing typed under the line: no field (and no stop for Enter), only the row tool.
  await expect(qty1).toBeFocused();
  await expect(description(lines, 1)).toHaveCount(0);
  await expect(descriptionTool(lines, 1)).toHaveCount(1);

  await page.keyboard.press('Control+e');
  await expect(description(lines, 1)).toBeFocused();
  await expect(description(nameCell(lines, 'Item, line 1'), 1)).toBeVisible();
  await expect(descriptionTool(lines, 1)).toHaveCount(0);
  await page.keyboard.type(ITEM_TEXT);
  await page.keyboard.press('Enter'); // item → description → quantity
  await expect(qty1).toBeFocused();
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await expect(lines.getByLabel('Rate, line 1', { exact: true })).toBeFocused();
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await expect(lines.getByLabel('Amount, line 1', { exact: true })).toHaveValue(/^1,?000(\.00)?$/);
  await expect(description(lines, 1)).toHaveValue(ITEM_TEXT); // with text it stays under the line

  // Line 2 without Ctrl+E: the Enter chain of 2.1, the quantity right after the item.
  await lines.getByLabel('Item, line 2', { exact: true }).focus();
  await pick(page, 'Brass', new RegExp(lit(HINGE)));
  await expect(lines.getByLabel('Quantity, line 2', { exact: true })).toBeFocused();
  await expect(description(lines, 2)).toHaveCount(0);
  await expect(descriptionTool(lines, 2)).toHaveCount(1);
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect(lines.getByLabel('Rate, line 2', { exact: true })).toBeFocused();
  await page.keyboard.type('70');
  await page.keyboard.press('Enter');
  await expect(lines.getByLabel('Amount, line 2', { exact: true })).toHaveValue(/^840(\.00)?$/);

  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(entry.getByRole('status', { name: 'Voucher saved' })).toContainText('Saved Sales 1');

  // Saved with the line (input.items → inventory_entries.description), not with the stock item.
  const sale = await savedToday('sales');
  ids.sale = sale.id;
  expect(sale.input.items?.map((l) => l.description ?? null)).toEqual([ITEM_TEXT, null]);
  expect(sale.inventory.map((l) => [l.itemId, l.description ?? null])).toEqual([
    [ids.bolt, ITEM_TEXT],
    [ids.hinge, null],
  ]);
  expect((await api<StockItemDetail>(page, 'inventory.item.get', { id: ids.bolt })).description).toBe(BOLT.master);
});

test('Day Book › Alt+Enter: the view shows the text under the item', async () => {
  const daybook = await openFromGateway(page, 'Day Book', 'vouchers.daybook');
  const row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(lit(PARTY.name)) });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.keyboard.press('Alt+Enter');
  const view = screen(page, 'vouchers.view');
  await expect(view.getByRole('heading', { name: 'Sales 1', level: 1 })).toBeVisible();

  const items = view.getByRole('grid', { name: 'Items', exact: true });
  const boltRow = items.getByRole('row').filter({ hasText: BOLT.name });
  await expect(boltRow).toHaveCount(1);
  await expect(boltRow.getByRole('gridcell').filter({ hasText: BOLT.name })).toContainText(ITEM_TEXT);
  await expect(view.getByText(ITEM_TEXT, { exact: true })).toBeVisible();
  const hingeRow = items.getByRole('row').filter({ hasText: HINGE });
  await expect(hingeRow).toHaveCount(1);
  await expect(hingeRow).not.toContainText(ITEM_TEXT);
  await expect(items).not.toContainText(BOLT.master);
});

test('Alt+P: the text prints under the item name', async () => {
  const view = screen(page, 'vouchers.view');
  await expect(view.getByRole('heading', { name: 'Sales 1', level: 1 })).toBeVisible();
  await page.keyboard.press('Alt+p');
  const preview = screen(page, 'print.voucher');
  await expect(preview.getByRole('heading', { name: 'Print Preview', level: 1 })).toBeVisible();
  const docs = preview.locator('.bp-docs');
  await expect(docs).toContainText(PARTY.name);
  // The item's description cell: the name, then the line's own text under it.
  const nameOf = (item: string): Locator => docs.locator('[data-part="col.description"]').filter({ hasText: item }).first();
  await expect(nameOf(BOLT.name)).toContainText(ITEM_TEXT);
  await expect(nameOf(HINGE)).toContainText(HINGE);
  await expect(nameOf(HINGE)).not.toContainText(ITEM_TEXT);
  await expect(docs).not.toContainText(BOLT.master);
});

test('Alt+A: the description shows with its text; emptied and saved, the line has none', async () => {
  const view = screen(page, 'vouchers.view');
  const heading = view.getByRole('heading', { name: 'Sales 1', level: 1 });
  // Esc leaves the preview for the view under it.
  for (let i = 0; i < 3 && !(await heading.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await heading.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
  }
  await expect(heading).toBeVisible();

  await page.keyboard.press('Alt+a');
  const entry = screen(page, 'vouchers.entry');
  await expect(entry.getByRole('heading', { name: 'Sales Alteration', level: 1 })).toBeVisible();
  const lines = entry.getByRole('table', { name: 'Item lines', exact: true });
  const desc = description(lines, 1);
  await expect(desc).toBeVisible();
  await expect(desc).toHaveValue(ITEM_TEXT);
  await expect(descriptionTool(lines, 1)).toHaveCount(0);
  await expect(description(lines, 2)).toHaveCount(0);

  await desc.fill('');
  await expect(desc).toHaveValue('');
  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Sales 1 altered').first()).toBeVisible();
  await expect(heading).toBeVisible();
  const items = view.getByRole('grid', { name: 'Items', exact: true });
  await expect(items).toContainText(BOLT.name);
  await expect(items).not.toContainText(ITEM_TEXT);

  const sale = await api<VoucherDetail>(page, 'vouchers.get', { id: ids.sale });
  expect(sale.input.items?.map((l) => l.description ?? null)).toEqual([null, null]);
  expect(sale.inventory.map((l) => l.description ?? null)).toEqual([null, null]);
  await toGateway(page);
});

test('F6 receipt: Ctrl+E opens the description under the ledger; Enter after it goes to the next line; saved as the narration', async () => {
  await toGateway(page);
  await page.keyboard.press('F6');
  const entry = screen(page, 'vouchers.entry');
  await expect(entry.getByRole('heading', { name: 'Receipt Creation', level: 1 })).toBeVisible();
  const lines = entry.getByRole('table', { name: 'Particulars', exact: true });
  await lines.getByLabel('Ledger, line 1', { exact: true }).focus();
  await pick(page, 'Commission', /Commission Received/);
  const amount = lines.getByLabel('Amount, line 1', { exact: true });
  await expect(amount).toBeFocused();
  await expect(description(lines, 1)).toHaveCount(0);
  await expect(descriptionTool(lines, 1)).toHaveCount(1);
  await page.keyboard.type('5000');

  await page.keyboard.press('Control+e');
  await expect(description(lines, 1)).toBeFocused();
  await expect(description(nameCell(lines, 'Ledger, line 1'), 1)).toBeVisible();
  await expect(amount).toHaveValue(/^5,?000(\.00)?$/);
  await page.keyboard.type(RECEIPT_TEXT);
  // In a ledger voucher the description is the last stop of its line.
  await page.keyboard.press('Enter');
  await expect(lines.getByLabel('Ledger, line 2', { exact: true })).toBeFocused();
  await expect(description(lines, 1)).toHaveValue(RECEIPT_TEXT);

  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(entry.getByRole('status', { name: 'Voucher saved' })).toContainText('Saved Receipt 1');
  const receipt = await savedToday('receipt');
  expect(receipt.input.ledgers?.find((l) => l.ledgerId === ids.commission)?.narration).toBe(RECEIPT_TEXT);
  expect(receipt.entries.find((e) => e.ledgerId === ids.commission)?.narration).toBe(RECEIPT_TEXT);
  // The cash line (the Account field) has none.
  expect(receipt.entries.filter((e) => e.ledgerId !== ids.commission).map((e) => e.narration ?? null)).toEqual([null]);
});

test('F5 payment with "Description on every line": ledger → amount → description; saved as the narration', async () => {
  await api(page, 'accounts.voucherType.save', { id: ids.payment, narrationPerEntry: true });
  try {
    await toGateway(page);
    await page.keyboard.press('F5');
    const entry = screen(page, 'vouchers.entry');
    await expect(entry.getByRole('heading', { name: 'Payment Creation', level: 1 })).toBeVisible();
    const lines = entry.getByRole('table', { name: 'Particulars', exact: true });
    const ledger = lines.getByLabel('Ledger, line 1', { exact: true });
    await expect(ledger).toBeVisible();
    await expect(description(lines, 1)).toHaveCount(0); // a line shows it once its ledger is chosen
    await ledger.focus();
    await pick(page, 'Shop', /Shop Rent/);
    const amount = lines.getByLabel('Amount, line 1', { exact: true });
    await expect(amount).toBeFocused();
    await expect(description(nameCell(lines, 'Ledger, line 1'), 1)).toBeVisible();
    await expect(descriptionTool(lines, 1)).toHaveCount(0);
    await page.keyboard.type('2500');
    await page.keyboard.press('Enter');
    await expect(description(lines, 1)).toBeFocused();
    await page.keyboard.type(PAYMENT_TEXT);
    await page.keyboard.press('Enter');
    await expect(lines.getByLabel('Ledger, line 2', { exact: true })).toBeFocused();
    await expect(description(lines, 2)).toHaveCount(0);

    await page.keyboard.press('Control+a');
    await saveAnywayIfAsked(page);
    await expect(entry.getByRole('status', { name: 'Voucher saved' })).toContainText('Saved Payment 1');
  } finally {
    await api(page, 'accounts.voucherType.save', { id: ids.payment, narrationPerEntry: false }).catch(() => undefined);
  }
  const payment = await savedToday('payment');
  expect(payment.input.ledgers?.find((l) => l.ledgerId === ids.rent)?.narration).toBe(PAYMENT_TEXT);
  expect(payment.entries.find((e) => e.ledgerId === ids.rent)?.narration).toBe(PAYMENT_TEXT);
  expect((await api<VoucherTypeDetail>(page, 'accounts.voucherType.get', { id: ids.payment })).narrationPerEntry).toBe(false);
  await toGateway(page);
});

test('no page error and no error logged by the app', async () => {
  expect(pageErrors).toEqual([]);
  expect(appErrors, 'error boundaries / unhandled rejections logged by the app').toEqual([]);
});
