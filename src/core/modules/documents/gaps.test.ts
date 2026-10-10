/**
 * Regression tests of the final-wave gap fixes in the documents module (each fails if its defect returns).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadVoucherRow, saveVoucher, storedInput } from '../vouchers/service.ts';
import { save, setupKit, throwsField } from '../vouchers/testkit.ts';
import './hook.ts';
import { budgetVariance, saveBudget } from './budgets.ts';
import { draftVoucher } from './quotations.ts';
import { saveScenario } from './scenarios.ts';

describe('conversion links are re-checked on alteration', () => {
  it('a converted invoice cannot move before its quotation, nor the quotation after the invoice', () => {
    const k = setupKit({ features: { orderProcessing: true } });
    const q = save(k, { voucherTypeId: k.vt.quotation, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const inv = save(k, { ...draftVoucher(k.t.ctx, { sourceId: q.id, targetBaseType: 'sales' }), date: '2026-04-15' });
    const alter = (id: number, date: string) => {
      const row = loadVoucherRow(k.t.db, id)!;
      return saveVoucher(k.t.ctx, { ...storedInput(k.t.db, row), id, number: row.number ?? undefined, date, expectedUpdatedAt: row.updated_at, acknowledgeWarnings: true });
    };
    throwsField(() => alter(inv.id, '2026-04-05'), 'date', /converts Quotation .* dated 10-Apr-2026; it cannot be dated before it/);
    throwsField(() => alter(q.id, '2026-04-20'), 'date', /converted into Sales .* dated 15-Apr-2026; it cannot be dated after it/);
    // Within the order, alterations are fine.
    alter(inv.id, '2026-04-12');
    alter(q.id, '2026-04-11');
    assert.equal(loadVoucherRow(k.t.db, inv.id)?.date, '2026-04-12');
    k.t.close();
  });
});

describe('budget variance under a scenario — cost centres too', () => {
  it('cost-centre actuals follow the scenario (memorandum in, excluded type out, actuals dropped)', () => {
    const k = setupKit({ today: '2026-04-30', features: { costCentres: true } });
    const centre = k.t.db.run(
      `INSERT INTO cost_centres (guid, name, category_id, created_at, updated_at) VALUES ('cc-1', 'Mumbai Branch', :cat, 'x', 'x')`,
      { cat: k.t.ids.costCategoryId },
    ).lastInsertRowid as number;
    const travel = k.t.addLedger({ name: 'Travel', group: 'INDIRECT_EXPENSES', costCentres: true });
    const jv = (vt: number, amount: number) =>
      save(k, { voucherTypeId: vt, date: '2026-04-12', mode: 'ledger', ledgers: [{ ledgerId: travel, amount, costAllocations: [{ costCentreId: centre, amount }] }, { ledgerId: k.L.capital, amount: -amount }] });
    jv(k.vt.journal, 4_000_00); // actual ₹4,000
    jv(k.vt.memorandum, 1_500_00); // provisional ₹1,500
    const b = saveBudget(k.t.ctx, { name: 'FY', from: '2026-04-01', to: '2026-04-30', lines: [{ kind: 'cost_centre', refId: centre, basis: 'net_transactions', amount: 5_000_00 }] });
    const actual = (scenarioId?: number) =>
      budgetVariance(k.t.ctx, { budgetId: b.id, from: '2026-04-01', to: '2026-04-30', ...(scenarioId !== undefined ? { scenarioId } : {}) }).rows.find((r) => r.key === `cost_centre:${centre}`)?.actual;
    assert.equal(actual(), 4_000_00, 'books only');
    const withMemo = saveScenario(k.t.ctx, { name: 'With memo', includeActuals: true, includeTypeIds: [k.vt.memorandum], excludeTypeIds: [] });
    assert.equal(actual(withMemo.id), 5_500_00, '4,000 + 1,500 provisional');
    const memoOnly = saveScenario(k.t.ctx, { name: 'Memo only', includeActuals: false, includeTypeIds: [k.vt.memorandum], excludeTypeIds: [] });
    assert.equal(actual(memoOnly.id), 1_500_00, 'actuals dropped');
    const noJv = saveScenario(k.t.ctx, { name: 'No journals', includeActuals: true, includeTypeIds: [], excludeTypeIds: [k.vt.journal] });
    assert.equal(actual(noJv.id), 0, 'the journal type is excluded');
    k.t.close();
  });
});
