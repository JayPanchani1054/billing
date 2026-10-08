import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveVoucherType } from '../accounts/voucherTypes.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { exceptions, negativeReason, register, statistics } from './registers.ts';
import { APRIL, makeBooks } from './testkit.ts';

test('sales register: month-wise count and amounts; optional left out, cancelled counted separately', () => {
  const b = makeBooks();
  const vt = b.t.ids.voucherTypes;
  const sale = (extra: object) =>
    b.post({ voucherTypeId: vt.sales, date: '2026-04-20', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 1, rate: 1000 }], ...extra });
  sale({ isOptional: true });
  const c = sale({});
  cancelVoucher(b.t.ctx, c.id, 'Wrong party');
  const r = register(b.env(), { ...APRIL, baseType: 'sales', includeVouchers: true });
  assert.equal(r.title, 'Sales Register');
  assert.equal(r.months.length, 1);
  // S1 only: invoice 1,41,600 = taxable 1,20,000 + tax 21,600
  assert.deepEqual(r.totals, { count: 1, cancelled: 1, amount: 14_160_000, taxable: 12_000_000, tax: 2_160_000 });
  assert.deepEqual(
    r.vouchers?.map((v) => [v.id, v.isCancelled, v.amount]),
    [
      [b.V.S1, false, 14_160_000],
      [c.id, true, 0],
    ],
  );
});

test('register by voucher type includes types based on it; months outside activity are zero', () => {
  const b = makeBooks({ today: '2026-05-31' });
  const exportSales = saveVoucherType(b.t.ctx, { name: 'Counter Sales', parentId: b.t.ids.voucherTypes.sales }).id;
  b.post({ voucherTypeId: exportSales, date: '2026-05-03', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 2, rate: 1000 }] });
  const env = b.env();
  const all = register(env, { from: '2026-04-01', to: '2026-06-30', voucherTypeId: b.t.ids.voucherTypes.sales });
  assert.deepEqual(
    all.months.map((m) => [m.month, m.count]),
    [
      ['2026-04', 1],
      ['2026-05', 1],
      ['2026-06', 0],
    ],
  );
  // 2 × 1,000 = 2,000 + 18% = 2,360 → 2,36,000 p
  assert.equal(all.months[1].amount, 236_000);
  const own = register(env, { from: '2026-04-01', to: '2026-06-30', voucherTypeId: exportSales });
  assert.equal(own.title, 'Counter Sales Register');
  assert.equal(own.totals.count, 1);
});

test('register: payment register amounts are Σ debits of each voucher', () => {
  const b = makeBooks();
  const r = register(b.env(), { ...APRIL, baseType: 'payment' });
  // P2 25,000 + P3 50,000
  assert.equal(r.totals.amount, 7_500_000);
  assert.equal(r.totals.count, 2);
  assert.equal(r.vouchers, null);
});

test('exceptions: negative cash, optional, cancelled, post-dated, memorandum and vouchers without narration', () => {
  const b = makeBooks();
  const vt = b.t.ids.voucherTypes;
  const pay = (date: string, amount: number, extra: object = {}) =>
    b.post({ voucherTypeId: vt.payment, date, mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount }, { ledgerId: b.L.cash, amount: -amount }], narration: 'x', ...extra });
  pay('2026-04-30', 10_000_000); // cash 37,00,000 − 1,00,00,000 → −63,00,000
  const opt = pay('2026-04-21', 100_000, { isOptional: true });
  const can = pay('2026-04-22', 100_000);
  cancelVoucher(b.t.ctx, can.id, 'Duplicate');
  const pdc = pay('2026-05-05', 100_000, { isPostDated: true });
  const memo = b.post({ voucherTypeId: vt.memorandum, date: '2026-04-23', mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 50_000 }, { ledgerId: b.L.cash, amount: -50_000 }] });
  const r = exceptions(b.env(), { from: '2026-04-01', to: '2026-05-31', includeNoNarration: true });
  const cash = r.negativeLedgers.find((n) => n.ledgerId === b.L.cash);
  assert.equal(cash?.closing, -6_300_000);
  assert.match(cash?.reason ?? '', /Cash in hand is negative/);
  assert.ok(!r.negativeLedgers.some((n) => n.groupName === 'Duties & Taxes'), 'input tax debit balances are normal');
  assert.deepEqual(r.optional.map((v) => v.id), [opt.id]);
  assert.deepEqual(r.cancelled.map((v) => v.id), [can.id]);
  assert.deepEqual(r.postDated.map((v) => v.id), [pdc.id]);
  assert.deepEqual(r.memorandum.map((v) => v.id), [memo.id]);
  // P1 (purchase) and P3 (payment) were entered without narration.
  assert.deepEqual(r.noNarration?.map((v) => v.id), [b.V.P1, b.V.P3]);
});

test('negativeReason: debtor credit, creditor debit, bank overdrawn, OD with money, income debit', () => {
  const base = { isCash: false, isBank: false, isBankOd: false, isDebtor: false, isCreditor: false, isDutyTax: false, nature: 'assets' };
  assert.match(negativeReason({ ...base, isDebtor: true }, -100) ?? '', /advance received/);
  assert.equal(negativeReason({ ...base, isDebtor: true }, 100), null);
  assert.match(negativeReason({ ...base, nature: 'liabilities', isCreditor: true }, 100) ?? '', /advance paid/);
  assert.match(negativeReason({ ...base, isBank: true }, -100) ?? '', /Bank OD/);
  assert.match(negativeReason({ ...base, nature: 'liabilities', isBank: true, isBankOd: true }, 100) ?? '', /Overdraft/);
  assert.equal(negativeReason({ ...base, nature: 'liabilities', isBank: true, isBankOd: true }, -100), null);
  assert.match(negativeReason({ ...base, nature: 'income' }, 100) ?? '', /Income ledger/);
  assert.equal(negativeReason({ ...base, nature: 'liabilities', isDutyTax: true }, 100), null);
});

test('statistics: voucher counts by type and master counts', () => {
  const b = makeBooks();
  b.post({ voucherTypeId: b.t.ids.voucherTypes.payment, date: '2026-04-21', mode: 'ledger', isOptional: true, ledgers: [{ ledgerId: b.L.rent, amount: 100 }, { ledgerId: b.L.cash, amount: -100 }] });
  const s = statistics(b.env(), APRIL);
  const count = (name: string) => s.vouchers.find((v) => v.name === name);
  assert.deepEqual([count('Sales')?.regular, count('Receipt')?.regular, count('Payment')?.regular, count('Payment')?.optional], [1, 2, 2, 1]);
  assert.deepEqual(s.voucherTotals, { regular: 8, optional: 1, cancelled: 0, postDated: 0, total: 9 });
  const m = Object.fromEntries(s.masters.map((x) => [x.key, x.count]));
  assert.equal(m.groups, 28);
  assert.equal(m.stockItems, 1);
  assert.ok(m.ledgers >= 13);
});
