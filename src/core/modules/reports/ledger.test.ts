import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { AS_PER_DETAILS, groupVouchers, ledgerReport, monthlySummary, particularsFor } from './ledger.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';
import { trialBalance } from './trialBalance.ts';

test('ledger: opening, running balance per voucher and closing (HDFC Bank, April)', () => {
  const b = makeBooks();
  const r = ledgerReport(b.env(), { ...APRIL, ledgerId: b.L.bank });
  assert.equal(r.opening, 20_000_000);
  assert.deepEqual(
    r.rows.map((x) => [x.date, x.voucherType, x.particulars, x.debit, x.credit, x.balance]),
    [
      ['2026-04-15', 'Receipt', 'Acme Traders', 10_000_000, 0, 30_000_000],
      ['2026-04-25', 'Payment', 'Supreme Suppliers', 0, 5_000_000, 25_000_000],
      ['2026-04-26', 'Contra', 'Cash', 0, 1_000_000, 24_000_000],
    ],
  );
  assert.deepEqual(r.totals, { debit: 10_000_000, credit: 6_000_000 });
  assert.equal(r.closing, EXPECTED.bank);
  assert.equal(r.count, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.ledger.groupName, 'Bank Accounts');
});

test('ledger: an invoice shows the sales ledger as particulars, details carry every other ledger', () => {
  const b = makeBooks();
  const r = ledgerReport(b.env(), { ...APRIL, ledgerId: b.L.acme });
  const sale = r.rows[0];
  assert.equal(sale.particulars, 'Sales');
  assert.equal(sale.voucherId, b.V.S1);
  assert.deepEqual(
    sale.details.map((d) => [d.ledgerName, d.amount]),
    [
      ['Sales', -12_000_000],
      ['Output CGST', -1_080_000],
      ['Output SGST/UTGST', -1_080_000],
    ],
  );
  assert.equal(sale.narration, 'April supply');
  assert.equal(r.closing, EXPECTED.acme);
});

test("ledger: several ledgers on the opposite side → '(as per details)'", () => {
  const b = makeBooks();
  b.post({
    voucherTypeId: b.t.ids.voucherTypes.journal,
    date: '2026-04-30',
    mode: 'ledger',
    ledgers: [
      { ledgerId: b.L.rent, amount: 100_000 },
      { ledgerId: b.L.depreciation, amount: 100_000 },
      { ledgerId: b.L.furniture, amount: -200_000 },
    ],
  });
  const env = b.env();
  const furn = ledgerReport(env, { ...APRIL, ledgerId: b.L.furniture });
  assert.equal(furn.rows.at(-1)?.particulars, AS_PER_DETAILS);
  const rent = ledgerReport(env, { ...APRIL, ledgerId: b.L.rent });
  assert.equal(rent.rows.at(-1)?.particulars, 'Furniture');
});

test('ledger totals and closing tie to the Trial Balance for every ledger', () => {
  const b = makeBooks();
  const env = b.env();
  const tb = trialBalance(env, { ...APRIL, mode: 'ledgers' });
  for (const row of tb.rows) {
    if (row.kind !== 'ledger' || row.id === null) continue;
    const r = ledgerReport(env, { ...APRIL, ledgerId: row.id });
    assert.equal(r.opening, row.opening, row.name);
    assert.equal(r.totals.debit, row.debit, row.name);
    assert.equal(r.totals.credit, row.credit, row.name);
    assert.equal(r.closing, row.closing, row.name);
    assert.equal(r.rows.at(-1)?.balance ?? r.opening, r.closing, row.name);
  }
});

test('ledger from mid-month: earlier entries move into the opening balance', () => {
  const b = makeBooks();
  const r = ledgerReport(b.env(), { from: '2026-04-20', to: '2026-04-30', ledgerId: b.L.bank });
  // 2,00,00,000 + 1,00,00,000 (R1 on 15-Apr)
  assert.equal(r.opening, 30_000_000);
  assert.equal(r.rows.length, 2);
  assert.equal(r.closing, EXPECTED.bank);
});

test('ledger: limit truncates the rows but not the totals', () => {
  const b = makeBooks();
  const r = ledgerReport(b.env(), { ...APRIL, ledgerId: b.L.cash, limit: 1 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.count, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.closing, EXPECTED.cash);
});

test('ledger: unknown ledger → VALIDATION on ledgerId', () => {
  const b = makeBooks({ skipVouchers: true });
  assert.throws(
    () => ledgerReport(b.env(), { ...APRIL, ledgerId: 99_999 }),
    (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && (e.details as Array<{ path: string }>)[0].path === 'ledgerId',
  );
});

test('group vouchers: Current Assets — a contra shows on both sides, running balance follows the group', () => {
  const b = makeBooks();
  const r = groupVouchers(b.env(), { ...APRIL, groupId: b.t.ids.groups.CURRENT_ASSETS });
  // Opening: cash 50,00,000 + bank 2,00,00,000
  assert.equal(r.opening, 25_000_000);
  const contra = r.rows.find((x) => x.voucherId === b.V.C1);
  assert.deepEqual([contra?.debit, contra?.credit, contra?.particulars], [1_000_000, 1_000_000, 'Cash, HDFC Bank']);
  assert.equal(r.closing, 31_860_000);
  assert.equal(r.rows.at(-1)?.balance, r.closing);
  assert.equal(r.totals.debit - r.totals.credit, r.closing - r.opening);
});

test('monthly summary of a ledger: month rows with closing balances (Cash, Apr–May)', () => {
  const b = makeBooks({ today: '2026-05-31' });
  b.post({ voucherTypeId: b.t.ids.voucherTypes.payment, date: '2026-05-05', mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 2_500_000 }, { ledgerId: b.L.cash, amount: -2_500_000 }] });
  const r = monthlySummary(b.env(), { from: '2026-04-01', to: '2026-05-31', ledgerId: b.L.cash });
  assert.equal(r.opening, 5_000_000);
  assert.deepEqual(
    r.rows.map((m) => [m.month, m.debit, m.credit, m.closing, m.count]),
    [
      // April: +10,000 contra +2,000 interest; −25,000 rent
      ['2026-04', 1_200_000, 2_500_000, 3_700_000, 3],
      ['2026-05', 0, 2_500_000, 1_200_000, 1],
    ],
  );
  assert.equal(r.closing, 1_200_000);
  assert.deepEqual(r.totals, { debit: 1_200_000, credit: 5_000_000 });
});

test('monthly summary of a group, and exactly one of ledger/group is required', () => {
  const b = makeBooks();
  const env = b.env();
  const r = monthlySummary(env, { ...APRIL, groupId: b.t.ids.groups.SUNDRY_DEBTORS });
  assert.equal(r.subject.kind, 'group');
  assert.equal(r.rows[0].debit, 14_160_000);
  assert.equal(r.closing, EXPECTED.acme);
  assert.throws(() => monthlySummary(env, { ...APRIL }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  assert.throws(
    () => monthlySummary(env, { ...APRIL, ledgerId: b.L.cash, groupId: b.t.ids.groups.SUNDRY_DEBTORS }),
    (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
  );
});

test('particularsFor: single opposite ledger, invoice, journal and no other ledger', () => {
  assert.equal(particularsFor(100, [{ ledgerName: 'Cash', amount: -100 }]), 'Cash');
  assert.equal(
    particularsFor(118, [
      { ledgerName: 'Output CGST', amount: -9, role: 'tax' },
      { ledgerName: 'Sales', amount: -100, role: 'sales' },
      { ledgerName: 'Output SGST', amount: -9, role: 'tax' },
    ]),
    'Sales',
  );
  assert.equal(particularsFor(-200, [{ ledgerName: 'Rent', amount: 100 }, { ledgerName: 'Depreciation', amount: 100 }]), AS_PER_DETAILS);
  assert.equal(particularsFor(0, []), AS_PER_DETAILS);
});
