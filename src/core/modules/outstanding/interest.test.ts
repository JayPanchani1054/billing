import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { billInterest, interestReport } from './interest.ts';
import { creditNote, payment, purchase, receipt, rs, sale } from './testkit.ts';

let t: TestCompany;
afterEach(() => t?.close());

function company(): TestCompany {
  t = createTestCompany({ today: '2026-09-30', booksFrom: '2026-04-01' });
  return t;
}

const report = (input: Partial<Parameters<typeof interestReport>[2]> = {}) =>
  interestReport(t.db, t.today, { from: '2026-04-01', to: '2026-06-14', ...input });

describe('billInterest (pure)', () => {
  it('₹1,00,000 overdue 45 days at 18% p.a. = ₹2,219.18', () => {
    // 1,00,00,000 paise × 18 × 45 ÷ 36,500 = 2,21,917.8 → 2,21,918 paise
    const r = billInterest([{ date: '2026-04-01', amount: rs(1_00_000) }], {
      dir: 1,
      interestFrom: '2026-04-30',
      from: '2026-04-01',
      to: '2026-06-14',
      ratePercent: 18,
    });
    assert.equal(r.days, 45);
    assert.equal(r.interest, 2_219_18);
    assert.equal(r.principal, 1_00_000_00);
    assert.deepEqual(r.segments, [{ from: '2026-04-30', to: '2026-06-14', days: 45, balance: 1_00_000_00 }]);
  });

  it('charges a payment day at the old balance and nothing once the balance is nil or in the party’s favour', () => {
    const ev = [
      { date: '2026-04-01', amount: 10_000 },
      { date: '2026-04-11', amount: -10_000 },
      { date: '2026-04-15', amount: -5_000 },
    ];
    const r = billInterest(ev, { dir: 1, interestFrom: '2026-04-01', from: '2026-04-01', to: '2026-04-30', ratePercent: 36.5 });
    // Days 2-Apr … 11-Apr (10 days) at 10,000; nothing after.  10,000 × 10 × 36.5 ÷ 36,500 = 100
    assert.deepEqual(r.segments, [{ from: '2026-04-01', to: '2026-04-11', days: 10, balance: 10_000 }]);
    assert.equal(r.interest, 100);
    assert.equal(r.pendingAtEnd, -5_000);
  });

  it('returns nothing when interest starts after the window', () => {
    const r = billInterest([{ date: '2026-04-01', amount: 10_000 }], { dir: 1, interestFrom: '2026-07-01', from: '2026-04-01', to: '2026-06-30', ratePercent: 18 });
    assert.deepEqual([r.days, r.interest, r.segments], [0, 0, []]);
  });
});

describe('outstanding.interest', () => {
  it('computes the worked example from a real sales bill and the ledger’s own rate', () => {
    company();
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', interestRate: 18 });
    sale(t, acme, { date: '2026-04-01', no: 'INV-1', amount: rs(1_00_000), creditDays: 29 }); // due 30-Apr
    const r = report({ ledgerId: acme });
    assert.equal(r.rows.length, 1);
    const b = r.rows[0];
    assert.deepEqual(
      [b.billName, b.dueDate, b.interestFrom, b.ratePercent, b.principal, b.days, b.interest, b.side],
      ['INV-1', '2026-04-30', '2026-04-30', 18, 1_00_000_00, 45, 2_219_18, 'receivable'],
    );
    assert.deepEqual(r.totals, { receivable: 2_219_18, payable: 0, billCount: 1 });
    assert.equal(r.method, 'simple_365');
  });

  it('splits the period at part-payments (interest up to the payment date, then on the balance)', () => {
    company();
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', interestRate: 18 });
    sale(t, acme, { date: '2026-04-01', no: 'INV-1', amount: rs(1_00_000), creditDays: 29 });
    receipt(t, acme, { date: '2026-05-31', no: 'R-1', amount: rs(40_000), bills: [{ ref: 'against', name: 'INV-1', amount: rs(40_000) }] });
    const b = report({ ledgerId: acme }).rows[0];
    // (30-Apr, 31-May] 31 days × 1,00,000 + (31-May, 14-Jun] 14 days × 60,000
    // = (1,00,00,000 × 31 + 60,00,000 × 14) × 18 ÷ 36,500 = 39,40,00,000 × 18 ÷ 36,500 = 1,94,301.4 → ₹1,943.01
    assert.deepEqual(b.segments, [
      { from: '2026-04-30', to: '2026-05-31', days: 31, balance: 1_00_000_00 },
      { from: '2026-05-31', to: '2026-06-14', days: 14, balance: 60_000_00 },
    ]);
    assert.equal(b.days, 45);
    assert.equal(b.interest, 1_943_01);
    assert.equal(b.pendingAtEnd, 60_000_00);
  });

  it('clips to the report window', () => {
    company();
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', interestRate: 18 });
    sale(t, acme, { date: '2026-04-01', no: 'INV-1', amount: rs(1_00_000), creditDays: 29 });
    const b = report({ ledgerId: acme, from: '2026-06-01' }).rows[0];
    // 1-Jun … 14-Jun = 14 days: 1,00,00,000 × 18 × 14 ÷ 36,500 = 69,041.1 → ₹690.41
    assert.deepEqual([b.days, b.interest, b.principal], [14, 690_41, 1_00_000_00]);
  });

  it('applies grace days and the bill-date basis', () => {
    company();
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', interestRate: 18 });
    sale(t, acme, { date: '2026-04-01', no: 'INV-1', amount: rs(1_00_000), creditDays: 29 });
    // Grace 15 days after 30-Apr → from 15-May: 30 days → 1,00,00,000 × 18 × 30 ÷ 36,500 = 1,47,945.2 → ₹1,479.45
    const g = report({ ledgerId: acme, graceDays: 15 }).rows[0];
    assert.deepEqual([g.interestFrom, g.days, g.interest], ['2026-05-15', 30, 1_479_45]);
    // Bill date 1-Apr → 2-Apr … 14-Jun = 29 + 31 + 14 = 74 days → 1,33,20,00,000 ÷ 36,500 = 3,64,931.5 → ₹3,649.32
    const bd = report({ ledgerId: acme, basis: 'bill_date' }).rows[0];
    assert.deepEqual([bd.interestFrom, bd.days, bd.interest], ['2026-04-01', 74, 3_649_32]);
  });

  it('charges nothing for a bill paid on its due date; a payment dated on the last day still bears that day', () => {
    company();
    const acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', interestRate: 18 });
    sale(t, acme, { date: '2026-04-01', no: 'ONTIME', amount: rs(10_000), creditDays: 10 });
    receipt(t, acme, { date: '2026-04-11', no: 'R-1', amount: rs(10_000), bills: [{ ref: 'against', name: 'ONTIME', amount: rs(10_000) }] });
    sale(t, acme, { date: '2026-04-01', no: 'LATE', amount: rs(36_500), creditDays: 0 });
    receipt(t, acme, { date: '2026-04-11', no: 'R-2', amount: rs(36_500), bills: [{ ref: 'against', name: 'LATE', amount: rs(36_500) }] });
    const r = report({ ledgerId: acme, to: '2026-04-11', ratePercent: 10 });
    // LATE: 2-Apr … 11-Apr = 10 days × 36,50,000 paise × 10 ÷ 36,500 = 10,000 paise = ₹100
    assert.deepEqual(r.rows.map((x) => [x.billName, x.days, x.interest]), [['LATE', 10, 100_00]]);
  });

  it('uses the entered rate for every ledger, skips ledgers without a rate, ignores advances and credits in the party’s favour', () => {
    company();
    const rated = t.addLedger({ name: 'Rated Co', group: 'SUNDRY_DEBTORS', interestRate: 12 });
    const plain = t.addLedger({ name: 'Plain Co', group: 'SUNDRY_DEBTORS' });
    sale(t, rated, { date: '2026-04-01', no: 'R-1', amount: rs(36_500), creditDays: 0 });
    sale(t, plain, { date: '2026-04-01', no: 'P-1', amount: rs(36_500), creditDays: 0 });
    receipt(t, plain, { date: '2026-04-01', no: 'ADV', amount: rs(1_000), bills: [{ ref: 'advance', name: 'ADV-1', amount: rs(1_000) }] });
    creditNote(t, plain, { date: '2026-04-01', no: 'CN', amount: rs(500), bills: [{ ref: 'new', name: 'CN-1', amount: rs(500) }] });
    const own = report({ to: '2026-04-11' });
    // Rated Co at its 12%: 36,50,000 × 12 × 10 ÷ 36,500 = 12,000 paise
    assert.deepEqual(own.rows.map((x) => [x.ledgerName, x.billName, x.interest]), [['Rated Co', 'R-1', 120_00]]);
    assert.deepEqual(own.skipped.map((s) => s.ledgerName), ['Plain Co']);
    assert.match(own.skipped[0].reason, /interest rate/);
    const forced = report({ to: '2026-04-11', ratePercent: 24 });
    assert.deepEqual(forced.rows.map((x) => [x.ledgerName, x.billName, x.interest]), [
      ['Plain Co', 'P-1', 240_00],
      ['Rated Co', 'R-1', 240_00],
    ]);
    assert.equal(forced.skipped.length, 0);
  });

  it('computes interest payable on supplier bills (e.g. MSME delayed payment)', () => {
    company();
    const supp = t.addLedger({ name: 'Shree Suppliers', group: 'SUNDRY_CREDITORS' });
    purchase(t, supp, { date: '2026-04-15', no: 'SS/1', amount: rs(50_000), creditDays: 30 }); // due 15-May
    payment(t, supp, { date: '2026-04-20', no: 'P-ADV', amount: rs(100), bills: [{ ref: 'advance', name: 'X', amount: rs(100) }] });
    const r = report({ ratePercent: 24, groupId: t.ids.groups.SUNDRY_CREDITORS });
    // 16-May … 14-Jun = 30 days: 50,00,000 × 24 × 30 ÷ 36,500 = 98,630.1 → ₹986.30
    assert.deepEqual(r.rows.map((x) => [x.billName, x.side, x.days, x.principal, x.interest]), [['SS/1', 'payable', 30, 50_000_00, 986_30]]);
    assert.deepEqual(r.totals, { receivable: 0, payable: 986_30, billCount: 1 });
  });

  it('settles a non-bill-wise ledger FIFO and charges each debit from its due date', () => {
    company();
    const walkin = t.addLedger({ name: 'Walk-in Credit', group: 'SUNDRY_DEBTORS', billWise: false, creditDays: 0, interestRate: 12 });
    sale(t, walkin, { date: '2026-04-01', no: 'W-1', amount: rs(10_000), bills: null });
    sale(t, walkin, { date: '2026-05-01', no: 'W-2', amount: rs(10_000), bills: null });
    receipt(t, walkin, { date: '2026-05-31', no: 'R-1', amount: rs(15_000), billWise: false }); // clears W-1, 5,000 of W-2
    const r = report({ to: '2026-06-30' });
    // W-1: (1-Apr, 31-May] 60 days × 10,00,000 → 6,00,00,000 × 12 ÷ 36,500 = 19,726.0 → ₹197.26
    // W-2: 30 days × 10,00,000 + 30 days × 5,00,000 = 4,50,00,000 × 12 ÷ 36,500 = 14,794.5 → ₹147.95
    assert.deepEqual(r.rows.map((x) => [x.billName, x.refType, x.days, x.interest, x.pendingAtEnd]), [
      ['W-1', 'fifo', 60, 197_26, 0],
      ['W-2', 'fifo', 60, 147_95, 5_000_00],
    ]);
  });
});
