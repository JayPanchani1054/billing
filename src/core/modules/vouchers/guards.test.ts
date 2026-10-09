/**
 * Guards (F12 › guards): negative stock, negative cash, credit limit, duplicate supplier invoice —
 * each in allow / warn (needs confirmation) / block (hard error) mode.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GuardPolicy } from '../../../shared/settings.ts';
import { ledgerBalanceAsOf } from './guards.ts';
import { previewVoucher, saveVoucher } from './service.ts';
import { purchaseInput, ruleDetails, salesInput, save, setupKit, throwsApp, type Kit } from './testkit.ts';

function setGuard(k: Kit, guard: 'negativeStock' | 'negativeCash' | 'creditLimit' | 'duplicateSupplierInvoice', policy: GuardPolicy): void {
  const paths: Record<typeof guard, string> = {
    negativeStock: '$.guards.negativeStock',
    negativeCash: '$.guards.negativeCash',
    creditLimit: '$.guards.creditLimit',
    duplicateSupplierInvoice: '$.guards.duplicateSupplierInvoice',
  };
  k.t.db.run(`UPDATE settings SET value = json_set(value, :path, :policy) WHERE key = 'config'`, { path: paths[guard], policy });
}

describe('negative stock', () => {
  it('warn → needsConfirmation; acknowledged save goes through', () => {
    const k = setupKit();
    const input = salesInput(k, { items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }] });
    const err = throwsApp(() => saveVoucher(k.t.ctx, input), 'BUSINESS_RULE', /Please confirm: Stock of Mixer Grinder in Main Location will go negative: 50 Nos available, 60 Nos required/);
    const d = ruleDetails(err);
    assert.equal(d.needsConfirmation, true);
    assert.deepEqual(d.warnings.map((w) => [w.code, w.blocking]), [['negative_stock', false]]);
    const res = saveVoucher(k.t.ctx, { ...input, acknowledgeWarnings: true });
    assert.equal(res.warnings[0].code, 'negative_stock');
    k.t.close();
  });

  it('block → hard error without needsConfirmation, even when acknowledged', () => {
    const k = setupKit();
    setGuard(k, 'negativeStock', 'block');
    const input = salesInput(k, { items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }], acknowledgeWarnings: true });
    const err = throwsApp(() => saveVoucher(k.t.ctx, input), 'BUSINESS_RULE', /will go negative/);
    assert.equal(ruleDetails(err).needsConfirmation, undefined);
    // Preview reports it as blocking instead of throwing.
    const p = previewVoucher(k.t.ctx, input);
    assert.deepEqual(p.warnings.map((w) => [w.code, w.blocking]), [['negative_stock', true]]);
    k.t.close();
  });

  it('allow → no warning; stock as of the voucher date ignores later purchases', () => {
    const k = setupKit();
    // Purchase 20 on 20-Apr does not help a sale of 60 on 16-Apr.
    save(k, purchaseInput(k, { date: '2026-04-20', items: [{ itemId: k.I.mixer, qty: 20, rate: 100 }] }));
    const p = previewVoucher(k.t.ctx, salesInput(k, { date: '2026-04-16', items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }] }));
    assert.ok(p.warnings.some((w) => w.code === 'negative_stock'));
    const ok = previewVoucher(k.t.ctx, salesInput(k, { date: '2026-04-21', items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }] }));
    assert.ok(!ok.warnings.some((w) => w.code === 'negative_stock'));
    setGuard(k, 'negativeStock', 'allow');
    const allowed = previewVoucher(k.t.ctx, salesInput(k, { date: '2026-04-16', items: [{ itemId: k.I.mixer, qty: 60, rate: 200 }] }));
    assert.equal(allowed.warnings.length, 0);
    k.t.close();
  });
});

describe('negative cash', () => {
  it('a payment that overdraws Cash-in-Hand needs confirmation; bank overdraft does not', () => {
    const k = setupKit();
    const pay = (ledgerId: number) => ({
      voucherTypeId: k.vt.payment,
      date: k.t.today,
      mode: 'ledger' as const,
      ledgers: [{ ledgerId: k.L.rent, amount: 5000 }, { ledgerId, amount: -5000 }],
    });
    const err = throwsApp(() => saveVoucher(k.t.ctx, pay(k.L.cash)), 'BUSINESS_RULE', /Cash will go negative: balance ₹ 0\.00 before this voucher, -₹ 50\.00 after it/);
    assert.equal(ruleDetails(err).warnings[0].code, 'negative_cash');
    assert.equal(saveVoucher(k.t.ctx, pay(k.L.bank)).warnings.length, 0);
    setGuard(k, 'negativeCash', 'block');
    throwsApp(() => saveVoucher(k.t.ctx, { ...pay(k.L.cash), acknowledgeWarnings: true }), 'BUSINESS_RULE', /Cash will go negative/);
    k.t.close();
  });

  it('altering a voucher leaves its own Cash entries out of the balance before it (excluded voucher subtracted)', () => {
    const k = setupKit();
    const day = k.t.today;
    save(k, { voucherTypeId: k.vt.receipt, date: day, mode: 'ledger', ledgers: [{ ledgerId: k.L.cash, amount: 10000 }, { ledgerId: k.L.capital, amount: -10000 }] });
    const pay = (amount: number) => ({ voucherTypeId: k.vt.payment, date: day, mode: 'ledger' as const, ledgers: [{ ledgerId: k.L.rent, amount }, { ledgerId: k.L.cash, amount: -amount }] });
    const p = saveVoucher(k.t.ctx, pay(8000));
    assert.equal(p.warnings.length, 0);
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.cash, day, day, null), 2000);
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.cash, day, day, p.id), 10000, 'the payment itself is left out');
    // ₹90 out of the ₹100 there was before the payment: fine, although ₹20 is all that is left after it.
    assert.equal(saveVoucher(k.t.ctx, { ...pay(9000), id: p.id }).warnings.length, 0);
    throwsApp(() => saveVoucher(k.t.ctx, { ...pay(12000), id: p.id }), 'BUSINESS_RULE', /Cash will go negative: balance ₹ 100\.00 before this voucher, -₹ 20\.00 after it/);
    k.t.close();
  });
});

describe('credit limit', () => {
  it('warns when the party balance after the voucher exceeds the limit', () => {
    const k = setupKit();
    const limited = k.t.addLedger({ name: 'Limited Credit Co', group: 'SUNDRY_DEBTORS', stateCode: '27', creditLimit: 100000, openingBalance: 50000 });
    // Opening ₹500.00 Dr + invoice ₹1,180.00 = ₹1,680.00 > limit ₹1,000.00.
    const p = previewVoucher(k.t.ctx, salesInput(k, { partyLedgerId: limited }));
    const w = p.warnings.find((x) => x.code === 'credit_limit');
    assert.ok(w);
    assert.equal(w?.message, 'Credit limit of ₹ 1,000.00 for Limited Credit Co will be exceeded: balance after this voucher is ₹ 1,680.00 Dr.');
    // A small invoice within the limit: ₹500 + rice 1 × ₹100 + 5% = ₹605.00.
    const small = previewVoucher(k.t.ctx, salesInput(k, { partyLedgerId: limited, items: [{ itemId: k.I.rice, qty: 1, rate: 100 }] }));
    assert.ok(!small.warnings.some((x) => x.code === 'credit_limit'));
    k.t.close();
  });
});

describe('duplicate supplier invoice', () => {
  it('same supplier + reference in the same FY is flagged (case-insensitive); another FY is not', () => {
    const k = setupKit();
    save(k, purchaseInput(k, { referenceNo: 'INV-55' }));
    const err = throwsApp(() => saveVoucher(k.t.ctx, purchaseInput(k, { referenceNo: 'inv-55' })), 'BUSINESS_RULE', /Supplier invoice inv-55 of Supreme Suppliers is already entered/);
    assert.equal(ruleDetails(err).warnings.some((w) => w.code === 'duplicate_reference'), true);
    const nextYear = previewVoucher(k.t.ctx, purchaseInput(k, { referenceNo: 'INV-55', date: '2027-04-02' }));
    assert.ok(!nextYear.warnings.some((w) => w.code === 'duplicate_reference'));
    setGuard(k, 'duplicateSupplierInvoice', 'block');
    throwsApp(() => save(k, purchaseInput(k, { referenceNo: 'INV-55' })), 'BUSINESS_RULE', /already entered/);
    k.t.close();
  });

  it('optional vouchers skip guards', () => {
    const k = setupKit();
    const p = previewVoucher(k.t.ctx, salesInput(k, { isOptional: true, items: [{ itemId: k.I.mixer, qty: 500, rate: 1 }] }));
    assert.equal(p.warnings.length, 0);
    assert.equal(p.affectsStock, false);
    k.t.close();
  });
});
