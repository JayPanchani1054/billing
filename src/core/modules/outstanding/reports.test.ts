import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTestCompany, type TestCompany, type TestLedgerSpec } from '../../testing/fixtures.ts';
import { makeBuckets, bucketIndex } from './ageing.ts';
import { fifoSettle, fifoSlices, loadParties, loadScope, type FifoItem } from './engine.ts';
import { ageing, dueSoon, outstandingBills, partySummary } from './reports.ts';
import { creditNote, payment, post, purchase, receipt, rs, sale } from './testkit.ts';

const TODAY = '2026-09-30';
let t: TestCompany;
afterEach(() => t?.close());

function company(opts: { today?: string; billWise?: boolean } = {}): TestCompany {
  t = createTestCompany({ today: opts.today ?? TODAY, booksFrom: '2026-04-01', features: { billWise: opts.billWise ?? true } });
  return t;
}
const debtor = (name: string, extra: Partial<TestLedgerSpec> = {}): number => t.addLedger({ name, group: 'SUNDRY_DEBTORS', creditDays: 30, ...extra });
const creditor = (name: string, extra: Partial<TestLedgerSpec> = {}): number => t.addLedger({ name, group: 'SUNDRY_CREDITORS', creditDays: 45, ...extra });

const bills = (input: Partial<Parameters<typeof outstandingBills>[2]> = {}) =>
  outstandingBills(t.db, t.today, { side: 'receivable', asOf: TODAY, ...input });

describe('outstanding.bills — receivables', () => {
  it('lists an unpaid sales bill with bill date, due date (stored), overdue days and the voucher', () => {
    company();
    const acme = debtor('Acme Traders');
    const vid = sale(t, acme, { date: '2026-04-10', no: 'INV-001', amount: rs(1_18_000), creditDays: 30 });
    const r = bills();
    assert.equal(r.rows.length, 1);
    const b = r.rows[0];
    assert.equal(b.ledgerName, 'Acme Traders');
    assert.equal(b.groupName, 'Sundry Debtors');
    assert.equal(b.billName, 'INV-001');
    assert.equal(b.billDate, '2026-04-10');
    assert.equal(b.dueDate, '2026-05-10'); // 10-Apr + 30 days
    assert.equal(b.creditDays, 30);
    assert.equal(b.originalAmount, 1_18_000_00);
    assert.equal(b.pendingAmount, 1_18_000_00);
    // 10-May → 30-Sep: 21 (May) + 30 + 31 + 31 + 30 = 143 days
    assert.equal(b.overdueDays, 143);
    assert.equal(b.refType, 'new');
    assert.equal(b.voucherId, vid);
    assert.deepEqual(r.totals, { pending: 1_18_000_00, overdue: 1_18_000_00, notDue: 0, advance: 0, onAccount: 0, billCount: 1, overdueCount: 1 });
  });

  it('reduces the bill by a partial receipt against it and drops it once fully settled', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-04-10', no: 'INV-001', amount: rs(1_18_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-05-20', no: 'R-1', amount: rs(50_000), bills: [{ ref: 'against', name: 'INV-001', amount: rs(50_000) }] });
    let r = bills();
    assert.equal(r.rows[0].pendingAmount, 68_000_00); // 1,18,000 − 50,000
    assert.equal(r.rows[0].originalAmount, 1_18_000_00);

    receipt(t, acme, { date: '2026-09-15', no: 'R-2', amount: rs(68_000), bills: [{ ref: 'against', name: 'INV-001', amount: rs(68_000) }] });
    r = bills();
    assert.equal(r.rows.length, 0);
    assert.equal(r.totals.pending, 0);
    assert.equal(partySummary(t.db, t.today, { side: 'receivable', asOf: TODAY }).rows.length, 0);
  });

  it('shows an advance separately until the invoice adjusts it', () => {
    company();
    const acme = debtor('Acme Traders');
    receipt(t, acme, { date: '2026-06-01', no: 'R-ADV', amount: rs(20_000), bills: [{ ref: 'advance', name: 'ADV-1', amount: rs(20_000) }] });
    let r = bills({ asOf: '2026-06-30' });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].refType, 'advance');
    assert.equal(r.rows[0].pendingAmount, -20_000_00); // in the customer's favour
    assert.equal(r.rows[0].dueDate, null);
    assert.equal(r.rows[0].overdueDays, 0);
    assert.equal(r.totals.advance, -20_000_00);
    assert.equal(r.totals.billCount, 0);

    // Invoice of ₹50,000: ₹20,000 against the advance, ₹30,000 new bill.
    sale(t, acme, {
      date: '2026-07-01',
      no: 'INV-7',
      amount: rs(50_000),
      bills: [
        { ref: 'against', name: 'ADV-1', amount: rs(20_000) },
        { ref: 'new', name: 'INV-7', amount: rs(30_000), creditDays: 30 },
      ],
    });
    r = bills();
    assert.deepEqual(
      r.rows.map((x) => [x.billName, x.pendingAmount, x.refType]),
      [['INV-7', 30_000_00, 'new']],
    );
    assert.equal(r.totals.advance, 0);
    // As of before the invoice, the advance is still open.
    assert.equal(bills({ asOf: '2026-06-30' }).totals.advance, -20_000_00);
  });

  it('reports an on-account receipt as one On Account line per party; Σ lines = ledger balance', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-08-01', no: 'INV-1', amount: rs(1_00_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-08-20', no: 'R-1', amount: rs(40_000) }); // on account
    const r = bills();
    const onAcc = r.rows.find((x) => x.refType === 'on_account');
    assert.ok(onAcc);
    assert.equal(onAcc.billName, 'On Account');
    assert.equal(onAcc.pendingAmount, -40_000_00);
    assert.equal(onAcc.billDate, null);
    assert.equal(r.rows.find((x) => x.billName === 'INV-1')?.pendingAmount, 1_00_000_00);
    assert.equal(r.totals.pending, 60_000_00); // 1,00,000 − 40,000 = the ledger's Dr balance
    assert.equal(r.totals.onAccount, -40_000_00);
    // includeOnAccount: false hides the line (but the bill stays).
    assert.deepEqual(bills({ includeOnAccount: false }).rows.map((x) => x.billName), ['INV-1']);
  });

  it('applies a credit note against a bill', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-09-01', no: 'INV-9', amount: rs(59_000), creditDays: 30 });
    creditNote(t, acme, { date: '2026-09-10', no: 'CN-1', amount: rs(5_900), bills: [{ ref: 'against', name: 'INV-9', amount: rs(5_900) }] });
    const r = bills();
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].pendingAmount, 53_100_00); // 59,000 − 5,900
    assert.equal(r.rows[0].overdueDays, 0); // due 01-Oct, not yet due on 30-Sep
    assert.equal(r.totals.notDue, 53_100_00);
  });

  it('includes opening bills (stored due date or bill date + credit days) and puts an unmatched opening balance on account', () => {
    company();
    const acme = debtor('Acme Traders', {
      openingBalance: rs(75_000),
      openingBills: [
        { name: 'OB/101', date: '2026-02-15', amount: rs(40_000), dueDate: '2026-03-15' },
        { name: 'OB/102', date: '2026-03-20', amount: rs(25_000) },
      ],
    });
    const r = bills({ sort: 'bill_date' });
    assert.deepEqual(
      r.rows.map((x) => [x.billName, x.billDate, x.dueDate, x.pendingAmount, x.refType, x.voucherId]),
      [
        ['OB/101', '2026-02-15', '2026-03-15', 40_000_00, 'opening', null],
        ['OB/102', '2026-03-20', '2026-04-19', 25_000_00, 'opening', null], // 20-Mar + 30 credit days
        ['On Account', null, null, 10_000_00, 'on_account', null], // 75,000 − (40,000 + 25,000)
      ],
    );
    receipt(t, acme, { date: '2026-04-25', no: 'R-1', amount: rs(40_000), bills: [{ ref: 'against', name: 'OB/101', amount: rs(40_000) }] });
    assert.deepEqual(bills().rows.map((x) => x.billName), ['OB/102', 'On Account']);
  });

  it('ignores optional and cancelled vouchers', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-09-01', no: 'INV-1', amount: rs(10_000), creditDays: 30 });
    sale(t, acme, { date: '2026-09-02', no: 'INV-OPT', amount: rs(20_000), optional: true });
    sale(t, acme, { date: '2026-09-03', no: 'INV-CXL', amount: rs(30_000), cancelled: true });
    receipt(t, acme, { date: '2026-09-05', no: 'R-OPT', amount: rs(10_000), optional: true, bills: [{ ref: 'against', name: 'INV-1', amount: rs(10_000) }] });
    const r = bills();
    assert.deepEqual(r.rows.map((x) => [x.billName, x.pendingAmount]), [['INV-1', 10_000_00]]);
  });

  it('counts a post-dated receipt only once its date is reached (books filter uses the working date)', () => {
    company({ today: '2026-09-30' });
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-09-01', no: 'INV-1', amount: rs(10_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-10-10', no: 'PDC-1', amount: rs(10_000), postDated: true, bills: [{ ref: 'against', name: 'INV-1', amount: rs(10_000) }] });
    // Even a report "as of" after the cheque date ignores it while today is before that date.
    assert.equal(bills({ asOf: '2026-10-31' }).totals.pending, 10_000_00);
    t.clock.setToday('2026-10-10');
    assert.equal(outstandingBills(t.db, t.today, { side: 'receivable', asOf: '2026-10-31' }).totals.pending, 0);
    // …and not before its own date.
    assert.equal(outstandingBills(t.db, t.today, { side: 'receivable', asOf: '2026-10-09' }).totals.pending, 10_000_00);
  });

  it('cuts off at the as-of date (later bills and receipts are ignored)', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-06-01', no: 'INV-1', amount: rs(10_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-07-15', no: 'R-1', amount: rs(4_000), bills: [{ ref: 'against', name: 'INV-1', amount: rs(4_000) }] });
    sale(t, acme, { date: '2026-08-01', no: 'INV-2', amount: rs(7_000), creditDays: 30 });
    assert.deepEqual(bills({ asOf: '2026-05-31' }).rows, []);
    assert.deepEqual(bills({ asOf: '2026-07-14' }).rows.map((x) => [x.billName, x.pendingAmount, x.overdueDays]), [['INV-1', 10_000_00, 13]]); // due 01-Jul
    assert.deepEqual(bills({ asOf: '2026-07-15' }).rows.map((x) => [x.billName, x.pendingAmount]), [['INV-1', 6_000_00]]);
    assert.deepEqual(bills({ asOf: '2026-08-01' }).rows.map((x) => x.billName), ['INV-1', 'INV-2']);
  });

  it('falls back to the ledger credit days when the allocation has no due date', () => {
    company();
    const acme = debtor('Acme Traders', { creditDays: 15 });
    sale(t, acme, { date: '2026-09-01', no: 'INV-1', amount: rs(1_000) }); // no credit days / due date on the allocation
    const b = bills().rows[0];
    assert.equal(b.dueDate, '2026-09-16');
    assert.equal(b.creditDays, 15);
    assert.equal(b.overdueDays, 14); // 16-Sep → 30-Sep
  });

  it('filters overdue bills (overdueOnly, minOverdueDays), searches and sorts', () => {
    company();
    const acme = debtor('Acme Traders');
    const bharat = debtor('Bharat Stores', { alias: 'BS' });
    sale(t, acme, { date: '2026-06-01', no: 'A-1', amount: rs(5_000), creditDays: 30 }); // due 01-Jul → 91 days
    sale(t, acme, { date: '2026-09-20', no: 'A-2', amount: rs(9_000), creditDays: 30 }); // not due
    sale(t, bharat, { date: '2026-08-01', no: 'B-1', amount: rs(7_000), creditDays: 30 }); // due 31-Aug → 30 days
    assert.deepEqual(bills({ overdueOnly: true }).rows.map((x) => x.billName), ['A-1', 'B-1']);
    assert.deepEqual(bills({ minOverdueDays: 31 }).rows.map((x) => x.billName), ['A-1']);
    assert.deepEqual(bills({ minOverdueDays: 30 }).rows.map((x) => x.billName), ['A-1', 'B-1']);
    assert.deepEqual(bills({ search: 'bs' }).rows.map((x) => x.billName), ['B-1']); // alias
    assert.deepEqual(bills({ search: 'a-2' }).rows.map((x) => x.billName), ['A-2']); // bill name
    assert.deepEqual(bills({ sort: 'amount' }).rows.map((x) => x.billName), ['A-2', 'B-1', 'A-1']);
    assert.deepEqual(bills({ sort: 'overdue' }).rows.map((x) => x.overdueDays), [91, 30, 0]);
    assert.deepEqual(bills({ sort: 'due_date' }).rows.map((x) => x.billName), ['A-1', 'B-1', 'A-2']);
    assert.deepEqual(bills({ sort: 'party' }).rows.map((x) => x.billName), ['A-1', 'A-2', 'B-1']);
    assert.equal(bills({ overdueOnly: true }).totals.overdue, 12_000_00);
  });

  it('pages with limit/offset while totals cover every matching row', () => {
    company();
    const acme = debtor('Acme Traders');
    for (let i = 1; i <= 5; i++) sale(t, acme, { date: `2026-09-0${i}`, no: `INV-${i}`, amount: rs(1_000 * i), creditDays: 30 });
    const r = bills({ limit: 2, offset: 2 });
    assert.deepEqual(r.rows.map((x) => x.billName), ['INV-3', 'INV-4']);
    assert.equal(r.total, 5);
    assert.equal(r.totals.pending, 15_000_00); // 1+2+3+4+5 thousand
  });

  it('restricts to a sub-group or a ledger', () => {
    company();
    const now = new Date().toISOString();
    const subId = t.db.run(
      `INSERT INTO groups (guid, name, parent_id, nature, created_at, updated_at) VALUES ('g-north', 'Debtors North', :p, 'assets', :ts, :ts)`,
      { p: t.ids.groups.SUNDRY_DEBTORS, ts: now },
    ).lastInsertRowid;
    const north = t.addLedger({ name: 'North Co', group: 'SUNDRY_DEBTORS', columns: { group_id: subId, maintain_bill_wise: 1 } });
    const acme = debtor('Acme Traders');
    sale(t, north, { date: '2026-09-01', no: 'N-1', amount: rs(1_000), creditDays: 30 });
    sale(t, acme, { date: '2026-09-01', no: 'A-1', amount: rs(2_000), creditDays: 30 });
    assert.deepEqual(bills().rows.map((x) => x.billName), ['A-1', 'N-1']); // sub-group is under Sundry Debtors
    assert.deepEqual(bills({ groupId: subId }).rows.map((x) => [x.billName, x.groupName]), [['N-1', 'Debtors North']]);
    assert.deepEqual(bills({ ledgerId: acme }).rows.map((x) => x.billName), ['A-1']);
    assert.deepEqual(bills({ ledgerId: acme, groupId: subId }).rows, []);
  });
  it('matches README example 3.1 (bills, advance adjusted by a later invoice, on account)', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-04-10', no: 'INV-001', amount: rs(1_18_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-05-20', no: 'R-1', amount: rs(50_000), bills: [{ ref: 'against', name: 'INV-001', amount: rs(50_000) }] });
    receipt(t, acme, { date: '2026-06-01', no: 'R-2', amount: rs(20_000), bills: [{ ref: 'advance', name: 'ADV-1', amount: rs(20_000) }] });
    sale(t, acme, {
      date: '2026-07-01',
      no: 'INV-7',
      amount: rs(50_000),
      bills: [
        { ref: 'against', name: 'ADV-1', amount: rs(20_000) },
        { ref: 'new', name: 'INV-7', amount: rs(30_000), creditDays: 30 },
      ],
    });
    receipt(t, acme, { date: '2026-08-20', no: 'R-3', amount: rs(40_000) });
    const r = bills();
    assert.deepEqual(r.rows.map((x) => [x.billName, x.dueDate, x.pendingAmount, x.overdueDays]), [
      ['INV-001', '2026-05-10', 68_000_00, 143],
      ['INV-7', '2026-07-31', 30_000_00, 61], // 31-Jul → 30-Sep: 31 + 30
      ['On Account', null, -40_000_00, 0],
    ]);
    const p = partySummary(t.db, t.today, { side: 'receivable', asOf: TODAY }).rows[0];
    assert.deepEqual([p.pending, p.overdue, p.advance, p.onAccount], [58_000_00, 98_000_00, 0, -40_000_00]);
  });
});

describe('outstanding.bills — payables and scope', () => {
  it('mirrors receivables for suppliers (payable amounts positive)', () => {
    company();
    const supp = creditor('Shree Suppliers');
    purchase(t, supp, { date: '2026-07-01', no: 'SS/88', amount: rs(2_36_000), creditDays: 45 }); // due 15-Aug
    payment(t, supp, { date: '2026-08-10', no: 'P-1', amount: rs(1_00_000), bills: [{ ref: 'against', name: 'SS/88', amount: rs(1_00_000) }] });
    const r = outstandingBills(t.db, t.today, { side: 'payable', asOf: TODAY });
    assert.deepEqual(
      r.rows.map((x) => [x.billName, x.dueDate, x.originalAmount, x.pendingAmount, x.overdueDays]),
      [['SS/88', '2026-08-15', 2_36_000_00, 1_36_000_00, 46]], // 15-Aug → 30-Sep = 16 + 30
    );
    assert.deepEqual(bills().rows, []); // not a receivable
  });

  it('shows a debtor with an advance (Cr) as a negative receivable, and a supplier advance as a negative payable', () => {
    company();
    const acme = debtor('Acme Traders');
    const supp = creditor('Shree Suppliers');
    receipt(t, acme, { date: '2026-09-01', no: 'R-1', amount: rs(5_000), bills: [{ ref: 'advance', name: 'ADV-A', amount: rs(5_000) }] });
    payment(t, supp, { date: '2026-09-01', no: 'P-1', amount: rs(8_000), bills: [{ ref: 'advance', name: 'ADV-S', amount: rs(8_000) }] });
    assert.equal(bills().totals.advance, -5_000_00);
    const pay = outstandingBills(t.db, t.today, { side: 'payable', asOf: TODAY });
    assert.deepEqual(pay.rows.map((x) => [x.ledgerName, x.pendingAmount]), [['Shree Suppliers', -8_000_00]]);
  });

  it('adds bill-wise ledgers outside debtors/creditors to the side of their balance', () => {
    company();
    const loan = t.addLedger({ name: 'Staff Advance - Ravi', group: 'LOANS_ADVANCES_ASSET', billWise: true });
    const dep = t.addLedger({ name: 'Security Deposit Recd', group: 'CURRENT_LIABILITIES', billWise: true });
    const notBw = t.addLedger({ name: 'Electricity Deposit', group: 'DEPOSITS_ASSET' });
    post(t, {
      type: 'payment',
      date: '2026-09-01',
      number: 'P-1',
      entries: [
        { ledgerId: loan, amount: rs(15_000), bills: [{ ref: 'new', name: 'ADV/RAVI/1', amount: rs(15_000) }] },
        { ledgerId: notBw, amount: rs(3_000) },
        { ledgerId: t.ids.ledgers.CASH, amount: -rs(18_000) },
      ],
    });
    post(t, {
      type: 'receipt',
      date: '2026-09-02',
      number: 'R-1',
      entries: [
        { ledgerId: t.ids.ledgers.CASH, amount: rs(50_000) },
        { ledgerId: dep, amount: -rs(50_000), bills: [{ ref: 'new', name: 'DEP-1', amount: rs(50_000) }] },
      ],
    });
    assert.deepEqual(bills().rows.map((x) => [x.ledgerName, x.pendingAmount]), [['Staff Advance - Ravi', 15_000_00]]);
    const pay = outstandingBills(t.db, t.today, { side: 'payable', asOf: TODAY });
    assert.deepEqual(pay.rows.map((x) => [x.ledgerName, x.pendingAmount]), [['Security Deposit Recd', 50_000_00]]);
    // An explicit group lists its ledgers regardless of sign.
    const grp = outstandingBills(t.db, t.today, { side: 'payable', asOf: TODAY, groupId: t.ids.groups.LOANS_ADVANCES_ASSET });
    assert.deepEqual(grp.rows.map((x) => [x.ledgerName, x.pendingAmount]), [['Staff Advance - Ravi', -15_000_00]]);
  });

  it('reports a party that is not maintained bill-wise as one On Account line equal to its balance', () => {
    company();
    const walkin = debtor('Walk-in Credit', { billWise: false, openingBalance: rs(2_000) });
    sale(t, walkin, { date: '2026-09-01', no: 'INV-1', amount: rs(5_000), bills: null });
    receipt(t, walkin, { date: '2026-09-10', no: 'R-1', amount: rs(1_500), billWise: false });
    const r = bills();
    assert.deepEqual(
      r.rows.map((x) => [x.billName, x.pendingAmount, x.refType, x.billWise, x.overdueDays]),
      [['On Account', 5_500_00, 'on_account', false, 0]], // 2,000 + 5,000 − 1,500
    );
    assert.deepEqual(bills({ overdueOnly: true }).rows, []);
  });

  it('ages a non-bill-wise balance FIFO against the most recent debits (option nonBillWise: fifo)', () => {
    company();
    const walkin = debtor('Walk-in Credit', { billWise: false, creditDays: 15, openingBalance: rs(3_000) });
    sale(t, walkin, { date: '2026-07-01', no: 'INV-1', amount: rs(4_000), bills: null });
    sale(t, walkin, { date: '2026-08-01', no: 'INV-2', amount: rs(6_000), bills: null });
    receipt(t, walkin, { date: '2026-08-20', no: 'R-1', amount: rs(9_000), billWise: false });
    sale(t, walkin, { date: '2026-09-10', no: 'INV-3', amount: rs(2_500), bills: null });
    // Balance 3,000 + 4,000 + 6,000 − 9,000 + 2,500 = 6,500 Dr = INV-3 2,500 + INV-2 4,000 (of 6,000).
    const r = bills({ nonBillWise: 'fifo' });
    assert.deepEqual(
      r.rows.map((x) => [x.billName, x.billDate, x.dueDate, x.originalAmount, x.pendingAmount, x.overdueDays, x.refType]),
      [
        ['INV-2', '2026-08-01', '2026-08-16', 6_000_00, 4_000_00, 45, 'fifo'], // 16-Aug → 30-Sep
        ['INV-3', '2026-09-10', '2026-09-25', 2_500_00, 2_500_00, 5, 'fifo'],
      ],
    );
    assert.equal(r.totals.pending, 6_500_00);
    assert.equal(r.totals.onAccount, 0);
  });

  it('treats every ledger as non-bill-wise when the bill-wise feature is off', () => {
    company({ billWise: false });
    const acme = debtor('Acme Traders', { billWise: true });
    sale(t, acme, { date: '2026-09-01', no: 'INV-1', amount: rs(1_000), creditDays: 30 });
    assert.deepEqual(bills().rows.map((x) => [x.billName, x.billWise, x.pendingAmount]), [['On Account', false, 1_000_00]]);
  });

  it('keeps Σ bills + On Account equal to the ledger balance through a mixed history', () => {
    company();
    const acme = debtor('Acme Traders', { openingBalance: rs(12_000), openingBills: [{ name: 'OB-1', date: '2026-03-01', amount: rs(10_000) }] });
    sale(t, acme, { date: '2026-04-05', no: 'INV-1', amount: rs(30_000), creditDays: 30 });
    receipt(t, acme, { date: '2026-04-20', no: 'R-1', amount: rs(25_000), bills: [{ ref: 'against', name: 'OB-1', amount: rs(10_000) }, { ref: 'against', name: 'INV-1', amount: rs(15_000) }] });
    receipt(t, acme, { date: '2026-05-01', no: 'R-2', amount: rs(3_000), bills: [{ ref: 'advance', name: 'ADV-1', amount: rs(3_000) }] });
    creditNote(t, acme, { date: '2026-05-05', no: 'CN-1', amount: rs(1_000), bills: [{ ref: 'on_account', amount: rs(1_000) }] });
    // A journal without bill allocations on a bill-wise ledger is also "on account".
    post(t, { type: 'journal', date: '2026-05-06', number: 'J-1', entries: [{ ledgerId: acme, amount: rs(700) }, { ledgerId: t.ids.ledgers.ROUND_OFF, amount: -rs(700) }] });
    const [p] = loadParties(t.db, loadScope(t.db, { side: 'receivable', ledgerId: acme }).ledgers, { asOf: TODAY, today: TODAY, nonBillWise: 'on_account' });
    // Balance: 12,000 + 30,000 − 25,000 − 3,000 − 1,000 + 700 = 13,700
    assert.equal(p.balance, 13_700_00);
    const billed = p.bills.reduce((a, b) => a + b.pending, 0);
    assert.deepEqual(p.bills.map((b) => [b.billName, b.pending]), [['INV-1', 15_000_00], ['ADV-1', -3_000_00]]);
    // On account: opening not in bills 2,000 − 1,000 (credit note) + 700 (journal) = 1,700
    assert.equal(p.onAccount, 1_700_00);
    assert.equal(billed + p.onAccount, p.balance);
  });
});

describe('FIFO helpers', () => {
  const item = (date: string, amount: number, label = date): FifoItem => ({ date, amount, voucherId: null, label });

  it('fifoSlices takes the newest same-side items, the oldest one partly', () => {
    const newestFirst = [item('2026-09-10', -500), item('2026-09-01', 300), item('2026-08-01', 700), item('2026-07-01', 1_000)];
    // Balance 1,500 Dr: 300 (01-Sep) + 700 (01-Aug) + 500 of 1,000 (01-Jul).
    assert.deepEqual(fifoSlices(1_500, newestFirst).map((s) => [s.date, s.take]), [['2026-09-01', 300], ['2026-08-01', 700], ['2026-07-01', 500]]);
    // A Cr balance is made of credits.
    assert.deepEqual(fifoSlices(-200, newestFirst).map((s) => [s.date, s.take]), [['2026-09-10', -200]]);
    assert.deepEqual(fifoSlices(0, newestFirst), []);
  });

  it('fifoSettle leaves open exactly the items fifoSlices returns (random histories)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let run = 0; run < 200; run++) {
      const items: FifoItem[] = [];
      let balance = 0;
      for (let i = 0; i < 12; i++) {
        const amount = Math.round((rnd() - 0.4) * 10_000);
        if (amount === 0) continue;
        items.push(item(`2026-04-${String(i + 1).padStart(2, '0')}`, amount));
        balance += amount;
      }
      const open = fifoSettle(items)
        .filter((o) => o.open !== 0)
        .map((o) => [o.item.date, o.open])
        .reverse();
      const slices = fifoSlices(balance, [...items].reverse()).map((s) => [s.date, s.take]);
      assert.deepEqual(open, slices, `run ${run}`);
    }
  });
});

describe('outstanding.partySummary', () => {
  it('summarises each party: overdue / not due / advance / on account, credit-limit utilisation, oldest overdue', () => {
    company();
    const acme = debtor('Acme Traders', { creditLimit: rs(1_00_000) });
    const bharat = debtor('Bharat Stores');
    debtor('Zero Balance Co');
    sale(t, acme, { date: '2026-06-01', no: 'A-1', amount: rs(80_000), creditDays: 30 }); // due 01-Jul → 91 days overdue
    sale(t, acme, { date: '2026-09-15', no: 'A-2', amount: rs(40_000), creditDays: 30 }); // not due
    receipt(t, acme, { date: '2026-09-20', no: 'R-1', amount: rs(5_000) }); // on account
    receipt(t, bharat, { date: '2026-09-01', no: 'R-2', amount: rs(2_000), bills: [{ ref: 'advance', name: 'ADV', amount: rs(2_000) }] });
    const r = partySummary(t.db, t.today, { side: 'receivable', asOf: TODAY });
    assert.deepEqual(r.rows.map((x) => x.ledgerName), ['Acme Traders', 'Bharat Stores']);
    const a = r.rows[0];
    assert.equal(a.pending, 1_15_000_00); // 80,000 + 40,000 − 5,000
    assert.equal(a.billsPending, 1_20_000_00);
    assert.equal(a.overdue, 80_000_00);
    assert.equal(a.notDue, 40_000_00);
    assert.equal(a.onAccount, -5_000_00);
    assert.equal(a.advance, 0);
    assert.equal(a.billCount, 2);
    assert.equal(a.overdueBillCount, 1);
    assert.equal(a.oldestDueDays, 91);
    assert.equal(a.creditLimit, 1_00_000_00);
    assert.equal(a.creditDays, 30);
    assert.equal(a.utilisationPercent, 115); // 1,15,000 ÷ 1,00,000
    assert.equal(a.overLimit, true);
    const b = r.rows[1];
    assert.equal(b.pending, -2_000_00);
    assert.equal(b.advance, -2_000_00);
    assert.equal(b.utilisationPercent, null);
    assert.deepEqual(r.totals, {
      pending: 1_13_000_00,
      billsPending: 1_20_000_00,
      overdue: 80_000_00,
      notDue: 40_000_00,
      advance: -2_000_00,
      onAccount: -5_000_00,
      partyCount: 2,
      overLimitCount: 1,
    });
    assert.equal(partySummary(t.db, t.today, { side: 'receivable', asOf: TODAY, includeZero: true }).rows.length, 3);
    assert.deepEqual(partySummary(t.db, t.today, { side: 'receivable', asOf: TODAY, search: 'bharat' }).rows.map((x) => x.ledgerName), ['Bharat Stores']);
  });
});

describe('outstanding.ageing', () => {
  it('builds labelled buckets for both bases', () => {
    assert.deepEqual(makeBuckets([30, 60, 90, 180], 'due_date').map((b) => b.label), ['Not due', '1–30 days', '31–60 days', '61–90 days', '91–180 days', '> 180 days']);
    assert.deepEqual(makeBuckets([30, 60], 'bill_date').map((b) => [b.label, b.minDays, b.maxDays]), [
      ['Not due', null, 0],
      ['0–30 days', 0, 30],
      ['31–60 days', 31, 60],
      ['> 60 days', 61, null],
    ]);
    const due = makeBuckets([30, 60, 90, 180], 'due_date');
    assert.deepEqual([-5, 0, 1, 30, 31, 60, 61, 90, 91, 180, 181, 5000].map((d) => bucketIndex(d, due)), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('puts bills in buckets by days past due, with exact boundaries (0, 30, 31, 180, 181 days)', () => {
    company();
    const acme = debtor('Acme Traders');
    // creditDays 0 → due on the bill date; ages counted from 30-Sep.
    const at = (daysAgo: number, no: string, amount: number): void => {
      const d = new Date(Date.UTC(2026, 8, 30 - daysAgo)).toISOString().slice(0, 10);
      sale(t, acme, { date: d, no, amount, creditDays: 0 });
    };
    at(0, 'D0', 1); // due today → not due
    at(30, 'D30', 10); // exactly 30 days → 1–30
    at(31, 'D31', 100); // 31–60
    at(90, 'D90', 1_000); // 61–90
    at(180, 'D180', 10_000); // 91–180
    at(181, 'D181', 1_00_000); // > 180
    receipt(t, acme, { date: '2026-09-29', no: 'R', amount: 7 }); // on account
    const r = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY });
    assert.equal(r.basis, 'due_date');
    assert.deepEqual(r.rows[0].amounts, [1, 10, 100, 1_000, 10_000, 1_00_000]);
    assert.equal(r.rows[0].onAccount, -7);
    assert.equal(r.rows[0].total, 1_11_111 - 7);
    assert.deepEqual(r.totals.amounts, [1, 10, 100, 1_000, 10_000, 1_00_000]);
  });

  it('ages from the bill date on the bill-date basis (a 30-day-old bill is in 0–30 even if overdue)', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-08-31', no: 'B30', amount: rs(1_000), creditDays: 10 }); // 30 days old, 20 overdue
    sale(t, acme, { date: '2026-08-30', no: 'B31', amount: rs(2_000), creditDays: 90 }); // 31 days old, not due
    const byBill = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY, basis: 'bill_date' });
    assert.deepEqual(byBill.rows[0].amounts, [0, 1_000_00, 2_000_00, 0, 0, 0]);
    const byDue = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY });
    assert.deepEqual(byDue.rows[0].amounts, [2_000_00, 1_000_00, 0, 0, 0, 0]);
  });

  it('supports custom buckets and keeps advances / on account out of the buckets; totals add up', () => {
    company();
    const acme = debtor('Acme Traders');
    const bharat = debtor('Bharat Stores');
    sale(t, acme, { date: '2026-09-01', no: 'A-1', amount: rs(1_000), creditDays: 0 }); // 29 days
    sale(t, bharat, { date: '2026-07-01', no: 'B-1', amount: rs(5_000), creditDays: 0 }); // 91 days
    receipt(t, bharat, { date: '2026-09-01', no: 'R-1', amount: rs(500), bills: [{ ref: 'advance', name: 'ADV', amount: rs(500) }] });
    receipt(t, acme, { date: '2026-09-02', no: 'R-2', amount: rs(200) });
    const r = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY, buckets: [15, 45] });
    assert.deepEqual(r.buckets.map((b) => b.label), ['Not due', '1–15 days', '16–45 days', '> 45 days']);
    assert.deepEqual(r.rows.map((x) => [x.ledgerName, x.amounts, x.advance, x.onAccount, x.total]), [
      ['Acme Traders', [0, 0, 1_000_00, 0], 0, -200_00, 800_00],
      ['Bharat Stores', [0, 0, 0, 5_000_00], -500_00, 0, 4_500_00],
    ]);
    assert.deepEqual(r.totals, { amounts: [0, 0, 1_000_00, 5_000_00], advance: -500_00, onAccount: -200_00, total: 5_300_00 });
  });

  it('ages non-bill-wise parties FIFO when asked, otherwise keeps them on account', () => {
    company();
    const walkin = debtor('Walk-in Credit', { billWise: false, creditDays: 0 });
    sale(t, walkin, { date: '2026-05-01', no: 'W-1', amount: rs(3_000), bills: null }); // 152 days
    sale(t, walkin, { date: '2026-09-20', no: 'W-2', amount: rs(1_000), bills: null }); // 10 days
    const plain = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY });
    assert.deepEqual([plain.rows[0].amounts, plain.rows[0].onAccount], [[0, 0, 0, 0, 0, 0], 4_000_00]);
    const fifo = ageing(t.db, t.today, { side: 'receivable', asOf: TODAY, nonBillWise: 'fifo' });
    assert.deepEqual([fifo.rows[0].amounts, fifo.rows[0].onAccount], [[0, 1_000_00, 0, 0, 3_000_00, 0], 0]);
  });
});

describe('outstanding.dueSoon', () => {
  it('lists bills falling due within N days (including today) and counts what is already overdue', () => {
    company();
    const acme = debtor('Acme Traders');
    sale(t, acme, { date: '2026-09-30', no: 'TODAY', amount: rs(1_000), creditDays: 0 }); // due today
    sale(t, acme, { date: '2026-09-10', no: 'IN7', amount: rs(2_000), creditDays: 27 }); // due 07-Oct
    sale(t, acme, { date: '2026-09-10', no: 'IN8', amount: rs(4_000), creditDays: 28 }); // due 08-Oct (outside 7 days)
    sale(t, acme, { date: '2026-08-01', no: 'LATE', amount: rs(8_000), creditDays: 30 }); // overdue
    receipt(t, acme, { date: '2026-09-29', no: 'R', amount: rs(16_000), bills: [{ ref: 'advance', name: 'ADV', amount: rs(16_000) }] });
    const r = dueSoon(t.db, t.today, { side: 'receivable', asOf: TODAY, days: 7 });
    assert.equal(r.until, '2026-10-07');
    assert.deepEqual(r.rows.map((x) => [x.billName, x.dueDate, x.daysToDue]), [['TODAY', '2026-09-30', 0], ['IN7', '2026-10-07', 7]]);
    assert.equal(r.amount, 3_000_00);
    assert.equal(r.total, 2);
    assert.deepEqual(r.overdue, { amount: 8_000_00, count: 1 });
    assert.equal(dueSoon(t.db, t.today, { side: 'receivable', asOf: TODAY, days: 7, limit: 1 }).rows.length, 1);
  });
});
