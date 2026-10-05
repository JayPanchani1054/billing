import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type {
  AgeingResult,
  DueSoonResult,
  InterestResult,
  LedgerBillsResult,
  OutstandingBillsResult,
  PartySummaryResult,
  RemindersResult,
  StatementResult,
} from '../../../shared/types/outstanding.ts';
import type { PendingBill, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { pendingBills } from '../vouchers/bills.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { ledgerBills } from './ledger.ts';
import { outstandingRoutes } from './routes.ts';
import { creditNote, receipt, rs, sale } from './testkit.ts';

let t: TestCompany;
afterEach(() => t?.close());

const errorOf = async (name: string, input: unknown, session?: ReturnType<TestCompany['sessionAs']>) => {
  const r = await t.call(outstandingRoutes, name, input, session ? { session } : undefined);
  assert.equal(r.ok, false, `${name} should fail`);
  return r.ok ? null : r.error;
};

describe('outstanding routes — dispatcher', () => {
  it('serves every route with reports.view (Data Entry role) and refuses without it', async () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', creditDays: 30, interestRate: 18 });
    sale(t, acme, { date: '2026-06-01', no: 'INV-1', amount: rs(10_000), creditDays: 30 });
    const dataEntry = t.sessionAs({ role: 'Data Entry' });
    const calls: Array<[string, unknown]> = [
      ['outstanding.bills', { side: 'receivable', asOf: '2026-09-30' }],
      ['outstanding.partySummary', { side: 'receivable', asOf: '2026-09-30' }],
      ['outstanding.ledgerBills', { ledgerId: acme, asOf: '2026-09-30' }],
      ['outstanding.ageing', { side: 'receivable', asOf: '2026-09-30' }],
      ['outstanding.interest', { from: '2026-04-01', to: '2026-09-30' }],
      ['outstanding.statement', { ledgerId: acme, from: '2026-04-01', to: '2026-09-30' }],
      ['outstanding.reminders', { asOf: '2026-09-30' }],
      ['outstanding.dueSoon', { side: 'receivable', asOf: '2026-09-30', days: 7 }],
    ];
    assert.deepEqual(Object.keys(outstandingRoutes).sort(), calls.map((c) => c[0]).sort());
    for (const [name, input] of calls) {
      const ok = await t.call(outstandingRoutes, name, input, { session: dataEntry });
      assert.equal(ok.ok, true, `${name}: ${ok.ok ? '' : ok.error.message}`);
      const denied = await errorOf(name, input, t.sessionAs({ permissions: ['vouchers.view'] }));
      assert.equal(denied?.code, 'FORBIDDEN', name);
    }
    for (const r of Object.values(outstandingRoutes)) assert.equal(r.transactional, false);
    const bills = await t.callOk<OutstandingBillsResult>(outstandingRoutes, 'outstanding.bills', { side: 'receivable', asOf: '2026-09-30' });
    assert.equal(bills.totals.pending, 10_000_00);
  });

  it('rejects bad input with messages an accountant understands', async () => {
    t = createTestCompany({ today: '2026-09-30' });
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS' });
    const period = await errorOf('outstanding.statement', { ledgerId: acme, from: '2026-09-30', to: '2026-04-01' });
    assert.deepEqual([period?.code, period?.message], ['VALIDATION', 'The end date must be on or after the start date']);
    const interest = await errorOf('outstanding.interest', { from: '2026-09-30', to: '2026-04-01' });
    assert.equal(interest?.code, 'VALIDATION');
    const buckets = await errorOf('outstanding.ageing', { side: 'receivable', asOf: '2026-09-30', buckets: [60, 30] });
    assert.deepEqual([buckets?.code, buckets?.message], ['VALIDATION', 'Ageing periods must be in increasing order (e.g. 30, 60, 90, 180)']);
    const side = await errorOf('outstanding.bills', { side: 'both', asOf: '2026-09-30' });
    assert.equal(side?.code, 'VALIDATION');
    const date = await errorOf('outstanding.bills', { side: 'receivable', asOf: '2026-02-30' });
    assert.equal(date?.code, 'VALIDATION');
    const rate = await errorOf('outstanding.interest', { from: '2026-04-01', to: '2026-09-30', ratePercent: 0 });
    assert.equal(rate?.code, 'VALIDATION');
    const ledger = await errorOf('outstanding.ledgerBills', { ledgerId: 99_999, asOf: '2026-09-30' });
    assert.equal(ledger?.code, 'NOT_FOUND');
    const group = await errorOf('outstanding.bills', { side: 'receivable', asOf: '2026-09-30', groupId: 99_999 });
    assert.equal(group?.code, 'NOT_FOUND');
  });

  it('agrees with the vouchers module’s pending bills (same filter and netting)', () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const acme = t.addLedger({
      name: 'Acme Traders',
      group: 'SUNDRY_DEBTORS',
      openingBalance: rs(5_000),
      openingBills: [{ name: 'OB-1', date: '2026-03-01', amount: rs(5_000) }],
    });
    sale(t, acme, { date: '2026-04-10', no: 'INV-1', amount: rs(10_000), creditDays: 30 });
    sale(t, acme, { date: '2026-05-10', no: 'INV-2', amount: rs(20_000), creditDays: 30, optional: true });
    receipt(t, acme, { date: '2026-05-01', no: 'R-1', amount: rs(7_000), bills: [{ ref: 'against', name: 'INV-1', amount: rs(4_000) }, { ref: 'advance', name: 'ADV', amount: rs(3_000) }] });
    creditNote(t, acme, { date: '2026-05-02', no: 'CN', amount: rs(1_000), bills: [{ ref: 'against', name: 'OB-1', amount: rs(1_000) }] });
    receipt(t, acme, { date: '2026-10-05', no: 'PDC', amount: rs(6_000), postDated: true, bills: [{ ref: 'against', name: 'INV-1', amount: rs(6_000) }] });
    for (const asOf of ['2026-04-30', '2026-05-01', '2026-09-30', '2026-12-31']) {
      const theirs = pendingBills(t.db, acme, asOf, t.today).map((b: PendingBill) => [b.billName, b.amount, b.originalAmount, b.billDate]);
      const mine = ledgerBills(t.db, t.today, { ledgerId: acme, asOf }).bills.map((b) => [b.billName, b.pendingAmount, b.originalAmount, b.billDate]);
      const sort = (rows: unknown[][]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      assert.deepEqual(sort(mine), sort(theirs), asOf);
    }
  });
});

describe('integration with the posting engine (vouchers.save)', () => {
  const routes = { ...vouchersRoutes, ...outstandingRoutes };

  it('follows a GST invoice through a part receipt, a post-dated cheque and a cancellation', async () => {
    t = createTestCompany({ today: '2026-06-15', booksFrom: '2026-04-01' });
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(1)), creditDays: 30, interestRate: 18 });
    const mixer = t.addStockItem({ name: 'Mixer Grinder', gstRate: 18, hsnSac: '8509', openingQty: 50, openingRate: 600 });
    const vt = t.ids.voucherTypes;
    const save = (input: Record<string, unknown>) => t.callOk<VoucherSaveResult>(routes, 'vouchers.save', { acknowledgeWarnings: true, ...input });

    // 15-Apr: 5 × ₹1,000 + CGST 9% ₹450 + SGST 9% ₹450 = ₹5,900; 30 credit days → due 15-May.
    const inv = await save({ voucherTypeId: vt.sales, date: '2026-04-15', mode: 'item_invoice', partyLedgerId: acme, items: [{ itemId: mixer, qty: 5, rate: 1000 }] });
    assert.equal(inv.totals.grandTotal, 5_900_00);
    const billName = inv.number as string;
    let bills = await t.callOk<OutstandingBillsResult>(routes, 'outstanding.bills', { side: 'receivable', asOf: '2026-06-15' });
    assert.deepEqual(bills.rows.map((r) => [r.billName, r.billDate, r.dueDate, r.pendingAmount, r.overdueDays, r.voucherId]), [
      [billName, '2026-04-15', '2026-05-15', 5_900_00, 31, inv.id], // 15-May → 15-Jun
    ]);

    // 20-May: receipt ₹2,000 against the invoice.
    const rec = await save({
      voucherTypeId: vt.receipt,
      date: '2026-05-20',
      mode: 'ledger',
      ledgers: [
        { ledgerId: t.ids.ledgers.CASH, amount: rs(2_000) },
        { ledgerId: acme, amount: -rs(2_000), billAllocations: [{ refType: 'against', billName, amount: rs(2_000) }] },
      ],
    });
    bills = await t.callOk<OutstandingBillsResult>(routes, 'outstanding.bills', { side: 'receivable', asOf: '2026-06-15' });
    assert.equal(bills.rows[0].pendingAmount, 3_900_00);

    // Interest at the ledger's 18%: (15-May, 20-May] 5 days × 5,900 + (20-May, 15-Jun] 26 days × 3,900
    // = (5,90,000 × 5 + 3,90,000 × 26) × 18 ÷ 36,500 = 1,30,90,000 × 18 ÷ 36,500 = 6,455.3 → ₹64.55
    const interest = await t.callOk<InterestResult>(routes, 'outstanding.interest', { ledgerId: acme, from: '2026-04-01', to: '2026-06-15' });
    assert.deepEqual(interest.rows.map((r) => [r.billName, r.days, r.interest]), [[billName, 31, 64_55]]);

    // 30-Jun: post-dated cheque for the balance — not in the books until 30-Jun.
    await save({
      voucherTypeId: vt.receipt,
      date: '2026-06-30',
      isPostDated: true,
      mode: 'ledger',
      ledgers: [
        { ledgerId: t.ids.ledgers.CASH, amount: rs(3_900) },
        { ledgerId: acme, amount: -rs(3_900), billAllocations: [{ refType: 'against', billName, amount: rs(3_900) }] },
      ],
    });
    let party = await t.callOk<PartySummaryResult>(routes, 'outstanding.partySummary', { side: 'receivable', asOf: '2026-06-30' });
    assert.equal(party.totals.pending, 3_900_00);
    t.clock.setToday('2026-06-30');
    party = await t.callOk<PartySummaryResult>(routes, 'outstanding.partySummary', { side: 'receivable', asOf: '2026-06-30' });
    assert.equal(party.totals.pending, 0);

    // Cancelling the 20-May receipt re-opens ₹2,000 of the bill.
    await t.callOk(routes, 'vouchers.cancel', { id: rec.id, reason: 'Cheque bounced' });
    const lb = await t.callOk<LedgerBillsResult>(routes, 'outstanding.ledgerBills', { ledgerId: acme, asOf: '2026-06-30' });
    assert.deepEqual(lb.bills.map((b) => [b.billName, b.pendingAmount, b.history.length]), [[billName, 2_000_00, 2]]);
    const st = await t.callOk<StatementResult>(routes, 'outstanding.statement', { ledgerId: acme, from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(st.transactions.map((x) => [x.voucherType, x.debit, x.credit, x.balance]), [
      ['Sales', 5_900_00, 0, 5_900_00],
      ['Receipt', 0, 3_900_00, 2_000_00],
    ]);
    assert.equal(st.transactions[0].particulars, 'Sales');
  });

  it('adjusts an advance against a later invoice and ages the result', async () => {
    t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(1)), creditDays: 15 });
    const vt = t.ids.voucherTypes;
    const save = (input: Record<string, unknown>) => t.callOk<VoucherSaveResult>(routes, 'vouchers.save', { acknowledgeWarnings: true, ...input });
    await save({
      voucherTypeId: vt.receipt,
      date: '2026-07-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: t.ids.ledgers.CASH, amount: rs(10_000) },
        { ledgerId: acme, amount: -rs(10_000), billAllocations: [{ refType: 'advance', billName: 'ADV-ACME', amount: rs(10_000) }] },
      ],
    });
    let ag = await t.callOk<AgeingResult>(routes, 'outstanding.ageing', { side: 'receivable', asOf: '2026-07-31' });
    assert.deepEqual([ag.rows[0].advance, ag.rows[0].total], [-10_000_00, -10_000_00]);
    // 01-Aug invoice ₹25,000 (journal-style sale in ledger mode): ₹10,000 against the advance, ₹15,000 new.
    await save({
      voucherTypeId: vt.journal,
      date: '2026-08-01',
      mode: 'ledger',
      ledgers: [
        {
          ledgerId: acme,
          amount: rs(25_000),
          billAllocations: [
            { refType: 'against', billName: 'ADV-ACME', amount: rs(10_000) },
            { refType: 'new', billName: 'J-INV-1', amount: rs(15_000) },
          ],
        },
        { ledgerId: t.ids.ledgers.SALES, amount: -rs(25_000) },
      ],
    });
    ag = await t.callOk<AgeingResult>(routes, 'outstanding.ageing', { side: 'receivable', asOf: '2026-09-30' });
    // New ref due 01-Aug + 15 = 16-Aug → 45 days overdue on 30-Sep → 31–60 bucket.
    assert.deepEqual([ag.rows[0].amounts, ag.rows[0].advance, ag.rows[0].total], [[0, 0, 15_000_00, 0, 0, 0], 0, 15_000_00]);
    const soon = await t.callOk<DueSoonResult>(routes, 'outstanding.dueSoon', { side: 'receivable', asOf: '2026-09-30', days: 30 });
    assert.deepEqual([soon.rows.length, soon.overdue], [0, { amount: 15_000_00, count: 1 }]);
    const rem = await t.callOk<RemindersResult>(routes, 'outstanding.reminders', { asOf: '2026-09-30', minOverdueDays: 30 });
    assert.deepEqual(rem.parties.map((p) => [p.ledgerName, p.tone, p.amountDue]), [['Acme Traders', 'second', 15_000_00]]);
  });
});
