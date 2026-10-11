/**
 * The Cheque Leaf Register's meter and stat (SPEC-21 §5, §4.8): the meter's whole is the book's leaves
 * (= the rows of the All leaves view), the gates, the takeaway, and "a stat never repeats a visible total".
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChequeLeafStatus, ChequeRegisterResult, ChequeRegisterRow } from '../../../../shared/types/cheques.ts';
import { assertSpec, enoughData, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { leafMeter, leafStat, leafTableTotal, leafTakeaway, meterBook } from './charts.ts';

function leaf(n: number, status: ChequeLeafStatus, amount: number | null = null): ChequeRegisterRow {
  return {
    key: `1:${n}`,
    bookId: 1,
    bookName: '000501–000525',
    chequeNo: String(n).padStart(6, '0'),
    status,
    postDated: false,
    voucherId: amount === null ? null : n,
    voucherLabel: amount === null ? null : `Payment ${n}`,
    voucherDate: null,
    chequeDate: null,
    payee: null,
    amount,
    bankDate: null,
    printedAt: null,
    reason: null,
  };
}

/** A book of 25 leaves: 10 issued (2 stale), 3 cleared, 1 cancelled, the rest unused — as the core totals it. */
function book(): ChequeRegisterResult {
  const rows: ChequeRegisterRow[] = [];
  for (let n = 501; n <= 525; n++) {
    const i = n - 501;
    const status: ChequeLeafStatus = i < 8 ? 'issued' : i < 10 ? 'stale' : i < 13 ? 'cleared' : i === 13 ? 'cancelled' : 'unused';
    rows.push(leaf(n, status, status === 'issued' || status === 'stale' || status === 'cleared' ? (i + 1) * 1_000_00 : null));
  }
  const count = (s: ChequeLeafStatus) => rows.filter((r) => r.status === s).length;
  const issuedAmount = rows.reduce((a, r) => a + (r.amount ?? 0), 0);
  const unclearedAmount = rows.filter((r) => r.status === 'issued' || r.status === 'stale').reduce((a, r) => a + (r.amount ?? 0), 0);
  return {
    bankLedgerId: 1,
    bankLedgerName: 'HDFC Bank',
    asOf: '2026-10-11',
    rows,
    totals: { leaves: rows.length, unused: count('unused'), issued: count('issued'), cleared: count('cleared'), stale: count('stale'), cancelled: count('cancelled'), issuedAmount, unclearedAmount },
  };
}

describe('Cheque Leaf Register — meter "Leaves used N of M"', () => {
  test('only with one book chosen; its whole = the book\'s leaves = the rows of the All leaves view', () => {
    const r = book();
    assert.equal(leafMeter(r, null), null, 'all books of a bank are not one stock of leaves');
    const spec = leafMeter(r, '000501–000525');
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.kind, 'meter');
    assert.equal(spec.total, r.rows.length);
    assert.equal(spec.total, r.totals.leaves);
    assert.equal(spec.series[0].values[0], r.totals.leaves - r.totals.unused, 'used = issued + stale + cleared + cancelled');
    assert.equal(spec.series[0].values[0], r.totals.issued + r.totals.stale + r.totals.cleared + r.totals.cancelled);
    assert.equal(spec.takeaway, '11 of 25 leaves left in 000501–000525');
    assert.equal(spec.activate, undefined, 'a meter is static (role=img)');
  });

  test("2.1.1: a bank's only book is the meter's book without choosing it — unless the register holds other leaves", () => {
    const r = book();
    const only = [{ id: 7, name: '000501–000525', leaves: 25 }];
    // The young shop's one cheque book: the register opens on all leaves of the bank and still draws.
    assert.equal(meterBook(only, null, r.totals), '000501–000525');
    const spec = leafMeter(r, meterBook(only, null, r.totals));
    assert.ok(spec && enoughData(spec));
    assert.equal(spec.total, r.totals.leaves);
    // A cheque issued outside the book (typed by hand): the register is not one stock of leaves.
    assert.equal(meterBook(only, null, { leaves: 26 }), null);
    // Two books together are not one stock of leaves; a chosen book always is.
    const two = [...only, { id: 8, name: '000526–000550', leaves: 25 }];
    assert.equal(meterBook(two, null, { leaves: 50 }), null);
    assert.equal(meterBook(two, 8, { leaves: 25 }), '000526–000550');
    assert.equal(meterBook(two, 9, { leaves: 25 }), null, 'a book id not (yet) in the list');
    assert.equal(meterBook([], null, { leaves: 0 }), null);
    assert.equal(meterBook([{ id: 7, name: 'Empty', leaves: 0 }], null, { leaves: 0 }), null);
  });

  test('none while no leaf is used (both meter parts must be > 0) or the book is empty', () => {
    const fresh = book();
    fresh.totals = { ...fresh.totals, unused: fresh.totals.leaves, issued: 0, stale: 0, cleared: 0, cancelled: 0 };
    assert.equal(leafMeter(fresh, 'New book'), null);
    const empty = book();
    empty.totals = { ...empty.totals, leaves: 0, unused: 0 };
    assert.equal(leafMeter(empty, 'Empty'), null);
  });

  test('a used-up book still draws (full track) and says to order a new one', () => {
    const r = book();
    r.totals = { ...r.totals, unused: 0 };
    const spec = leafMeter(r, 'Book 1');
    assert.ok(spec && enoughData(spec));
    assert.equal(spec.takeaway, 'No leaf left in Book 1 — order a new book');
  });

  test('takeaway warns when few leaves are left; stays within 90 characters', () => {
    assert.equal(leafTakeaway(3, 25, 'B'), '3 of 25 leaves left in B — order a new book');
    assert.equal(leafTakeaway(6, 25, 'B'), '6 of 25 leaves left in B');
    assert.equal(leafTakeaway(1, 1, 'B'), '1 of 1 leaf left in B — order a new book');
    assert.ok(leafTakeaway(20, 100, 'X'.repeat(200)).length <= 90);
  });
});

describe('Cheque Leaf Register — stat in words', () => {
  test('issued, not cleared ₹x · stale N — the Amount total of the table is never repeated', () => {
    const r = book();
    const stat = leafStat(r, true);
    assert.deepEqual(
      stat.map((s) => [s.id, s.value, s.tone ?? null]),
      [
        ['uncleared', r.totals.unclearedAmount, null],
        ['stale', '2 cheques', 'danger'],
      ],
    );
    const money = stat.map((s) => s.value).filter((v): v is number => typeof v === 'number');
    assert.equal(statRepeatsTotal(money, [leafTableTotal(r)]), false);
  });

  test('the Issued view whose total IS the uncleared figure: the stat leaves it out', () => {
    const r = book();
    const issuedOnly = { ...r, rows: r.rows.filter((x) => x.status === 'issued' || x.status === 'stale') };
    assert.equal(leafTableTotal(issuedOnly), r.totals.unclearedAmount);
    assert.ok(!leafStat(issuedOnly, true).some((s) => s.id === 'uncleared'));
  });

  test('without a chosen book (no meter) the unused leaves join the stat; zeros are left out', () => {
    const r = book();
    assert.deepEqual(leafStat(r, false).map((s) => [s.id, s.value]), [
      ['uncleared', r.totals.unclearedAmount],
      ['stale', '2 cheques'],
      ['unused', '11 leaves'],
    ]);
    const clean = book();
    clean.totals = { ...clean.totals, unclearedAmount: 0, stale: 0, unused: 0 };
    assert.deepEqual(leafStat(clean, false), []);
  });
});
