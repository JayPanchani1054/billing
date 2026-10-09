// A new user's first day, driven through the real UI of the built app (out/), keyboard first:
//
//   first launch (data folder) → Create Company wizard → party ledger → stock item → sales invoice
//   (F8, typed) → Day Book → voucher → Print Preview → Balance Sheet → GSTR-1 → Backup
//
// Every value typed here is pinned by the API-level twin src/core/testing/e2e/first-day.test.ts
// (same masters, same routes, same figures), which runs in `npm test` — keep the two in step.
//
// Selectors are roles, labels and visible text taken from the components. Screens are scoped with
// the shell's `data-screen="<screen id>"` attribute (src/renderer/app/nav.tsx), because lower screens
// of the navigation stack stay mounted (hidden) and would otherwise make label lookups ambiguous.
//
// Figures: 10 Nos × ₹100.00 = ₹1,000.00; Maharashtra → Maharashtra, so CGST 9% ₹90.00 + SGST 9%
// ₹90.00 → ₹1,180.00. The item has no opening stock, so saving asks to confirm negative stock.
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fictional, checksum-valid GSTINs (see the API twin). */
const FLOW = {
  company: { name: 'Sharma Traders E2E', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' },
  party: { name: 'Kavya Traders', gstin: '27AAAPA0002A1Z5' },
  item: { name: 'Steel Bolt M8', unit: 'Nos', hsn: '7318', rate: '18' },
  sale: { qty: '10', price: '100' },
} as const;

let app: ElectronApplication;
let page: Page;
let tmp: string;
let dataDir: string;

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'BAHI_DEV_SERVER_URL') env[key] = value;
  }
  return { ...env, ...extra };
}

/** A pushed screen of the navigation stack, by its registered id. */
function screen(id: string): Locator {
  return page.locator(`[data-screen="${id}"]`);
}

/** Escape a literal for a RegExp. */
function lit(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Esc back down the stack until the Gateway is the visible screen. */
async function toGateway(): Promise<void> {
  const gateway = screen('app.gateway');
  for (let i = 0; i < 8; i++) {
    if (await gateway.isVisible()) return;
    await page.keyboard.press('Escape');
    await gateway.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
  }
  await expect(gateway).toBeVisible();
}

/** Open a Gateway menu item by its label (Tally-style menu on the left). */
async function openFromGateway(label: string, screenId: string): Promise<Locator> {
  await toGateway();
  await page
    .getByRole('navigation', { name: 'Gateway menu' })
    .getByRole('button', { name: new RegExp(`^${lit(label)}`) })
    .click();
  const s = screen(screenId);
  await expect(s).toBeVisible();
  return s;
}

/** Type into the focused combobox and accept the highlighted option once it is listed. */
async function pick(typed: string, option: RegExp): Promise<void> {
  await page.keyboard.type(typed);
  await expect(page.getByRole('option', { name: option }).first()).toBeVisible();
  await page.keyboard.press('Enter');
}

/** "MMYYYY" of the current month — the GST return period of an invoice dated today. */
function currentReturnPeriod(): string {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'bahi-e2e-flow-'));
  dataDir = path.join(tmp, 'data');
  app = await electron.launch({
    args: ['out/main/index.cjs'],
    cwd: repoRoot,
    env: childEnv({
      BAHI_USER_DATA: path.join(tmp, 'user-data'),
      BAHI_DATA_DIR: dataDir,
      BAHI_E2E: '1',
    }),
  });
  app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron] ${d.toString()}`));
  app.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[electron] ${d.toString()}`));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('first launch: keep the data folder given by BAHI_DATA_DIR', async () => {
  await expect(page.getByRole('heading', { name: 'Where should Bahi keep your data?' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(dataDir, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Bahi ERP' })).toBeVisible();
});

test('create a GST company with the wizard', async () => {
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Create Company', level: 1 })).toBeVisible();

  // Step 1 — Business
  await page.getByLabel(/^Business name/).fill(FLOW.company.name);
  await page.getByLabel(/^State/).focus();
  await pick(FLOW.company.state, new RegExp(`27 - ${FLOW.company.state}`));
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2 — GST & tax (Regular is the default; the GSTIN fills the PAN)
  await expect(page.getByRole('heading', { name: 'GST and tax' })).toBeVisible();
  await page.getByLabel(/^GSTIN/).fill(FLOW.company.gstin);
  await expect(page.getByLabel(/^PAN/)).toHaveValue(FLOW.company.gstin.slice(2, 12));
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 3 — Books (current financial year), Step 4 — Features (stock + bill-wise are on by default)
  await expect(page.getByRole('heading', { name: 'Books of accounts' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Maintain stock' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 5 — Security: no password for this run (the login flow has its own unit tests)
  await expect(page.getByRole('heading', { name: 'Protect your books' })).toBeVisible();
  await page.getByRole('switch', { name: /^Protect this company with a password/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 6 — Review → Create
  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await page.getByRole('button', { name: 'Create company' }).click();

  await expect(screen('app.gateway')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Gateway', level: 1 })).toBeVisible();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '')).toContain(FLOW.company.name);
});

test('create the party ledger (Sundry Debtors, GSTIN)', async () => {
  const form = await openFromGateway('Create Ledger', 'accounts.ledger.form');
  await expect(form.getByRole('heading', { name: 'Ledger Creation', level: 1 })).toBeVisible();
  await expect(form.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.type(FLOW.party.name);

  await form.getByLabel(/^Under/).focus();
  await pick('Sundry Debtors', /^Sundry Debtors/);

  // Party sections appear for a customer group; a valid GSTIN fills state, PAN and registration.
  const gstin = form.getByLabel(/^GSTIN/);
  await expect(gstin).toBeVisible();
  await gstin.fill(FLOW.party.gstin);
  await expect(form.getByLabel(/^PAN/)).toHaveValue(FLOW.party.gstin.slice(2, 12));

  await page.keyboard.press('Alt+s'); // Save & close
  await expect(page.getByText(`Ledger “${FLOW.party.name}” created`)).toBeVisible();
  await expect(form).toHaveCount(0);
});

test('create the stock item (Nos, own GST 18%, HSN)', async () => {
  const form = await openFromGateway('Create Stock Item', 'inventory.item.form');
  await expect(form.getByRole('heading', { name: 'Stock Item Creation', level: 1 })).toBeVisible();
  await expect(form.getByLabel(/^Name/)).toBeFocused();
  await page.keyboard.type(FLOW.item.name);

  await form.getByLabel(/^Unit/).focus();
  await pick(FLOW.item.unit, new RegExp(`^${FLOW.item.unit}\\b`));

  await form.getByRole('switch', { name: 'No — inherit' }).click();
  await form.getByLabel(/^GST rate/).selectOption(FLOW.item.rate);
  await form.getByLabel(/^HSN code/).fill(FLOW.item.hsn);

  await page.keyboard.press('Alt+s'); // Save & close
  await expect(page.getByText(`Stock item “${FLOW.item.name}” created`)).toBeVisible();
  await expect(form).toHaveCount(0);
});

test('enter a sales invoice by keyboard (F8)', async () => {
  await toGateway();
  await page.keyboard.press('F8');
  const entry = screen('vouchers.entry');
  await expect(entry).toBeVisible();

  // The cursor starts on the party (automatic numbering).
  const party = entry.getByLabel(/^Party A\/c name/);
  await expect(party).toBeFocused();
  await pick('Kavya', new RegExp(lit(FLOW.party.name)));
  await expect(party).toHaveValue(FLOW.party.name);

  // Item line: item → Enter → quantity → Enter → rate.
  await entry.getByLabel('Item, line 1').focus();
  await pick('Steel', new RegExp(lit(FLOW.item.name)));
  const qty = entry.getByLabel('Quantity, line 1');
  await expect(qty).toBeFocused();
  await page.keyboard.type(FLOW.sale.qty);
  await page.keyboard.press('Enter');
  const rate = entry.getByLabel('Rate, line 1');
  await expect(rate).toBeFocused();
  await page.keyboard.type(FLOW.sale.price);
  await page.keyboard.press('Enter');

  await expect(entry.getByLabel('Amount, line 1')).toHaveValue(/^1,?000(\.00)?$/);
  await expect(entry.getByText('1,180.00').first()).toBeVisible();

  // Accept. No stock was ever received, so the negative-stock guard asks first.
  await page.keyboard.press('Control+a');
  const check = page.getByRole('dialog', { name: 'Please check before saving' });
  await expect(check).toBeVisible();
  await check.getByRole('button', { name: 'Save anyway' }).click();
  await expect(page.getByText('Sales 1 saved')).toBeVisible();
});

test('Day Book shows the invoice; it opens and prints (preview)', async () => {
  const daybook = await openFromGateway('Day Book', 'vouchers.daybook');
  const row = daybook.getByRole('grid', { name: 'Day Book' }).getByRole('row', { name: new RegExp(lit(FLOW.party.name)) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('1,180.00');
  await expect(row).toContainText('Sales');

  await row.click();
  await page.keyboard.press('Alt+Enter'); // View
  const view = screen('vouchers.view');
  await expect(view).toBeVisible();
  await expect(view).toContainText(FLOW.party.name);

  await page.keyboard.press('Alt+p'); // Print
  const preview = screen('print.voucher');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Print Preview', level: 1 })).toBeVisible();
  await expect(preview).toContainText(FLOW.party.name);
  await expect(preview).toContainText(FLOW.party.gstin);
  await expect(preview).toContainText('1,180.00');
});

test('Balance Sheet opens and agrees', async () => {
  const bs = await openFromGateway('Balance Sheet', 'reports.balanceSheet');
  await expect(bs.getByRole('heading', { name: 'Balance Sheet', level: 1 })).toBeVisible();
  const assets = bs.getByRole('region', { name: 'Assets' });
  await expect(assets.getByRole('row', { name: /Current Assets/ })).toBeVisible();
  await expect(bs.getByRole('region', { name: 'Liabilities' })).toBeVisible();
  await expect(bs.getByText('The Balance Sheet does not agree')).toHaveCount(0);
  await expect(bs.getByText('Opening balances do not agree')).toHaveCount(0);
});

test('GSTR-1 counts the invoice in table 4A (B2B)', async () => {
  const gstr1 = await openFromGateway('GSTR-1', 'gst.gstr1');
  // The screen opens on the period due for filing (last month); the invoice is in this month.
  await gstr1.getByLabel('Return period').selectOption(currentReturnPeriod());
  await expect(gstr1.getByRole('button', { name: /^Table 4A, B2B invoices: 1 document, taxable 1,000\.00, tax 180\.00/ })).toBeVisible();
});

test('back up the company', async () => {
  const backup = await openFromGateway('Backup', 'data.backup');
  await expect(backup.getByRole('heading', { name: 'Backup', level: 1 })).toBeVisible();
  // The default backup folder lives inside the data folder (shown once the list has loaded).
  const folderInput = backup.getByLabel('Backup folder');
  await expect(folderInput).toHaveValue(new RegExp(`^${lit(dataDir)}`));
  const folder = await folderInput.inputValue();

  await page.keyboard.press('Control+a'); // Back up now
  await expect(page.getByText(/^Backed up to /)).toBeVisible({ timeout: 30_000 });
  await expect(backup.getByRole('grid', { name: 'Backups' }).getByRole('row', { name: new RegExp(lit(FLOW.company.name)) })).toHaveCount(1);
  expect(existsSync(folder)).toBe(true);
  expect(readdirSync(folder).filter((f) => f.endsWith('.bahibak'))).toHaveLength(1);
});
