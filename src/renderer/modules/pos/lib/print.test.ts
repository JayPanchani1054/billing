import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { posPrintRows } from './print.ts';

describe('POS print block', () => {
  it('a bill: tenders, cash tendered, change, counter and cashier', () => {
    const out = posPrintRows({
      kind: 'sale',
      tenders: [
        { label: 'UPI (Ref 889)', amount: 5_000 },
        { label: 'Cash', amount: 10_000 },
      ],
      paid: 15_000,
      credit: 0,
      cashTendered: 20_000,
      change: 10_000,
      counter: 'C1',
      cashier: 'Asha',
    });
    assert.equal(out.title, 'Paid by');
    assert.deepEqual(out.rows.map((r) => [r.label, r.amount]), [
      ['UPI (Ref 889)', '50.00'],
      ['Cash', '100.00'],
      ['Cash tendered', '200.00'],
      ['Change', '100.00'],
    ]);
    assert.equal(out.footer, 'Counter: C1 · Cashier: Asha');
  });

  it('credit on a bill and a return credited to the account', () => {
    const bill = posPrintRows({ kind: 'sale', tenders: [{ label: 'Cash', amount: 4_000 }], paid: 4_000, credit: 6_000, cashTendered: null, change: 0, counter: null, cashier: null });
    assert.deepEqual(bill.rows.map((r) => [r.label, r.amount, r.strong ?? false]), [
      ['Cash', '40.00', false],
      ['On account (to pay)', '60.00', true],
    ]);
    assert.equal(bill.footer, null);
    const ret = posPrintRows({ kind: 'return', tenders: [], paid: 0, credit: 11_800, cashTendered: null, change: 0, counter: null, cashier: 'Asha' });
    assert.equal(ret.title, 'Refunded by');
    assert.deepEqual(ret.rows.map((r) => r.label), ['Credited to your account']);
  });
});
