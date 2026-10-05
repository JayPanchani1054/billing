import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import {
  deleteCostCategory,
  deleteCostCentre,
  getCostCentre,
  listCostCategories,
  listCostCentres,
  saveCostCategory,
  saveCostCentre,
} from './costCentres.ts';
import {
  deleteCurrency,
  deleteExchangeRate,
  exchangeRateOn,
  listCurrencies,
  listExchangeRates,
  saveCurrency,
  saveExchangeRate,
} from './currencies.ts';
import { saveLedger } from './ledgers.ts';
import { lastAudit, postRaw } from './testkit.ts';

const isErr = (code: string, re?: RegExp) => (e: unknown) =>
  e instanceof AppError && e.code === code && (!re || re.test(e.message + ' ' + JSON.stringify(e.details ?? '')));

describe('cost categories', () => {
  it('creates, renames and deletes categories; the predefined one and categories with centres stay', () => {
    const t = createTestCompany();
    const cat = saveCostCategory(t.ctx, { name: 'Projects', allocateNonRevenue: true });
    assert.equal(cat.allocateRevenue, true);
    assert.equal(cat.allocateNonRevenue, true);
    assert.throws(() => saveCostCategory(t.ctx, { name: 'projects' }), isErr('VALIDATION', /already exists/));
    const renamed = saveCostCategory(t.ctx, { id: cat.id, name: 'Client Projects' });
    assert.equal(renamed.allocateNonRevenue, true, 'omitted flags are kept');
    assert.deepEqual(
      listCostCategories(t.db).rows.map((c) => c.name),
      ['Primary Cost Category', 'Client Projects'],
    );
    assert.throws(() => deleteCostCategory(t.ctx, t.ids.costCategoryId), isErr('BUSINESS_RULE', /predefined cost category/));
    saveCostCentre(t.ctx, { name: 'Project Alpha', categoryId: cat.id });
    assert.throws(() => deleteCostCategory(t.ctx, cat.id), isErr('BUSINESS_RULE', /has 1 cost centre/));
    const empty = saveCostCategory(t.ctx, { name: 'Unused' });
    assert.deepEqual(deleteCostCategory(t.ctx, empty.id), { id: empty.id, deleted: true });
    assert.equal(lastAudit(t, 'cost_category')?.action, 'delete');
    t.close();
  });
});

describe('cost centres', () => {
  it('builds a tree per category; parents must be in the same category; no cycles', () => {
    const t = createTestCompany();
    const primary = t.ids.costCategoryId;
    const other = saveCostCategory(t.ctx, { name: 'Projects' }).id;
    const north = saveCostCentre(t.ctx, { name: 'North Region', categoryId: primary });
    const delhi = saveCostCentre(t.ctx, { name: 'Delhi Branch', alias: 'DEL', categoryId: primary, parentId: north.id });
    const noida = saveCostCentre(t.ctx, { name: 'Noida Office', categoryId: primary, parentId: delhi.id });
    assert.deepEqual(noida.path, ['North Region', 'Delhi Branch', 'Noida Office']);
    assert.equal(noida.depth, 2);
    assert.equal(getCostCentre(t.db, north.id).childCount, 1);
    assert.throws(() => saveCostCentre(t.ctx, { name: 'Alpha', categoryId: other, parentId: north.id }), isErr('VALIDATION', /belongs to another cost category/));
    assert.throws(() => saveCostCentre(t.ctx, { id: north.id, parentId: noida.id }), isErr('VALIDATION', /under itself or under one of its own sub-centres/));
    assert.throws(() => saveCostCentre(t.ctx, { name: 'del', categoryId: primary }), isErr('VALIDATION', /already exists/));
    assert.throws(() => saveCostCentre(t.ctx, { name: 'Gurgaon' }), isErr('VALIDATION', /Choose the cost category/));
    assert.deepEqual(
      listCostCentres(t.db, { categoryId: primary }).rows.map((r) => r.name),
      ['North Region', 'Delhi Branch', 'Noida Office'],
    );
    assert.equal(listCostCentres(t.db, { search: 'del' }).total, 1);
    // Moving the top centre to another category moves the whole sub-tree.
    saveCostCentre(t.ctx, { id: north.id, categoryId: other });
    assert.equal(getCostCentre(t.db, noida.id).categoryId, other);
    assert.equal(getCostCentre(t.db, noida.id).categoryName, 'Projects');
    t.close();
  });

  it('refuses to delete centres with sub-centres or cost allocations', () => {
    const t = createTestCompany();
    const parent = saveCostCentre(t.ctx, { name: 'Factory', categoryId: t.ids.costCategoryId });
    const child = saveCostCentre(t.ctx, { name: 'Machine Shop', categoryId: t.ids.costCategoryId, parentId: parent.id });
    assert.throws(() => deleteCostCentre(t.ctx, parent.id), isErr('BUSINESS_RULE', /has 1 sub-centre/));
    const rent = saveLedger(t.ctx, { name: 'Rent', groupId: t.ids.groups.INDIRECT_EXPENSES, costCentresApplicable: true });
    const vid = postRaw(t, { date: '2026-04-02', lines: [[rent.id, 5000], [t.ids.ledgers.CASH, -5000]] });
    const entry = t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l', { v: vid, l: rent.id });
    t.db.run(
      `INSERT INTO cost_allocations (voucher_id, ledger_entry_id, ledger_id, cost_centre_id, amount, date) VALUES (:v, :e, :l, :c, 5000, '2026-04-02')`,
      { v: vid, e: entry, l: rent.id, c: child.id },
    );
    assert.throws(() => deleteCostCentre(t.ctx, child.id), isErr('BUSINESS_RULE', /used in 1 voucher/));
    t.db.run('DELETE FROM cost_allocations');
    deleteCostCentre(t.ctx, child.id);
    assert.deepEqual(deleteCostCentre(t.ctx, parent.id), { id: parent.id, deleted: true });
    assert.equal(lastAudit(t, 'cost_centre')?.action, 'delete');
    t.close();
  });
});

describe('currencies & exchange rates', () => {
  it('creates currencies with unique symbol/ISO code; the base currency cannot be deleted', () => {
    const t = createTestCompany();
    const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'usd' });
    assert.equal(usd.isoCode, 'USD');
    assert.equal(usd.decimalPlaces, 2);
    assert.equal(usd.isBase, false);
    assert.throws(() => saveCurrency(t.ctx, { symbol: '$', formalName: 'Singapore Dollar', isoCode: 'SGD' }), isErr('VALIDATION', /already used by US Dollar/));
    assert.throws(() => saveCurrency(t.ctx, { symbol: 'US$', formalName: 'Dollar', isoCode: 'USD' }), isErr('VALIDATION', /ISO code USD is already used/));
    assert.throws(() => saveCurrency(t.ctx, { symbol: '€', formalName: 'Euro', isoCode: 'EURO' }), isErr('VALIDATION', /3 letters/));
    const list = listCurrencies(t.db);
    assert.deepEqual(
      list.rows.map((c) => [c.isoCode, c.isBase]),
      [
        ['INR', true],
        ['USD', false],
      ],
    );
    assert.throws(() => deleteCurrency(t.ctx, t.ids.currencyId), isErr('BUSINESS_RULE', /base currency/));
    assert.throws(() => saveCurrency(t.ctx, { id: t.ids.currencyId, isoCode: 'USD' }), isErr('VALIDATION', /base currency cannot be changed/));
    const renamed = saveCurrency(t.ctx, { id: t.ids.currencyId, symbol: 'Rs.' });
    assert.equal(renamed.symbol, 'Rs.');
    t.close();
  });

  it('upserts exchange rates by date and lists them by range', () => {
    const t = createTestCompany();
    const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD' });
    const r1 = saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-01', standard: 83.25 });
    assert.equal(lastAudit(t, 'exchange_rate')?.action, 'create');
    const r1b = saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-01', selling: 83.5 });
    assert.equal(r1b.id, r1.id, 'same date updates the row');
    assert.deepEqual([r1b.standard, r1b.selling, r1b.buying], [83.25, 83.5, null]);
    assert.equal(lastAudit(t, 'exchange_rate')?.action, 'alter');
    saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-10', standard: 83.9 });
    assert.deepEqual(
      listExchangeRates(t.db, { currencyId: usd.id }).rows.map((r) => r.date),
      ['2026-04-10', '2026-04-01'],
    );
    assert.equal(listExchangeRates(t.db, { currencyId: usd.id, from: '2026-04-05', to: '2026-04-30' }).total, 1);
    assert.throws(() => listExchangeRates(t.db, { currencyId: usd.id, from: '2026-05-01', to: '2026-04-01' }), isErr('VALIDATION', /starts after it ends/));
    assert.equal(exchangeRateOn(t.db, usd.id, '2026-04-05')?.standard, 83.25);
    assert.equal(exchangeRateOn(t.db, usd.id, '2026-03-31'), null);
    assert.throws(() => saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-11', standard: 0 }), isErr('VALIDATION', /more than zero/));
    assert.throws(() => saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-11' }), isErr('VALIDATION', /at least one rate/));
    assert.throws(() => saveExchangeRate(t.ctx, { currencyId: t.ids.currencyId, date: '2026-04-11', standard: 1 }), isErr('BUSINESS_RULE', /base currency/));
    assert.equal(listCurrencies(t.db).rows[1].latestRate?.date, '2026-04-10');
    deleteExchangeRate(t.ctx, r1.id);
    assert.equal(listExchangeRates(t.db, { currencyId: usd.id }).total, 1);
    t.close();
  });

  it('refuses to delete a currency used by ledgers; deletes its rates otherwise', () => {
    const t = createTestCompany();
    const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD' });
    saveExchangeRate(t.ctx, { currencyId: usd.id, date: '2026-04-01', standard: 83 });
    const l = saveLedger(t.ctx, { name: 'Globex Inc', groupId: t.ids.groups.SUNDRY_DEBTORS, registrationType: 'overseas', currencyId: usd.id });
    assert.throws(() => deleteCurrency(t.ctx, usd.id), isErr('BUSINESS_RULE', /1 ledger uses it/));
    saveLedger(t.ctx, { id: l.id, currencyId: null });
    assert.deepEqual(deleteCurrency(t.ctx, usd.id), { id: usd.id, deleted: true });
    assert.equal(t.db.value('SELECT COUNT(*) FROM exchange_rates'), 0);
    assert.equal(JSON.parse(lastAudit(t, 'currency')?.before_json ?? '{}').exchangeRatesDeleted, 1);
    t.close();
  });
});
