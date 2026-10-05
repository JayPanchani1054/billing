import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { deleteGroup, getGroup, listGroups, saveGroup } from './groups.ts';
import { lastAudit } from './testkit.ts';

const isErr = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message + JSON.stringify(e.details ?? '')));

describe('groups: list & get', () => {
  it('lists the 28 predefined groups in tree order with depth, path and counts', () => {
    const t = createTestCompany();
    const { rows, total } = listGroups(t.db, { includeCounts: true });
    assert.equal(total, 28);
    const debtors = rows.find((r) => r.reservedCode === 'SUNDRY_DEBTORS');
    assert.ok(debtors);
    assert.equal(debtors.depth, 1);
    assert.deepEqual(debtors.path, ['Current Assets', 'Sundry Debtors']);
    assert.equal(debtors.parentName, 'Current Assets');
    assert.equal(debtors.primaryCode, 'CURRENT_ASSETS');
    const duties = rows.find((r) => r.reservedCode === 'DUTIES_TAXES');
    assert.equal(duties?.ledgerCount, 12); // GST ledgers (Output/Input/RCM × 4)
    const cl = rows.find((r) => r.reservedCode === 'CURRENT_LIABILITIES');
    assert.equal(cl?.ledgerCount, 0);
    assert.equal(cl?.totalLedgerCount, 12);
    assert.equal(rows.findIndex((r) => r.reservedCode === 'CURRENT_ASSETS') < rows.findIndex((r) => r.reservedCode === 'SUNDRY_DEBTORS'), true);
    assert.equal(listGroups(t.db).rows[0].ledgerCount, undefined);
    assert.deepEqual(
      listGroups(t.db, { search: 'debt' }).rows.map((r) => r.name),
      ['Sundry Debtors'],
    );
    const g = getGroup(t.db, t.ids.groups.CASH_IN_HAND);
    assert.equal(g.ledgerCount, 1);
    assert.throws(() => getGroup(t.db, 99_999), isErr('NOT_FOUND'));
    t.close();
  });
});

describe('groups: create & alter', () => {
  it('a sub-group inherits nature and gross-profit treatment from its parent (input nature ignored)', () => {
    const t = createTestCompany();
    const g = saveGroup(t.ctx, { name: 'Factory Overheads', parentId: t.ids.groups.DIRECT_EXPENSES, nature: 'assets', affectsGrossProfit: false });
    assert.equal(g.nature, 'expenses');
    assert.equal(g.affectsGrossProfit, true);
    assert.equal(g.isPredefined, false);
    assert.deepEqual(g.path, ['Direct Expenses', 'Factory Overheads']);
    const sub = saveGroup(t.ctx, { name: 'Power & Fuel', parentId: g.id });
    assert.equal(sub.nature, 'expenses');
    assert.equal(sub.affectsGrossProfit, true);
    assert.equal(sub.depth, 2);
    t.close();
  });

  it('a primary group needs a nature; only income/expense groups can affect gross profit', () => {
    const t = createTestCompany();
    assert.throws(() => saveGroup(t.ctx, { name: 'Misc' }), isErr('VALIDATION', /nature of a primary group/));
    assert.throws(() => saveGroup(t.ctx, { name: 'Misc', nature: 'assets', affectsGrossProfit: true }), isErr('VALIDATION', /Only income and expense/));
    const g = saveGroup(t.ctx, { name: 'Job Work Income', nature: 'income', affectsGrossProfit: true });
    assert.equal(g.parentId, null);
    assert.equal(g.affectsGrossProfit, true);
    assert.ok(g.sortOrder > 280, 'new primary groups sort after the predefined ones');
    t.close();
  });

  it('group names and aliases are unique across groups (case-insensitive)', () => {
    const t = createTestCompany();
    assert.throws(() => saveGroup(t.ctx, { name: 'sundry debtors', parentId: t.ids.groups.CURRENT_ASSETS }), isErr('VALIDATION', /already exists/));
    saveGroup(t.ctx, { name: 'Retail Customers', alias: 'Retail', parentId: t.ids.groups.SUNDRY_DEBTORS });
    assert.throws(() => saveGroup(t.ctx, { name: 'RETAIL', parentId: t.ids.groups.SUNDRY_DEBTORS }), isErr('VALIDATION', /alias of group 'Retail Customers'/));
    assert.throws(
      () => saveGroup(t.ctx, { name: 'Wholesale', alias: 'retail customers', parentId: t.ids.groups.SUNDRY_DEBTORS }),
      isErr('VALIDATION', /already used by group/),
    );
    t.close();
  });

  it('predefined groups keep name, parent and nature but may change alias, sort order and flags', () => {
    const t = createTestCompany();
    const id = t.ids.groups.SUNDRY_DEBTORS;
    assert.throws(() => saveGroup(t.ctx, { id, name: 'Customers' }), isErr('VALIDATION', /predefined group and cannot be renamed/));
    assert.throws(() => saveGroup(t.ctx, { id, parentId: t.ids.groups.FIXED_ASSETS }), isErr('VALIDATION', /cannot be moved/));
    assert.throws(() => saveGroup(t.ctx, { id: t.ids.groups.SALES_ACCOUNTS, affectsGrossProfit: false }), isErr('VALIDATION', /gross profit cannot be changed/));
    assert.throws(() => saveGroup(t.ctx, { id: t.ids.groups.CAPITAL_ACCOUNT, parentId: null, nature: 'assets' }), isErr('VALIDATION', /nature cannot be changed/));
    // The full form re-sent unchanged is accepted.
    const ok = saveGroup(t.ctx, { id, name: 'Sundry Debtors', parentId: t.ids.groups.CURRENT_ASSETS, alias: 'Customers', sortOrder: 5, netBalances: true });
    assert.equal(ok.alias, 'Customers');
    assert.equal(ok.sortOrder, 5);
    assert.equal(ok.netBalances, true);
    assert.equal(ok.name, 'Sundry Debtors');
    t.close();
  });

  it('prevents cycles: a group cannot go under itself or one of its sub-groups', () => {
    const t = createTestCompany();
    const a = saveGroup(t.ctx, { name: 'Region North', parentId: t.ids.groups.SUNDRY_DEBTORS });
    const b = saveGroup(t.ctx, { name: 'Delhi Customers', parentId: a.id });
    const c = saveGroup(t.ctx, { name: 'Delhi Retail', parentId: b.id });
    assert.throws(() => saveGroup(t.ctx, { id: a.id, parentId: a.id }), isErr('VALIDATION', /under itself or under one of its own sub-groups/));
    assert.throws(() => saveGroup(t.ctx, { id: a.id, parentId: c.id }), isErr('VALIDATION', /under itself/));
    // Moving a leaf up is fine.
    assert.equal(saveGroup(t.ctx, { id: c.id, parentId: a.id }).depth, 3); // Current Assets › Sundry Debtors › Region North › Delhi Retail
    t.close();
  });

  it('moving a group re-derives nature for the whole sub-tree', () => {
    const t = createTestCompany();
    const a = saveGroup(t.ctx, { name: 'Projects', nature: 'assets' });
    const b = saveGroup(t.ctx, { name: 'Project Costs', parentId: a.id });
    assert.equal(b.nature, 'assets');
    saveGroup(t.ctx, { id: a.id, parentId: t.ids.groups.DIRECT_EXPENSES });
    const moved = getGroup(t.db, b.id);
    assert.equal(moved.nature, 'expenses');
    assert.equal(moved.affectsGrossProfit, true);
    assert.equal(moved.primaryCode, 'DIRECT_EXPENSES');
    // Back to primary with a new nature.
    const back = saveGroup(t.ctx, { id: a.id, parentId: null, nature: 'liabilities' });
    assert.equal(back.affectsGrossProfit, false);
    assert.equal(getGroup(t.db, b.id).nature, 'liabilities');
    t.close();
  });

  it('refuses to move a group when ledgers below it would hold details their new group does not allow', () => {
    const t = createTestCompany();
    const g = saveGroup(t.ctx, { name: 'Current Accounts', parentId: t.ids.groups.BANK_ACCOUNTS });
    t.addLedger({ name: 'ICICI Current', group: 'BANK_ACCOUNTS', columns: { group_id: g.id }, bank: { accountNo: '123456789', ifsc: 'ICIC0000001' } });
    assert.throws(
      () => saveGroup(t.ctx, { id: g.id, parentId: t.ids.groups.SUNDRY_DEBTORS }),
      isErr('BUSINESS_RULE', /ledger 'ICICI Current' would no longer be valid/),
    );
    assert.equal(getGroup(t.db, g.id).parentId, t.ids.groups.BANK_ACCOUNTS, 'rolled back');
    // Moving to Bank OD keeps the bank details valid.
    assert.equal(saveGroup(t.ctx, { id: g.id, parentId: t.ids.groups.BANK_OD }).nature, 'liabilities');
    t.close();
  });

  it('writes create and alter audit rows with before/after snapshots', () => {
    const t = createTestCompany();
    const g = saveGroup(t.ctx, { name: 'Branch Expenses', parentId: t.ids.groups.INDIRECT_EXPENSES });
    let a = lastAudit(t, 'group');
    assert.equal(a?.action, 'create');
    assert.equal(a?.entity_id, g.id);
    assert.equal(a?.before_json, null);
    assert.equal(JSON.parse(a?.after_json ?? '{}').name, 'Branch Expenses');
    saveGroup(t.ctx, { id: g.id, name: 'Branch Office Expenses' });
    a = lastAudit(t, 'group');
    assert.equal(a?.action, 'alter');
    assert.equal(JSON.parse(a?.before_json ?? '{}').name, 'Branch Expenses');
    assert.equal(JSON.parse(a?.after_json ?? '{}').name, 'Branch Office Expenses');
    t.close();
  });
});

describe('groups: delete', () => {
  it('refuses predefined groups, groups with sub-groups and groups with ledgers; deletes and audits otherwise', () => {
    const t = createTestCompany();
    assert.throws(() => deleteGroup(t.ctx, t.ids.groups.SUNDRY_DEBTORS), isErr('BUSINESS_RULE', /predefined group/));
    const parent = saveGroup(t.ctx, { name: 'Dealers', parentId: t.ids.groups.SUNDRY_DEBTORS });
    const child = saveGroup(t.ctx, { name: 'Dealers - South', parentId: parent.id });
    assert.throws(() => deleteGroup(t.ctx, parent.id), isErr('BUSINESS_RULE', /has 1 sub-group \('Dealers - South'\)/));
    t.addLedger({ name: 'Chennai Dealer', group: 'SUNDRY_DEBTORS', columns: { group_id: child.id } });
    assert.throws(() => deleteGroup(t.ctx, child.id), isErr('BUSINESS_RULE', /contains 1 ledger/));
    t.db.run('DELETE FROM ledgers WHERE name = :n', { n: 'Chennai Dealer' });
    assert.deepEqual(deleteGroup(t.ctx, child.id), { id: child.id, deleted: true });
    const a = lastAudit(t, 'group');
    assert.equal(a?.action, 'delete');
    assert.equal(JSON.parse(a?.before_json ?? '{}').name, 'Dealers - South');
    assert.throws(() => deleteGroup(t.ctx, child.id), isErr('NOT_FOUND'));
    t.close();
  });
});
