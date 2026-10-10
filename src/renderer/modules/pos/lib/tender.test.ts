import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PosTenderMode } from '../../../../shared/types/pos.ts';
import { addExchangeRow, initialTenders, tendersFromSaved, payRestBy, quickCash, setTenderAmount, setTenderReference, summarizeTenders, toPosBill, wantsReference, billBlockers } from './tender.ts';

const mode = (id: number, name: string, kind: PosTenderMode['kind'], isActive = true): PosTenderMode => ({
  id,
  name,
  kind,
  ledgerId: id * 10,
  ledgerName: name,
  sortOrder: id,
  isActive,
  isSystem: kind === 'exchange',
  usedCount: 0,
});
const MODES = [mode(1, 'Cash', 'cash'), mode(2, 'UPI', 'upi'), mode(3, 'Card', 'card'), mode(4, 'Old', 'wallet', false), mode(9, 'Exchange credit', 'exchange')];

describe('tenders', () => {
  it('start with the whole bill in cash; other rows take from cash', () => {
    let s = initialTenders(MODES, 22_300);
    assert.deepEqual(s.rows.map((r) => [r.name, r.amount]), [
      ['Cash', 22_300],
      ['UPI', 0],
      ['Card', 0],
    ]);
    s = setTenderAmount(s, 1, 10_000, 22_300);
    assert.deepEqual(s.rows.map((r) => r.amount), [12_300, 10_000, 0]);
    const sum = summarizeTenders({ ...s, cashTendered: 15_000 }, 22_300, { walkIn: true });
    assert.deepEqual([sum.paid, sum.cash, sum.change, sum.credit, sum.ok], [22_300, 12_300, 2_700, 0, true]);
  });

  it('typing on the cash row stops the automatic balance; a walk-in bill must then be paid in full', () => {
    let s = initialTenders(MODES, 22_300);
    s = setTenderAmount(s, 0, 20_000, 22_300);
    s = setTenderAmount(s, 1, 1_000, 22_300);
    assert.deepEqual(s.rows.map((r) => r.amount), [20_000, 1_000, 0]);
    const walkIn = summarizeTenders(s, 22_300, { walkIn: true });
    assert.equal(walkIn.credit, 1_300);
    assert.equal(walkIn.ok, false);
    assert.match(walkIn.problems[0], /₹ 13\.00 is not paid/);
    // A customer may take the rest on account.
    assert.equal(summarizeTenders(s, 22_300, { walkIn: false }).ok, true);
  });

  it('pay the rest by one mode; more than the bill is refused; cash tendered checks', () => {
    let s = initialTenders(MODES, 10_000);
    s = payRestBy(s, 1, 10_000);
    assert.deepEqual(s.rows.map((r) => r.amount), [0, 10_000, 0]);
    s = setTenderAmount(s, 2, 5_000, 10_000);
    assert.deepEqual(s.rows.map((r) => r.amount), [0, 5_000, 5_000]);
    const over = setTenderAmount(initialTenders(MODES, 10_000), 0, 12_000, 10_000);
    assert.match(summarizeTenders(over, 10_000, { walkIn: true }).problems[0], /more than the bill .* by ₹ 20\.00/);
    const short = { ...initialTenders(MODES, 10_000), cashTendered: 5_000 };
    assert.match(summarizeTenders(short, 10_000, { walkIn: true }).problems[0], /less than the cash/);
    const noCash = { ...payRestBy(initialTenders(MODES, 10_000), 1, 10_000), cashTendered: 20_000 };
    assert.match(summarizeTenders(noCash, 10_000, { walkIn: true }).problems[0], /nothing is paid in cash/);
  });

  it('exchange credit from a return comes first, capped at the bill', () => {
    const s = initialTenders(MODES, 15_000, { modeId: 9, name: 'Exchange credit', voucherId: 77, amount: 11_800 });
    assert.deepEqual(s.rows.map((r) => [r.kind, r.amount]), [
      ['cash', 3_200],
      ['upi', 0],
      ['card', 0],
      ['exchange', 11_800],
    ]);
    const capped = initialTenders(MODES, 5_000, { modeId: 9, name: 'Exchange credit', voucherId: 77, amount: 11_800 });
    assert.deepEqual(capped.rows.map((r) => r.amount), [0, 0, 0, 5_000]);
    assert.deepEqual(toPosBill(capped, { counter: ' C1 ' }), { tenders: [{ modeId: 9, amount: 5_000, exchangeVoucherId: 77 }], counter: 'C1' });
  });

  it('adds exchange credit of a return later, taking it from the balance row', () => {
    let s = initialTenders(MODES, 15_000);
    s = setTenderAmount(s, 1, 2_000, 15_000); // UPI 2,000 → cash 13,000
    s = addExchangeRow(s, { modeId: 9, name: 'Exchange credit', voucherId: 77, available: 11_800 }, 15_000);
    assert.deepEqual(s.rows.map((r) => [r.kind, r.amount]), [
      ['cash', 1_200],
      ['upi', 2_000],
      ['card', 0],
      ['exchange', 11_800],
    ]);
    // Again for the same return: replaced, not added twice; capped by what is due.
    s = addExchangeRow(s, { modeId: 9, name: 'Exchange credit', voucherId: 77, available: 50_000 }, 15_000);
    assert.equal(s.rows.filter((r) => r.kind === 'exchange').length, 1);
    assert.deepEqual(s.rows.map((r) => r.amount), [0, 2_000, 0, 13_000]);
  });

  it('builds the posBill block (rows with an amount, references trimmed, return without cash tendered)', () => {
    let s = initialTenders(MODES, 10_000);
    s = setTenderAmount(s, 1, 4_000, 10_000);
    s = setTenderReference(s, 1, ' 4521 ');
    assert.deepEqual(toPosBill({ ...s, cashTendered: 10_000 }), {
      tenders: [
        { modeId: 1, amount: 6_000 },
        { modeId: 2, amount: 4_000, reference: '4521' },
      ],
      cashTendered: 10_000,
    });
    assert.deepEqual(toPosBill({ ...s, cashTendered: 10_000 }, { isReturn: true, returnOfId: 5 }), {
      tenders: [
        { modeId: 1, amount: 6_000 },
        { modeId: 2, amount: 4_000, reference: '4521' },
      ],
      returnOfId: 5,
    });
  });

  it('a saved bill comes back with its tenders as saved', () => {
    const s = tendersFromSaved(MODES, { tenders: [{ modeId: 2, amount: 5_000, reference: 'R9' }, { modeId: 1, amount: 3_000 }, { modeId: 4, amount: 100 }, { modeId: 9, amount: 700, exchangeVoucherId: 77 }], cashTendered: 5_000 });
    assert.deepEqual(s.rows.map((r) => [r.name, r.amount, r.reference, r.exchangeVoucherId ?? null]), [
      ['Cash', 3_000, '', null],
      ['UPI', 5_000, 'R9', null],
      ['Card', 0, '', null],
      ['Old', 100, '', null],
      ['Exchange credit', 700, '', 77],
    ]);
    assert.equal(s.balanceIndex, -1);
    assert.equal(s.cashTendered, 5_000);
  });

  it('quick cash amounts and references', () => {
    // ₹123.00 → exact, ₹130, ₹150, ₹200, ₹500.
    assert.deepEqual(quickCash(12_300), [12_300, 13_000, 15_000, 20_000, 50_000]);
    assert.deepEqual(quickCash(50_000), [50_000, 200_000]);
    assert.deepEqual(quickCash(0), []);
    assert.equal(wantsReference('upi'), true);
    assert.equal(wantsReference('cash'), false);
  });
});

describe('billBlockers (review: every pos warning used to be hidden on the bill, incl. returns over the bill)', () => {
  it('hides only what the payment settles; keeps blocks on goods, customer, date and the bill returned', () => {
    const w = (code: string, path: string | undefined, blocking = true) => ({ code: code as 'pos', path, blocking });
    const list = [
      w('pos', 'posBill.tenders'), // walk-in not paid in full — settled in the payment dialog
      w('pos', 'posBill.tenders[0].exchangeVoucherId'),
      w('pos', 'posBill.cashTendered'),
      w('pos', 'posBill.returnOfId'), // return above what is left on the bill
      w('pos', 'items[0].qty'), // altered bill sells less than came back
      w('pos', 'partyLedgerId', false), // Rule 46(e) reminder (confirm) — not a blocker
      w('stock_negative' as 'pos', 'items[1]'),
    ];
    assert.deepEqual(billBlockers(list).map((x) => `${x.code}:${x.path}`), ['pos:posBill.returnOfId', 'pos:items[0].qty', 'stock_negative:items[1]']);
  });
});
