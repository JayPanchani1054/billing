/**
 * Regression tests for the accounts review: each block pins a defect that was found and fixed
 * (GST defaults and rate history, shared name space, opening stock, period lock, sub-tree audits …).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FieldIssue } from '../../../shared/api.ts';
import type { ChartNode, CurrencyRow, ListResult, ExchangeRateRow } from '../../../shared/types/accounts.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, makeGstin } from '../../testing/fixtures.ts';
import { setPeriodLock } from '../company/service.ts';
import { chartOfAccounts } from './chart.ts';
import { getCostCentre, saveCostCategory, saveCostCentre } from './costCentres.ts';
import { listCurrencies, listExchangeRates, saveCurrency, saveExchangeRate } from './currencies.ts';
import { getGroup, saveGroup } from './groups.ts';
import { bulkCreateLedgers, deleteLedger, getLedger, ledgerGstRateOn, saveLedger } from './ledgers.ts';
import { accountsRoutes } from './routes.ts';
import { postRaw } from './testkit.ts';
import { getVoucherType, saveVoucherType } from './voucherTypes.ts';

function expectIssue(fn: () => unknown, path: string, re: RegExp): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError && e.code === 'VALIDATION', `expected VALIDATION, got ${String(e)}`);
    const hit = (e.details as FieldIssue[]).find((i) => i.path === path);
    assert.ok(hit, `no issue at ${path}: ${JSON.stringify(e.details)}`);
    assert.match(hit.message, re);
    return;
  }
  assert.fail(`expected a validation error at ${path}`);
}

const isErr = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));
const history = (t: ReturnType<typeof createTestCompany>, id: number): Array<[string, number, string | null, string]> =>
  getLedger(t.db, id, t.today).gstRateHistory.map((h) => [h.applicableFrom, h.rate, h.hsnSac, h.taxability]);

describe('new sales/purchase ledgers take the Tally defaults', () => {
  it('GST applicable (taxable, rate from items) and inventory affected, like the predefined Sales ledger', () => {
    const t = createTestCompany();
    const s = saveLedger(t.ctx, { name: 'Sales - Retail', groupId: t.ids.groups.SALES_ACCOUNTS });
    assert.deepEqual([s.gstApplicable, s.gstTaxability, s.gstRate, s.inventoryValuesAffected], [true, 'taxable', null, true]);
    assert.equal(s.gstRateHistory.length, 0, 'no rate defined → no history row (rate comes from items)');
    const p = saveLedger(t.ctx, { name: 'Purchase - Imports', groupId: t.ids.groups.PURCHASE_ACCOUNTS });
    assert.deepEqual([p.gstApplicable, p.inventoryValuesAffected], [true, true]);
    // Explicit choices win; other groups keep the plain defaults.
    const nonGst = saveLedger(t.ctx, { name: 'Scrap Sales', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: false, inventoryValuesAffected: false });
    assert.deepEqual([nonGst.gstApplicable, nonGst.inventoryValuesAffected], [false, false]);
    const rent = saveLedger(t.ctx, { name: 'Rent', groupId: t.ids.groups.INDIRECT_EXPENSES });
    assert.deepEqual([rent.gstApplicable, rent.inventoryValuesAffected], [false, false]);
    // Bulk creation goes through the same defaults.
    const bulk = bulkCreateLedgers(t.ctx, { rows: [{ name: 'Sales - Online', groupId: t.ids.groups.SALES_ACCOUNTS }] });
    assert.equal(getLedger(t.db, bulk.ids[0], t.today).gstApplicable, true);
    t.close();
  });

  it('a company without GST or without inventory does not get those defaults', () => {
    const u = createTestCompany({ gst: false, features: { inventory: false } });
    const s = saveLedger(u.ctx, { name: 'Sales - Retail', groupId: u.ids.groups.SALES_ACCOUNTS });
    assert.deepEqual([s.gstApplicable, s.inventoryValuesAffected], [false, false]);
    u.close();
  });
});

describe('GST rate history stays consistent with the master', () => {
  it('a back-dated change of one detail keeps the other details in force on that date', () => {
    const t = createTestCompany({ today: '2026-10-05' });
    const l = saveLedger(t.ctx, { name: 'Sales - Furniture', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 12, hsnSac: '9403' });
    saveLedger(t.ctx, { id: l.id, gstRate: 18, applicableFrom: '2026-09-22' });
    // HSN corrected from 1-Jun: the June row must still carry the 12% in force then (not today's 18%).
    const after = saveLedger(t.ctx, { id: l.id, hsnSac: '94036000', applicableFrom: '2026-06-01' });
    assert.deepEqual(history(t, l.id), [
      ['2026-04-01', 12, '9403', 'taxable'],
      ['2026-06-01', 12, '94036000', 'taxable'],
      ['2026-09-22', 18, '9403', 'taxable'],
    ]);
    assert.equal(ledgerGstRateOn(t.db, l.id, '2026-07-01')?.rate, 12);
    assert.deepEqual([after.gstRate, after.hsnSac], [18, '9403'], 'the master keeps showing the latest row');
    t.close();
  });

  it('a back-dated rate equal to the current master rate is still recorded', () => {
    const t = createTestCompany({ today: '2026-10-05' });
    const l = saveLedger(t.ctx, { name: 'Sales - Toys', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 12 });
    saveLedger(t.ctx, { id: l.id, gstRate: 18, applicableFrom: '2026-09-22' });
    // The increase really applied from 1-Jul: 18% (already the master's rate) from that date.
    saveLedger(t.ctx, { id: l.id, gstRate: 18, applicableFrom: '2026-07-01' });
    assert.deepEqual(
      history(t, l.id).map(([d, r]) => [d, r]),
      [
        ['2026-04-01', 12],
        ['2026-07-01', 18],
        ['2026-09-22', 18],
      ],
    );
    // Re-sending the details already in force on a date writes nothing.
    saveLedger(t.ctx, { id: l.id, gstRate: 12, applicableFrom: '2026-05-01' });
    assert.equal(history(t, l.id).length, 3);
    t.close();
  });

  it('exempt → taxable from a date takes the ledger rate, not the 0% of the exempt row', () => {
    const t = createTestCompany({ today: '2026-10-05' });
    const l = saveLedger(t.ctx, { name: 'Sales - Books', groupId: t.ids.groups.SALES_ACCOUNTS, gstTaxability: 'exempt' });
    saveLedger(t.ctx, { id: l.id, gstTaxability: 'taxable', gstRate: 5, applicableFrom: '2026-09-22' });
    saveLedger(t.ctx, { id: l.id, gstTaxability: 'taxable', applicableFrom: '2026-08-01' });
    assert.deepEqual(history(t, l.id), [
      ['2026-04-01', 0, null, 'exempt'],
      ['2026-08-01', 5, null, 'taxable'],
      ['2026-09-22', 5, null, 'taxable'],
    ]);
    t.close();
  });

  it('turning GST off, clearing the rate or moving out of a GST group removes the history (the posting engine reads it first)', () => {
    const t = createTestCompany({ today: '2026-10-05' });
    const count = (id: number): number =>
      t.db.value<number>(`SELECT COUNT(*) FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id }) ?? 0;
    const a = saveLedger(t.ctx, { name: 'Sales - A', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 12 });
    expectIssue(() => saveLedger(t.ctx, { id: a.id, gstApplicable: false, applicableFrom: '2026-07-01' }), 'applicableFrom', /set the taxability/);
    assert.equal(count(a.id), 1, 'refused change leaves the history');
    saveLedger(t.ctx, { id: a.id, gstApplicable: false });
    assert.equal(count(a.id), 0);
    assert.equal(ledgerGstRateOn(t.db, a.id, '2026-07-01'), null);
    const b = saveLedger(t.ctx, { name: 'Sales - B', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 5 });
    const cleared = saveLedger(t.ctx, { id: b.id, gstRate: null });
    assert.deepEqual([cleared.gstApplicable, cleared.gstRate, cleared.gstRateHistory.length], [true, null, 0]);
    const c = saveLedger(t.ctx, { name: 'Sales - C', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 18 });
    saveLedger(t.ctx, { id: c.id, groupId: t.ids.groups.SUNDRY_DEBTORS });
    assert.equal(count(c.id), 0);
    t.close();
  });
});

describe('ledgers and groups share one name space', () => {
  it('refuses a ledger named like a group and a group named like a ledger (names and aliases)', () => {
    const t = createTestCompany();
    expectIssue(() => saveLedger(t.ctx, { name: 'sundry debtors', groupId: t.ids.groups.SUNDRY_DEBTORS }), 'name', /name of the group 'Sundry Debtors'/);
    expectIssue(() => saveLedger(t.ctx, { name: 'Acme', alias: 'Bank Accounts', groupId: t.ids.groups.SUNDRY_DEBTORS }), 'alias', /group 'Bank Accounts'/);
    expectIssue(() => saveGroup(t.ctx, { name: 'Cash', parentId: t.ids.groups.CURRENT_ASSETS }), 'name', /name of the ledger 'Cash'/);
    saveLedger(t.ctx, { name: 'Acme Traders', alias: 'ACME', groupId: t.ids.groups.SUNDRY_DEBTORS });
    expectIssue(() => saveGroup(t.ctx, { name: 'Key Accounts', alias: 'acme', parentId: t.ids.groups.SUNDRY_DEBTORS }), 'alias', /alias of the ledger 'Acme Traders'/);
    t.close();
  });

  it('an old clash does not block unrelated edits of the ledger', () => {
    const t = createTestCompany();
    t.db.run(`INSERT INTO groups (guid, name, parent_id, nature, created_at, updated_at) VALUES ('g-old', 'Old Debtors', :p, 'assets', 'x', 'x')`, {
      p: t.ids.groups.SUNDRY_DEBTORS,
    });
    const id = t.addLedger({ name: 'Old Debtors', group: 'SUNDRY_DEBTORS' });
    assert.equal(saveLedger(t.ctx, { id, notes: 'legacy name' }).notes, 'legacy name');
    t.close();
  });
});

describe('ledger party rules', () => {
  it('deemed-export parties need a GSTIN; overseas parties may have a foreign postal code', () => {
    const t = createTestCompany();
    const g = t.ids.groups.SUNDRY_DEBTORS;
    expectIssue(() => saveLedger(t.ctx, { name: 'EOU Buyer', groupId: g, registrationType: 'deemed_export' }), 'gstin', /GSTIN is required for a Deemed Export party/);
    assert.equal(saveLedger(t.ctx, { name: 'EOU Buyer', groupId: g, registrationType: 'deemed_export', gstin: makeGstin('24') }).stateCode, '24');
    const foreign = saveLedger(t.ctx, { name: 'Globex Inc', groupId: g, registrationType: 'overseas', pincode: '90210' });
    assert.deepEqual([foreign.stateCode, foreign.pincode], ['96', '90210']);
    expectIssue(() => saveLedger(t.ctx, { name: 'Local Buyer', groupId: g, pincode: '90210' }), 'pincode', /6 digits/);
    t.close();
  });

  it('removing the GSTIN of a regular party makes it unregistered again (SEZ still needs one)', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, { name: 'Acme', groupId: t.ids.groups.SUNDRY_DEBTORS, gstin: makeGstin('29') });
    assert.equal(l.registrationType, 'regular');
    const a = saveLedger(t.ctx, { id: l.id, gstin: null });
    assert.deepEqual([a.registrationType, a.gstin, a.stateCode], ['unregistered', null, '29']);
    const sez = saveLedger(t.ctx, { name: 'SEZ Unit', groupId: t.ids.groups.SUNDRY_DEBTORS, registrationType: 'sez', gstin: makeGstin('24') });
    expectIssue(() => saveLedger(t.ctx, { id: sez.id, gstin: null }), 'gstin', /GSTIN is required for a SEZ party/);
    t.close();
  });
});

describe('opening balances', () => {
  it('no opening balance on Stock-in-Hand ledgers while inventory is integrated (opening stock comes from items)', () => {
    const t = createTestCompany();
    expectIssue(
      () => saveLedger(t.ctx, { name: 'Stock of Goods', groupId: t.ids.groups.STOCK_IN_HAND, openingBalance: 500000 }),
      'openingBalance',
      /opening values.*stock items/,
    );
    assert.equal(saveLedger(t.ctx, { name: 'Stock of Goods', groupId: t.ids.groups.STOCK_IN_HAND }).openingBalance, 0);
    t.close();
    const accountsOnly = createTestCompany({ features: { integrateInventory: false } });
    assert.equal(saveLedger(accountsOnly.ctx, { name: 'Stock of Goods', groupId: accountsOnly.ids.groups.STOCK_IN_HAND, openingBalance: 500000 }).openingBalance, 500000);
    accountsOnly.close();
  });

  it('a period lock covering the books beginning freezes opening balances and opening bills', () => {
    const t = createTestCompany({ today: '2026-06-30' });
    const l = saveLedger(t.ctx, {
      name: 'Acme',
      groupId: t.ids.groups.SUNDRY_DEBTORS,
      openingBalance: 100000,
      openingBills: [{ billName: 'OB-1', billDate: '2026-03-01', amount: 100000 }],
    });
    setPeriodLock(t.ctx, '2026-05-31');
    assert.throws(
      () => saveLedger(t.ctx, { id: l.id, openingBalance: 120000, openingBills: [{ billName: 'OB-1', billDate: '2026-03-01', amount: 120000 }] }),
      isErr('LOCKED', /opening balances \(as at 01-Apr-2026\)/),
    );
    assert.throws(
      () => saveLedger(t.ctx, { id: l.id, openingBills: [{ billName: 'OB-2', billDate: '2026-03-01', amount: 100000 }] }),
      isErr('LOCKED'),
    );
    assert.throws(() => saveLedger(t.ctx, { name: 'New Party', groupId: t.ids.groups.SUNDRY_DEBTORS, openingBalance: 500 }), isErr('LOCKED'));
    // Other changes, the same bills re-sent and new ledgers without an opening balance are fine.
    assert.equal(saveLedger(t.ctx, { id: l.id, mobile: '9876543210', openingBalance: 100000 }).mobile, '9876543210');
    saveLedger(t.ctx, { id: l.id, openingBills: [{ billName: 'OB-1', billDate: '2026-03-01', amount: 100000 }] });
    assert.ok(saveLedger(t.ctx, { name: 'New Party', groupId: t.ids.groups.SUNDRY_DEBTORS }).id);
    t.close();
  });
});

describe('ledger delete finds references from other modules', () => {
  it('names a table added by another module that still refers to the ledger', () => {
    const t = createTestCompany();
    t.db.exec('CREATE TABLE tds_deductions (id INTEGER PRIMARY KEY, party_ledger_id INTEGER REFERENCES ledgers(id))');
    const l = saveLedger(t.ctx, { name: 'Contractor', groupId: t.ids.groups.SUNDRY_CREDITORS });
    t.db.run('INSERT INTO tds_deductions (party_ledger_id) VALUES (:id), (:id)', { id: l.id });
    assert.throws(() => deleteLedger(t.ctx, l.id), isErr('BUSINESS_RULE', /2 records in tds deductions still refer to it\. Mark it inactive instead/));
    t.db.run('DELETE FROM tds_deductions');
    assert.deepEqual(deleteLedger(t.ctx, l.id), { id: l.id, deleted: true });
    t.close();
  });
});

describe('structural changes are audited row by row', () => {
  const audits = (t: ReturnType<typeof createTestCompany>, type: string, id: number) =>
    t.db.all<{ action: string; before_json: string; after_json: string; entity_label: string }>(
      'SELECT action, before_json, after_json, entity_label FROM audit_log WHERE entity_type = :type AND entity_id = :id ORDER BY id',
      { type, id },
    );

  it('moving a group audits every sub-group whose nature changes', () => {
    const t = createTestCompany();
    const a = saveGroup(t.ctx, { name: 'Projects', nature: 'assets' });
    const b = saveGroup(t.ctx, { name: 'Project Costs', parentId: a.id });
    saveGroup(t.ctx, { id: a.id, parentId: t.ids.groups.DIRECT_EXPENSES });
    const rows = audits(t, 'group', b.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].action, 'alter');
    assert.match(rows[1].entity_label, /follows 'Projects'/);
    assert.deepEqual([JSON.parse(rows[1].before_json).nature, JSON.parse(rows[1].after_json).nature], ['assets', 'expenses']);
    assert.equal(getGroup(t.db, b.id).nature, 'expenses');
    t.close();
  });

  it('a voucher type changing base type audits the types based on it', () => {
    const t = createTestCompany();
    const a = saveVoucherType(t.ctx, { name: 'Counter Sales', baseType: 'sales' });
    const b = saveVoucherType(t.ctx, { name: 'Counter Sales - Card', parentId: a.id });
    saveVoucherType(t.ctx, { id: a.id, parentId: t.ids.voucherTypes.purchase });
    const rows = audits(t, 'voucher_type', b.id);
    assert.equal(rows.length, 2);
    assert.deepEqual([JSON.parse(rows[1].before_json).baseType, JSON.parse(rows[1].after_json).baseType], ['sales', 'purchase']);
    assert.equal(getVoucherType(t.db, b.id).baseType, 'purchase');
    t.close();
  });

  it('cost centres: a new centre takes its parent\'s category; moving a centre audits its sub-centres', () => {
    const t = createTestCompany();
    const projects = saveCostCategory(t.ctx, { name: 'Projects' });
    const north = saveCostCentre(t.ctx, { name: 'North', categoryId: t.ids.costCategoryId });
    const delhi = saveCostCentre(t.ctx, { name: 'Delhi', parentId: north.id });
    assert.equal(delhi.categoryId, t.ids.costCategoryId, 'category inherited from the parent');
    saveCostCentre(t.ctx, { id: north.id, categoryId: projects.id });
    assert.equal(getCostCentre(t.db, delhi.id).categoryId, projects.id);
    const rows = audits(t, 'cost_centre', delhi.id);
    assert.equal(rows.length, 2);
    assert.deepEqual([JSON.parse(rows[1].before_json).categoryId, JSON.parse(rows[1].after_json).categoryId], [t.ids.costCategoryId, projects.id]);
    t.close();
  });
});

describe('currencies and exchange rates', () => {
  it('lists currencies with their latest rate, gets one by id and pages exchange rates', async () => {
    const t = createTestCompany();
    const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD' });
    for (const [date, rate] of [['2026-04-01', 83.1], ['2026-04-02', 83.2], ['2026-04-03', 83.3]] as const) {
      saveExchangeRate(t.ctx, { currencyId: usd.id, date, standard: rate });
    }
    const list = listCurrencies(t.db);
    assert.deepEqual(list.rows.map((c) => [c.isoCode, c.latestRate?.date ?? null, c.latestRate?.standard ?? null]), [
      ['INR', null, null],
      ['USD', '2026-04-03', 83.3],
    ]);
    const got = await t.callOk<CurrencyRow>(accountsRoutes, 'accounts.currency.get', { id: usd.id });
    assert.equal(got.latestRate?.standard, 83.3);
    const page = listExchangeRates(t.db, { currencyId: usd.id, limit: 2, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.rows.map((r) => r.date), ['2026-04-02', '2026-04-01']);
    const viaRoute = await t.callOk<ListResult<ExchangeRateRow>>(accountsRoutes, 'accounts.exchangeRate.list', { currencyId: usd.id, limit: 1 });
    assert.deepEqual([viaRoute.total, viaRoute.rows[0].date], [3, '2026-04-03']);
    t.close();
  });

  it('Data Entry may add a new day\'s rate but not alter an existing one, nor alter or delete masters', async () => {
    const t = createTestCompany();
    const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD' });
    saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-01', standard: 83 });
    const session = t.sessionAs({ role: 'Data Entry' });
    const code = async (route: string, input: unknown): Promise<string | null> => {
      const r = await t.call(accountsRoutes, route, input, { session });
      return r.ok ? null : r.error.code;
    };
    assert.equal(await code('accounts.exchangeRate.save', { currencyId: usd.id, date: '2026-04-02', standard: 84 }), null);
    assert.equal(await code('accounts.exchangeRate.save', { currencyId: usd.id, date: '2026-04-01', standard: 85 }), 'FORBIDDEN');
    assert.equal(await code('accounts.currency.save', { id: usd.id, formalName: 'Dollar' }), 'FORBIDDEN');
    assert.equal(await code('accounts.currency.delete', { id: usd.id }), 'FORBIDDEN');
    const cc = saveCostCentre(t.ctx, { name: 'Factory', categoryId: t.ids.costCategoryId });
    assert.equal(await code('accounts.costCentre.save', { id: cc.id, name: 'Plant' }), 'FORBIDDEN');
    assert.equal(await code('accounts.costCentre.delete', { id: cc.id }), 'FORBIDDEN');
    assert.equal(await code('accounts.costCategory.save', { id: t.ids.costCategoryId, name: 'Main' }), 'FORBIDDEN');
    assert.equal(await code('accounts.group.delete', { id: t.ids.groups.SUNDRY_DEBTORS }), 'FORBIDDEN');
    t.close();
  });
});

describe('chart of accounts with activeOnly', () => {
  it('keeps an inactive ledger that still carries a balance, so group totals add up', () => {
    const t = createTestCompany();
    const old = saveLedger(t.ctx, { name: 'Old Party', groupId: t.ids.groups.SUNDRY_DEBTORS });
    const gone = saveLedger(t.ctx, { name: 'Closed Party', groupId: t.ids.groups.SUNDRY_DEBTORS });
    postRaw(t, { date: '2026-04-02', lines: [[old.id, 5000], [t.ids.ledgers.SALES, -5000]] });
    saveLedger(t.ctx, { id: old.id, isActive: false });
    saveLedger(t.ctx, { id: gone.id, isActive: false });
    const chart = chartOfAccounts(t.db, { activeOnly: true }, t.today);
    const find = (nodes: ChartNode[], name: string): ChartNode | undefined => {
      for (const n of nodes) {
        if (n.name === name) return n;
        const hit = find(n.children, name);
        if (hit) return hit;
      }
      return undefined;
    };
    const debtors = find(chart.roots, 'Sundry Debtors');
    assert.ok(debtors);
    assert.deepEqual(debtors.children.map((c) => [c.name, c.isActive, c.closing]), [['Old Party', false, 5000]]);
    assert.equal(debtors.closing, debtors.children.reduce((s, c) => s + c.closing, 0));
    t.close();
  });
});
