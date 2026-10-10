/**
 * End to end through runtime.dispatch (as Electron main calls the core): a quotation is converted into
 * a sales invoice, a monthly retainer is made recurring and posted from the due list (twice → once),
 * and the summary the Gateway / dashboard show agrees; a delivery note is billed from Sales Bills
 * Pending; an order balance is pre-closed and reopened; a reversing journal counts in a scenario only
 * up to its "applicable up to" date, and a budget is compared with it (pro-rated).
 *
 * Figures: Quotation 2 × Steel Bolt M8 @ ₹500 = ₹1,000 + CGST 9% ₹90 + SGST 9% ₹90 = ₹1,180.00.
 * Retainer: accounting invoice "Consultancy Income" ₹10,000 + 18% (CGST ₹900 + SGST ₹900) = ₹11,800.00.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan, TEST_PAN } from '../../testing/fixtures.ts';
import { startRuntime, type E2E } from '../../testing/e2e/harness.ts';

describe('documents end to end (runtime.dispatch)', () => {
  let e: E2E;
  const ids = { party: 0, item: 0, income: 0, quote: 0, invoice: 0, retainer: 0, template: 0 };
  const types: Record<string, number> = {};

  before(async () => {
    e = startRuntime('2026-06-10');
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Documents E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: true, gst: true, billWise: true, orderProcessing: true, trackingNumbers: true },
    });
    const groups = await e.call<{ rows: Array<{ id: number; name: string }> }>('accounts.group.list', {});
    const debtors = groups.rows.find((g) => g.name === 'Sundry Debtors')?.id;
    const direct = groups.rows.find((g) => g.name === 'Direct Incomes')?.id;
    ids.party = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Kavya Traders', groupId: debtors, gstin: makeGstin('27', testPan(2)), stateCode: '27', registrationType: 'regular' })).id;
    ids.income = (
      await e.call<{ id: number }>('accounts.ledger.save', { name: 'Consultancy Income', groupId: direct, gstApplicable: true, gstRate: 18, hsnSac: '998311', gstTaxability: 'taxable', gstSupplyType: 'services' })
    ).id;
    const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
    ids.item = (
      await e.call<{ item: { id: number } }>('inventory.item.save', { name: 'Steel Bolt M8', unitId: units.rows.find((u) => u.symbol === 'Nos')?.id, gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7318' })
    ).item.id;
    for (const t of (await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {})).rows) {
      if (t.isPredefined) types[t.baseType] = t.id;
    }
  });
  after(async () => {
    await e.close();
  });

  it('the new company has the Quotation and Proforma Invoice voucher types', () => {
    assert.ok(types.quotation > 0);
    assert.ok(types.proforma > 0);
  });

  it('saves a quotation (no books) and converts it into a sales invoice that links back', async () => {
    const q = await e.call<{ id: number; number: string }>('vouchers.save', {
      voucherTypeId: types.quotation,
      date: '2026-06-01',
      mode: 'item_invoice',
      partyLedgerId: ids.party,
      validUntil: '2026-06-30',
      items: [{ itemId: ids.item, qty: 2, rate: 500 }],
    });
    ids.quote = q.id;
    assert.equal(q.number, '1');
    const tb = await e.call<{ rows: Array<{ key: string; closing: number }> }>('reports.trialBalance', { from: '2026-04-01', to: '2026-06-30', mode: 'ledgers' });
    assert.equal(tb.rows.find((r) => r.key === `l:${ids.party}`), undefined, 'a quotation does not touch the party ledger');

    const draft = await e.call<Record<string, unknown>>('documents.draft', { sourceId: q.id, targetBaseType: 'sales', date: '2026-06-10' });
    assert.equal(draft.convertedFromId, q.id);
    const inv = await e.call<{ id: number; number: string; totals: { grandTotal: number } }>('vouchers.save', { ...draft, acknowledgeWarnings: true });
    ids.invoice = inv.id;
    assert.equal(inv.number, '1', 'the GST invoice series starts at 1: the quotation did not use a number from it');
    assert.equal(inv.totals.grandTotal, 118000);
    const list = await e.call<{ rows: Array<{ id: number; status: string; convertedTo: { id: number } | null }>; summary: { conversionRatePct: number } }>('documents.quotation.list', {
      baseType: 'quotation',
      from: '2026-04-01',
      to: '2026-06-30',
    });
    assert.equal(list.rows[0].status, 'converted');
    assert.equal(list.rows[0].convertedTo?.id, inv.id);
    assert.equal(list.summary.conversionRatePct, 100);
    await e.fails('documents.draft', { sourceId: q.id, targetBaseType: 'sales' }, 'BUSINESS_RULE', /already been converted/);
  });

  it('makes a monthly retainer recurring and posts the due occurrences exactly once', async () => {
    const r = await e.call<{ id: number }>('vouchers.save', {
      voucherTypeId: types.sales,
      date: '2026-04-30',
      mode: 'accounting_invoice',
      partyLedgerId: ids.party,
      narration: 'Retainer for {period}',
      ledgers: [{ ledgerId: ids.income, amount: 1000000 }],
      acknowledgeWarnings: true,
    });
    ids.retainer = r.id;
    const suggestion = await e.call<{ dayOfMonth: number; startDate: string; name: string }>('documents.recurring.fromVoucher', { voucherId: r.id });
    assert.equal(suggestion.dayOfMonth, 0, '30-Apr is a month end → last day of every month');
    assert.equal(suggestion.startDate, '2026-05-31');
    const tpl = await e.call<{ id: number; nextDate: string }>('documents.recurring.save', {
      name: 'Retainer – Kavya',
      sourceVoucherId: r.id,
      frequency: 'monthly',
      dayOfMonth: 0,
      startDate: suggestion.startDate,
    });
    ids.template = tpl.id;
    assert.equal(tpl.nextDate, '2026-05-31');

    const summary = await e.call<{ recurringDue: number; recurringDueValue: number }>('documents.summary', {});
    assert.deepEqual([summary.recurringDue, summary.recurringDueValue], [1, 1000000], 'May is due on 10-Jun (value before tax)');
    const due = await e.call<{ rows: Array<{ templateId: number; periodKey: string; date: string }> }>('documents.recurring.due', {});
    assert.deepEqual(due.rows.map((x) => [x.periodKey, x.date]), [['2026-05', '2026-05-31']]);
    const items = due.rows.map((x) => ({ templateId: x.templateId, periodKey: x.periodKey }));
    const posted = await e.call<{ posted: number; results: Array<{ ok: boolean; voucherId?: number; number?: string }> }>('documents.recurring.post', { items, acknowledgeWarnings: true });
    assert.equal(posted.posted, 1, JSON.stringify(posted));
    const again = await e.call<{ posted: number; failed: number }>('documents.recurring.post', { items, acknowledgeWarnings: true });
    assert.deepEqual([again.posted, again.failed], [0, 1], 'never posted twice');
    const v = await e.call<{ number: string; narration: string; totals: { amount: number } }>('vouchers.get', { id: posted.results[0].voucherId });
    assert.equal(v.narration, 'Retainer for May 2026');
    assert.equal(v.totals.amount, 1180000);
    const links = await e.call<{ recurring: { templateName: string; periodKey: string } | null }>('documents.links', { voucherId: posted.results[0].voucherId });
    assert.deepEqual(links.recurring, { templateId: ids.template, templateName: 'Retainer – Kavya', periodKey: '2026-05' });
    assert.equal((await e.call<{ recurringDue: number }>('documents.summary', {})).recurringDue, 0);
  });

  it('a schedule change onto other dates cannot re-open the posted month (review fix)', async () => {
    // Retainer posted for May (31-May). "Every 30 days from 31-May" would key 31-May afresh → posted twice.
    const r = await e.raw('documents.recurring.save', { id: ids.template, name: 'Retainer – Kavya', frequency: 'every_n_days', intervalDays: 30, startDate: '2026-05-31' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'VALIDATION');
      assert.match(JSON.stringify(r.error.details), /startDate.*on or after 30-Jun-2026/);
    }
    // Nothing changed: still nothing due on 10-Jun.
    assert.equal((await e.call<{ rows: unknown[] }>('documents.recurring.due', {})).rows.length, 0);
  });

  it('bills a delivery note from Sales Bills Pending, and pre-closes / reopens an order balance', async () => {
    // Delivery note 2-Jun: 10 × ₹500 = ₹5,000 not yet invoiced; 8 days old on 10-Jun.
    const dn = await e.call<{ id: number }>('vouchers.save', {
      voucherTypeId: types.delivery_note,
      date: '2026-06-02',
      mode: 'item_invoice',
      partyLedgerId: ids.party,
      items: [{ itemId: ids.item, qty: 10, rate: 500 }],
      acknowledgeWarnings: true,
    });
    const pending = await e.call<{ rows: Array<{ noteId: number; pendingQty: number; pendingValue: number; ageDays: number }>; totals: { olderThan7Days: number } }>('documents.billsPending', { kind: 'sales', asOf: '2026-06-10' });
    assert.deepEqual(pending.rows.map((r) => [r.noteId, r.pendingQty, r.pendingValue, r.ageDays]), [[dn.id, 10, 500000, 8]]);
    assert.equal(pending.totals.olderThan7Days, 1);
    assert.equal((await e.call<{ unbilledDeliveryNotes: number; unbilledValue: number }>('documents.summary', {})).unbilledValue, 500000);
    // "Invoice now": the draft bills the pending quantity against the note (no second stock movement).
    const draft = await e.call<{ items: Array<{ qty: number; trackingRef: string }> }>('documents.draft', { sourceId: dn.id, targetBaseType: 'sales', date: '2026-06-10' });
    assert.deepEqual(draft.items.map((i) => [i.qty, i.trackingRef]), [[10, '1']]);
    await e.call('vouchers.save', { ...draft, acknowledgeWarnings: true });
    assert.equal((await e.call<{ rows: unknown[] }>('documents.billsPending', { kind: 'sales', asOf: '2026-06-10' })).rows.length, 0);

    // Sales order 3-Jun for 5; the customer cancels the balance on 10-Jun.
    const so = await e.call<{ id: number }>('vouchers.save', { voucherTypeId: types.sales_order, date: '2026-06-03', mode: 'item_invoice', partyLedgerId: ids.party, items: [{ itemId: ids.item, qty: 5, rate: 500 }] });
    const orders = async () => (await e.call<{ rows: Array<{ orderId: number; pendingQty: number; closedQty?: number }> }>('stock.pendingOrders', { kind: 'sales', asOf: '2026-06-10' })).rows.filter((r) => r.orderId === so.id);
    assert.deepEqual((await orders()).map((r) => r.pendingQty), [5]);
    await e.call('documents.order.preclose', { orderId: so.id, date: '2026-06-10', reason: 'Customer cancelled the balance' });
    assert.deepEqual(await orders(), [], 'a pre-closed order leaves Pending Orders');
    const closures = await e.call<Array<{ closedQty: number; reason: string }>>('documents.order.closures', { orderId: so.id });
    assert.deepEqual(closures.map((c) => [c.closedQty, c.reason]), [[5, 'Customer cancelled the balance']]);
    await e.call('documents.order.reopen', { orderId: so.id });
    assert.deepEqual((await orders()).map((r) => r.pendingQty), [5]);
  });

  it('a reversing journal counts in a scenario only up to its "applicable up to" date; budget variance under the scenario', async () => {
    const groups = await e.call<{ rows: Array<{ id: number; name: string }> }>('accounts.group.list', {});
    const gid = (n: string) => groups.rows.find((g) => g.name === n)?.id;
    const rent = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Office Rent', groupId: gid('Indirect Expenses') })).id;
    const provision = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Rent Payable', groupId: gid('Provisions') })).id;
    const rj = { voucherTypeId: types.reversing_journal, date: '2026-05-31', mode: 'ledger', ledgers: [{ ledgerId: rent, amount: 300000 }, { ledgerId: provision, amount: -300000 }] };
    await e.fails('vouchers.save', { ...rj, applicableUpto: '2026-05-30' }, 'VALIDATION', /before the journal date/);
    await e.call('vouchers.save', { ...rj, applicableUpto: '2026-06-15' });
    const scenario = await e.call<{ id: number }>('documents.scenario.save', { name: 'Provisional', includeActuals: true, includeTypeIds: [types.reversing_journal], excludeTypeIds: [] });
    const rentIn = async (to: string, scenarioId?: number) =>
      (await e.call<{ rows: Array<{ key: string; closing: number }> }>('reports.trialBalance', { from: '2026-04-01', to, mode: 'ledgers', ...(scenarioId ? { scenarioId } : {}) })).rows.find((r) => r.key === `l:${rent}`)?.closing ?? 0;
    assert.equal(await rentIn('2026-06-10'), 0, 'the books never include a reversing journal');
    assert.equal(await rentIn('2026-06-10', scenario.id), 300000);
    assert.equal(await rentIn('2026-06-15', scenario.id), 300000, 'last day it applies');
    assert.equal(await rentIn('2026-06-16', scenario.id), 0, 'gone after its applicable-up-to date');

    // Budget Q1 (1-Apr … 30-Jun, 91 days): rent ₹6,000 on nett transactions. Report to 15-Jun = 76 days:
    // budget 6,00,000 × 76 ÷ 91 = 5,01,098.9 → 5,01,099 paise; actual ₹3,000 under the scenario.
    const budget = await e.call<{ id: number }>('documents.budget.save', {
      name: 'Q1 2026-27',
      from: '2026-04-01',
      to: '2026-06-30',
      lines: [{ kind: 'ledger', refId: rent, basis: 'net_transactions', amount: 600000 }],
    });
    const v = await e.call<{ proRata: number; rows: Array<{ budget: number; actual: number; variance: number; variancePct: number | null; overBudget: boolean }> }>('documents.budget.variance', {
      budgetId: budget.id,
      from: '2026-04-01',
      to: '2026-06-15',
      scenarioId: scenario.id,
    });
    assert.equal(v.proRata, 0.8352);
    // variance 3,00,000 − 5,01,099 = −2,01,099; −2,01,099 ÷ 5,01,099 = −40.13%.
    assert.deepEqual(v.rows.map((r) => [r.budget, r.actual, r.variance, r.variancePct, r.overBudget]), [[501099, 300000, -201099, -40.13, false]]);
    const books = await e.call<{ rows: Array<{ actual: number }> }>('documents.budget.variance', { budgetId: budget.id, from: '2026-04-01', to: '2026-06-15' });
    assert.equal(books.rows[0].actual, 0, 'without the scenario the books have no rent');
    // The Trial Balance / P&L budget column: the ledger, and its group rolled up.
    const cols = await e.call<{ byKey: Record<string, number> }>('documents.budget.columns', { budgetId: budget.id, from: '2026-04-01', to: '2026-06-15' });
    assert.equal(cols.byKey[`l:${rent}`], 501099);
    assert.equal(cols.byKey[`g:${gid('Indirect Expenses')}`], 501099);
  });

  it('every change is in the edit log', async () => {
    const log = await e.call<{ rows: Array<{ entityType: string | null; action: string }> }>('security.audit.list', { limit: 200 });
    const kinds = log.rows.map((r) => `${r.entityType}:${r.action}`);
    assert.ok(kinds.includes('recurring_template:create'));
    assert.ok(kinds.includes('scenario:create'));
    assert.ok(kinds.includes('budget:create'));
    assert.ok(kinds.filter((k) => k === 'voucher:create').length >= 4, 'quotation, invoice, retainer, posted occurrence');
  });
});
