/**
 * Scenarios (memorandum, reversing journal "applicable up to", optional, excluded types) on the Trial
 * Balance / Balance Sheet / P&L, and Budgets (variance report, report columns).
 *
 * Books (April 2026): Journal 1 (10-Apr) Dr Office Rent ₹10,000 / Cr Owner Capital — actual.
 *   Memorandum (12-Apr) Dr Office Rent ₹2,000 / Cr Owner Capital.
 *   Optional Journal (20-Apr) Dr Office Rent ₹500 / Cr Owner Capital.
 *   Reversing Journal (30-Apr, applicable up to 15-May) Dr Office Rent ₹3,000 / Cr Rent Payable (Provisions).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportsRoutes } from '../reports/routes.ts';
import { save, setupKit, throwsApp, throwsField, type Kit } from '../vouchers/testkit.ts';
import { budgetColumns, budgetVariance, deleteBudget, periodBudget, proRataShare, saveBudget } from './budgets.ts';
import { documentsRoutes } from './routes.ts';
import { deleteScenario, listScenarios, saveScenario } from './scenarios.ts';

interface TbRowLite {
  key: string;
  closing: number;
}

function books(): { k: Kit; payable: number } {
  const k = setupKit({ today: '2026-05-31' });
  const payable = k.t.addLedger({ name: 'Rent Payable', group: 'PROVISIONS' });
  const jv = (vt: number, date: string, amount: number, cr: number, extra: Record<string, unknown> = {}) =>
    save(k, { voucherTypeId: vt, date, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount }, { ledgerId: cr, amount: -amount }], ...extra });
  jv(k.vt.journal, '2026-04-10', 1000000, k.L.capital);
  jv(k.vt.memorandum, '2026-04-12', 200000, k.L.capital);
  jv(k.vt.journal, '2026-04-20', 50000, k.L.capital, { isOptional: true });
  jv(k.vt.reversing_journal, '2026-04-30', 300000, payable, { applicableUpto: '2026-05-15' });
  return { k, payable };
}

async function tb(k: Kit, to: string, scenarioId?: number): Promise<Map<string, number> & { balanced?: boolean }> {
  const r = await k.t.callOk<{ rows: TbRowLite[]; balanced: boolean }>(reportsRoutes, 'reports.trialBalance', { from: '2026-04-01', to, mode: 'ledgers', ...(scenarioId ? { scenarioId } : {}) });
  assert.equal(r.balanced, true, 'Dr = Cr under any scenario');
  return new Map(r.rows.map((x) => [x.key, x.closing]));
}

describe('scenarios', () => {
  it('include provisional vouchers: memorandum, optional, reversing journal only up to its date', async () => {
    const { k, payable } = books();
    const all = saveScenario(k.t.ctx, { name: 'Provisional', includeActuals: true, includeTypeIds: [k.vt.memorandum, k.vt.reversing_journal, k.vt.journal], excludeTypeIds: [] });
    const rent = `l:${k.L.rent}`;
    // Books only: ₹10,000.
    assert.equal((await tb(k, '2026-04-30')).get(rent), 1000000);
    // 30-Apr: 10,000 + 2,000 + 500 + 3,000 = ₹15,500; provision Cr ₹3,000.
    const apr = await tb(k, '2026-04-30', all.id);
    assert.equal(apr.get(rent), 1550000);
    assert.equal(apr.get(`l:${payable}`), -300000);
    // 15-May is the last day the reversing journal applies; 16-May it is gone (₹12,500).
    assert.equal((await tb(k, '2026-05-15', all.id)).get(rent), 1550000);
    assert.equal((await tb(k, '2026-05-16', all.id)).get(rent), 1250000);
    // Without actuals: only the memorandum (scenario includes the memorandum type only).
    const memo = saveScenario(k.t.ctx, { name: 'Memo only', includeActuals: false, includeTypeIds: [k.vt.memorandum], excludeTypeIds: [] });
    assert.equal((await tb(k, '2026-04-30', memo.id)).get(rent), 200000);
    // Actuals without journals: rent 0 (the journal type is excluded), memorandum not included.
    const noJv = saveScenario(k.t.ctx, { name: 'No journals', includeActuals: true, includeTypeIds: [], excludeTypeIds: [k.vt.journal] });
    assert.equal((await tb(k, '2026-04-30', noJv.id)).get(rent) ?? 0, 0);
    k.t.close();
  });

  it('Balance Sheet stays balanced and the P&L shows the provisional expense', async () => {
    const { k } = books();
    const s = saveScenario(k.t.ctx, { name: 'Provisional', includeActuals: true, includeTypeIds: [k.vt.memorandum, k.vt.reversing_journal], excludeTypeIds: [] });
    const bs = await k.t.callOk<{ balanced: boolean; difference: number }>(reportsRoutes, 'reports.balanceSheet', { asOf: '2026-04-30', scenarioId: s.id });
    assert.equal(bs.balanced, true);
    const pl = await k.t.callOk<{ figures: { netProfit: number } }>(reportsRoutes, 'reports.profitLoss', { from: '2026-04-01', to: '2026-04-30', scenarioId: s.id });
    const plBooks = await k.t.callOk<{ figures: { netProfit: number } }>(reportsRoutes, 'reports.profitLoss', { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(plBooks.figures.netProfit, -1000000, 'books: rent ₹10,000 loss');
    assert.equal(plBooks.figures.netProfit - pl.figures.netProfit, 500000, 'memorandum ₹2,000 + reversing ₹3,000 more expense');
    const bad = await k.t.call(reportsRoutes, 'reports.trialBalance', { from: '2026-04-01', to: '2026-04-30', scenarioId: 9999 });
    assert.equal(bad.ok, false);
    k.t.close();
  });

  it('validates scenario masters and audits them', () => {
    const { k } = books();
    throwsField(() => saveScenario(k.t.ctx, { name: 'X', includeActuals: true, includeTypeIds: [k.vt.journal], excludeTypeIds: [k.vt.journal] }), 'excludeTypeIds');
    throwsField(() => saveScenario(k.t.ctx, { name: 'X', includeActuals: false, includeTypeIds: [], excludeTypeIds: [] }), 'includeTypeIds');
    throwsField(() => saveScenario(k.t.ctx, { name: 'X', includeActuals: true, includeTypeIds: [k.vt.sales_order], excludeTypeIds: [] }), 'includeTypeIds[0]', /no ledger entries/);
    const s = saveScenario(k.t.ctx, { name: 'P', includeActuals: true, includeTypeIds: [k.vt.memorandum], excludeTypeIds: [] });
    throwsField(() => saveScenario(k.t.ctx, { name: 'p', includeActuals: true, includeTypeIds: [k.vt.memorandum], excludeTypeIds: [] }), 'name');
    assert.deepEqual(listScenarios(k.t.db).map((x) => [x.name, x.includeTypes]), [['P', ['Memorandum']]]);
    throwsApp(() => deleteScenario(k.t.ctxAs({ role: 'Data Entry' }), s.id), 'FORBIDDEN');
    deleteScenario(k.t.ctx, s.id);
    assert.deepEqual(k.t.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'scenario' ORDER BY id`).map((r) => r.action), ['create', 'delete']);
    k.t.close();
  });
});

describe('budgets', () => {
  it('pro-rates net-transaction budgets by days; closing-balance budgets stay whole', () => {
    // April = 30 of 365 days of FY 2026-27.
    const share = proRataShare({ from: '2026-04-01', to: '2027-03-31' }, '2026-04-01', '2026-04-30');
    assert.equal(share, 30 / 365);
    assert.equal(periodBudget(12000000, 'net_transactions', share), 986301, '₹1,20,000 × 30/365 = ₹9,863.01');
    assert.equal(periodBudget(12000000, 'closing_balance', share), 12000000);
    assert.equal(proRataShare({ from: '2026-04-01', to: '2027-03-31' }, '2025-04-01', '2025-04-30'), 0);
  });

  it('variance report: actual vs budget for ledgers, groups and cost centres', () => {
    const k = setupKit({ today: '2026-04-30', features: { costCentres: true } });
    const centre = k.t.db.run(
      `INSERT INTO cost_centres (guid, name, category_id, created_at, updated_at) VALUES ('cc-1', 'Mumbai Branch', :cat, 'x', 'x')`,
      { cat: k.t.ids.costCategoryId },
    ).lastInsertRowid;
    const travel = k.t.addLedger({ name: 'Travel', group: 'INDIRECT_EXPENSES', costCentres: true });
    save(k, { voucherTypeId: k.vt.journal, date: '2026-04-10', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 1000000 }, { ledgerId: k.L.capital, amount: -1000000 }] });
    save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-04-12',
      mode: 'ledger',
      ledgers: [{ ledgerId: travel, amount: 400000, costAllocations: [{ costCentreId: centre, amount: 400000 }] }, { ledgerId: k.L.capital, amount: -400000 }],
    });
    // Sale to acme: 5 × ₹200 + 18% = ₹1,180 → debtors ₹1,180 Dr, sales ₹1,000 Cr.
    save(k, { voucherTypeId: k.vt.sales, date: '2026-04-15', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const g = (code: string) => k.t.ids.groups[code as 'INDIRECT_EXPENSES'];
    const b = saveBudget(k.t.ctx, {
      name: 'FY 2026-27',
      from: '2026-04-01',
      to: '2027-03-31',
      lines: [
        { kind: 'ledger', refId: k.L.rent, basis: 'net_transactions', amount: 12000000 },
        { kind: 'group', refId: g('INDIRECT_EXPENSES'), basis: 'net_transactions', amount: 18250000 },
        { kind: 'group', refId: g('SALES_ACCOUNTS'), basis: 'net_transactions', amount: -36500000 },
        { kind: 'group', refId: g('SUNDRY_DEBTORS'), basis: 'closing_balance', amount: 500000 },
        { kind: 'cost_centre', refId: centre, basis: 'net_transactions', amount: 3650000 },
      ],
    });
    const r = budgetVariance(k.t.ctx, { budgetId: b.id, from: '2026-04-01', to: '2026-04-30' });
    const row = (key: string) => r.rows.find((x) => x.key === key);
    // Rent: budget 9,863.01; actual 10,000 → variance 136.99 = 1.39% over.
    assert.deepEqual([row(`ledger:${k.L.rent}`)?.budget, row(`ledger:${k.L.rent}`)?.actual, row(`ledger:${k.L.rent}`)?.variance, row(`ledger:${k.L.rent}`)?.variancePct, row(`ledger:${k.L.rent}`)?.overBudget], [986301, 1000000, 13699, 1.39, true]);
    // Indirect expenses: budget 1,82,500 × 30/365 = 15,000.00; actual rent 10,000 + travel 4,000 = 14,000 → −1,000 (6.67% under).
    const ie = row(`group:${g('INDIRECT_EXPENSES')}`);
    assert.deepEqual([ie?.budget, ie?.actual, ie?.variance, ie?.variancePct, ie?.overBudget], [1500000, 1400000, -100000, -6.67, false]);
    // Sales: budget Cr 3,65,000 × 30/365 = 30,000 Cr; actual 1,000 Cr → variance 29,000 Dr (short of target).
    const sales = row(`group:${g('SALES_ACCOUNTS')}`);
    assert.deepEqual([sales?.budget, sales?.actual, sales?.variance, sales?.overBudget], [-3000000, -100000, 2900000, false]);
    // Debtors closing: target 5,000 Dr (not pro-rated), actual 1,180 Dr.
    const deb = row(`group:${g('SUNDRY_DEBTORS')}`);
    assert.deepEqual([deb?.budget, deb?.actual], [500000, 118000]);
    // Cost centre: 36,500 × 30/365 = 3,000; actual 4,000.
    const cc = row(`cost_centre:${centre}`);
    assert.deepEqual([cc?.budget, cc?.actual, cc?.variance], [300000, 400000, 100000]);
    assert.equal(r.proRata, Math.round((30 / 365) * 10000) / 10000);

    // Report columns: explicit lines, and parents rolled up (Current Assets ← Sundry Debtors).
    const cols = budgetColumns(k.t.ctx, { budgetId: b.id, from: '2026-04-01', to: '2026-04-30' });
    assert.equal(cols.byKey[`l:${k.L.rent}`], 986301);
    assert.equal(cols.byKey[`g:${g('INDIRECT_EXPENSES')}`], 1500000);
    assert.equal(cols.byKey[`g:${g('CURRENT_ASSETS')}`], 500000);
    assert.equal(cols.byKey[`g:${g('CAPITAL_ACCOUNT')}`], undefined);
    k.t.close();
  });

  it('validates budgets, audits them, and serves the report through the dispatcher with access checks', async () => {
    const k = setupKit({ today: '2026-04-30' });
    throwsField(() => saveBudget(k.t.ctx, { name: 'B', from: '2026-04-30', to: '2026-04-01', lines: [] }), 'to');
    throwsField(
      () =>
        saveBudget(k.t.ctx, {
          name: 'B',
          from: '2026-04-01',
          to: '2027-03-31',
          lines: [
            { kind: 'ledger', refId: k.L.rent, basis: 'net_transactions', amount: 1 },
            { kind: 'ledger', refId: k.L.rent, basis: 'closing_balance', amount: 2 },
          ],
        }),
      'lines[1].refId',
    );
    throwsField(() => saveBudget(k.t.ctx, { name: 'B', from: '2026-04-01', to: '2027-03-31', lines: [{ kind: 'group', refId: 99999, basis: 'net_transactions', amount: 1 }] }), 'lines[0].refId');
    const b = saveBudget(k.t.ctx, { name: 'B', from: '2026-04-01', to: '2027-03-31', lines: [{ kind: 'ledger', refId: k.L.rent, basis: 'net_transactions', amount: 100 }] });
    const ok = await k.t.callOk<{ rows: unknown[] }>(documentsRoutes, 'documents.budget.variance', { budgetId: b.id });
    assert.equal(ok.rows.length, 1);
    const denied = await k.t.call(documentsRoutes, 'documents.budget.variance', { budgetId: b.id }, { session: k.t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(denied.ok ? '' : denied.error.code, 'FORBIDDEN', 'budget variance is P&L information (reports.financial)');
    deleteBudget(k.t.ctx, b.id);
    assert.deepEqual(k.t.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'budget' ORDER BY id`).map((r) => r.action), ['create', 'delete']);
    k.t.close();
  });
});
