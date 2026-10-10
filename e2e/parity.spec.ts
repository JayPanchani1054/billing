// The extended accounting features (TDS, forex, cheques, manufacturing, POS …) through the real UI
// of the built app, keyboard first:
//
//   wizard company → F11: TDS, multiple currencies, cheque printing, manufacturing, POS → masters
//   (through window.pevqori.api) → quotation → Quotation Register › Alt+V → Sales 1 (Ctrl+A) →
//   print preview of Sales 1 on A5 and on the 80 mm roll → POS counter: scan, UPI + cash, change →
//   purchase (F9) with the TDS auto-line → export invoice in US$ (voucher view) → Manufacturing
//   Journal from the BOM → cheque print preview of a payment (voucher view › Alt+K).
//
// Masters, inputs and figures are shared with the API-level twin src/core/testing/e2e/parity.test.ts
// through src/core/testing/e2e/parityFlow.ts (its header has the arithmetic) — the twin runs the same
// business flow in `npm test`. Steps created through the API (allowed in e2e: same IPC and core) are
// the masters, the quotation, the export invoice and the cheque payment; everything else is typed.
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { FEATURE_CATALOG } from '../src/renderer/app/lib/featureCatalog.ts';
import { chequePaymentInput, exportInvoiceInput, financialYearOf, PARITY, quotationInput, seedParityMasters } from '../src/core/testing/e2e/parityFlow.ts';
import type { ApiCall, ParityMasters } from '../src/core/testing/e2e/parityFlow.ts';
import { api, enableFeatures, firstLaunchCreateCompany, lit, localToday, openFromGateway, openGoto, pick, saveAnywayIfAsked, screen, stubNativeDialogs, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

let launched: LaunchedApp | undefined;
let app: ElectronApplication;
let page: Page;
let dataDir: string;
let m: ParityMasters;
const today = localToday();
const pageErrors: string[] = [];
/** The app's own console errors: a screen's error boundary, an unhandled rejection (src/renderer/app). */
const appErrors: string[] = [];

/** "1,180.00" for paise (Indian grouping, as the screens show amounts). */
function money(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest ? `${rest},` : ''}${last3}.${String(Math.abs(paise) % 100).padStart(2, '0')}`;
}

/** What a cashier / accountant types for an amount: plain rupees ("40000", "68.5"). */
function typed(paise: number): string {
  return String(paise / 100);
}

/** Open a screen through Go To by typing its label and taking the first option with that label. */
async function goTo(label: string, screenId: string): Promise<Locator> {
  const input = await openGoto(page);
  await input.fill(label);
  await page.getByRole('option', { name: new RegExp(`^${lit(label)}`) }).first().click();
  const s = screen(page, screenId);
  await expect(s).toBeVisible();
  return s;
}

/**
 * Day Book row of a party (optionally of a voucher type, by its exact Vch Type cell) → voucher view
 * (Alt+Enter). The type is matched on its own grid cell: a row's text joins its cells without spaces
 * ("Kavya TradersSales1"), so a word-bounded `hasText` never matches a type name.
 */
async function viewFromDayBook(party: string, type?: string): Promise<Locator> {
  const daybook = await openFromGateway(page, 'Day Book', 'vouchers.daybook');
  let row = daybook.getByRole('grid', { name: 'Day Book', exact: true }).getByRole('row', { name: new RegExp(lit(party)) });
  if (type) row = row.filter({ has: page.getByRole('gridcell', { name: type, exact: true }) });
  await expect(row).toHaveCount(1);
  await row.click();
  await page.keyboard.press('Alt+Enter');
  const view = screen(page, 'vouchers.view');
  await expect(view).toBeVisible();
  await expect(view).toContainText(party);
  return view;
}

/** Width of the first printed sheet in the preview, in millimetres (CSS: 96 px per inch). */
async function sheetWidthMm(preview: Locator): Promise<number> {
  const px = await preview.locator('.bp-doc').first().evaluate((el) => el.getBoundingClientRect().width);
  return (px * 25.4) / 96;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-parity-');
  ({ app, page, dataDir } = launched);
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[pevqori]')) appErrors.push(msg.text());
  });
  await stubNativeDialogs(app);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('company, F11 parity features and masters', async () => {
  test.setTimeout(120_000);
  await firstLaunchCreateCompany(page, dataDir, { name: PARITY.company.name, gstin: PARITY.company.gstin, state: PARITY.company.state });
  const labels = PARITY.features.map((k) => {
    const info = FEATURE_CATALOG.find((f) => f.key === k);
    if (!info) throw new Error(`Feature ${k} is not in the F11 catalogue`);
    return info.label;
  });
  await enableFeatures(page, labels);
  const call: ApiCall = <T>(route: string, input?: unknown) => api<T>(page, route, input);
  m = await seedParityMasters(call, today);
});

test('quotation → Quotation Register › Alt+V → Sales 1', async () => {
  const q = await api<{ number: string }>(page, 'vouchers.save', quotationInput(m, today));
  expect(q.number).toBe('1');

  const register = await goTo('Quotation Register', 'documents.quotations');
  const grid = register.getByRole('grid', { name: 'Quotations', exact: true });
  const row = grid.getByRole('row', { name: new RegExp(lit(PARITY.customer.name)) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Open');
  await expect(row).toContainText(money(PARITY.quotation.total));

  await page.keyboard.press('Alt+v'); // Convert to Sales Invoice (the first row is the current one)
  const entry = screen(page, 'vouchers.entry');
  await expect(entry).toBeVisible();
  await expect(entry.getByLabel(/^Party A\/c name/)).toHaveValue(PARITY.customer.name);
  await expect(entry.getByLabel('Quantity, line 1', { exact: true })).toHaveValue(new RegExp(`^${PARITY.quotation.qty}\\b`));
  await expect(entry.getByText(money(PARITY.quotation.total)).first()).toBeVisible();
  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Sales 1 saved')).toBeVisible();

  // Back on the register (a converted document returns to its list): converted into Sales 1.
  await expect(register).toBeVisible();
  await expect(row).toContainText('Converted');
  await expect(row).toContainText('Sales 1');
});

test('print preview of Sales 1 on A5, then on the 80 mm roll', async () => {
  await viewFromDayBook(PARITY.customer.name, 'Sales');
  await page.keyboard.press('Alt+p');
  const preview = screen(page, 'print.voucher');
  await expect(preview.getByRole('heading', { name: 'Print Preview', level: 1 })).toBeVisible();
  await expect(preview).toContainText(money(PARITY.quotation.total));

  const paper = preview.getByLabel('Paper size', { exact: true });
  await paper.selectOption('A5');
  await expect.poll(() => sheetWidthMm(preview)).toBeCloseTo(148, 0); // A5 portrait: 148 × 210 mm
  await expect(preview.locator('.bp-doc').first()).toContainText(PARITY.customer.name);

  await paper.selectOption('80mm');
  await expect(preview.locator('.bp-compact').first()).toBeVisible(); // the roll prints the Compact receipt
  await expect.poll(() => sheetWidthMm(preview)).toBeCloseTo(80, 0);
  await expect(preview.locator('.bp-doc').first()).toContainText(money(PARITY.quotation.total));
  await toGateway(page);
});

test('POS counter: scan, pay UPI + cash, change due', async () => {
  const counter = await goTo('POS Counter', 'pos.counter');
  const scan = counter.getByLabel('Scan barcode or type item code', { exact: true });
  await scan.focus();
  await scan.fill(PARITY.item.barcode);
  await page.keyboard.press('Enter');
  await expect(counter.getByRole('grid', { name: 'Bill lines', exact: true })).toContainText(PARITY.item.name);
  await expect(counter.locator('.pos-total__amount:not(.is-pending)')).toHaveText(`₹ ${money(PARITY.pos.total)}`);

  await page.keyboard.press('Control+a'); // Payment
  const pay = page.getByRole('dialog', { name: `Payment — ₹ ${money(PARITY.pos.total)}` });
  await expect(pay).toBeVisible();
  await pay.getByLabel(`${PARITY.pos.upiMode} amount`, { exact: true }).fill(typed(PARITY.pos.upi));
  await expect(pay.getByLabel('Cash amount', { exact: true })).toHaveValue(money(PARITY.pos.cash)); // the balance moves to cash
  await pay.locator('#pos-cash-tendered').fill(typed(PARITY.pos.tendered));
  await expect(pay.locator('.pos-pay-summary__change')).toContainText(`₹ ${money(PARITY.pos.change)}`);
  await pay.getByRole('button', { name: 'Save bill' }).click();
  await saveAnywayIfAsked(page);

  await expect(page.getByText('Bill POS/1 saved')).toBeVisible();
  await expect(counter).toContainText('Last bill POS/1');
  await expect(counter).toContainText(`Change given ₹ ${money(PARITY.pos.change)}`);
  await toGateway(page);
});

test('purchase (F9) in accounting-invoice mode gets the TDS auto-line', async () => {
  await toGateway(page);
  await page.keyboard.press('F9');
  const entry = screen(page, 'vouchers.entry');
  await expect(entry).toBeVisible();
  await entry.getByRole('radiogroup', { name: 'Entry mode' }).getByRole('radio', { name: 'Accounting invoice' }).click();

  // A purchase names its party field after the supplier (sales-side documents: "Party A/c name").
  const supplier = entry.getByLabel(/^Supplier \(party A\/c\)/);
  await supplier.focus();
  await pick(page, 'Sharma Con', new RegExp(lit(PARITY.tds.supplier)));
  await expect(supplier).toHaveValue(PARITY.tds.supplier);
  await entry.getByLabel(/^Supplier invoice no/).fill(PARITY.tds.supplierInvoiceNo);

  const lines = entry.getByRole('table', { name: 'Invoice lines' });
  await lines.getByLabel('Ledger, line 1', { exact: true }).focus();
  await pick(page, 'Contract', new RegExp(lit(PARITY.tds.expense)));
  const amount = lines.getByLabel('Amount, line 1', { exact: true });
  await amount.fill(typed(PARITY.tds.amount));
  await amount.press('Tab');

  const tds = entry.getByRole('region', { name: 'TDS on this voucher' });
  await expect(tds).toContainText(PARITY.tds.section, { timeout: 15_000 });
  await expect(tds).toContainText(`TDS deducted from the party`);
  await expect(tds).toContainText(money(PARITY.tds.tds));
  await expect(entry.getByText(money(PARITY.tds.total)).first()).toBeVisible();

  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Purchase 1 saved')).toBeVisible();
  await toGateway(page);
});

test('export invoice in US$: the voucher view shows both currencies', async () => {
  const saved = await api<{ number: string; totals: { grandTotal: number } }>(page, 'vouchers.save', exportInvoiceInput(m, today));
  expect(saved.number).toBe('2');
  expect(saved.totals.grandTotal).toBe(PARITY.forex.inr);
  const view = await viewFromDayBook(PARITY.forex.customer);
  await expect(view).toContainText('Foreign currency');
  await expect(view).toContainText(`${PARITY.forex.currency.symbol} 2,000.00`);
  await expect(view).toContainText(`@ ₹${PARITY.forex.rate}.00`);
  await expect(view).toContainText(money(PARITY.forex.inr));
  await toGateway(page);
});

test('Manufacturing Journal from the default BOM', async () => {
  const journal = await goTo('Manufacturing Journal', 'mfg.journal.entry');
  const finished = journal.getByRole('region', { name: 'Finished goods' });
  await finished.getByRole('combobox', { name: /^Item/ }).focus();
  await pick(page, 'Bolt Kit', new RegExp(lit(PARITY.kit.name)));
  // The item's default BOM is chosen at once; its components fill in once the quantity is known
  // (as accountants expect: item → quantity → components scaled to it).
  await expect(finished.getByLabel('Bill of materials')).toHaveValue(String(m.bom));
  const qty = finished.getByLabel(/^Quantity/);
  await qty.fill(String(PARITY.kit.qty));
  await qty.press('Tab');
  const consumed = journal.getByLabel(`Quantity of ${PARITY.item.name}`, { exact: true });
  await expect(consumed).toHaveValue(new RegExp(`^${PARITY.kit.consumed}(\\.0+)?\\b`));
  await page.keyboard.press('Control+a');
  await saveAnywayIfAsked(page);
  await expect(page.getByText('Manufacturing Journal 1 created')).toBeVisible();
  await toGateway(page);
  const reg = await api<{ rows: Array<{ itemName: string; qty: number; productValue: number }> }>(page, 'mfg.production.register', financialYearOf(today));
  expect(reg.rows.map((r) => [r.itemName, r.qty, r.productValue])).toEqual([[PARITY.kit.name, PARITY.kit.qty, PARITY.kit.cost]]);
});

test('cheque print preview from a payment (voucher view › Alt+K)', async () => {
  await api(page, 'vouchers.save', chequePaymentInput(m, today));
  await viewFromDayBook(PARITY.cheque.payee);
  await page.keyboard.press('Alt+k');
  const cheques = screen(page, 'cheques.print');
  await expect(cheques.getByRole('heading', { name: 'Print Cheques', level: 1 })).toBeVisible();
  const row = cheques.getByRole('grid', { name: 'Cheques', exact: true }).getByRole('row', { name: new RegExp(lit(PARITY.cheque.payee)) });
  await expect(row).toContainText(PARITY.cheque.leaf);
  await expect(row).toContainText(money(PARITY.cheque.amount));
  const sheet = cheques.getByRole('region', { name: 'Preview of the cheques' });
  await expect(sheet).toContainText(PARITY.cheque.payee);
  await expect(sheet).toContainText(PARITY.cheque.words);
  await expect(sheet).toContainText(PARITY.cheque.figures);
  await toGateway(page);
});

test('the books balance and no screen threw', async () => {
  const fy = financialYearOf(today);
  const tb = await api<{ totals: { debit: number; credit: number } }>(page, 'reports.trialBalance', { from: fy.from, to: today });
  expect(tb.totals.debit).toBe(tb.totals.credit);
  expect(pageErrors).toEqual([]);
  expect(appErrors, 'error boundaries / unhandled rejections logged by the app').toEqual([]);
});
