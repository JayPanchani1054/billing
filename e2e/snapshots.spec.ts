// UI snapshots for design review (docs/BUILD.md §5.1). Skipped unless PEVQORI_SNAPSHOTS=1 — the manual
// "UI snapshots" workflow (.github/workflows/ui-snapshots.yml) runs it; the regular e2e job does not.
//
//   wizard company → a small shop's year so far through the API (customers, suppliers, items with
//   opening stock, expenses, a bank; sales, purchases, receipts and payments in every month up to
//   today) → the key screens at 1366×768 (light, then a few in dark) saved as JPEGs in
//   test-results/snapshots/.
//
// PEVQORI_SNAPSHOT_PART=i/n captures every n-th screen starting at the i-th (parallel jobs).
// PEVQORI_SNAPSHOT_LOG=1 also prints each image to the log as base64 between `[snap:begin] <name>` and
// `[snap:end] <name>` lines, for reviewers who can read CI logs but not artifacts. Capturing is
// best-effort: a screen that cannot be reached is logged and skipped; the test fails only when no
// image was taken.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { financialYearOf, PARITY } from '../src/core/testing/e2e/parityFlow.ts';
import { api, firstLaunchCreateCompany, localToday, openGoto, stubNativeDialogs, toGateway, topScreen } from './flows.ts';
import { captureFailures, closeApp, launchApp, repoRoot } from './support.ts';
import type { LaunchedApp } from './support.ts';

const ENABLED = process.env.PEVQORI_SNAPSHOTS === '1';
const PRINT = process.env.PEVQORI_SNAPSHOT_LOG === '1';
const PART_SPEC = /^(\d+)\/(\d+)$/.exec(process.env.PEVQORI_SNAPSHOT_PART ?? '') ?? ['', '1', '1'];
const PARTS = Math.max(1, Number(PART_SPEC[2]));
const PART = Math.min(PARTS, Math.max(1, Number(PART_SPEC[1])));
const OUT = path.join(repoRoot, 'test-results', 'snapshots');
const VIEWPORT = { width: 1366, height: 768 } as const;
/** Base64 characters per log line. */
const LINE = 8000;

const COMPANY = { name: 'Shree Ganesh Hardware', gstin: PARITY.company.gstin, state: PARITY.company.state } as const;

let launched: LaunchedApp | undefined;
let page: Page;
const taken: string[] = [];
const skipped: string[] = [];

test.describe.configure({ mode: 'serial' });
test.skip(!ENABLED, 'UI snapshots run only in the manual UI snapshots workflow (PEVQORI_SNAPSHOTS=1)');

test.beforeAll(async () => {
  if (!ENABLED) return;
  launched = await launchApp('pevqori-e2e-snapshots-', { trace: false });
  page = launched.page;
  await stubNativeDialogs(launched.app);
  await page.setViewportSize(VIEWPORT);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

interface Row {
  id: number;
  name: string;
}

const P = (rupees: number): number => Math.round(rupees * 100);

/** Dates of `day` in every month from the start of the financial year up to today (ISO). */
function monthlyDates(today: string, day: number): string[] {
  const out: string[] = [];
  let y = Number(financialYearOf(today).from.slice(0, 4));
  let m = 4;
  for (;;) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (iso > today) break;
    out.push(iso);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** A small shop's year so far, through the real IPC and core. */
async function seed(today: string): Promise<void> {
  const call = <T>(route: string, input: unknown = {}): Promise<T> => api<T>(page, route, input);
  const groups = new Map((await call<{ rows: Row[] }>('accounts.group.list')).rows.map((g) => [g.name, g.id]));
  const gid = (name: string): number => {
    const id = groups.get(name);
    if (!id) throw new Error(`Group "${name}" is missing`);
    return id;
  };
  const types: Record<string, number> = {};
  for (const t of (await call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list')).rows) {
    if (t.isPredefined && types[t.baseType] === undefined) types[t.baseType] = t.id;
  }
  const units = (await call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list')).rows;
  const nos = units.find((u) => u.symbol === 'Nos')?.id;
  const cash = (await call<{ rows: Row[] }>('accounts.ledger.list', { search: 'Cash' })).rows.find((l) => l.name === 'Cash')?.id;
  if (!nos || !cash) throw new Error('Unit Nos or the Cash ledger is missing');

  const ledger = async (input: Record<string, unknown>): Promise<number> => (await call<Row>('accounts.ledger.save', input)).id;
  const customers = [
    await ledger({ name: 'Asha Retail', groupId: gid('Sundry Debtors'), gstin: PARITY.customer.gstin, stateCode: '27', registrationType: 'regular' }),
    await ledger({ name: 'Meera Stores', groupId: gid('Sundry Debtors'), stateCode: '27', registrationType: 'unregistered' }),
    await ledger({ name: 'Kumar Builders', groupId: gid('Sundry Debtors'), stateCode: '27', registrationType: 'unregistered' }),
    await ledger({ name: 'Sunrise Interiors', groupId: gid('Sundry Debtors'), stateCode: '27', registrationType: 'unregistered' }),
  ];
  const suppliers = [
    await ledger({ name: 'Gupta Metal Works', groupId: gid('Sundry Creditors'), stateCode: '27', registrationType: 'unregistered' }),
    await ledger({ name: 'Patel Paints', groupId: gid('Sundry Creditors'), stateCode: '27', registrationType: 'unregistered' }),
  ];
  const bank = await ledger({ name: 'HDFC Bank', groupId: gid('Bank Accounts'), openingBalance: P(250_000) });
  const rent = await ledger({ name: 'Shop Rent', groupId: gid('Indirect Expenses') });
  const power = await ledger({ name: 'Electricity', groupId: gid('Indirect Expenses') });
  const salary = await ledger({ name: 'Salaries', groupId: gid('Indirect Expenses') });

  const item = async (name: string, hsn: string, qty: number, rate: number): Promise<number> =>
    (await call<{ item: Row }>('inventory.item.save', { name, unitId: nos, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: hsn, openings: [{ qty, rate }] })).item.id;
  const items = [
    await item('Steel Bolt M8', '7318', 4000, 6),
    await item('Brass Hinge 4in', '8302', 1500, 45),
    await item('Door Handle Set', '8302', 600, 320),
    await item('Wood Primer 1L', '3208', 800, 180),
  ];

  const save = (input: Record<string, unknown>): Promise<unknown> => call('vouchers.save', { acknowledgeWarnings: true, ...input });
  const months = monthlyDates(today, 1).length;
  for (let k = 0; k < months; k++) {
    const grow = 1 + k * 0.12;
    for (const [i, day] of [3, 9, 15, 22, 27].entries()) {
      const date = monthlyDates(today, day)[k];
      if (!date) continue;
      await save({
        voucherTypeId: types.sales,
        date,
        mode: 'item_invoice',
        partyLedgerId: customers[(k + i) % customers.length],
        items: [
          { itemId: items[(i + k) % items.length], qty: Math.round((20 + i * 7) * grow), rate: [9, 70, 480, 260][(i + k) % items.length] },
          { itemId: items[(i + k + 1) % items.length], qty: Math.round((10 + k) * grow), rate: [9, 70, 480, 260][(i + k + 1) % items.length] },
        ],
      });
    }
    const pDate = monthlyDates(today, 6)[k];
    if (pDate) {
      await save({ voucherTypeId: types.purchase, date: pDate, mode: 'item_invoice', partyLedgerId: suppliers[k % 2], items: [{ itemId: items[k % 2 === 0 ? 0 : 3], qty: 300 + k * 40, rate: k % 2 === 0 ? 6 : 180 }] });
    }
    const rDate = monthlyDates(today, 18)[k];
    if (rDate) {
      for (const [i, c] of customers.entries()) {
        const amount = P(9_000 + 2_500 * i + 1_000 * k);
        await save({ voucherTypeId: types.receipt, date: rDate, mode: 'ledger', ledgers: [{ ledgerId: i % 2 ? cash : bank, amount }, { ledgerId: c, amount: -amount }] });
      }
    }
    const xDate = monthlyDates(today, 5)[k];
    if (xDate) {
      await save({ voucherTypeId: types.payment, date: xDate, mode: 'ledger', ledgers: [{ ledgerId: rent, amount: P(25_000) }, { ledgerId: bank, amount: -P(25_000) }] });
      await save({ voucherTypeId: types.payment, date: xDate, mode: 'ledger', ledgers: [{ ledgerId: power, amount: P(4_200 + 300 * (k % 3)) }, { ledgerId: cash, amount: -P(4_200 + 300 * (k % 3)) }] });
      await save({ voucherTypeId: types.payment, date: xDate, mode: 'ledger', ledgers: [{ ledgerId: salary, amount: P(38_000) }, { ledgerId: bank, amount: -P(38_000) }] });
      await save({ voucherTypeId: types.payment, date: xDate, mode: 'ledger', ledgers: [{ ledgerId: suppliers[k % 2], amount: P(1_500 + 500 * k) }, { ledgerId: bank, amount: -P(1_500 + 500 * k) }] });
    }
  }
  // Today's business: the Day Book (which opens on today) lists these; the voucher view and print shots open the first.
  await save({ voucherTypeId: types.sales, date: today, mode: 'item_invoice', partyLedgerId: customers[0], items: [{ itemId: items[2], qty: 6, rate: 480 }, { itemId: items[1], qty: 24, rate: 70 }] });
  await save({ voucherTypeId: types.sales, date: today, mode: 'item_invoice', partyLedgerId: customers[1], items: [{ itemId: items[3], qty: 10, rate: 260 }] });
  await save({ voucherTypeId: types.receipt, date: today, mode: 'ledger', ledgers: [{ ledgerId: cash, amount: P(5_000) }, { ledgerId: customers[2], amount: -P(5_000) }] });
}

/** One planned capture: how to get there (from Home) and the file name. */
interface Shot {
  name: string;
  open: () => Promise<void>;
  dark?: boolean;
}

async function viaGoto(label: string): Promise<void> {
  const input = await openGoto(page);
  await input.fill(label);
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });
}

async function settle(): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // Data loads behind skeletons / busy regions; give them a moment, never fail on it.
  await page
    .locator('.bx-screen-skeleton, .bx-skeleton, [aria-busy="true"]')
    .first()
    .waitFor({ state: 'detached', timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForTimeout(400);
}

async function openFirstDayBookVoucher(): Promise<void> {
  await viaGoto('Day Book');
  await settle();
  const grid = topScreen(page).getByRole('grid').first();
  await grid.getByRole('row').nth(1).click();
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('[data-screen="vouchers.view"]')).toBeVisible({ timeout: 8_000 });
}

const SHOTS: Shot[] = [
  { name: '01-home', open: async () => undefined },
  { name: '02-home-all-menus', open: async () => void (await page.keyboard.press('Control+2')) },
  { name: '03-create-menu', open: async () => void (await page.getByRole('button', { name: 'Create', exact: true }).click()) },
  { name: '04-goto-palette', open: async () => void (await (await openGoto(page)).fill('led')) },
  { name: '05-sales-entry', open: async () => void (await page.keyboard.press('F8')) },
  { name: '06-day-book', open: () => viaGoto('Day Book') },
  { name: '07-voucher-view', open: openFirstDayBookVoucher },
  {
    name: '08-print-preview',
    open: async () => {
      await openFirstDayBookVoucher();
      await page.keyboard.press('Alt+P');
    },
  },
  {
    name: '09-print-editor',
    open: async () => {
      await openFirstDayBookVoucher();
      await page.keyboard.press('Alt+P');
      await settle();
      await page.keyboard.press('Alt+L');
    },
  },
  { name: '10-ledgers', open: () => viaGoto('Ledgers') },
  { name: '11-ledger-create', open: () => viaGoto('Create Ledger') },
  { name: '12-stock-items', open: () => viaGoto('Stock Items') },
  { name: '13-receivables', open: () => viaGoto('Receivables') },
  { name: '14-profit-loss', open: () => viaGoto('Profit & Loss A/c') },
  { name: '15-balance-sheet', open: () => viaGoto('Balance Sheet') },
  { name: '16-trial-balance', open: () => viaGoto('Trial Balance') },
  { name: '17-stock-summary', open: () => viaGoto('Stock Summary') },
  { name: '18-cash-bank', open: () => viaGoto('Cash/Bank Books') },
  { name: '19-gstr1', open: () => viaGoto('GSTR-1') },
  { name: '20-gstr3b', open: () => viaGoto('GSTR-3B') },
  { name: '21-sales-register', open: () => viaGoto('Sales Register') },
  { name: '22-settings', open: () => viaGoto('Settings') },
  { name: '23-invoice-numbering', open: () => viaGoto('Invoice Numbering') },
  { name: '24-payables', open: () => viaGoto('Payables') },
  { name: '25-dark-home', open: async () => undefined, dark: true },
  { name: '26-dark-profit-loss', open: () => viaGoto('Profit & Loss A/c'), dark: true },
  { name: '27-dark-sales-entry', open: async () => void (await page.keyboard.press('F8')), dark: true },
];

function emit(name: string, jpeg: Buffer): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), jpeg);
  if (!PRINT) return;
  const b64 = jpeg.toString('base64');
  console.log(`[snap:begin] ${name} ${b64.length}`);
  for (let i = 0; i < b64.length; i += LINE) console.log(`[snap] ${b64.slice(i, i + LINE)}`);
  console.log(`[snap:end] ${name}`);
}

test('seed a small shop and capture the key screens', async () => {
  test.setTimeout(15 * 60_000);
  const today = localToday();
  await firstLaunchCreateCompany(page, launched?.dataDir ?? '', COMPANY);
  await seed(today);
  await toGateway(page);

  for (const [index, shot] of SHOTS.entries()) {
    if (index % PARTS !== PART - 1) continue;
    try {
      await page.emulateMedia({ colorScheme: shot.dark ? 'dark' : 'light' });
      await toGateway(page);
      await page.keyboard.press('Control+1').catch(() => undefined);
      await shot.open();
      await settle();
      const title = (await topScreen(page).locator('h1').first().textContent({ timeout: 2_000 }).catch(() => null)) ?? '';
      console.log(`[snap:info] ${shot.name} — top screen h1: ${title.trim() || '(none)'}`);
      emit(shot.name, await page.screenshot({ type: 'jpeg', quality: 72 }));
      taken.push(shot.name);
    } catch (e) {
      skipped.push(`${shot.name}: ${String(e).split('\n')[0]}`);
      console.log(`[snap:skip] ${shot.name}: ${String(e).split('\n')[0]}`);
    } finally {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  console.log(`[snap:summary] taken ${taken.length}: ${taken.join(', ')}; skipped ${skipped.length}`);
  expect(taken.length, `no snapshot taken; skipped: ${skipped.join(' | ')}`).toBeGreaterThan(0);
});
