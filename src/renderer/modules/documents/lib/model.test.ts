import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BillsPendingRow, DocumentRow, RecurringDueRow } from '../../../../shared/types/documents.ts';
import {
  ageBucket,
  amountToSend,
  billsGroupExport,
  budgetLinesForSave,
  canConvert,
  DAY_OF_MONTH_OPTIONS,
  documentsExport,
  expiryText,
  groupBills,
  postItems,
  precloseItems,
  precloseLines,
  qtyText,
  scenarioProblem,
  scheduleInput,
  scheduleProblem,
  scheduleText,
  selectedKeys,
  toggleId,
  toggleKey,
  variancePctText,
  varianceDrill,
  varianceStatus,
} from './model.ts';

const due = (key: string, over: Partial<RecurringDueRow> = {}): RecurringDueRow => ({
  key,
  templateId: Number(key.split('|')[0]),
  templateName: 'Rent',
  voucherTypeId: 1,
  voucherTypeName: 'Journal',
  baseType: 'journal',
  partyName: null,
  periodKey: key.split('|')[1],
  date: `${key.split('|')[1]}-05`,
  overdueDays: 0,
  amount: 2500000,
  overridable: true,
  ...over,
});

describe('documents screen model', () => {
  it('describes schedules in words', () => {
    assert.equal(scheduleText({ frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' }), 'Monthly on the 5th');
    assert.equal(scheduleText({ frequency: 'quarterly', dayOfMonth: 0, startDate: '2026-06-30', endDate: '2027-03-31' }), 'Quarterly on the last day until 31-Mar-2027');
    assert.equal(scheduleText({ frequency: 'yearly', startDate: '2026-04-22' }), 'Yearly on the 22nd');
    assert.equal(scheduleText({ frequency: 'monthly', dayOfMonth: 11, startDate: '2026-04-11' }), 'Monthly on the 11th');
    assert.equal(scheduleText({ frequency: 'every_n_days', intervalDays: 1, startDate: '2026-04-01' }), 'Every 1 day');
    assert.equal(scheduleText({ frequency: 'every_n_days', intervalDays: 14, startDate: '2026-04-01' }), 'Every 14 days');
  });

  it('expiry text and convertible statuses', () => {
    assert.equal(expiryText({ daysToExpiry: 3, status: 'open' }), 'Expires in 3 days');
    assert.equal(expiryText({ daysToExpiry: 0, status: 'accepted' }), 'Expires today');
    assert.equal(expiryText({ daysToExpiry: -1, status: 'expired' }), 'Expired 1 day ago');
    assert.equal(expiryText({ daysToExpiry: -5, status: 'converted' }), null);
    assert.equal(canConvert('expired'), true);
    assert.equal(canConvert('converted'), false);
    assert.equal(canConvert('rejected'), false);
  });

  it('builds the post request from the selection, with amount overrides only where allowed and changed', () => {
    const rows = [due('1|2026-05'), due('1|2026-06'), due('2|2026-06', { overridable: false })];
    let sel = new Set(rows.map((r) => r.key));
    sel = toggleKey(sel, '1|2026-06');
    assert.deepEqual(postItems(rows, sel, { '1|2026-05': 2750000, '2|2026-06': 999 }), [
      { templateId: 1, periodKey: '2026-05', amount: 2750000 },
      { templateId: 2, periodKey: '2026-06' },
    ]);
    assert.deepEqual(postItems(rows, toggleKey(new Set(), '1|2026-05'), { '1|2026-05': 2500000 }), [{ templateId: 1, periodKey: '2026-05' }], 'unchanged amount is not an override');
  });

  it('checks budget lines before saving', () => {
    const ok = budgetLinesForSave([
      { key: 'a', kind: 'ledger', refId: 5, name: 'Rent', basis: 'net_transactions', amount: 100 },
      { key: 'b', kind: 'group', refId: null, name: '', basis: 'net_transactions', amount: null },
    ]);
    assert.deepEqual(ok, { lines: [{ kind: 'ledger', refId: 5, basis: 'net_transactions', amount: 100 }], problem: null });
    assert.equal(budgetLinesForSave([{ key: 'a', kind: 'ledger', refId: 5, name: 'Rent', basis: 'net_transactions', amount: 0 }]).problem?.key, 'a');
    assert.match(
      budgetLinesForSave([
        { key: 'a', kind: 'ledger', refId: 5, name: 'Rent', basis: 'net_transactions', amount: 1 },
        { key: 'b', kind: 'ledger', refId: 5, name: 'Rent', basis: 'closing_balance', amount: 2 },
      ]).problem?.message ?? '',
      /already on another line/,
    );
  });

  it('variance % text has a sign; ageing buckets', () => {
    assert.equal(variancePctText({ variancePct: 1.39 }), '+1.39%');
    assert.equal(variancePctText({ variancePct: -6.67 }), '−6.67%');
    assert.equal(variancePctText({ variancePct: null }), '—');
    assert.equal(ageBucket(7), '0–7 days');
    assert.equal(ageBucket(31), '31–90 days');
  });

  it('exports the register with totals', () => {
    const r: DocumentRow = {
      id: 1, number: 'Q1', date: '2026-04-15', validUntil: '2026-04-30', daysToExpiry: 15, voucherTypeName: 'Quotation', partyLedgerId: 2, partyName: 'Acme',
      amount: 118000, status: 'converted', statusReason: null,
      convertedTo: { id: 3, number: '7', date: '2026-04-20', voucherTypeName: 'Sales', baseType: 'sales', isCancelled: false },
    };
    const t = documentsExport([r], 'quotation');
    assert.deepEqual(t.rows[0], ['2026-04-15', 'Q1', 'Acme', '2026-04-30', 'Converted', 'Sales 7 dt 20-Apr-2026', 118000]);
    assert.equal(t.totals?.[6], 118000);
  });

  it('recurring form: day choices, schedule checks, what is sent', () => {
    assert.equal(DAY_OF_MONTH_OPTIONS.length, 32);
    assert.deepEqual(DAY_OF_MONTH_OPTIONS[30], { value: 31, label: '31st (or the month end)' });
    assert.deepEqual(DAY_OF_MONTH_OPTIONS[31], { value: 0, label: 'Last day of the month' });
    const base = { frequency: 'monthly' as const, intervalDays: null, dayOfMonth: 5, startDate: '2026-05-05', endDate: null };
    assert.equal(scheduleProblem(base), null);
    assert.equal(scheduleProblem({ ...base, frequency: 'every_n_days' })?.field, 'intervalDays');
    assert.equal(scheduleProblem({ ...base, frequency: 'every_n_days', intervalDays: 400 })?.field, 'intervalDays');
    assert.equal(scheduleProblem({ ...base, startDate: null })?.field, 'startDate');
    assert.equal(scheduleProblem({ ...base, endDate: '2026-05-04' })?.field, 'endDate');
    assert.deepEqual(scheduleInput(base), { frequency: 'monthly', startDate: '2026-05-05', endDate: null, dayOfMonth: 5 });
    assert.deepEqual(scheduleInput({ ...base, frequency: 'every_n_days', intervalDays: 14 }), { frequency: 'every_n_days', startDate: '2026-05-05', endDate: null, intervalDays: 14 });
    assert.equal(amountToSend(2500000, 2500000, true), undefined, 'unchanged');
    assert.equal(amountToSend(2500000, 2750000, true), 2750000);
    assert.equal(amountToSend(2500000, 2750000, false), undefined, 'several amounts: never overridden');
    assert.equal(amountToSend(2500000, 0, true), undefined);
    const rows = [due('1|2026-05'), due('1|2026-06')];
    assert.deepEqual([...selectedKeys(rows, new Set(['1|2026-06', 'gone|x']))], ['1|2026-05']);
  });

  it('groups bills pending per party and per item with ageing buckets', () => {
    const line = (o: Partial<BillsPendingRow>): BillsPendingRow => ({
      key: 'n', noteId: 1, noteNo: '1', noteDate: '2026-04-01', noteBaseType: 'delivery_note', noteTypeName: 'Delivery Note', invoiceBaseType: 'sales',
      partyLedgerId: 7, partyName: 'Acme', itemId: 3, itemName: 'Rice', unit: 'kg', qty: 10, billedQty: 4, pendingQty: 6, rate: 50, discountPct: 0,
      pendingValue: 30000, ageDays: 3, ...o,
    });
    const rows = [
      line({ key: 'a' }),
      line({ key: 'b', itemId: 4, itemName: 'Dal', pendingQty: 2, pendingValue: 20000 }),
      line({ key: 'c', noteId: 2, ageDays: 45, pendingQty: 1.5, pendingValue: 7500 }),
      line({ key: 'd', noteId: 3, partyLedgerId: 8, partyName: 'Bharat', ageDays: 100, pendingValue: 90000 }),
    ];
    const parties = groupBills(rows, 'party');
    // Bharat ₹900 first; Acme ₹300 + ₹200 + ₹75 = ₹575 on notes 1 and 2.
    assert.deepEqual(parties.map((g) => [g.name, g.notes, g.lines, g.pendingValue, g.oldestDays]), [
      ['Bharat', 1, 1, 90000, 100],
      ['Acme', 2, 3, 57500, 45],
    ]);
    assert.deepEqual(parties[1].buckets, { '0–7 days': 50000, '8–30 days': 0, '31–90 days': 7500, 'Over 90 days': 0 });
    const items = groupBills(rows, 'item');
    // Rice: 6 + 1.5 + 6 = 13.5 kg.
    assert.deepEqual(items.map((g) => [g.name, g.pendingQty, g.pendingValue]), [['Rice', 13.5, 127500], ['Dal', 2, 20000]]);
    const t = billsGroupExport(items, 'item', 'sales');
    assert.equal(t.columns.length, 8);
    assert.deepEqual(t.totals, ['Total', '', null, 50000, 0, 7500, 90000, 147500]);
  });

  it('checks scenarios like the core does', () => {
    assert.equal(scenarioProblem({ name: ' ', includeActuals: true, include: [], exclude: [] })?.field, 'name');
    assert.equal(scenarioProblem({ name: 'P', includeActuals: true, include: [1], exclude: [1] })?.field, 'excludeTypeIds');
    assert.equal(scenarioProblem({ name: 'P', includeActuals: false, include: [1], exclude: [2] })?.field, 'excludeTypeIds');
    assert.equal(scenarioProblem({ name: 'P', includeActuals: false, include: [], exclude: [] })?.field, 'includeTypeIds');
    assert.equal(scenarioProblem({ name: 'P', includeActuals: true, include: [3], exclude: [2] }), null);
    assert.deepEqual(toggleId([1, 2], 2), [1]);
    assert.deepEqual(toggleId([1], 3), [1, 3]);
  });

  it('pre-close: pending per item of the order; whole balance sent without qty; never more than pending', () => {
    const rows = [
      { orderId: 9, itemId: 1, itemName: 'Rice', unit: 'kg', pendingQty: 4 },
      { orderId: 9, itemId: 1, itemName: 'Rice', unit: 'kg', pendingQty: 2.5 },
      { orderId: 9, itemId: 2, itemName: 'Dal', unit: 'kg', pendingQty: 3 },
      { orderId: 9, itemId: 3, itemName: 'Salt', unit: 'kg', pendingQty: 0 },
      { orderId: 8, itemId: 1, itemName: 'Rice', unit: 'kg', pendingQty: 50 },
    ];
    const lines = precloseLines(rows, 9);
    assert.deepEqual(lines.map((l) => [l.itemName, l.pendingQty]), [['Rice', 6.5], ['Dal', 3]]);
    assert.deepEqual(precloseItems(lines, {}), { items: [{ itemId: 1 }, { itemId: 2 }], problem: null });
    assert.deepEqual(precloseItems(lines, { 1: 2, 2: 0 }), { items: [{ itemId: 1, qty: 2 }], problem: null });
    assert.match(precloseItems(lines, { 2: 4 }).problem?.message ?? '', /Only 3 kg of Dal is pending/);
    assert.deepEqual([qtyText(6.5, 'kg'), qtyText(1.125), qtyText(2.25, 'Nos')], ['6.5 kg', '1.125', '2.25 Nos']);
  });

  it('variance rows drill to the ledger / group summary / cost centres and say over or within budget', () => {
    assert.deepEqual(varianceDrill({ kind: 'ledger', refId: 4, basis: 'net_transactions' }, '2026-04-01', '2026-06-30'), { screen: 'reports.ledger', params: { ledgerId: 4, from: '2026-04-01', to: '2026-06-30' } });
    assert.equal(varianceDrill({ kind: 'group', refId: 9, basis: 'net_transactions' }, 'a', 'b').params.basis, 'profitLoss');
    assert.equal(varianceDrill({ kind: 'group', refId: 9, basis: 'closing_balance' }, 'a', 'b').params.basis, 'trialBalance');
    assert.equal(varianceDrill({ kind: 'cost_centre', refId: 2, basis: 'net_transactions' }, 'a', 'b').screen, 'reports.costCentres');
    assert.equal(varianceStatus({ budget: 5000, actual: 6000, overBudget: true }).label, 'Over budget');
    assert.equal(varianceStatus({ budget: -5000, actual: -4000, overBudget: false }).label, 'Within budget');
    assert.equal(varianceStatus({ budget: 0, actual: 10, overBudget: false }).label, 'Not budgeted');
  });

  it('a variance run under a scenario drills into Group Summary under the same scenario (ledgers show the books)', () => {
    // Review fix: the group's actual under scenario 3 must match the Group Summary it opens.
    assert.equal(varianceDrill({ kind: 'group', refId: 9, basis: 'net_transactions' }, 'a', 'b', 3).params.scenarioId, 3);
    assert.equal(varianceDrill({ kind: 'group', refId: 9, basis: 'net_transactions' }, 'a', 'b').params.scenarioId, undefined);
    assert.equal(varianceDrill({ kind: 'ledger', refId: 4, basis: 'net_transactions' }, 'a', 'b', 3).params.scenarioId, undefined);
  });
});
