// Graphs on reports (2.1, design/SPEC-21 §4.8, D28, D30), on the real built app:
//
//   its own company whose books begin on 1-Apr of the PREVIOUS financial year (set in the Create
//   Company wizard), three sales invoices seeded through the API in three months of that year, and the
//   period set with Alt+F2 to that year — so nothing depends on today's date.
//
//   Sales Register .. the graph "Sales before GST, by month" is drawn; the sum of its data table (the
//                     visually hidden twin of the graph) equals the table's Taxable value total; Ctrl+J
//                     folds it to the header line ("Show graphs"), the fold survives a relaunch, Ctrl+J
//                     unfolds it; Shift+Tab from the table reaches the graph, → then Enter opens the same
//                     voucher list as Enter on that month's row
//   Profit & Loss ... the monthly graph is drawn (no purchases) and its total equals the Net Profit row;
//                     Tab goes to the other side of the same block (Trading Expenses → Trading Income →
//                     P&L Expenses), as in 2.0, although each side is now one named section
//   Ledger .......... a drill-down report (detail class): the graph's header line shows and, since
//                     2.1.1 (D3, the owner's request), the plot is drawn by default
//   Monthly Summary . (Alt+Y on the customer's ledger) a report-class column graph by month, shown by
//                     default (2.1.1 D1); each column of its hidden data table equals that month's
//                     Closing Balance in the table
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { PARITY } from '../src/core/testing/e2e/parityFlow.ts';
import { api, lit, localToday, openGoto, openGotoItem, pick, screen, stubNativeDialogs, toGateway, topScreen } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const COMPANY = { name: 'Graph Traders E2E', gstin: PARITY.company.gstin, state: PARITY.company.state } as const;
const CUSTOMER = PARITY.customer;
const REGISTER_GRAPH = 'Sales before GST, by month';

/** The financial year before the one containing today (April–March). */
function previousFinancialYear(): { from: string; to: string; start: number } {
  const today = localToday();
  const y = Number(today.slice(0, 4));
  const start = (Number(today.slice(5, 7)) >= 4 ? y : y - 1) - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, start };
}
const FY = previousFinancialYear();
/** Three months of that year with a sale each (April first: → from the graph's start reaches it). */
const SALES = [
  { date: `${FY.start}-04-15`, qty: 4, rate: 100 },
  { date: `${FY.start}-06-10`, qty: 6, rate: 100 },
  { date: `${FY.start}-08-20`, qty: 3, rate: 100 },
] as const;

let launched: LaunchedApp | undefined;
let page: Page;
/** The customer's ledger id (its Go To option is `ledger:<id>`). */
let customerId = 0;
let itemId = 0;
let salesTypeId = 0;

captureFailures(() => launched);
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-graphs-');
  page = launched.page;
  await stubNativeDialogs(launched.app);
});

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

/** '₹ 1,23,456.00' / '-₹ 12.00' / '(1,000.00)' / '1,000.00 Cr' → paise (sign from '-' or brackets). */
function paise(text: string): number {
  const t = text.replace(/[₹\s,]/g, '').replace(/(Dr|Cr)$/, '');
  const neg = t.startsWith('-') || t.startsWith('(');
  const n = Math.round(Number(t.replace(/[-()]/g, '')) * 100);
  if (!Number.isFinite(n)) throw new Error(`not an amount: "${text}"`);
  return neg ? -n : n;
}

/** The graph's visually hidden data table (its caption is the graph's title): the sum of its cells. */
async function graphTwinTotal(scope: Locator, title: string): Promise<number> {
  const twin = scope.locator('table.bx-sr-only').filter({ has: page.locator('caption', { hasText: new RegExp(`^${lit(title)}$`) }) });
  await expect(twin).toHaveCount(1);
  const cells = await twin.locator('tbody td').allTextContents();
  expect(cells.length).toBeGreaterThan(2);
  return cells.reduce((sum, c) => sum + (c.trim() === '—' ? 0 : paise(c)), 0);
}

/** Alt+F2 → From / To → Apply period. */
async function setPeriod(from: string, to: string): Promise<void> {
  await page.keyboard.press('Alt+F2');
  const dialog = page.getByRole('dialog', { name: 'Change Period' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^From/).fill(from);
  await dialog.getByLabel(/^From/).press('Tab');
  await dialog.getByLabel(/^To\b/).fill(to);
  await dialog.getByLabel(/^To\b/).press('Tab');
  await dialog.getByRole('button', { name: /^Apply period/ }).click();
  await expect(dialog).toBeHidden();
}

/** Go To → a screen by its label → the pushed screen. */
async function viaGoto(label: string, id: string): Promise<Locator> {
  const input = await openGoto(page);
  await input.fill(label);
  await page.getByRole('option', { name: new RegExp(`^${lit(label)}`) }).first().click();
  const s = screen(page, id);
  await expect(s).toBeVisible();
  return s;
}

/** The Sales Register (months view) with its period set, its month grid focused. */
async function openSalesRegister(): Promise<Locator> {
  await toGateway(page);
  await setPeriod(FY.from, FY.to);
  const reg = await viaGoto('Sales Register', 'reports.register');
  await expect(reg.getByRole('heading', { name: 'Sales Register', level: 1 })).toBeVisible();
  await expect(reg.getByRole('grid', { name: 'Sales Register by month' })).toBeFocused();
  return reg;
}

test('setup: a company whose books begin a year back, three sales in three months', async () => {
  test.setTimeout(180_000);
  // The Create Company wizard (as flows.ts firstLaunchCreateCompany), with "Books begin on" a year back.
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
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Books of accounts' })).toBeVisible();
  const books = page.getByLabel(/^Books begin on/);
  await books.fill(FY.from);
  await books.press('Tab');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Protect your books' })).toBeVisible();
  await page.getByRole('switch', { name: /^Protect this company with a password/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await expect(page.getByText(`01-Apr-${FY.start}`).first()).toBeVisible();
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(screen(page, 'app.gateway')).toBeVisible({ timeout: 30_000 });

  // Masters and three sales invoices through the API (the same IPC path the screens use).
  const groups = (await api<{ rows: Array<{ id: number; name: string }> }>(page, 'accounts.group.list', {})).rows;
  const debtors = groups.find((g) => g.name === 'Sundry Debtors')?.id;
  const types = (await api<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>(page, 'accounts.voucherType.list', {})).rows;
  const sales = types.find((t) => t.isPredefined && t.baseType === 'sales')?.id;
  const units = (await api<{ rows: Array<{ id: number; symbol: string }> }>(page, 'inventory.unit.list', {})).rows;
  const nos = units.find((u) => u.symbol === PARITY.item.unit)?.id;
  expect(debtors && sales && nos, 'Sundry Debtors, the Sales type and the Nos unit exist').toBeTruthy();
  const customer = (customerId = (await api<{ id: number }>(page, 'accounts.ledger.save', { name: CUSTOMER.name, groupId: debtors, gstin: CUSTOMER.gstin, stateCode: '27', registrationType: 'regular' })).id);
  const item = (
    await api<{ item: { id: number } }>(page, 'inventory.item.save', {
      name: PARITY.item.name,
      unitId: nos,
      gstApplicable: true,
      taxability: 'taxable',
      gstRate: PARITY.item.gstRate,
      hsnSac: PARITY.item.hsn,
      openings: [{ qty: PARITY.item.openingQty, rate: PARITY.item.openingRate }],
    })
  ).item.id;
  itemId = item;
  salesTypeId = sales ?? 0;
  for (const s of SALES) {
    await api(page, 'vouchers.save', { voucherTypeId: sales, date: s.date, mode: 'item_invoice', partyLedgerId: customer, items: [{ itemId: item, qty: s.qty, rate: s.rate }], acknowledgeWarnings: true });
  }
  const register = await api<{ totals: { taxable: number; count: number } }>(page, 'reports.register', { baseType: 'sales', from: FY.from, to: FY.to });
  expect(register.totals.count).toBe(SALES.length);
  expect(register.totals.taxable).toBe(SALES.reduce((a, s) => a + s.qty * s.rate * 100, 0));
});

test('Sales Register: the graph is drawn and its total is the table\'s Taxable value total', async () => {
  const reg = await openSalesRegister();
  await expect(reg.getByRole('listbox', { name: REGISTER_GRAPH })).toBeVisible();
  const drawn = await graphTwinTotal(reg, REGISTER_GRAPH);

  const grid = reg.getByRole('grid', { name: 'Sales Register by month' });
  const headers = (await grid.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const col = headers.indexOf('Taxable value');
  expect(col, `columns: ${headers.join(' | ')}`).toBeGreaterThan(0);
  expect(headers, 'no Cancelled column while no month has one').not.toContain('Cancelled');
  const totalText = await grid.locator('tfoot tr').first().locator('td').nth(col).textContent();
  expect(drawn).toBe(paise(totalText ?? ''));
  expect(drawn).toBe(SALES.reduce((a, s) => a + s.qty * s.rate * 100, 0));
});

test('Ctrl+J folds the graphs to their header line; the fold survives a relaunch; Ctrl+J unfolds', async ({}, testInfo) => {
  test.setTimeout(180_000);
  let reg = screen(page, 'reports.register');
  await page.keyboard.press('Control+j');
  await expect(reg.getByRole('listbox', { name: REGISTER_GRAPH })).toHaveCount(0);
  await expect(reg.locator('.bx-report__graph-head').getByRole('button', { name: 'Show graphs' })).toBeVisible();
  await expect(reg.locator('.bx-report__graph-head')).toContainText(REGISTER_GRAPH);

  // Relaunch on the same folders: the preference is remembered on this computer.
  const first = launched;
  if (!first) throw new Error('not launched');
  await closeApp(first, testInfo, { keepFolders: true });
  // Nothing to close if the relaunch fails (the folders are the first launch's: removed by the last closeApp).
  launched = undefined;
  launched = await launchApp('pevqori-e2e-graphs-', { reuse: first });
  page = launched.page;
  await stubNativeDialogs(launched.app);
  await expect(page.getByText(COMPANY.name, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  const search = page.getByRole('textbox', { name: 'Search companies' });
  await expect(search).toBeVisible();
  await search.focus();
  await page.keyboard.press('Enter');
  await expect(screen(page, 'app.gateway')).toBeVisible({ timeout: 60_000 });

  reg = await openSalesRegister();
  await expect(reg.locator('.bx-report__graph-head').getByRole('button', { name: 'Show graphs' })).toBeVisible();
  await expect(reg.getByRole('listbox', { name: REGISTER_GRAPH })).toHaveCount(0);
  await page.keyboard.press('Control+j');
  await expect(reg.getByRole('listbox', { name: REGISTER_GRAPH })).toBeVisible();
  await expect(reg.locator('.bx-report__graph-head').getByRole('button', { name: 'Hide graphs' })).toBeVisible();
});

test('Shift+Tab reaches the graph; → then Enter opens the same vouchers as Enter on that month\'s row', async () => {
  const reg = screen(page, 'reports.register');
  const grid = reg.getByRole('grid', { name: 'Sales Register by month' });
  await grid.focus();
  const graph = reg.getByRole('listbox', { name: REGISTER_GRAPH });
  await page.keyboard.press('Shift+Tab');
  await expect(graph).toBeFocused();
  await page.keyboard.press('ArrowRight'); // the first month (April: a sale)
  await expect(graph.getByRole('option', { selected: true })).toHaveCount(1);
  await page.keyboard.press('Enter');
  const fromGraph = topScreen(page).getByRole('grid', { name: 'Sales Register vouchers' });
  await expect(fromGraph).toBeVisible();
  await expect(fromGraph.getByRole('row', { name: new RegExp(lit(CUSTOMER.name)) })).toHaveCount(1);
  const viaGraph = (await fromGraph.locator('tbody').innerText()).trim();

  await page.keyboard.press('Escape');
  await expect(grid).toBeVisible();
  await grid.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter'); // the first row: April
  const fromRow = topScreen(page).getByRole('grid', { name: 'Sales Register vouchers' });
  await expect(fromRow).toBeVisible();
  await expect(fromRow.getByRole('row', { name: new RegExp(lit(CUSTOMER.name)) })).toHaveCount(1);
  expect((await fromRow.locator('tbody').innerText()).trim()).toBe(viaGraph);
  await toGateway(page);
});

test('Profit & Loss: the monthly graph is drawn and adds up to the Net Profit row', async () => {
  await toGateway(page);
  const pl = await viaGoto('Profit & Loss A/c', 'reports.profitLoss');
  await expect(pl.getByRole('heading', { name: 'Profit & Loss A/c', level: 1 })).toBeVisible();
  await expect(pl.getByRole('region', { name: 'Expenses', exact: true })).toBeVisible();
  await expect(pl.getByRole('region', { name: 'Income', exact: true })).toBeVisible();
  await expect(pl.getByRole('listbox', { name: 'Net profit by month' })).toBeVisible();
  const drawn = await graphTwinTotal(pl, 'Net profit by month');
  const net = pl.getByRole('row', { name: /^Net (Profit|Loss)\b/ }).first();
  await expect(net).toBeVisible();
  const name = (await net.getByRole('gridcell').first().textContent()) ?? '';
  const amount = paise((await net.getByRole('gridcell').nth(1).textContent()) ?? '');
  expect(drawn).toBe(/Loss/.test(name) ? -amount : amount);
  // The same figure is the title row's one state word.
  await expect(pl.locator('.bx-titlebar__context')).toContainText(/Net (profit|loss) ₹/);
  // One sheet, but Tab still goes to the other side of the same block first (2.0's "Tab Other side").
  const tradingExpenses = pl.getByLabel('Expenses, Trading Account', { exact: true });
  await tradingExpenses.focus();
  await page.keyboard.press('Tab');
  await expect(pl.getByLabel('Income, Trading Account', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pl.getByLabel('Expenses, Profit & Loss Account', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pl.getByLabel('Income, Trading Account', { exact: true })).toBeFocused();
  await toGateway(page);
});

test('Ledger (a drill-down report): the header line shows, the plot is drawn by default (2.1.1 D3)', async () => {
  await toGateway(page);
  await openGotoItem(page, { id: `ledger:${customerId}`, label: CUSTOMER.name });
  const ledger = screen(page, 'reports.ledger');
  await expect(ledger).toBeVisible();
  await expect(ledger.getByRole('heading', { name: CUSTOMER.name, level: 1 })).toBeVisible();
  const head = ledger.locator('.bx-report__graph-head');
  await expect(head).toContainText('Balance by date');
  // The owner's request (2.1.1): drill-down graphs are shown until folded — never folded by default.
  await expect(head.getByRole('button', { name: 'Hide graphs' })).toBeVisible();
  await expect(ledger.getByRole('listbox', { name: 'Balance by date' })).toBeVisible();
  await toGateway(page);
});

test('Monthly Summary (Alt+Y on the ledger): a column graph by month, shown by default, each column = that month\'s Closing', async () => {
  await toGateway(page);
  await openGotoItem(page, { id: `ledger:${customerId}`, label: CUSTOMER.name });
  const ledger = screen(page, 'reports.ledger');
  await expect(ledger).toBeVisible();
  await page.keyboard.press('Alt+y');
  const ms = screen(page, 'reports.monthlySummary');
  await expect(ms).toBeVisible();
  await expect(ms.getByRole('heading', { name: `${CUSTOMER.name} — Monthly Summary`, level: 1 })).toBeVisible();
  // A customer (an asset): its month-end closing balance as columns, report class — drawn by default.
  const title = 'Closing balance by month';
  const head = ms.locator('.bx-report__graph-head');
  await expect(head).toContainText(title);
  await expect(head.getByRole('button', { name: 'Hide graphs' })).toBeVisible();
  const graph = ms.getByRole('listbox', { name: title });
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('option')).toHaveCount(12);
  // The hidden twin ties to the table, month by month (the same order: April first).
  const twin = ms.locator('table.bx-sr-only').filter({ has: page.locator('caption', { hasText: new RegExp(`^${lit(title)}$`) }) });
  await expect(twin).toHaveCount(1);
  const drawn = (await twin.locator('tbody td').allTextContents()).map((c) => paise(c));
  const grid = ms.getByRole('grid', { name: 'Monthly summary' });
  const headers = (await grid.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const col = headers.indexOf('Closing Balance');
  expect(col, `columns: ${headers.join(' | ')}`).toBeGreaterThan(0);
  const rows = grid.locator('tbody tr[data-pos]');
  await expect(rows).toHaveCount(12);
  const closing: number[] = [];
  for (let i = 0; i < 12; i++) closing.push(paise((await rows.nth(i).locator('td').nth(col).textContent()) ?? ''));
  expect(drawn).toEqual(closing);
  // The last column is the Grand Total's closing balance; every sale is on the Dr side (slot 1).
  const grand = paise((await grid.locator('tfoot tr').last().locator('td').nth(col).textContent()) ?? '');
  expect(drawn[11]).toBe(grand);
  expect(grand).toBeGreaterThan(0);
  await toGateway(page);
});

test('Home: with a sale this month, "Sales — last 12 months" is drawn (books began a year back)', async () => {
  await api(page, 'vouchers.save', { voucherTypeId: salesTypeId, date: localToday(), mode: 'item_invoice', partyLedgerId: customerId, items: [{ itemId, qty: 1, rate: 100 }], acknowledgeWarnings: true });
  // Home refetches when it comes back to the top: leave it once after the API save.
  await toGateway(page);
  await viaGoto('Day Book', 'vouchers.daybook');
  await toGateway(page);
  const graph = page.getByRole('listbox', { name: 'Sales — last 12 months' });
  await expect(graph).toBeVisible();
  expect(await graph.getByRole('option').count()).toBeGreaterThanOrEqual(3);
});
