import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PendingBill } from '../../../../shared/types/vouchers.ts';
import { allocationRemaining, autoAllocateFifo, checkAllocations, defaultAllocation, dueDateFor, fifoOrder } from './bills.ts';

const bill = (billName: string, billDate: string, amount: number, dueDate: string | null = null): PendingBill => ({
  billName,
  billDate,
  dueDate,
  amount,
  originalAmount: amount,
  source: 'voucher',
  voucherId: 1,
});

// A customer's pending bills (Dr = receivable) plus an unadjusted advance (Cr).
const PENDING: PendingBill[] = [bill('S/12', '2026-09-20', 300000), bill('S/3', '2026-08-05', 118000), bill('ADV-1', '2026-07-01', -50000), bill('S/9', '2026-09-01', 200000)];

describe('FIFO auto-allocation', () => {
  it('orders oldest first', () => {
    assert.deepEqual(
      fifoOrder(PENDING).map((b) => b.billName),
      ['ADV-1', 'S/3', 'S/9', 'S/12'],
    );
  });

  it('a receipt (Cr) of ₹4,00,000 settles S/3 then S/9 in full and S/12 partly', () => {
    const out = autoAllocateFifo(PENDING, 400000, 'cr');
    // 1,180.00 + 2,000.00 = 3,180.00 → 820.00 left for S/12 (pending 3,000.00)
    assert.deepEqual(out, [
      { refType: 'against', billName: 'S/3', amount: 118000 },
      { refType: 'against', billName: 'S/9', amount: 200000 },
      { refType: 'against', billName: 'S/12', amount: 82000 },
    ]);
    assert.equal(allocationRemaining(out, -400000), 0);
  });

  it('more than all pending bills → remainder On Account', () => {
    const out = autoAllocateFifo(PENDING, 700000, 'cr');
    // Σ Dr bills = 1,180 + 2,000 + 3,000 = 6,180.00 → 820.00 on account
    assert.deepEqual(out[out.length - 1], { refType: 'on_account', amount: 82000 });
    assert.equal(out.length, 4);
  });

  it('a Dr entry settles only Cr bills (the advance), the rest as an advance with a name', () => {
    const out = autoAllocateFifo(PENDING, 80000, 'dr', { remainder: 'advance', remainderName: 'ADV-2' });
    assert.deepEqual(out, [
      { refType: 'against', billName: 'ADV-1', amount: 50000 },
      { refType: 'advance', billName: 'ADV-2', amount: 30000 },
    ]);
  });

  it('no pending bills → one On Account line', () => {
    assert.deepEqual(autoAllocateFifo([], 1000, 'cr'), [{ refType: 'on_account', amount: 1000 }]);
  });
});

describe('allocation checks', () => {
  it('names, amounts and total', () => {
    const issues = checkAllocations(
      [
        { refType: 'against', billName: '', amount: 100 },
        { refType: 'on_account', amount: 0 },
      ],
      500,
    );
    assert.equal(issues.length, 3);
    assert.match(issues[2].message, /remaining amount \(₹4\.00\)/);
    assert.deepEqual(checkAllocations([{ refType: 'new', billName: 'X', amount: 500 }], -500), []);
  });

  it('due date = date + credit days', () => {
    assert.equal(dueDateFor('2026-10-05', 30), '2026-11-04');
    assert.equal(dueDateFor('2026-10-05', 0), null);
    assert.equal(dueDateFor('2026-10-05', null), null);
  });
});

describe('default allocation when the dialog opens', () => {
  const pending = [bill('S/2', '2026-09-10', 300000, '2026-10-10'), bill('S/1', '2026-08-01', 200000, '2026-08-31'), bill('P/9', '2026-08-15', -50000)];
  it('a receipt (Cr) against a customer who owes settles the oldest Dr bills first, the rest On Account', () => {
    // ₹6,000 received: S/1 ₹2,000 (oldest) + S/2 ₹3,000, remaining ₹1,000 on account. P/9 (Cr) is not settled by a Cr entry.
    assert.deepEqual(defaultAllocation({ pending, amount: 600000, side: 'cr', date: '2026-10-05', suggestedName: '17', creditDays: null, invoiceParty: false }), [
      { refType: 'against', billName: 'S/1', amount: 200000 },
      { refType: 'against', billName: 'S/2', amount: 300000 },
      { refType: 'on_account', amount: 100000 },
    ]);
  });

  it('an invoice party, or nothing to settle, starts a New Ref named after the voucher with the credit period', () => {
    assert.deepEqual(defaultAllocation({ pending, amount: 118000, side: 'dr', date: '2026-10-05', suggestedName: 'INV/42', creditDays: 30, invoiceParty: true }), [
      { refType: 'new', billName: 'INV/42', amount: 118000, creditDays: 30, dueDate: '2026-11-04' },
    ]);
    assert.deepEqual(defaultAllocation({ pending: [], amount: -5000, side: 'cr', date: '2026-10-05', suggestedName: '9', creditDays: null, invoiceParty: false }), [
      { refType: 'new', billName: '9', amount: 5000 },
    ]);
  });
});
