import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { addressLines, buildReminderLetter, reminders, toneFor } from './reminders.ts';
import { purchase, receipt, rs, sale } from './testkit.ts';

let t: TestCompany;
afterEach(() => t?.close());

/** Debtors on 30-Sep-2026 (credit days 0 unless stated, so due date = bill date). */
function scenario(): Record<string, number> {
  t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
  t.db.run(`UPDATE company SET phone = '022-4000 1234', email = 'accounts@testtraders.example' WHERE id = 1`);
  const d = (name: string, extra: Record<string, string> = {}): number =>
    t.addLedger({ name, group: 'SUNDRY_DEBTORS', creditDays: 0, email: `${name.split(' ')[0].toLowerCase()}@example.com`, columns: extra });
  const ids = {
    acme: d('Acme Traders', { contact_person: 'Mr. Rao', address: '45 Industrial Area\nPhase 2', state_code: '29', pincode: '560001' }),
    bharat: d('Bharat Stores'),
    chetan: d('Chetan Enterprises'),
    deepak: d('Deepak & Sons'),
    eshwar: d('Eshwar Agencies'),
  };
  sale(t, ids.acme, { date: '2026-09-10', no: 'A-1', amount: rs(11_800) }); // 20 days overdue
  sale(t, ids.acme, { date: '2026-09-25', no: 'A-2', amount: rs(5_000), creditDays: 30 }); // not due
  sale(t, ids.bharat, { date: '2026-08-16', no: 'B-1', amount: rs(50_000) }); // 45 days
  sale(t, ids.bharat, { date: '2026-09-20', no: 'B-2', amount: rs(5_000) }); // 10 days
  sale(t, ids.chetan, { date: '2026-06-22', no: 'C-1', amount: 1_23_456_78 }); // 100 days
  receipt(t, ids.chetan, { date: '2026-09-01', no: 'RC-1', amount: 23_456_78 }); // on account
  sale(t, ids.deepak, { date: '2026-09-10', no: 'D-1', amount: rs(10_000) }); // 20 days, but…
  receipt(t, ids.deepak, { date: '2026-09-12', no: 'RD-1', amount: rs(10_000), bills: [{ ref: 'advance', name: 'ADV', amount: rs(10_000) }] }); // …covered
  sale(t, ids.eshwar, { date: '2026-09-27', no: 'E-1', amount: rs(1_000) }); // 3 days
  const supp = t.addLedger({ name: 'Shree Suppliers', group: 'SUNDRY_CREDITORS' });
  purchase(t, supp, { date: '2026-06-01', no: 'SS-1', amount: rs(9_999), creditDays: 0 }); // payable — never a reminder
  return ids;
}

describe('outstanding.reminders', () => {
  it('selects debtors with bills overdue ≥ minOverdueDays whose unadjusted credits do not cover them', () => {
    scenario();
    const r = reminders(t.db, t.today, { asOf: '2026-09-30', minOverdueDays: 7 });
    assert.deepEqual(
      r.parties.map((p) => [p.ledgerName, p.tone, p.oldestOverdueDays, p.totalOverdue, p.unadjustedCredits, p.amountDue]),
      [
        ['Acme Traders', 'gentle', 20, 11_800_00, 0, 11_800_00],
        ['Bharat Stores', 'second', 45, 55_000_00, 0, 55_000_00],
        ['Chetan Enterprises', 'firm', 100, 1_23_456_78, -23_456_78, 1_00_000_00],
      ],
    );
    assert.deepEqual(r.parties[1].overdueBills.map((b) => [b.billName, b.overdueDays]), [['B-1', 45], ['B-2', 10]]);
    assert.deepEqual(r.totals, { partyCount: 3, amountDue: 1_66_800_00 });
    // Default minOverdueDays = 1 brings in Eshwar (3 days overdue).
    assert.deepEqual(reminders(t.db, t.today, { asOf: '2026-09-30' }).parties.map((p) => p.ledgerName), [
      'Acme Traders',
      'Bharat Stores',
      'Chetan Enterprises',
      'Eshwar Agencies',
    ]);
    assert.deepEqual(reminders(t.db, t.today, { asOf: '2026-09-30', minOverdueDays: 46 }).parties.map((p) => p.ledgerName), ['Chetan Enterprises']);
  });

  it('writes a polite letter with company and party details, Indian-format amounts and the bills table', () => {
    scenario();
    const acme = reminders(t.db, t.today, { asOf: '2026-09-30', minOverdueDays: 7 }).parties[0];
    const l = acme.letter;
    assert.equal(l.date, '30-Sep-2026');
    assert.deepEqual(l.from.slice(0, 3), ['Test Traders Pvt Ltd', '12 MG Road', 'Maharashtra - 400001']);
    assert.deepEqual(l.to, ['To,', 'Acme Traders', '45 Industrial Area', 'Phase 2', 'Karnataka - 560001']);
    assert.equal(l.subject, 'Payment reminder: overdue bill — ₹ 11,800.00');
    assert.equal(l.salutation, 'Dear Mr. Rao,');
    assert.deepEqual(l.table.columns, ['Bill No.', 'Bill Date', 'Due Date', 'Overdue (days)', 'Amount (₹)']);
    assert.deepEqual(l.table.rows, [['A-1', '10-Sep-2026', '10-Sep-2026', '20', '11,800.00']]);
    assert.deepEqual(l.table.total, ['Total overdue', '', '', '', '11,800.00']);
    assert.match(l.text, /^Test Traders Pvt Ltd\n12 MG Road\nMaharashtra - 400001\nGSTIN: 27/);
    assert.match(l.text, /gentle reminder/);
    assert.match(l.text, /please contact us at 022-4000 1234 or accounts@testtraders\.example\./);
    assert.match(l.text, /Yours faithfully,\nFor Test Traders Pvt Ltd\n\n\nAuthorised Signatory\n$/);
    assert.doesNotMatch(l.text, /</); // plain text, no markup
    assert.equal(acme.email, 'acme@example.com');
  });

  it('mentions unadjusted credits and asks only for the net amount (firm tone)', () => {
    scenario();
    const chetan = reminders(t.db, t.today, { asOf: '2026-09-30', minOverdueDays: 7 }).parties.find((p) => p.ledgerName === 'Chetan Enterprises');
    assert.ok(chetan);
    assert.equal(chetan.letter.subject, 'Request for payment of overdue bill — ₹ 1,00,000.00');
    assert.ok(chetan.letter.closing[0].includes('₹ 23,456.78 received from you in advance, on account or as credit notes'));
    assert.ok(chetan.letter.closing[0].includes('the net amount due is ₹ 1,00,000.00'));
    assert.ok(chetan.letter.closing[1].includes('within 7 days'));
    assert.deepEqual(chetan.letter.table.rows, [['C-1', '22-Jun-2026', '22-Jun-2026', '100', '1,23,456.78']]);
  });

  it('picks the tone from the oldest overdue bill and renders an aligned plain-text table', () => {
    assert.deepEqual([1, 30, 31, 60, 61].map(toneFor), ['gentle', 'gentle', 'second', 'second', 'firm']);
    assert.deepEqual(addressLines('  Line 1 \n\n Line 2', '27', ' 400001 '), ['Line 1', 'Line 2', 'Maharashtra - 400001']);
    assert.deepEqual(addressLines(null, null, null), []);
    const l = buildReminderLetter({
      company: { name: 'Shah & Co', address: null, stateCode: null, pincode: null, phone: null, mobile: null, email: null, gstin: null },
      party: { name: 'Patel Bros', mailingName: 'Patel Brothers', address: null, stateCode: null, pincode: null, contactPerson: null, gstin: null },
      date: '2026-10-01',
      asOf: '2026-09-30',
      bills: [
        { billName: 'S/1', billDate: '2026-07-01', dueDate: '2026-07-31', pendingAmount: 1_00_000_00, overdueDays: 61 },
        { billName: 'S/22', billDate: '2026-08-01', dueDate: '2026-08-31', pendingAmount: 5_00, overdueDays: 30 },
      ],
      totalOverdue: 1_00_005_00,
      unadjustedCredits: 0,
      amountDue: 1_00_005_00,
      tone: 'firm',
      oldestOverdueDays: 61,
    });
    assert.equal(l.salutation, 'Dear Sir/Madam,');
    assert.deepEqual(l.to, ['To,', 'Patel Brothers']);
    assert.equal(l.subject, 'Request for payment of overdue bills — ₹ 1,00,005.00');
    const table = [
      'Bill No.       Bill Date    Due Date     Overdue (days)   Amount (₹)',
      '-------------  -----------  -----------  --------------  -----------',
      'S/1            01-Jul-2026  31-Jul-2026              61  1,00,000.00',
      'S/22           01-Aug-2026  31-Aug-2026              30         5.00',
      '-------------  -----------  -----------  --------------  -----------',
      'Total overdue                                            1,00,005.00',
    ].join('\n');
    assert.ok(l.text.includes(table), l.text);
    assert.ok(!l.closing.some((p) => p.includes('contact us at'))); // no contact details on the company
  });
});
