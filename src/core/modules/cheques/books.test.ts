/**
 * Cheque books, automatic leaf numbers on Payment / Contra (voucher hook), leaf cancellation and the
 * cheque register (issued / cleared / stale / cancelled / unused). Today: 15-Apr-2026.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveFeatures } from '../company/service.ts';
import { cancelVoucher, deleteVoucher, saveVoucher } from '../vouchers/service.ts';
import { cancelLeaf, deleteBook, listBooks, nextLeaf, restoreLeaf, saveBook } from './books.ts';
import { recordChequePrints } from './printData.ts';
import { chequeRegister } from './register.ts';
import { chequeKit, chequeOf } from './testkit.ts';

describe('cheque books', () => {
  it('creates books, refuses overlaps / bad ranges / non-bank ledgers, names them by range', () => {
    const k = chequeKit();
    const b = saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 101, toNo: 150 });
    assert.equal(b.name, '000101–000150');
    assert.deepEqual([b.leaves, b.unused, b.nextNo], [50, 50, '000101']);
    assert.throws(() => saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 150, toNo: 160 }), /overlap the cheque book “000101–000150”/);
    assert.throws(() => saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 200, toNo: 190 }), /same as or after the first/);
    assert.throws(() => saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 20_000 }), /at most 10,000 leaves/);
    assert.throws(() => saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 990, toNo: 1000, digits: 3 }), /more than 3 digits/);
    assert.throws(() => saveBook(k.t.ctx, { bankLedgerId: k.L.supplier, fromNo: 1, toNo: 10 }), /only for ledgers under Bank Accounts or Bank OD/);
    const audit = k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity_type = 'cheque_book' AND action = 'create'");
    assert.equal(audit, 1);
  });

  it('is gated by F11 › Cheque printing on the routes; the hook does nothing when it is off', () => {
    const k = chequeKit({ chequePrinting: false });
    k.t.db.run(
      `INSERT INTO cheque_books (guid, bank_ledger_id, name, from_no, to_no, digits, is_active, created_at, updated_at)
       VALUES ('g1', :b, 'B', 1, 10, 6, 1, 'x', 'x')`,
      { b: k.L.bank },
    );
    const p = k.pay({ amount: 500_00 });
    assert.equal(chequeOf(k, p.id), null, 'no number filled in');
  });
});

describe('automatic cheque numbers (voucher hook)', () => {
  it('fills the next unused leaf in order, skips typed and cancelled leaves, keeps the number on alteration', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 101, toNo: 105 });
    const p1 = k.pay({ amount: 1_180_00 });
    assert.equal(chequeOf(k, p1.id), '000101');
    k.pay({ amount: 100_00, chequeNo: '000103' }); // typed by hand
    cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '102', reason: 'Spoilt while writing' });
    const p3 = k.pay({ amount: 200_00 });
    assert.equal(chequeOf(k, p3.id), '000104', '102 cancelled, 103 typed');
    // Alter p1 (amount): its own leaf stays.
    const stored = k.t.db.value<string>('SELECT meta FROM vouchers WHERE id = :id', { id: p1.id }) ?? '{}';
    const input = (JSON.parse(stored) as { input: Parameters<typeof saveVoucher>[1] }).input;
    const updatedAt = k.t.db.value<string>('SELECT updated_at FROM vouchers WHERE id = :id', { id: p1.id });
    saveVoucher(k.t.ctx, { ...input, id: p1.id, expectedUpdatedAt: updatedAt, acknowledgeWarnings: true, ledgers: [{ ledgerId: k.L.supplier, amount: 1_200_00 }, { ledgerId: k.L.bank, amount: -1_200_00, instrument: { type: 'cheque', number: '000101' } }] });
    assert.equal(chequeOf(k, p1.id), '000101');
    assert.deepEqual(nextLeaf(k.t.db, k.L.bank), { bookId: listBooks(k.t.db)[0].id, chequeNo: '000105' });
    const p5 = k.pay({ amount: 300_00 });
    assert.equal(chequeOf(k, p5.id), '000105');
    // Book used up: the voucher saves without a number and says why.
    const p6 = k.pay({ amount: 400_00 });
    assert.equal(chequeOf(k, p6.id), null);
    assert.ok(p6.warnings.some((w) => w.code === 'cheque' && /Every leaf of the cheque books of HDFC Bank is used/.test(w.message)));
    const book = listBooks(k.t.db)[0];
    assert.deepEqual([book.issued, book.cancelled, book.unused, book.nextNo], [4, 1, 0, null]);
  });

  it('self cheques on a Contra get leaves too; a deposit (bank debit) does not', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 9, digits: 6 });
    const c = k.withdraw({ amount: 10_000_00 });
    assert.equal(chequeOf(k, c.id), '000001');
  });

  it('warns (confirm) when a typed leaf is already issued, cancelled or outside the books', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 101, toNo: 110 });
    const p1 = k.pay({ amount: 100_00 });
    const dup = (): ReturnType<typeof saveVoucher> =>
      saveVoucher(k.t.ctx, {
        voucherTypeId: k.vt.payment,
        date: '2026-04-15',
        mode: 'ledger',
        ledgers: [{ ledgerId: k.L.rent, amount: 50_00 }, { ledgerId: k.L.bank, amount: -50_00, instrument: { type: 'cheque', number: '000101' } }],
      });
    assert.throws(dup, (err: unknown) => {
      const e = err as { code?: string; message?: string };
      return e.code === 'BUSINESS_RULE' && /Cheque 000101 of HDFC Bank is already issued on Payment/.test(e.message ?? '');
    });
    void p1;
    cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '000105', reason: 'Torn' });
    const viaCancelled = k.pay({ amount: 10_00, chequeNo: '000105' });
    assert.ok(viaCancelled.warnings.some((w) => w.level === 'confirm' && /was cancelled on 15-Apr-2026 \(Torn\)/.test(w.message)));
    const outside = k.pay({ amount: 10_00, chequeNo: '900001' });
    assert.ok(outside.warnings.some((w) => w.level === 'info' && /not in any cheque book of HDFC Bank/.test(w.message)));
  });

  it('cancelling a voucher cancels its leaf; deleting frees it unless it was printed', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 5 });
    const a = k.pay({ amount: 100_00 }); // 000001
    const b = k.pay({ amount: 200_00 }); // 000002
    const c = k.pay({ amount: 300_00 }); // 000003
    cancelVoucher(k.t.ctx, a.id, 'Wrong party');
    deleteVoucher(k.t.ctx, b.id);
    recordChequePrints(k.t.ctx, { items: [{ voucherId: c.id, lineNo: 2 }] });
    deleteVoucher(k.t.ctx, c.id);
    const reg = chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank });
    assert.deepEqual(
      reg.rows.map((r) => [r.chequeNo, r.status]),
      [
        ['000001', 'cancelled'],
        ['000002', 'unused'],
        ['000003', 'cancelled'],
        ['000004', 'unused'],
        ['000005', 'unused'],
      ],
    );
    assert.match(reg.rows[0].reason ?? '', /Payment .* cancelled/);
    assert.match(reg.rows[2].reason ?? '', /^Printed for Payment .* \(spoilt\)$/);
    // The next leaf skips both cancelled ones.
    assert.equal(chequeOf(k, k.pay({ amount: 1_00 }).id), '000002');
  });
});

describe('cheque register', () => {
  it('issued, cleared (BRS bank date), stale (> 3 months), post-dated, cancelled, unused — with totals', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 11, toNo: 16 });
    const issued = k.pay({ amount: 1_000_00 }); // 000011, 15-Apr-2026
    const cleared = k.pay({ amount: 2_000_00 }); // 000012
    k.t.db.run("UPDATE ledger_entries SET bank_date = '2026-04-15' WHERE voucher_id = :id AND instrument_type = 'cheque'", { id: cleared.id });
    // Cheque dated 1-Jan-2026, still not cleared on 15-Apr-2026: 3 months ended 1-Apr-2026 → stale.
    k.pay({ amount: 3_000_00, instrumentDate: '2026-01-01' }); // 000013
    k.pay({ amount: 4_000_00, instrumentDate: '2026-05-10' }); // 000014, post-dated cheque
    cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '000016', reason: 'Lost' });
    const reg = chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank });
    const by = Object.fromEntries(reg.rows.map((r) => [r.chequeNo, r]));
    assert.equal(by['000011'].status, 'issued');
    assert.equal(by['000011'].payee, 'Supreme Suppliers Private Limited', 'name on cheque from the payee details');
    assert.equal(by['000011'].voucherId, issued.id);
    assert.equal(by['000012'].status, 'cleared');
    assert.equal(by['000012'].bankDate, '2026-04-15');
    assert.equal(by['000013'].status, 'stale');
    assert.equal(by['000014'].status, 'issued');
    assert.equal(by['000014'].postDated, true);
    assert.equal(by['000015'].status, 'unused');
    assert.equal(by['000016'].status, 'cancelled');
    // 1,000 + 2,000 + 3,000 + 4,000 = 10,000.00 issued; uncleared 10,000 − 2,000 = 8,000.00 (all four
    // vouchers are dated 15-Apr and in the books — the BRS's 'issued but not presented' on that date)
    assert.deepEqual(reg.totals, { leaves: 6, unused: 1, issued: 2, cleared: 1, stale: 1, cancelled: 1, issuedAmount: 10_000_00, unclearedAmount: 8_000_00 });
    assert.deepEqual(chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank, status: 'stale' }).rows.map((r) => r.chequeNo), ['000013']);
    // As on 30-Jun-2026 the April cheque is not stale yet (valid to 15-Jul-2026); the January one is.
    assert.equal(chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank, asOf: '2026-06-30' }).rows.find((r) => r.chequeNo === '000011')?.status, 'issued');
  });

  it('lists cheques issued outside every book; re-opens a cancelled leaf; books with used leaves cannot be deleted', () => {
    const k = chequeKit();
    const book = saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 3 });
    k.pay({ amount: 10_00, chequeNo: '777777' });
    const reg = chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank });
    assert.deepEqual(reg.rows.map((r) => [r.chequeNo, r.bookId, r.status]).at(-1), ['777777', null, 'issued']);
    cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '1', reason: 'Spoilt' });
    assert.throws(() => deleteBook(k.t.ctx, book.id), /already used or cancelled/);
    assert.throws(() => cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '777777', reason: 'x' }), /is issued on Payment/);
    restoreLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '000001' });
    deleteBook(k.t.ctx, book.id);
    assert.equal(listBooks(k.t.db).length, 0);
    saveFeatures(k.t.ctx, { chequePrinting: false });
  });
});
