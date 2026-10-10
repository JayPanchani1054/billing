/**
 * Regression tests from the adversarial review of the print group (cheques, e-payments, sharing).
 * Each test fails if the defect it names comes back. Company Maharashtra, today 15-Apr-2026.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setVoucherOptional } from '../vouchers/service.ts';
import { shareContext } from '../print/share.ts';
import { saveBook } from './books.ts';
import { discardEPaymentBatch, exportEPayments, listEPayments } from './epayment.ts';
import { CHEQUE_PRESETS, layoutIssues, saveBankSettings } from './layouts.ts';
import { chequePrintData } from './printData.ts';
import { chequeRegister } from './register.ts';
import { brs } from '../banking/brs.ts';
import { chequesRoutes } from './routes.ts';
import { chequeKit, chequeOf } from './testkit.ts';

describe('print group review: e-payments', () => {
  it('leaves optional (memorandum) payments out of the payment file list and the export', () => {
    const k = chequeKit();
    const regular = k.pay({ amount: 1_000_00, type: 'neft' });
    const optional = k.pay({ amount: 2_000_00, type: 'neft' });
    setVoucherOptional(k.t.ctx, optional.id, true);
    const list = listEPayments(k.t.db, { from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(list.map((c) => c.voucherId), [regular.id], 'an optional voucher is not a payment to make');
    const res = exportEPayments(k.t.ctx, { voucherIds: [regular.id, optional.id] });
    assert.equal(res.rows, 1);
    assert.deepEqual(res.skipped.map((s) => s.voucherId), [optional.id]);
  });

  it('discards the batch of a file that was never saved (save dialog cancelled), so it is not "already exported"', () => {
    const k = chequeKit();
    const p = k.pay({ amount: 1_000_00, type: 'neft' });
    const res = exportEPayments(k.t.ctx, { voucherIds: [p.id] });
    assert.ok(res.batchId > 0);
    assert.ok(listEPayments(k.t.db, { from: '2026-04-01', to: '2026-04-30' })[0].exportedAt, 'marked after export');
    discardEPaymentBatch(k.t.ctx, { batchId: res.batchId });
    assert.equal(listEPayments(k.t.db, { from: '2026-04-01', to: '2026-04-30' })[0].exportedAt, null, 'the mark is gone');
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM epayment_batch_items'), 0);
    const log = k.t.db.all<{ action: string; entity_type: string }>("SELECT action, entity_type FROM audit_log WHERE entity_type = 'epayment_batch' ORDER BY id");
    assert.deepEqual(log.map((r) => r.action), ['export', 'delete'], 'both the export and its discard are in the edit log');
    assert.throws(() => discardEPaymentBatch(k.t.ctx, { batchId: res.batchId }), /no longer exists|not found/i);
  });

  it('cannot discard a batch made by another user or on another day', () => {
    const k = chequeKit();
    const p = k.pay({ amount: 1_000_00, type: 'neft' });
    const res = exportEPayments(k.t.ctx, { voucherIds: [p.id] });
    k.t.db.run("UPDATE epayment_batches SET created_at = '2026-04-14T10:00:00.000Z' WHERE id = :id", { id: res.batchId });
    assert.throws(() => discardEPaymentBatch(k.t.ctx, { batchId: res.batchId }), /only right after/i);
  });
});

describe('print group review: cheque register as on a date', () => {
  it('a cheque cleared after the "as on" date is still uncleared on that date (and can be stale then)', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 5 });
    const p = k.pay({ amount: 500_00, date: '2026-04-01' });
    assert.equal(chequeOf(k, p.id), '000001');
    k.t.db.run("UPDATE ledger_entries SET bank_date = '2026-08-20' WHERE voucher_id = :v AND instrument_type = 'cheque'", { v: p.id });
    const at = (asOf: string) => chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank, asOf }).rows.find((r) => r.chequeNo === '000001');
    assert.equal(at('2026-05-01')?.status, 'issued', 'cleared only on 20-08');
    assert.equal(at('2026-05-01')?.bankDate, null);
    // 01-04 + 3 months = 01-07: valid through 01-07, stale from 02-07 while still uncleared.
    assert.equal(at('2026-07-01')?.status, 'issued');
    assert.equal(at('2026-07-02')?.status, 'stale');
    assert.equal(at('2026-08-20')?.status, 'cleared');
  });

  it("ties its uncleared total to the BRS 'cheques issued but not presented'", () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 10 });
    const cleared = k.pay({ amount: 1_000_00, date: '2026-04-02' });
    k.pay({ amount: 2_345_67, date: '2026-04-03' }); // uncleared → counts
    const optional = k.pay({ amount: 5_000_00, date: '2026-04-04' }); // optional: not in the books
    setVoucherOptional(k.t.ctx, optional.id, true);
    k.pay({ amount: 7_000_00, date: '2026-04-30' }); // post-dated (after today 15-04): not yet in the books
    k.t.db.run("UPDATE ledger_entries SET bank_date = '2026-04-10' WHERE voucher_id = :v AND instrument_type = 'cheque'", { v: cleared.id });
    const reg = chequeRegister(k.t.db, '2026-04-15', { bankLedgerId: k.L.bank, asOf: '2026-04-15' });
    const b = brs(k.t.db, '2026-04-15', { ledgerId: k.L.bank, asOf: '2026-04-15' });
    assert.equal(b.chequesIssuedNotPresented, 2_345_67);
    assert.equal(reg.totals.unclearedAmount, b.chequesIssuedNotPresented);
    assert.equal(reg.totals.issuedAmount, 1_000_00 + 2_345_67 + 5_000_00 + 7_000_00, 'every leaf written is still listed');
  });

  it('names the payee of every issued cheque with one query (no per-voucher look-up)', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 50 });
    for (let i = 0; i < 20; i++) k.pay({ amount: 100_00 + i });
    const withdrawal = k.withdraw({ amount: 50_00 });
    let queries = 0;
    const db = k.t.db;
    const proxy = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (typeof v === 'function' && ['get', 'all', 'value'].includes(String(prop))) {
          return (...args: unknown[]) => {
            queries++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reg = chequeRegister(proxy, '2026-04-15', { bankLedgerId: k.L.bank });
    const issued = reg.rows.filter((r) => r.status === 'issued');
    assert.equal(issued.length, 21);
    assert.ok(issued.filter((r) => r.voucherId !== withdrawal.id).every((r) => r.payee === 'Supreme Suppliers Private Limited'));
    assert.equal(issued.find((r) => r.voucherId === withdrawal.id)?.payee, 'Self');
    assert.ok(queries < 15, `register used ${queries} queries for 21 cheques`);
  });
});

describe('print group review: cheque layouts keep text out of the MICR band', () => {
  const cts = CHEQUE_PRESETS[0].spec;
  it('every preset is valid', () => {
    for (const p of CHEQUE_PRESETS) assert.deepEqual(layoutIssues(p.spec), [], p.code);
  });
  it('refuses a signatory whose second line ("Authorised Signatory", 10 mm lower) would print in the band', () => {
    // 92 − 16 = 76 mm usable. Signatory at 70: the second line starts at 80 mm → in the band.
    const issues = layoutIssues({ ...cts, signatory: { x: 140, y: 70, w: 58 } });
    assert.ok(issues.some((i) => i.path === 'spec.signatory.y'), JSON.stringify(issues));
  });
  it('a stored layout saved under the older rule keeps its calibrated positions, and printing warns', () => {
    const k = chequeKit();
    const spec = { ...cts, signatory: { x: 140, y: 70, w: 58 }, offsetX: 2 };
    const id = Number(
      k.t.db.run("INSERT INTO cheque_layouts (guid, name, preset, layout, created_at, updated_at) VALUES ('g-old', 'Old HDFC', 'cts2010', :l, 'x', 'x')", { l: JSON.stringify(spec) }).lastInsertRowid,
    );
    saveBankSettings(k.t.ctx, { bankLedgerId: k.L.bank, layoutId: id });
    const p = k.pay({ amount: 1_000_00, chequeNo: '000123' });
    const c = chequePrintData(k.t.ctx, [p.id]).cheques[0];
    assert.equal(c.layoutName, 'Old HDFC');
    assert.deepEqual([c.spec.signatory.y, c.spec.offsetX], [70, 2], 'not silently replaced by the standard preset');
    assert.ok(c.warnings.some((w) => /Old HDFC.*needs correcting.*MICR band/.test(w)), c.warnings.join(' | '));
  });

  it('refuses a line whose text (not just its top edge) runs into the band', () => {
    // 11 pt text is ≈ 3.9 mm tall: starting at 75 mm it ends at ≈ 78.9 mm.
    const issues = layoutIssues({ ...cts, words2: { x: 10, y: 75, w: 140 } });
    assert.ok(issues.some((i) => i.path === 'spec.words2.y'), JSON.stringify(issues));
    assert.deepEqual(layoutIssues({ ...cts, words2: { x: 10, y: 72, w: 140 } }), []);
  });
});

describe('print group review: access and sharing', () => {
  it('cheque book save is open at route level to masters.view (create / alter are checked in the service)', () => {
    assert.equal(chequesRoutes['cheques.book.save'].access, 'masters.view');
  });

  it('a voucher without a party is never addressed to the bank ledger that has an e-mail address', () => {
    const k = chequeKit();
    k.t.db.run("UPDATE ledgers SET email = 'branch@hdfc.example', mobile = '9123456780' WHERE id = :id", { id: k.L.bank });
    // A cash withdrawal (Contra) has no party: the bank's branch contact must not be offered.
    const w = k.withdraw({ amount: 5_000_00 });
    assert.equal(k.t.db.value('SELECT party_ledger_id FROM vouchers WHERE id = :id', { id: w.id }), null, 'exercises the inferred-party path');
    const c = shareContext(k.t.ctx, { voucherId: w.id });
    assert.equal(c.email, null);
    assert.equal(c.mobile, null);
    assert.equal(c.partyLedgerId, null);
  });
});
