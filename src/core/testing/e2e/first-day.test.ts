/**
 * API-level twin of the Playwright flow in e2e/first-day.spec.ts: the same first day of a new user,
 * driven through runtime.dispatch exactly as the Electron main process does.
 *
 *   first launch (data folder) → create company → party ledger + stock item → item sales invoice
 *   → Day Book → Balance Sheet → GSTR-1 → print data → backup
 *
 * The Playwright spec cannot run in the dev container (no Electron), so this test pins every master,
 * route and figure that spec relies on: if it fails here, the UI flow would fail too.
 *
 * Figures: 10 Nos × ₹100.00 = ₹1,000.00 taxable; intra-state (27 → 27) CGST 9% = ₹90.00,
 * SGST 9% = ₹90.00 → invoice total ₹1,180.00. No opening stock, so the sale takes the item negative
 * (the default "warn" guard asks for confirmation — the UI shows "Save anyway").
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan, TEST_PAN } from '../fixtures.ts';
import { P, startRuntime } from './harness.ts';
import type { E2E } from './harness.ts';

/** Values typed by e2e/first-day.spec.ts — keep the two files in step. */
const FLOW = {
  today: '2026-10-09',
  company: { name: 'Sharma Traders E2E', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' },
  party: { name: 'Kavya Traders', gstin: '27AAAPA0002A1Z5' },
  item: { name: 'Steel Bolt M8', unit: 'Nos', hsn: '7318', rate: 18 },
  sale: { qty: 10, price: 100 },
} as const;

interface Row {
  id: number;
  name: string;
  [k: string]: unknown;
}

describe('first day in Bahi ERP (API twin of the Playwright flow)', () => {
  let e: E2E;
  let partyId = 0;
  let itemId = 0;
  let voucherId = 0;

  before(() => {
    e = startRuntime(FLOW.today);
  });
  after(async () => {
    await e.close();
  });

  it('uses fictional, checksum-valid GSTINs', () => {
    assert.equal(makeGstin('27'), FLOW.company.gstin);
    assert.equal(FLOW.company.gstin.slice(2, 12), TEST_PAN);
    assert.equal(makeGstin('27', testPan(2)), FLOW.party.gstin);
  });

  it('first launch: "Use this folder" accepts the BAHI_DATA_DIR folder without a dialog', async () => {
    const s = await e.call<{ firstRun: boolean; dataDir: string; companies: unknown[] }>('app.state');
    assert.equal(s.firstRun, true);
    assert.equal(s.companies.length, 0);
    const next = await e.call<{ firstRun: boolean; dataDir: string }>('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    assert.equal(next.firstRun, false);
    assert.equal(next.dataDir, s.dataDir);
  });

  it('creates and opens an unprotected GST company (wizard defaults, password switched off)', async () => {
    const s = await e.call<{ company: { name: string; gstEnabled: boolean; features: { inventory: boolean } } | null; session: unknown }>('app.company.create', {
      name: FLOW.company.name,
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: FLOW.company.gstin,
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
    });
    assert.equal(s.company?.name, FLOW.company.name);
    assert.equal(s.company?.gstEnabled, true);
    assert.equal(s.company?.features.inventory, true);
    assert.ok(s.session, 'an unprotected company opens straight into the workspace');
  });

  it('creates the party under Sundry Debtors; the GSTIN fills state and registration', async () => {
    const groups = await e.call<{ rows: Row[] }>('accounts.group.list', {});
    const debtors = groups.rows.find((g) => g.name === 'Sundry Debtors');
    assert.ok(debtors, 'Sundry Debtors is a predefined group');
    const out = await e.call<Row & { stateCode: string; registrationType: string; billWise: boolean }>('accounts.ledger.save', {
      name: FLOW.party.name,
      groupId: debtors.id,
      gstin: FLOW.party.gstin,
      stateCode: '27',
      registrationType: 'regular',
    });
    partyId = out.id;
    assert.equal(out.stateCode, '27');
    assert.equal(out.registrationType, 'regular');
    assert.equal(out.billWise, true, 'bill-wise is on for customers when the feature is on');
  });

  it('creates the stock item in Nos with its own 18% GST and HSN', async () => {
    const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
    const nos = units.rows.find((u) => u.symbol === FLOW.item.unit);
    assert.ok(nos, 'Nos is a seeded unit');
    const out = await e.call<{ item: Row }>('inventory.item.save', {
      name: FLOW.item.name,
      unitId: nos.id,
      gstApplicable: true,
      taxability: 'taxable',
      gstRate: FLOW.item.rate,
      hsnSac: FLOW.item.hsn,
    });
    itemId = out.item.id;
    assert.ok(itemId > 0);
  });

  it('saves the sales invoice after the negative-stock confirmation', async () => {
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    const sales = types.rows.find((t) => t.baseType === 'sales' && t.isPredefined);
    assert.ok(sales);
    const input = {
      voucherTypeId: sales.id,
      date: FLOW.today,
      mode: 'item_invoice',
      partyLedgerId: partyId,
      items: [{ itemId, qty: FLOW.sale.qty, rate: FLOW.sale.price }],
    };
    // Without acknowledgement the negative-stock guard asks first (UI: "Please check before saving").
    const first = await e.raw('vouchers.save', input);
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.equal(first.error.code, 'BUSINESS_RULE');
      assert.equal((first.error.details as { needsConfirmation?: boolean }).needsConfirmation, true, first.error.message);
    }
    const saved = await e.call<{ id: number; number: string; totals: { grandTotal: number } }>('vouchers.save', { ...input, acknowledgeWarnings: true });
    voucherId = saved.id;
    assert.equal(saved.number, '1');
    assert.equal(saved.totals.grandTotal, P(1180)); // 1,000 + 90 + 90
  });

  it('Day Book (working date) lists the invoice with the party and ₹1,180.00', async () => {
    const list = await e.call<{ rows: Array<{ id: number; partyName: string | null; amount: number }>; total: number }>('vouchers.list', { from: FLOW.today, to: FLOW.today });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].id, voucherId);
    assert.equal(list.rows[0].partyName, FLOW.party.name);
    assert.equal(list.rows[0].amount, P(1180));
  });

  it('Balance Sheet agrees and carries the debtor and the output tax', async () => {
    const bs = await e.call<{ balanced: boolean; openingDifference: number; assetsTotal: number; liabilitiesTotal: number; closingStock: number; assets: Array<{ name: string; amount: number }> }>(
      'reports.balanceSheet',
      { asOf: FLOW.today, mode: 'condensed' },
    );
    assert.equal(bs.balanced, true);
    assert.equal(bs.openingDifference, 0, 'no "Opening balances do not agree" banner');
    assert.equal(bs.assetsTotal, bs.liabilitiesTotal);
    assert.ok(bs.assets.some((l) => l.name === 'Current Assets'), JSON.stringify(bs.assets.map((l) => l.name)));
  });

  it('GSTR-1 opens on the period due for filing (last month), so the spec picks the current month', async () => {
    const p = await e.call<{ suggested: string | null; current: string | null; periods: Array<{ key: string; label: string }> }>('gst.periods', {});
    assert.equal(p.suggested, '092026');
    assert.equal(p.current, '102026');
    assert.equal(p.periods.find((x) => x.key === '102026')?.label, 'Oct 2026');
  });

  it('GSTR-1 for the month counts the invoice in table 4A (B2B)', async () => {
    const summary = await e.call<{ period: { key: string }; sections: Array<{ id: string; table: string; count: number; countLabel: string; taxable: number }> }>('gst.gstr1.summary', {
      period: '102026',
    });
    assert.equal(summary.period.key, '102026');
    const b2b = summary.sections.find((s) => s.id === 'b2b');
    assert.ok(b2b, JSON.stringify(summary.sections.map((s) => s.id)));
    // The tile's accessible name is "Table 4A, B2B invoices: 1 document, taxable 1,000.00, …".
    assert.equal(b2b.table, '4A');
    assert.equal(b2b.count, 1);
    assert.equal(b2b.countLabel, 'documents');
    assert.equal(b2b.taxable, P(1000));
  });

  it('print data for the invoice names the party', async () => {
    const doc = await e.call<{ title: string; party: { name: string } | null }>('print.voucherData', { id: voucherId });
    assert.equal(doc.party?.name, FLOW.party.name);
    assert.ok(doc.title.length > 0);
  });

  it('"Back up now" with no folder and no password writes a backup into the data folder', async () => {
    const r = await e.call<{ path: string; fileName: string; encrypted: boolean }>('data.backup.create', {});
    assert.equal(r.encrypted, false);
    assert.ok(fs.existsSync(r.path), r.path);
    const s = await e.call<{ dataDir: string }>('app.state');
    assert.ok(r.path.startsWith(s.dataDir), `${r.path} is inside ${s.dataDir}`);
    const list = await e.call<{ backups: Array<{ path: string }> }>('data.backup.list', {});
    assert.ok(list.backups.some((b) => b.path === r.path));
  });
});
