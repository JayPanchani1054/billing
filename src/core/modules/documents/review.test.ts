/**
 * Regression tests from the adversarial review of the documents module. Each test fails if its defect
 * returns:
 *
 *  1. Changing a recurring schedule onto another grid (every-N-days start shifted by a non-multiple of
 *     N; quarterly → monthly) re-opened periods already posted → the same week / quarter posted twice.
 *  2. A long run of dealt-with occurrences (> 2,000, e.g. a daily template over years) hid every later
 *     occurrence: nothing was ever due again and "next due" was blank.
 *  3. An alter of a template without `isActive` silently resumed a paused template.
 *  4. Pre-close with the same item twice failed with a raw SQLite UNIQUE error.
 *  5. Budget variance totals added a ledger line again inside its budgeted group (and cost-centre lines,
 *     which split the same ledger amounts) — totals double-counted.
 *  6. Budget columns gave no basis, so the Trial Balance compared a nett-transactions budget with the
 *     closing balance (opening included).
 *  7. Bills pending counted rejections-in as "challans unbilled over 7 days" (s.31 does not apply).
 *  8. Duplicating a quotation kept the source's "valid until" (an expired date, refused on save) instead
 *     of the same validity length from the new date; likewise a reversing journal's "applicable up to".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duplicateVoucher } from '../vouchers/service.ts';
import { save, setupKit, throwsField, type Kit } from '../vouchers/testkit.ts';
import { billsPending } from './billsPending.ts';
import { budgetColumns, budgetVariance, saveBudget } from './budgets.ts';
import './hook.ts';
import { orderClosures, precloseOrder } from './orders.ts';
import { dueOccurrences, getTemplate, listTemplates, postOccurrences, saveTemplate, setTemplateActive } from './recurring.ts';
import { scheduleShifts, undoneOccurrences } from './schedule.ts';

/** A ₹1.00 journal (Dr Office Rent / Cr Owner Capital) to copy into templates. */
function source(k: Kit, date = '2026-05-01'): number {
  return save(k, { voucherTypeId: k.vt.journal, date, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 100 }, { ledgerId: k.L.capital, amount: -100 }] }).id;
}

describe('documents review: recurring schedule changes never re-open a posted period', () => {
  it('scheduleShifts: only a change of grid shifts the keys', () => {
    const m = { frequency: 'monthly' as const, dayOfMonth: 5, startDate: '2026-05-05' };
    assert.equal(scheduleShifts(m, { ...m, dayOfMonth: 20, startDate: '2026-09-20' }), false, 'monthly keys are months');
    const q = { frequency: 'quarterly' as const, dayOfMonth: 5, startDate: '2026-05-05' };
    assert.equal(scheduleShifts(q, { ...q, startDate: '2026-08-05' }), false, 'one whole quarter later: same phase');
    assert.equal(scheduleShifts(q, { ...q, startDate: '2026-06-05' }), true, 'another phase');
    assert.equal(scheduleShifts(q, { ...q, frequency: 'monthly' }), true);
    const w = { frequency: 'every_n_days' as const, intervalDays: 7, startDate: '2026-05-05' };
    assert.equal(scheduleShifts(w, { ...w, startDate: '2026-05-19' }), false, '14 days = 2 whole intervals');
    assert.equal(scheduleShifts(w, { ...w, startDate: '2026-05-06' }), true);
    assert.equal(scheduleShifts(w, { ...w, intervalDays: 14 }), true);
  });

  it('every 7 days: moving the start by a day after two postings is refused until the next date', () => {
    const k = setupKit({ today: '2026-05-13' });
    const tpl = saveTemplate(k.t.ctx, { name: 'Weekly', sourceVoucherId: source(k), frequency: 'every_n_days', intervalDays: 7, startDate: '2026-05-05' });
    assert.equal(postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-05-05' }, { templateId: tpl.id, periodKey: '2026-05-12' }] }).posted, 2);
    // Before the fix: allowed, and 6-May and 13-May fell due — the weeks of 5-May and 12-May posted twice.
    throwsField(
      () => saveTemplate(k.t.ctx, { id: tpl.id, name: 'Weekly', frequency: 'every_n_days', intervalDays: 7, startDate: '2026-05-06' }),
      'startDate',
      /up to 12-May-2026.*on or after 19-May-2026/,
    );
    // The same grid (a whole number of weeks) is not a shift: nothing posted falls due again.
    saveTemplate(k.t.ctx, { id: tpl.id, name: 'Weekly', frequency: 'every_n_days', intervalDays: 7, startDate: '2026-04-28' });
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-05-13').rows.map((r) => r.periodKey), ['2026-04-28']);
    // From the next date of the current schedule it is accepted.
    saveTemplate(k.t.ctx, { id: tpl.id, name: 'Weekly', frequency: 'every_n_days', intervalDays: 7, startDate: '2026-05-20' });
    k.t.clock.setToday('2026-05-27');
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-05-27').rows.map((r) => r.periodKey), ['2026-05-20', '2026-05-27']);
    k.t.close();
  });

  it('quarterly → monthly: the posted quarter is not billed again month by month', () => {
    const k = setupKit({ today: '2026-05-05' });
    const tpl = saveTemplate(k.t.ctx, { name: 'AMC', sourceVoucherId: source(k), frequency: 'quarterly', dayOfMonth: 5, startDate: '2026-05-05' });
    assert.equal(postOccurrences(k.t.ctx, { items: [{ templateId: tpl.id, periodKey: '2026-05' }] }).posted, 1);
    // Before the fix: allowed, and June and July (inside the May–July quarter already billed) fell due.
    throwsField(() => saveTemplate(k.t.ctx, { id: tpl.id, name: 'AMC', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' }), 'startDate', /on or after 05-Aug-2026/);
    throwsField(() => saveTemplate(k.t.ctx, { id: tpl.id, name: 'AMC', frequency: 'quarterly', dayOfMonth: 5, startDate: '2026-06-05' }), 'startDate', /on or after 05-Aug-2026/);
    saveTemplate(k.t.ctx, { id: tpl.id, name: 'AMC', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-08-05' });
    assert.deepEqual(dueOccurrences(k.t.ctx, '2026-09-30').rows.map((r) => r.periodKey), ['2026-08', '2026-09']);
    k.t.close();
  });

  it('a template with thousands of dealt-with occurrences still shows the next ones', () => {
    const k = setupKit({ today: '2026-01-03' });
    const tpl = saveTemplate(k.t.ctx, { name: 'Daily', sourceVoucherId: source(k, '2026-01-01'), frequency: 'every_n_days', intervalDays: 1, startDate: '2020-01-01' });
    // 2,192 days 1-Jan-2020 … 31-Dec-2025 skipped (more than the old 2,000-occurrence scan).
    k.t.db.run(
      `WITH RECURSIVE d(x) AS (SELECT '2020-01-01' UNION ALL SELECT date(x, '+1 day') FROM d WHERE x < '2025-12-31')
       INSERT INTO recurring_runs (template_id, period_key, scheduled_date, status, created_at) SELECT :t, x, x, 'skipped', 'x' FROM d`,
      { t: tpl.id },
    );
    const due = dueOccurrences(k.t.ctx, '2026-01-03');
    assert.deepEqual(due.rows.map((r) => r.periodKey), ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.equal(due.truncated, false);
    assert.equal(listTemplates(k.t.ctx)[0].nextDate, '2026-01-01');
    // The window walk agrees with a plain filter, and stops at `max`.
    const done = new Set(['2026-01-01']);
    const s = { frequency: 'every_n_days' as const, intervalDays: 1, startDate: '2026-01-01' };
    assert.deepEqual(undoneOccurrences(s, done, '2026-01-04', 2), { list: [{ periodKey: '2026-01-02', date: '2026-01-02' }, { periodKey: '2026-01-03', date: '2026-01-03' }], truncated: true });
    k.t.close();
  });

  it('an alter that does not mention isActive keeps a paused template paused', () => {
    const k = setupKit({ today: '2026-05-05' });
    const tpl = saveTemplate(k.t.ctx, { name: 'Rent', sourceVoucherId: source(k), frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    setTemplateActive(k.t.ctx, tpl.id, false);
    saveTemplate(k.t.ctx, { id: tpl.id, name: 'Rent (Sharma)', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-05-05' });
    assert.equal(getTemplate(k.t.ctx, tpl.id).isActive, false);
    assert.equal(dueOccurrences(k.t.ctx, '2026-06-30').rows.length, 0);
    k.t.close();
  });
});

describe('documents review: pre-close, bills pending, duplicate', () => {
  it('pre-close refuses the same item twice with a field error (no raw database error), nothing written', () => {
    const k = setupKit({ today: '2026-04-15', features: { orderProcessing: true } });
    const so = save(k, { voucherTypeId: k.vt.sales_order, date: '2026-04-02', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 10, rate: 150 }] });
    throwsField(() => precloseOrder(k.t.ctx, { orderId: so.id, reason: 'x', items: [{ itemId: k.I.mixer, qty: 1 }, { itemId: k.I.mixer, qty: 2 }] }), 'items[1].itemId', /listed twice/);
    assert.equal(orderClosures(k.t.db, so.id).length, 0);
    k.t.close();
  });

  it('"unbilled over 7 days" counts delivery / receipt notes, not rejections awaiting a credit note', () => {
    const k = setupKit({ today: '2026-04-20', features: { trackingNumbers: true, rejectionNotes: true } });
    save(k, { voucherTypeId: k.vt.rejection_in, date: '2026-04-02', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 2, rate: 50 }] });
    let r = billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-20' });
    assert.equal(r.rows.length, 1, 'the rejection is listed (it awaits a credit note)');
    assert.equal(r.totals.olderThan7Days, 0, 'but it is not a challan under CGST s.31 / Rule 55');
    save(k, { voucherTypeId: k.vt.delivery_note, date: '2026-04-05', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 3, rate: 50 }] });
    r = billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-20' });
    assert.equal(r.totals.olderThan7Days, 1);
    k.t.close();
  });

  it('duplicating a quotation keeps its validity length from the new date (and a reversing journal its period)', () => {
    const k = setupKit({ today: '2026-05-10' });
    const q = save(k, {
      voucherTypeId: k.vt.quotation,
      date: '2026-04-01',
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      validUntil: '2026-04-15',
      items: [{ itemId: k.I.rice, qty: 1, rate: 50 }],
      acknowledgeWarnings: true,
    });
    const copy = duplicateVoucher(k.t.ctx, q.id);
    assert.deepEqual([copy.date, copy.validUntil], ['2026-05-10', '2026-05-24'], '14 days, as the original');
    assert.ok(save(k, copy).id > 0, 'the copy saves (an expired validity would be refused)');
    const rj = save(k, {
      voucherTypeId: k.vt.reversing_journal,
      date: '2026-04-30',
      mode: 'ledger',
      applicableUpto: '2026-05-15',
      ledgers: [{ ledgerId: k.L.rent, amount: 100 }, { ledgerId: k.L.capital, amount: -100 }],
    });
    assert.equal(duplicateVoucher(k.t.ctx, rj.id).applicableUpto, '2026-05-25');
    k.t.close();
  });
});

describe('documents review: budgets', () => {
  it('variance totals count each amount once; report columns carry the basis per key', () => {
    const k = setupKit({ today: '2026-04-30', features: { costCentres: true } });
    const centre = k.t.db.run(`INSERT INTO cost_centres (guid, name, category_id, created_at, updated_at) VALUES ('cc-r', 'Head Office', :cat, 'x', 'x')`, {
      cat: k.t.ids.costCategoryId,
    }).lastInsertRowid;
    const travel = k.t.addLedger({ name: 'Travel', group: 'INDIRECT_EXPENSES', costCentres: true });
    save(k, { voucherTypeId: k.vt.journal, date: '2026-04-10', mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 1000000 }, { ledgerId: k.L.capital, amount: -1000000 }] });
    save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-04-12',
      mode: 'ledger',
      ledgers: [{ ledgerId: travel, amount: 400000, costAllocations: [{ costCentreId: centre, amount: 400000 }] }, { ledgerId: k.L.capital, amount: -400000 }],
    });
    const g = (code: string) => k.t.ids.groups[code as 'INDIRECT_EXPENSES'];
    const b = saveBudget(k.t.ctx, {
      name: 'April',
      from: '2026-04-01',
      to: '2026-04-30',
      lines: [
        { kind: 'group', refId: g('INDIRECT_EXPENSES'), basis: 'net_transactions', amount: 1500000 },
        { kind: 'ledger', refId: k.L.rent, basis: 'net_transactions', amount: 900000 },
        { kind: 'cost_centre', refId: centre, basis: 'net_transactions', amount: 300000 },
        { kind: 'group', refId: g('SUNDRY_DEBTORS'), basis: 'closing_balance', amount: 500000 },
      ],
    });
    const r = budgetVariance(k.t.ctx, { budgetId: b.id });
    const inTotal = Object.fromEntries(r.rows.map((x) => [x.key, x.inTotal]));
    assert.equal(inTotal[`group:${g('INDIRECT_EXPENSES')}`], true);
    assert.equal(inTotal[`ledger:${k.L.rent}`], false, 'rent is inside Indirect Expenses');
    assert.equal(inTotal[`cost_centre:${centre}`], false, 'cost centres split the same ledger amounts');
    // Budget 15,000 (IE) + 5,000 (debtors target) = ₹20,000; actual 14,000 (rent 10,000 + travel 4,000) + 0 = ₹14,000.
    // Before the fix: budget 15,000 + 9,000 + 3,000 + 5,000 = 32,000 and actual 14,000 + 10,000 + 4,000 = 28,000.
    assert.deepEqual(r.totals, { budget: 2000000, actual: 1400000, variance: -600000 });

    const cols = budgetColumns(k.t.ctx, { budgetId: b.id, from: '2026-04-01', to: '2026-04-30' });
    assert.equal(cols.basisByKey?.[`l:${k.L.rent}`], 'net_transactions');
    assert.equal(cols.basisByKey?.[`g:${g('INDIRECT_EXPENSES')}`], 'net_transactions');
    assert.equal(cols.basisByKey?.[`g:${g('SUNDRY_DEBTORS')}`], 'closing_balance');
    // Primary group rolling up both bases (Indirect Expenses nett under P&L side; debtors closing under assets) —
    // a parent holding lines of both bases is 'mixed'.
    const both = saveBudget(k.t.ctx, {
      name: 'Mixed',
      from: '2026-04-01',
      to: '2026-04-30',
      lines: [
        { kind: 'ledger', refId: k.L.rent, basis: 'net_transactions', amount: 100 },
        { kind: 'ledger', refId: travel, basis: 'closing_balance', amount: 100 },
      ],
    });
    assert.equal(budgetColumns(k.t.ctx, { budgetId: both.id, from: '2026-04-01', to: '2026-04-30' }).basisByKey?.[`g:${g('INDIRECT_EXPENSES')}`], 'mixed');
    k.t.close();
  });
});
