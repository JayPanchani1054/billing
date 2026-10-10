import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoForexFifo, decodeForex, draftsFromAllocations, draftsToAllocations, encodeForex, estimatedDifference, forexBills, lineRupees, settleableForex, signedForex } from './entry.ts';
import type { PendingForexBill } from './entry.ts';

test('encode / decode the form amount (foreign × 100)', () => {
  assert.equal(encodeForex(12.5), 1250);
  assert.equal(encodeForex(0.015), 2);
  assert.equal(decodeForex(1250), 12.5);
  assert.equal(decodeForex(-5), -0.05);
  assert.deepEqual(forexBills([{ refType: 'new', billName: 'E-1', amount: 100050 }]), [{ refType: 'new', billName: 'E-1', amount: 100050, forexAmount: 1000.5 }]);
});

test('signedForex follows the rupee side', () => {
  assert.equal(signedForex(600, -5040000), -600);
  assert.equal(signedForex(-600, 5040000), 600);
  assert.equal(signedForex(0, 100), 0);
  assert.equal(signedForex(-3, 0), -3);
});

test('drafts → allocations: rupees split exactly from the line at the rate', () => {
  // $100 + $200 at ₹83.333 = ₹24,999.90 split 1:2 → 833333 + 1666657 (largest remainder).
  const out = draftsToAllocations(
    [
      { refType: 'against', billName: 'A', forexAmount: 100 },
      { refType: 'against', billName: 'B', forexAmount: 200 },
      { refType: 'new', billName: '  ', forexAmount: 5 },
    ],
    { dp: 2, rate: 83.333, unit: 'inr' },
  );
  assert.deepEqual(out.map((b) => [b.billName, b.amount, b.forexAmount]), [['A', 833330, 100], ['B', 1666660, 200]]);
  assert.equal(lineRupees(300, 2, 83.333), 2499990);
  const enc = draftsToAllocations([{ refType: 'on_account', billName: '', forexAmount: 12.34 }], { dp: 2, rate: null, unit: 'encoded' });
  assert.deepEqual(enc, [{ refType: 'on_account', amount: 1234, forexAmount: 12.34 }]);
  assert.deepEqual(draftsFromAllocations(enc), [{ refType: 'on_account', billName: '', forexAmount: 12.34 }]);
});

const pending: PendingForexBill[] = [
  { billName: '2', billDate: '2026-05-10', dueDate: null, amount: 4_150_000, forexAmount: 500, bookedRate: 83 },
  { billName: '1', billDate: '2026-04-10', dueDate: null, amount: 8_325_000, forexAmount: 1000, bookedRate: 83.25 },
  { billName: 'P', billDate: '2026-04-01', dueDate: null, amount: -100, forexAmount: -1, bookedRate: 1 },
];

test('FIFO settles the oldest bills of the other side, rest on account / new ref', () => {
  assert.deepEqual(settleableForex(pending, 'cr').map((b) => b.billName), ['2', '1']);
  assert.deepEqual(autoForexFifo(pending, 1200, 'cr', 2), [
    { refType: 'against', billName: '1', forexAmount: 1000 },
    { refType: 'against', billName: '2', forexAmount: 200 },
  ]);
  assert.deepEqual(autoForexFifo(pending, 1600, 'cr', 2, 'ADV'), [
    { refType: 'against', billName: '1', forexAmount: 1000 },
    { refType: 'against', billName: '2', forexAmount: 500 },
    { refType: 'new', billName: 'ADV', forexAmount: 100 },
  ]);
});

test('estimated realised difference: receipt at a higher rate is a gain (Cr)', () => {
  // $600 of bill 1 at ₹84: ₹50,400 vs booked ₹49,950 → gain ₹450 → −45000.
  assert.equal(estimatedDifference(pending[1], 600, 84, 2, 'cr'), -45_000);
  // Payment of the payable P at a higher rate: loss.
  assert.equal(estimatedDifference(pending[2], 1, 2, 2, 'dr'), 100);
});
