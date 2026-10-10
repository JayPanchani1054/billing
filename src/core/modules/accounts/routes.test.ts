import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import type { ChartOfAccounts, LedgerDetail, LedgerPickerRow, ListResult, GroupRow } from '../../../shared/types/accounts.ts';
import { createTestCompany, makeGstin } from '../../testing/fixtures.ts';
import { accountsRoutes } from './routes.ts';

const code = (r: ApiResult<unknown>): string | null => (r.ok ? null : r.error.code);
const message = (r: ApiResult<unknown>): string => (r.ok ? '' : r.error.message);

describe('accounts routes', () => {
  it('registers the full route table', () => {
    assert.deepEqual(Object.keys(accountsRoutes).sort(), [
      'accounts.chart',
      'accounts.costCategory.delete',
      'accounts.costCategory.get',
      'accounts.costCategory.list',
      'accounts.costCategory.save',
      'accounts.costCentre.delete',
      'accounts.costCentre.get',
      'accounts.costCentre.list',
      'accounts.costCentre.save',
      'accounts.currency.delete',
      'accounts.currency.get',
      'accounts.currency.list',
      'accounts.currency.save',
      'accounts.exchangeRate.delete',
      'accounts.exchangeRate.list',
      'accounts.exchangeRate.save',
      'accounts.group.delete',
      'accounts.group.get',
      'accounts.group.list',
      'accounts.group.save',
      'accounts.ledger.balance',
      'accounts.ledger.bulkCreate',
      'accounts.ledger.delete',
      'accounts.ledger.get',
      'accounts.ledger.list',
      'accounts.ledger.picker',
      'accounts.ledger.save',
      'accounts.openingBalances.summary',
      'accounts.voucherType.delete',
      'accounts.voucherType.get',
      'accounts.voucherType.list',
      'accounts.voucherType.numberGaps',
      'accounts.voucherType.numberingStatus',
      'accounts.voucherType.save',
      'accounts.voucherType.setNextNumber',
    ]);
  });

  it('Data Entry can create masters but cannot alter or delete them', async () => {
    const t = createTestCompany();
    const session = t.sessionAs({ role: 'Data Entry' });
    const created = await t.call(accountsRoutes, 'accounts.ledger.save', { name: 'Acme Traders', groupId: t.ids.groups.SUNDRY_DEBTORS }, { session });
    assert.equal(code(created), null, message(created));
    const id = (created as { ok: true; data: LedgerDetail }).data.id;
    const alter = await t.call(accountsRoutes, 'accounts.ledger.save', { id, name: 'Acme' }, { session });
    assert.equal(code(alter), 'FORBIDDEN');
    assert.match(message(alter), /permission to alter masters.*'masters\.alter'/);
    assert.equal(code(await t.call(accountsRoutes, 'accounts.ledger.delete', { id }, { session })), 'FORBIDDEN');
    assert.equal(code(await t.call(accountsRoutes, 'accounts.group.save', { id: t.ids.groups.SUNDRY_DEBTORS, alias: 'Customers' }, { session })), 'FORBIDDEN');
    assert.equal(code(await t.call(accountsRoutes, 'accounts.voucherType.save', { id: t.ids.voucherTypes.sales, numbering: { prefix: 'S/' } }, { session })), 'FORBIDDEN');
    assert.equal(code(await t.call(accountsRoutes, 'accounts.voucherType.delete', { id: t.ids.voucherTypes.sales }, { session })), 'FORBIDDEN');
    assert.equal(code(await t.call(accountsRoutes, 'accounts.group.save', { name: 'Dealers', parentId: t.ids.groups.SUNDRY_DEBTORS }, { session })), null);
    // Unchanged after the refused alter.
    const after = await t.callOk<LedgerDetail>(accountsRoutes, 'accounts.ledger.get', { id });
    assert.equal(after.name, 'Acme Traders');
    t.close();
  });

  it('Auditor can read but not create; an Accountant can alter and delete', async () => {
    const t = createTestCompany();
    const auditor = t.sessionAs({ role: 'Auditor' });
    assert.equal(code(await t.call(accountsRoutes, 'accounts.ledger.list', {}, { session: auditor })), null);
    assert.equal(code(await t.call(accountsRoutes, 'accounts.ledger.save', { name: 'X', groupId: t.ids.groups.SUNDRY_DEBTORS }, { session: auditor })), 'FORBIDDEN');
    assert.equal(code(await t.call(accountsRoutes, 'accounts.ledger.bulkCreate', { rows: [{ name: 'X', groupId: t.ids.groups.SUNDRY_DEBTORS }] }, { session: auditor })), 'FORBIDDEN');
    const acc = t.sessionAs({ role: 'Accountant', username: 'meera' });
    const l = await t.callOk<LedgerDetail>(accountsRoutes, 'accounts.ledger.save', { name: 'Acme', groupId: t.ids.groups.SUNDRY_DEBTORS }, { session: acc });
    await t.callOk(accountsRoutes, 'accounts.ledger.save', { id: l.id, name: 'Acme Traders' }, { session: acc });
    await t.callOk(accountsRoutes, 'accounts.ledger.delete', { id: l.id }, { session: acc });
    const rows = t.db.all<{ action: string; username: string }>(`SELECT action, username FROM audit_log WHERE entity_type = 'ledger' ORDER BY id`);
    assert.deepEqual(
      rows.map((r) => [r.action, r.username]),
      [
        ['create', 'meera'],
        ['alter', 'meera'],
        ['delete', 'meera'],
      ],
    );
    t.close();
  });

  it('reports schema and rule violations as VALIDATION with field paths', async () => {
    const t = createTestCompany();
    const bad = await t.call(accountsRoutes, 'accounts.ledger.save', { name: 'X', groupId: t.ids.groups.SALES_ACCOUNTS, gstRate: 'eighteen' });
    assert.equal(code(bad), 'VALIDATION');
    const rule = await t.call(accountsRoutes, 'accounts.ledger.save', { name: 'X', groupId: t.ids.groups.SUNDRY_DEBTORS, gstin: makeGstin('29'), stateCode: '27' });
    assert.equal(code(rule), 'VALIDATION');
    assert.deepEqual(
      (rule as { ok: false; error: { details: Array<{ path: string }> } }).error.details.map((d) => d.path),
      ['gstin'],
    );
    const range = await t.call(accountsRoutes, 'accounts.ledger.balance', { ledgerId: t.ids.ledgers.CASH, from: '2026-05-01', to: '2026-04-01' });
    assert.equal(code(range), 'VALIDATION');
    const limit = await t.call(accountsRoutes, 'accounts.ledger.list', { limit: 0 });
    assert.equal(code(limit), 'VALIDATION');
    t.close();
  });

  it('a refused change leaves no data and no audit row behind (route transaction)', async () => {
    const t = createTestCompany();
    const g = await t.callOk<GroupRow>(accountsRoutes, 'accounts.group.save', { name: 'Current A/cs', parentId: t.ids.groups.BANK_ACCOUNTS });
    await t.callOk(accountsRoutes, 'accounts.ledger.save', { name: 'ICICI', groupId: g.id, bankIfsc: 'ICIC0000001' });
    const audits = t.db.value<number>('SELECT COUNT(*) FROM audit_log');
    const moved = await t.call(accountsRoutes, 'accounts.group.save', { id: g.id, parentId: t.ids.groups.SUNDRY_DEBTORS });
    assert.equal(code(moved), 'BUSINESS_RULE');
    assert.equal(t.db.value('SELECT parent_id FROM groups WHERE id = :id', { id: g.id }), t.ids.groups.BANK_ACCOUNTS);
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM audit_log'), audits);
    const bulk = await t.call(accountsRoutes, 'accounts.ledger.bulkCreate', {
      rows: [
        { name: 'P1', groupId: t.ids.groups.SUNDRY_DEBTORS },
        { name: 'P2', groupId: t.ids.groups.SUNDRY_DEBTORS, stateCode: '99X' },
      ],
    });
    assert.equal(code(bulk), 'VALIDATION');
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE name IN ('P1', 'P2')`), 0);
    t.close();
  });

  it('serves pickers, lists, balances, the chart and the opening summary', async () => {
    const t = createTestCompany();
    await t.callOk(accountsRoutes, 'accounts.ledger.save', { name: 'Capital', groupId: t.ids.groups.CAPITAL_ACCOUNT, openingBalance: -500000 });
    await t.callOk(accountsRoutes, 'accounts.ledger.save', { id: t.ids.ledgers.CASH, openingBalance: 500000 });
    const picker = await t.callOk<LedgerPickerRow[]>(accountsRoutes, 'accounts.ledger.picker', { classes: ['cash_bank'] });
    assert.deepEqual(
      picker.map((r) => [r.name, r.balance]),
      [['Cash', 500000]],
    );
    const list = await t.callOk<ListResult<unknown>>(accountsRoutes, 'accounts.ledger.list', { classes: ['duty_tax'], limit: 5 });
    assert.equal(list.total, 12);
    assert.equal(list.rows.length, 5);
    const bal = await t.callOk(accountsRoutes, 'accounts.ledger.balance', { ledgerId: t.ids.ledgers.CASH });
    assert.deepEqual(bal, { opening: 500000, debit: 0, credit: 0, closing: 500000 });
    const chart = await t.callOk<ChartOfAccounts>(accountsRoutes, 'accounts.chart', {});
    assert.equal(chart.totalDebit, 500000);
    assert.equal(chart.totalCredit, 500000);
    assert.deepEqual(await t.callOk(accountsRoutes, 'accounts.openingBalances.summary'), { totalDebit: 500000, totalCredit: 500000, difference: 0, ledgerCount: 2 });
    for (const name of ['accounts.group.list', 'accounts.voucherType.list', 'accounts.currency.list', 'accounts.costCategory.list', 'accounts.costCentre.list']) {
      const r = await t.call(accountsRoutes, name, {});
      assert.equal(code(r), null, `${name}: ${message(r)}`);
    }
    t.close();
  });
});
