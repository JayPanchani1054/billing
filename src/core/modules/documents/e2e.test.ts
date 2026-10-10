/**
 * End to end through runtime.dispatch (as Electron main calls the core): a quotation is converted into
 * a sales invoice, a monthly retainer is made recurring and posted from the due list (twice → once),
 * and the summary the Gateway / dashboard show agrees.
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

  it('every change is in the edit log', async () => {
    const log = await e.call<{ rows: Array<{ entityType: string | null; action: string }> }>('security.audit.list', { limit: 200 });
    const kinds = log.rows.map((r) => `${r.entityType}:${r.action}`);
    assert.ok(kinds.includes('recurring_template:create'));
    assert.ok(kinds.filter((k) => k === 'voucher:create').length >= 4, 'quotation, invoice, retainer, posted occurrence');
  });
});
