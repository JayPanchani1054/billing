import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import { ledgerBills, statement } from './ledger.ts';
import { creditNote, post, receipt, rs, sale } from './testkit.ts';

let t: TestCompany;
afterEach(() => t?.close());

/**
 * Acme Traders (Karnataka), opening ₹10,000 Dr = bill OB-1.
 *   10-Apr  INV-1  Sales ₹1,00,000 + IGST ₹18,000 = ₹1,18,000 (30 days → due 10-May)
 *   05-May  R-1    Receipt ₹60,000: OB-1 ₹10,000 + INV-1 ₹50,000
 *   20-Jun  INV-2  ₹23,600 (due 20-Jul)
 *   25-Jun  INV-X  optional (ignored)
 *   01-Jul  CN-1   Credit note ₹2,360 against INV-2
 *   01-Aug  R-2    Receipt ₹5,000 on account
 *   02-Aug  J-1    Journal Dr ₹300 (no bill allocation)
 */
function scenario(): { acme: number; inv1: number; r1: number } {
  t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
  const acme = t.addLedger({
    name: 'Acme Traders',
    group: 'SUNDRY_DEBTORS',
    gstin: makeGstin('29'),
    address: '45 Industrial Area\nPhase 2',
    email: 'accounts@acme.example',
    creditDays: 30,
    creditLimit: rs(2_00_000),
    openingBalance: rs(10_000),
    openingBills: [{ name: 'OB-1', date: '2026-03-15', amount: rs(10_000), dueDate: '2026-04-14' }],
    columns: { pincode: '560001', contact_person: 'Mr. Rao' },
  });
  const inv1 = post(t, {
    type: 'sales',
    date: '2026-04-10',
    number: 'INV-1',
    partyLedgerId: acme,
    entries: [
      { ledgerId: acme, amount: rs(1_18_000), bills: [{ ref: 'new', name: 'INV-1', amount: rs(1_18_000), creditDays: 30 }] },
      { ledgerId: t.ids.ledgers.SALES, amount: -rs(1_00_000) },
      { ledgerId: t.ids.ledgers.OUTPUT_IGST, amount: -rs(18_000) },
    ],
  });
  const r1 = receipt(t, acme, {
    date: '2026-05-05',
    no: 'R-1',
    amount: rs(60_000),
    bills: [
      { ref: 'against', name: 'OB-1', amount: rs(10_000) },
      { ref: 'against', name: 'INV-1', amount: rs(50_000) },
    ],
  });
  sale(t, acme, { date: '2026-06-20', no: 'INV-2', amount: rs(23_600), creditDays: 30 });
  sale(t, acme, { date: '2026-06-25', no: 'INV-X', amount: rs(99_999), optional: true });
  creditNote(t, acme, { date: '2026-07-01', no: 'CN-1', amount: rs(2_360), bills: [{ ref: 'against', name: 'INV-2', amount: rs(2_360) }] });
  receipt(t, acme, { date: '2026-08-01', no: 'R-2', amount: rs(5_000) });
  post(t, { type: 'journal', date: '2026-08-02', number: 'J-1', entries: [{ ledgerId: acme, amount: rs(300) }, { ledgerId: t.ids.ledgers.ROUND_OFF, amount: -rs(300) }] });
  return { acme, inv1, r1 };
}

describe('outstanding.ledgerBills', () => {
  it('lists pending bills with their full history and running pending', () => {
    const { acme, inv1, r1 } = scenario();
    const r = ledgerBills(t.db, t.today, { ledgerId: acme, asOf: '2026-09-30' });
    assert.equal(r.method, 'bill_wise');
    assert.equal(r.ledger.side, 'receivable');
    assert.equal(r.ledger.creditLimit, 2_00_000_00);
    assert.deepEqual(r.bills.map((b) => [b.billName, b.pendingAmount, b.overdueDays]), [
      ['INV-1', 68_000_00, 143], // due 10-May
      ['INV-2', 21_240_00, 72], // due 20-Jul → 30-Sep: 11 + 31 + 30
    ]);
    const inv = r.bills[0];
    assert.equal(inv.voucherId, inv1);
    assert.deepEqual(
      inv.history.map((h) => [h.kind, h.voucherId, h.voucherNumber, h.voucherType, h.baseType, h.date, h.amount, h.runningPending]),
      [
        ['new', inv1, 'INV-1', 'Sales', 'sales', '2026-04-10', 1_18_000_00, 1_18_000_00],
        ['against', r1, 'R-1', 'Receipt', 'receipt', '2026-05-05', -50_000_00, 68_000_00],
      ],
    );
  });

  it('shows settled bills on request and explains the On Account remainder line by line', () => {
    const { acme } = scenario();
    const r = ledgerBills(t.db, t.today, { ledgerId: acme, asOf: '2026-09-30', includeSettled: true });
    const ob = r.bills.find((b) => b.billName === 'OB-1');
    assert.ok(ob);
    assert.equal(ob.refType, 'opening');
    assert.deepEqual(ob.history.map((h) => [h.kind, h.amount, h.runningPending]), [['opening', 10_000_00, 10_000_00], ['against', -10_000_00, 0]]);
    // Balance: 10,000 + 1,18,000 − 60,000 + 23,600 − 2,360 − 5,000 + 300 = 84,540
    assert.equal(r.balance, 84_540_00);
    assert.deepEqual(r.onAccount.lines.map((l) => [l.kind, l.voucherNumber, l.amount]), [['on_account', 'R-2', -5_000_00], ['unallocated', 'J-1', 300_00]]);
    assert.equal(r.onAccount.total, -4_700_00);
    assert.deepEqual(r.totals, { billsPending: 89_240_00, advance: 0, onAccount: -4_700_00, overdue: 89_240_00, balance: 84_540_00 });
  });

  it('breaks a non-bill-wise ledger into FIFO pseudo-bills with the payments applied to them', () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const nbw = t.addLedger({ name: 'Cash Customer', group: 'SUNDRY_DEBTORS', billWise: false, creditDays: 10, openingBalance: rs(1_000) });
    const s1 = sale(t, nbw, { date: '2026-05-01', no: 'S-1', amount: rs(2_000), bills: null });
    const rc = receipt(t, nbw, { date: '2026-05-15', no: 'RC-1', amount: rs(2_500), billWise: false }); // clears opening + 1,500 of S-1
    sale(t, nbw, { date: '2026-06-01', no: 'S-2', amount: rs(4_000), bills: null });
    const r = ledgerBills(t.db, t.today, { ledgerId: nbw, asOf: '2026-09-30' });
    assert.equal(r.method, 'fifo');
    assert.deepEqual(r.bills.map((b) => [b.billName, b.billDate, b.dueDate, b.originalAmount, b.pendingAmount, b.refType]), [
      ['S-1', '2026-05-01', '2026-05-11', 2_000_00, 500_00, 'fifo'],
      ['S-2', '2026-06-01', '2026-06-11', 4_000_00, 4_000_00, 'fifo'],
    ]);
    assert.deepEqual(r.bills[0].history.map((h) => [h.kind, h.voucherId, h.voucherNumber, h.amount, h.runningPending]), [
      ['fifo', s1, 'S-1', 2_000_00, 2_000_00],
      ['against', rc, 'RC-1', -1_500_00, 500_00],
    ]);
    assert.equal(r.onAccount.total, 0);
    assert.equal(r.totals.balance, 4_500_00);
    const all = ledgerBills(t.db, t.today, { ledgerId: nbw, asOf: '2026-09-30', includeSettled: true });
    assert.deepEqual(all.bills.map((b) => [b.billName, b.pendingAmount]), [['Opening Balance', 0], ['S-1', 500_00], ['S-2', 4_000_00]]);
    const plain = ledgerBills(t.db, t.today, { ledgerId: nbw, asOf: '2026-09-30', nonBillWise: 'on_account' });
    assert.deepEqual([plain.method, plain.bills.length, plain.onAccount.total], ['on_account', 0, 4_500_00]);
  });

  it('reports a supplier on the payable side', () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const supp = t.addLedger({ name: 'Shree Suppliers', group: 'SUNDRY_CREDITORS' });
    const r = ledgerBills(t.db, t.today, { ledgerId: supp, asOf: '2026-09-30' });
    assert.deepEqual([r.ledger.side, r.balance, r.bills.length], ['payable', 0, 0]);
  });
});

describe('outstanding.statement', () => {
  it('builds a statement of account with opening, running balance, closing and aged pending bills', () => {
    const { acme, r1 } = scenario();
    const s = statement(t.db, t.today, { ledgerId: acme, from: '2026-05-01', to: '2026-07-31' });
    assert.equal(s.company.name, 'Test Traders Pvt Ltd');
    assert.equal(s.company.stateName, 'Maharashtra');
    assert.deepEqual([s.party.name, s.party.stateName, s.party.pincode, s.party.contactPerson, s.party.address], [
      'Acme Traders',
      'Karnataka',
      '560001',
      'Mr. Rao',
      '45 Industrial Area\nPhase 2',
    ]);
    assert.equal(s.generatedOn, '2026-09-30');
    // Opening on 1-May: 10,000 (opening) + 1,18,000 (INV-1) = 1,28,000 Dr
    assert.equal(s.openingBalance, 1_28_000_00);
    assert.deepEqual(
      s.transactions.map((x) => [x.date, x.voucherType, x.voucherNumber, x.particulars, x.debit, x.credit, x.balance]),
      [
        ['2026-05-05', 'Receipt', 'R-1', 'Cash', 0, 60_000_00, 68_000_00],
        ['2026-06-20', 'Sales', 'INV-2', 'Sales', 23_600_00, 0, 91_600_00],
        ['2026-07-01', 'Credit Note', 'CN-1', 'Sales', 0, 2_360_00, 89_240_00],
      ],
    );
    assert.equal(s.transactions[0].voucherId, r1);
    assert.deepEqual(s.totals, { debit: 23_600_00, credit: 62_360_00 });
    assert.equal(s.closingBalance, 89_240_00);
    // Pending on 31-Jul: INV-1 68,000 due 10-May (82 days → 61–90), INV-2 21,240 due 20-Jul (11 days → 1–30)
    const p = s.pendingBills;
    assert.equal(p.asOf, '2026-07-31');
    assert.deepEqual(p.rows.map((x) => [x.billName, x.pendingAmount, x.overdueDays, x.ageDays, x.bucketIndex]), [
      ['INV-1', 68_000_00, 82, 82, 3],
      ['INV-2', 21_240_00, 11, 11, 1],
    ]);
    assert.deepEqual(p.bucketTotals, [0, 21_240_00, 0, 68_000_00, 0, 0]);
    assert.equal(p.total, s.closingBalance);
    assert.equal(p.onAccount, 0);
  });

  it('picks the largest opposite-side ledger as particulars and includes on-account items in the pending section', () => {
    const { acme } = scenario();
    const s = statement(t.db, t.today, { ledgerId: acme, from: '2026-04-01', to: '2026-09-30' });
    assert.equal(s.openingBalance, 10_000_00);
    assert.equal(s.transactions[0].particulars, 'Sales'); // ₹1,00,000 Sales beats ₹18,000 IGST
    assert.equal(s.transactions.at(-1)?.particulars, 'Round Off');
    assert.equal(s.closingBalance, 84_540_00);
    assert.equal(s.transactions.at(-1)?.balance, 84_540_00);
    assert.equal(s.pendingBills.onAccount, -4_700_00);
    assert.equal(s.pendingBills.bucketTotals.reduce((a, b) => a + b, 0) + s.pendingBills.onAccount + s.pendingBills.advance, 84_540_00);
  });

  it('lists a non-bill-wise party’s pending items FIFO', () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const nbw = t.addLedger({ name: 'Cash Customer', group: 'SUNDRY_DEBTORS', billWise: false });
    sale(t, nbw, { date: '2026-09-01', no: 'S-1', amount: rs(1_000), bills: null });
    sale(t, nbw, { date: '2026-09-20', no: 'S-2', amount: rs(500), bills: null });
    receipt(t, nbw, { date: '2026-09-25', no: 'RC', amount: rs(1_200), billWise: false });
    const s = statement(t.db, t.today, { ledgerId: nbw, from: '2026-09-01', to: '2026-09-30' });
    assert.equal(s.pendingBills.method, 'fifo');
    assert.deepEqual(s.pendingBills.rows.map((x) => [x.billName, x.pendingAmount]), [['S-2', 300_00]]);
    assert.equal(s.closingBalance, 300_00);
  });
});
