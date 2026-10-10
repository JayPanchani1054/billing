import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DocumentRow, RecurringDueRow } from '../../../../shared/types/documents.ts';
import { ageBucket, budgetLinesForSave, canConvert, documentsExport, expiryText, postItems, scheduleText, sideBudget, toggleKey, variancePctText } from './model.ts';

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

  it('budget column is side-natural on statements; % text has a sign', () => {
    const byKey = { 'l:1': 5000, 'g:2': -9000 };
    assert.equal(sideBudget(byKey, 'l:1', true), 5000);
    assert.equal(sideBudget(byKey, 'g:2', false), 9000);
    assert.equal(sideBudget(byKey, 'g:3', true), null);
    assert.equal(sideBudget(null, 'l:1', true), null);
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
});
