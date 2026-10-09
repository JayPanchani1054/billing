/**
 * Recurring vouchers: template from a saved voucher, due list, review-then-post (idempotent per
 * occurrence), skip / undo, pause, amount override, narration placeholders, permissions.
 *
 * Rent: Journal Dr Office Rent ₹25,000 / Cr Sharma Estates ₹25,000 on the 5th of every month from
 * 5-Apr-2026 (the source voucher). Template starts 5-May-2026.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { deleteVoucher } from '../vouchers/service.ts';
import { save, setupKit, throwsApp, throwsField, type Kit } from '../vouchers/testkit.ts';
import './hook.ts';
import { voucherLinks } from './quotations.ts';
import {
  applyAmountOverride,
  deleteTemplate,
  dueOccurrences,
  getTemplate,
  listTemplates,
  occurrenceInput,
  postOccurrences,
  saveTemplate,
  setTemplateActive,
  skipOccurrence,
  suggestFromVoucher,
  templateInput,
  unskipOccurrence,
} from './recurring.ts';

function rentKit(): { k: Kit; landlord: number; rentVoucher: number } {
  const k = setupKit({ today: '2026-04-05' });
  const landlord = k.t.addLedger({ name: 'Sharma Estates', group: 'SUNDRY_CREDITORS' });
  const v = save(k, {
    voucherTypeId: k.vt.journal,
    date: '2026-04-05',
    mode: 'ledger',
    narration: 'Office rent for {period}',
    ledgers: [
      { ledgerId: k.L.rent, amount: 2500000 },
      { ledgerId: landlord, amount: -2500000, billAllocations: [{ refType: 'new', billName: 'APR-26', amount: 2500000 }] },
    ],
  });
  return { k, landlord, rentVoucher: v.id };
}

describe('recurring vouchers', () => {
  it('suggests a monthly template from a saved voucher without its one-off details', () => {
    const { k, rentVoucher } = rentKit();
    const s = suggestFromVoucher(k.t.ctx, rentVoucher);
    assert.equal(s.frequency, 'monthly');
    assert.equal(s.dayOfMonth, 5);
    assert.equal(s.startDate, '2026-05-05', 'starts with the next occurrence');
    assert.equal(s.amount, 2500000);
    assert.equal(s.overridable, true);
    assert.ok(s.notes.some((n) => /Bill references/.test(n)));
    const { input } = templateInput({ voucherTypeId: 1, date: '2026-04-30', mode: 'ledger', number: '7', ledgers: [{ ledgerId: 1, amount: 5, instrument: { type: 'cheque', number: '123456' } }] }, 'payment');
    assert.equal(input.number, undefined);
    assert.deepEqual(input.ledgers?.[0].instrument, { type: 'cheque' });
    // Month-end voucher → last day of every month.
    const end = save(k, { voucherTypeId: k.vt.journal, date: '2026-04-30', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 100 }, { ledgerId: k.L.capital, amount: -100 }] });
    assert.equal(suggestFromVoucher(k.t.ctx, end.id).dayOfMonth, 0);
    k.t.close();
  });

  it('lists due occurrences, posts them once, and never twice', () => {
    const { k, landlord, rentVoucher } = rentKit();
    const tpl = saveTemplate(k.t.ctx, { name: 'Office rent', sourceVoucherId: rentVoucher, frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    assert.equal(tpl.nextDate, '2026-05-05');
    k.t.clock.setToday('2026-07-10');
    const due = dueOccurrences(k.t.ctx, '2026-07-10');
    assert.deepEqual(due.rows.map((r) => [r.periodKey, r.date, r.overdueDays]), [
      ['2026-05', '2026-05-05', 66],
      ['2026-06', '2026-06-05', 35],
      ['2026-07', '2026-07-05', 5],
    ]);
    const res = postOccurrences(k.t.ctx, { items: due.rows.map((r) => ({ templateId: r.templateId, periodKey: r.periodKey })) });
    assert.equal(res.posted, 3, JSON.stringify(res.results));
    const ids = res.results.map((r) => (r.ok ? r.voucherId : 0));
    const v = k.t.db.all<{ date: string; number: string; narration: string; total_amount: number }>(
      'SELECT date, number, narration, total_amount FROM vouchers WHERE id IN (SELECT value FROM json_each(:ids)) ORDER BY date',
      { ids: JSON.stringify(ids) },
    );
    assert.deepEqual(v.map((x) => [x.date, x.number, x.narration, x.total_amount]), [
      ['2026-05-05', '2', 'Office rent for May 2026', 2500000],
      ['2026-06-05', '3', 'Office rent for Jun 2026', 2500000],
      ['2026-07-05', '4', 'Office rent for Jul 2026', 2500000],
    ]);
    // Rent ledger: ₹25,000 × 4 (source + 3 posted).
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l AND affects_books = 1', { l: k.L.rent }), 10000000);
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l', { l: landlord }), -10000000);
    // Each posting is audited as an ordinary voucher creation.
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher' AND action = 'create' AND entity_id IN (SELECT value FROM json_each(:ids))`, { ids: JSON.stringify(ids) }), 3);
    assert.equal(dueOccurrences(k.t.ctx, '2026-07-10').rows.length, 0);

    // Idempotent: posting the same occurrence again fails for that item only.
    const again = postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-06' }] });
    assert.equal(again.posted, 0);
    assert.match(again.results[0].ok ? '' : again.results[0].message, /already posted as Journal 3/);
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM vouchers WHERE base_type = 'journal'`), 4);
    // The voucher view knows where it came from.
    assert.deepEqual(voucherLinks(k.t.ctx, ids[1]).recurring, { templateId: tpl.id, templateName: 'Office rent', periodKey: '2026-06' });
    assert.equal(voucherLinks(k.t.ctx, rentVoucher).templates[0]?.name, 'Office rent');

    // Deleting a posted voucher makes its occurrence due again.
    deleteVoucher(k.t.ctx, ids[2]);
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-07-10').rows.map((r) => r.periodKey), ['2026-07']);
    const row = listTemplates(k.t.ctx)[0];
    assert.equal(row.postedCount, 2);
    assert.equal(row.nextDate, '2026-07-05');
    k.t.close();
  });

  it('posts what it can: a confirmation-needing or locked occurrence fails alone', () => {
    const { k, rentVoucher } = rentKit();
    const tpl = saveTemplate(k.t.ctx, { name: 'Rent', sourceVoucherId: rentVoucher, frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    k.t.clock.setToday('2026-06-10');
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.lockedUpTo', '2026-05-31') WHERE key = 'config'`);
    const res = postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-05' }, { templateId: tpl.id, periodKey: '2026-06' }] });
    assert.equal(res.posted, 1);
    const failed = res.results.find((r) => !r.ok);
    assert.equal(failed && !failed.ok ? failed.code : '', 'LOCKED');
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-06-10').rows.map((r) => r.periodKey), ['2026-05']);
    k.t.close();
  });

  it('skips, undoes a skip, pauses and resumes; amount override for one occurrence and for the template', () => {
    const { k, rentVoucher } = rentKit();
    const tpl = saveTemplate(k.t.ctx, { name: 'Rent', sourceVoucherId: rentVoucher, frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    k.t.clock.setToday('2026-07-10');
    skipOccurrence(k.t.ctx, tpl.id, '2026-05', 'Rent-free month');
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-07-10').rows.map((r) => r.periodKey), ['2026-06', '2026-07']);
    throwsApp(() => skipOccurrence(k.t.ctx, tpl.id, '2026-05'), 'CONFLICT');
    throwsField(() => skipOccurrence(k.t.ctx, tpl.id, '2026-05-05'), 'periodKey');
    const posted = postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-05' }] });
    assert.match(posted.results[0].ok ? '' : posted.results[0].message, /was skipped/);
    unskipOccurrence(k.t.ctx, tpl.id, '2026-05');
    assert.equal(dueOccurrences(k.t.ctx, '2026-07-10').rows.length, 3);

    setTemplateActive(k.t.ctx, tpl.id, false);
    assert.equal(dueOccurrences(k.t.ctx, '2026-07-10').rows.length, 0, 'a paused template is not due');
    const paused = postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-06' }] });
    assert.match(paused.results[0].ok ? '' : paused.results[0].message, /paused/);
    setTemplateActive(k.t.ctx, tpl.id, true);

    // One occurrence at ₹27,500 (rent revised), the template unchanged.
    const r = postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-06', amount: 2750000 }] });
    const id = r.results[0].ok ? r.results[0].voucherId : 0;
    assert.deepEqual(
      k.t.db.all<{ amount: number }>('SELECT amount FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id }).map((e) => e.amount),
      [2750000, -2750000],
    );
    assert.equal(getTemplate(k.t.ctx, tpl.id).amount, 2500000);
    // Revise the template itself from July.
    const revised = saveTemplate(k.t.ctx, { id: tpl.id, name: 'Rent', amount: 3000000, frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    assert.equal(revised.amount, 3000000);
    assert.equal(occurrenceInput(k.t.ctx, tpl.id, '2026-07').ledgers?.[0].amount, 3000000);
    // History of runs.
    assert.deepEqual(getTemplate(k.t.ctx, tpl.id).runs.map((x) => [x.periodKey, x.status]), [['2026-06', 'posted']]);
    k.t.close();
  });

  it('refuses an amount override on a voucher with several amounts', () => {
    const multi: VoucherInput = { voucherTypeId: 1, date: '2026-04-01', mode: 'ledger', ledgers: [{ ledgerId: 1, amount: 100 }, { ledgerId: 2, amount: 50 }, { ledgerId: 3, amount: -150 }] };
    throwsField(() => applyAmountOverride(multi, 500), 'amount', /more than one amount/);
    const inv: VoucherInput = { voucherTypeId: 1, date: '2026-04-01', mode: 'item_invoice', items: [{ itemId: 1, qty: 2, rate: 10 }] };
    assert.equal(applyAmountOverride(inv, 5000).items?.[0].amount, 5000);
  });

  it('validates templates: name, schedule, manual numbering, cancelled source, physical stock', () => {
    const { k, rentVoucher } = rentKit();
    throwsField(() => saveTemplate(k.t.ctx, { name: ' ', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' }), 'name');
    throwsField(() => saveTemplate(k.t.ctx, { name: 'X', sourceVoucherId: rentVoucher, frequency: 'every_n_days', startDate: '2026-05-05' }), 'intervalDays');
    throwsField(() => saveTemplate(k.t.ctx, { name: 'X', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05', endDate: '2026-05-01' }), 'endDate');
    throwsField(() => saveTemplate(k.t.ctx, { name: 'X', frequency: 'monthly', startDate: '2026-05-05' }), 'sourceVoucherId');
    saveTemplate(k.t.ctx, { name: 'Rent', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' });
    throwsField(() => saveTemplate(k.t.ctx, { name: 'rent', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' }), 'name', /already exists/);
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'manual' WHERE id = :id`, { id: k.vt.journal });
    throwsApp(() => saveTemplate(k.t.ctx, { name: 'Manual', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' }), 'BUSINESS_RULE', /numbered manually/);
    k.t.close();
  });

  it('needs vouchers.create to set up and post, vouchers.delete to delete; templates are audited', () => {
    const { k, rentVoucher } = rentKit();
    const viewer = k.t.ctxAs({ permissions: ['vouchers.view'] });
    throwsApp(() => saveTemplate(viewer, { name: 'Rent', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' }), 'FORBIDDEN');
    const tpl = saveTemplate(k.t.ctx, { name: 'Rent', sourceVoucherId: rentVoucher, frequency: 'monthly', startDate: '2026-05-05' });
    throwsApp(() => postOccurrences(viewer, { items: [{ templateId: tpl.id, periodKey: '2026-05' }] }), 'FORBIDDEN');
    const clerk = k.t.ctxAs({ role: 'Data Entry' });
    throwsApp(() => deleteTemplate(clerk, tpl.id), 'FORBIDDEN');
    deleteTemplate(k.t.ctx, tpl.id);
    const actions = k.t.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'recurring_template' ORDER BY id`).map((r) => r.action);
    assert.deepEqual(actions, ['create', 'delete']);
    k.t.close();
  });

  it('a recurring sales invoice with an item and every-14-days schedule', () => {
    const k = setupKit({ today: '2026-04-01' });
    const inv = save(k, { voucherTypeId: k.vt.sales, date: '2026-04-01', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 2, rate: 50 }] });
    const tpl = saveTemplate(k.t.ctx, { name: 'Rice supply', sourceVoucherId: inv.id, frequency: 'every_n_days', intervalDays: 14, startDate: '2026-04-15' });
    k.t.clock.setToday('2026-04-30');
    const due = dueOccurrences(k.t.ctx, '2026-04-30');
    assert.deepEqual(due.rows.map((r) => r.periodKey), ['2026-04-15', '2026-04-29']);
    const res = postOccurrences(k.t.ctx, { items: due.rows.map((r) => ({ templateId: tpl.id, periodKey: r.periodKey })), acknowledgeWarnings: true });
    assert.equal(res.posted, 2, JSON.stringify(res.results));
    // 2 × ₹50 = ₹100 + 5% GST ₹5 = ₹105 each; numbers continue the sales series (2, 3).
    const rows = k.t.db.all<{ number: string; total_amount: number }>(`SELECT number, total_amount FROM vouchers WHERE base_type = 'sales' ORDER BY id`);
    assert.deepEqual(rows.map((r) => [r.number, r.total_amount]), [['1', 10500], ['2', 10500], ['3', 10500]]);
    k.t.close();
  });
});
