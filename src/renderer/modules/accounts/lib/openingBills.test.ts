import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { billsForSave, checkBills, emptyBill, fillDifference, isBlankBill, remapBillErrors, sameBills, validateBills } from './openingBills.ts';
import type { BillDraft } from './openingBills.ts';

const BOOKS = '2026-04-01';
const bill = (billName: string, amount: number | null, billDate = '2026-03-15', dueDate: string | null = null): BillDraft => ({
  key: billName || 'blank',
  billName,
  billDate,
  dueDate,
  amount,
});

describe('checkBills — live "bills total vs opening" check', () => {
  it('no bills → balanced, whole opening on account', () => {
    const c = checkBills(11_800_000, []);
    assert.equal(c.balanced, true);
    assert.equal(c.count, 0);
    assert.match(c.message, /on account/);
  });

  it('bills short of the opening → difference still to allocate', () => {
    // Opening ₹1,18,000.00 Dr = 11,800,000 paise; bills 10,000,000 + 1,500,000 = 11,500,000;
    // difference = 11,800,000 − 11,500,000 = 300,000 paise (₹3,000.00 Dr).
    const c = checkBills(11_800_000, [bill('INV-1', 10_000_000), bill('INV-2', 1_500_000), bill('', null)]);
    assert.equal(c.total, 11_500_000);
    assert.equal(c.difference, 300_000);
    assert.equal(c.count, 2);
    assert.equal(c.balanced, false);
    assert.match(c.message, /3,000\.00 Dr is not yet allocated/);
  });

  it('exact match, including an advance (Cr bill) netted against a Dr bill', () => {
    // 50,000 Dr bill + 20,000 Cr advance = 30,000 Dr = opening 30,000 Dr (in paise ×100).
    const c = checkBills(3_000_000, [bill('INV-9', 5_000_000), bill('ADV-1', -2_000_000)]);
    assert.equal(c.total, 3_000_000);
    assert.equal(c.difference, 0);
    assert.equal(c.balanced, true);
  });

  it('credit opening (supplier) with Cr bills', () => {
    const c = checkBills(-2_500_000, [bill('P-77', -2_500_000)]);
    assert.equal(c.balanced, true);
    assert.match(c.message, /25,000\.00 Cr/);
  });
});

describe('validateBills', () => {
  it('flags missing name, duplicates, late date, due before bill date, zero amount; skips blank rows', () => {
    const e = validateBills(
      [
        bill('A', 100),
        bill('a', 200), // duplicate (case-insensitive)
        bill('', 300), // no name
        bill('B', 400, '2026-04-02'), // after books begin
        bill('C', 500, '2026-03-01', '2026-02-01'), // due before bill date
        bill('D', 0), // zero
        bill('', null), // blank → ignored
      ],
      BOOKS,
    );
    assert.equal(e['openingBills[1].billName'], "Bill 'a' is entered twice");
    assert.equal(e['openingBills[2].billName'], 'Enter the bill number');
    assert.match(e['openingBills[3].billDate'], /on or before 1-Apr-2026|on or before/);
    assert.equal(e['openingBills[4].dueDate'], 'Due date is before the bill date');
    assert.equal(e['openingBills[5].amount'], 'Enter the amount still outstanding');
    assert.equal(Object.keys(e).some((k) => k.startsWith('openingBills[6]')), false);
    assert.equal(Object.keys(e).some((k) => k.startsWith('openingBills[0]')), false);
  });

  it('a bill dated exactly on the books beginning is allowed', () => {
    assert.deepEqual(validateBills([bill('X', 100, BOOKS)], BOOKS), {});
  });
});

describe('save mapping', () => {
  it('drops blank rows and maps server indices back to grid rows', () => {
    const rows = [bill('', null), bill('A', 100), bill('', null), bill('B', -50)];
    const out = billsForSave(rows);
    assert.deepEqual(out.input.map((b) => b.billName), ['A', 'B']);
    assert.deepEqual(out.serverIndexMap, [1, 3]);
    const remapped = remapBillErrors({ 'openingBills[1].amount': 'bad', openingBills: 'sum' }, out.serverIndexMap);
    assert.deepEqual(remapped, { 'openingBills[3].amount': 'bad', openingBills: 'sum' });
  });

  it('sameBills compares values in order', () => {
    const saved = [{ id: 1, billName: 'A', billDate: '2026-03-01', dueDate: null, amount: 100 }];
    assert.equal(sameBills([{ billName: 'A', billDate: '2026-03-01', dueDate: null, amount: 100 }], saved), true);
    assert.equal(sameBills([{ billName: 'A', billDate: '2026-03-01', dueDate: null, amount: 101 }], saved), false);
    assert.equal(sameBills([], saved), false);
  });

  it('fillDifference puts the unallocated amount in the last blank row (or a new one)', () => {
    // Opening 1,000 paise, bills 600 → difference 400 goes to the blank row.
    const filled = fillDifference([bill('A', 600), bill('', null)], 1_000, BOOKS);
    assert.equal(filled[1].amount, 400);
    const appended = fillDifference([bill('A', 600)], 1_000, BOOKS);
    assert.equal(appended.length, 2);
    assert.equal(appended[1].amount, 400);
    assert.equal(appended[1].billDate, BOOKS);
    assert.equal(isBlankBill(emptyBill(BOOKS)), true);
  });
});
