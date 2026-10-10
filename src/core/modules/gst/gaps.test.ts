/**
 * Regression tests of the final-wave gap fixes in the gst module (each fails if its defect returns):
 * set-off and "credit not in the books", the filed GSTR-3B protection and the Rule 37 180-day check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstSetoffResult, Gstr3bChangeRow, Rule37Result } from '../../../shared/types/gst-plus.ts';
import type { Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { AppError } from '../../lib/errors.ts';
import { deleteVoucher, duplicateVoucher, loadVoucherRow, saveVoucher, storedInput } from '../vouchers/service.ts';
import { entryMap, save, setupKit } from '../vouchers/testkit.ts';

const bal = (k: ReturnType<typeof setupKit>, ledgerName: string): number =>
  k.t.db.value<number>('SELECT COALESCE(SUM(le.amount), 0) FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE l.name = :n', { n: ledgerName }) ?? 0;

describe('GST set-off — credit not in the books', () => {
  it('is credited to "GST Credit Not in Books", never to the Input ledgers', async () => {
    const k = setupKit({ today: '2026-06-25' });
    // May: sale 1,00,000 @18% intra → CGST 9,000 + SGST 9,000.
    save(k, { voucherTypeId: k.vt.sales, date: '2026-05-05', mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 1_00_000_00 }] });
    // Local purchase 10,000 @5% → CGST 250 + SGST 250 in the books.
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    // The portal also holds CGST 5,000 the books do not (the balance when the books started).
    await k.t.callOk(routes, 'gst.gstr3b.saveAdjustments', { period: '052026', values: { creditLedgerBalance: { cgst: 5_000_00 } } });

    const s = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '052026' });
    // CGST credit used: 250 (books) + 5,000 (not in the books) = 5,250.
    assert.deepEqual(s.credit.filter((c) => c.from === 'cgst'), [{ from: 'cgst', to: 'cgst', amount: 5_250_00 }]);
    assert.ok(s.notes.some((n) => /GST Credit Not in Books/.test(n)), 'the screen explains where it goes');
    // Cash: CGST 9,000 − 5,250 = 3,750; SGST 9,000 − 250 = 8,750.
    await k.t.callOk<VoucherSaveResult>(routes, 'gst.challan.post', {
      date: '2026-06-18', bankLedgerId: k.L.bank, cpin: '26052700012345', period: '052026',
      heads: [{ head: 'cgst', minor: 'tax', amount: 3_750_00 }, { head: 'sgst', minor: 'tax', amount: 8_750_00 }],
    });
    const posted = await k.t.callOk<VoucherSaveResult>(routes, 'gst.setoff.post', { period: '052026', date: '2026-06-20' });
    const e = entryMap(k, posted.id);
    // Dr Output 9,000 + 9,000 = Cr Input CGST 250 + Input SGST 250 + Not in Books 5,000 + Cash 12,500.
    assert.deepEqual(
      [e['Output CGST'], e['Output SGST/UTGST'], e['Input CGST'], e['Input SGST/UTGST'], e['GST Credit Not in Books'], e['GST Electronic Cash Ledger']],
      [9_000_00, 9_000_00, -250_00, -250_00, -5_000_00, -12_500_00],
    );
    // The Input ledgers are squared off, never driven into credit.
    assert.equal(bal(k, 'Input CGST'), 0);
    assert.equal(bal(k, 'Input SGST/UTGST'), 0);
    assert.equal(bal(k, 'Output CGST'), 0);
    k.t.close();
  });

  it('without a "not in the books" entry the journal is unchanged (all credit from the Input ledgers)', async () => {
    const k = setupKit({ today: '2026-06-25' });
    save(k, { voucherTypeId: k.vt.sales, date: '2026-05-05', mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 10_000_00 }] });
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    // A June purchase (dated before the set-off) must not be counted as May's credit.
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-06-02', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-2', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    await k.t.callOk<VoucherSaveResult>(routes, 'gst.challan.post', {
      date: '2026-06-18', bankLedgerId: k.L.bank, cpin: '26052700012346', period: '052026',
      heads: [{ head: 'cgst', minor: 'tax', amount: 650_00 }, { head: 'sgst', minor: 'tax', amount: 650_00 }],
    });
    const posted = await k.t.callOk<VoucherSaveResult>(routes, 'gst.setoff.post', { period: '052026', date: '2026-06-20' });
    const e = entryMap(k, posted.id);
    // CGST 900 = 250 credit + 650 cash; nothing to the Not-in-Books ledger.
    assert.deepEqual([e['Output CGST'], e['Input CGST'], e['GST Credit Not in Books']], [900_00, -250_00, undefined]);
    k.t.close();
  });
});

// ───────────────────────────── Filed GSTR-3B ─────────────────────────────


const itcOth = (s: Gstr3bSummary) => s.itc.available.find((r) => r.ty === 'OTH')!;
const rev2 = (s: Gstr3bSummary) => s.itc.reversed.find((r) => r.row === '4(B)(2)')!;

describe('Filed GSTR-3B — a period is protected like a filed GSTR-1', () => {
  it('altering, adding and deleting a purchase of the filed period needs confirmation, is logged and reported in the next GSTR-3B; the filed period keeps its figures', async () => {
    const k = setupKit({ today: '2026-07-25' });
    // May: purchase 10,000 @5% intra → CGST 250 + SGST 250.
    const p1 = save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    const may0 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    assert.equal(itcOth(may0).cgst, 250_00);
    await k.t.callOk(routes, 'gst.filing.mark', { form: 'gstr3b', period: '052026', filedOn: '2026-06-20' });

    // Alter: 200 bags (CGST 500). Without confirmation it is stopped with the explanation.
    const row = loadVoucherRow(k.t.db, p1.id)!;
    const altered = { ...storedInput(k.t.db, row), id: p1.id, expectedUpdatedAt: row.updated_at, items: [{ itemId: k.I.rice, qty: 200, rate: 100 }] };
    assert.throws(
      () => saveVoucher(k.t.ctx, altered),
      (e: unknown) => e instanceof AppError && /GSTR-3B for May 2026 was filed/.test(e.message) && /Jun 2026/.test(e.message),
    );
    saveVoucher(k.t.ctx, { ...altered, acknowledgeWarnings: true });
    let log = await k.t.callOk<Gstr3bChangeRow[]>(routes, 'gst.gstr3b.changes', { period: '062026' });
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].kind, log[0].originalPeriod, log[0].itcDelta.cgst, log[0].itcDelta.sgst], ['altered', '052026', 250_00, 250_00]);

    // May keeps the filed 250; June reports the extra 250 in 4(A)(5).
    const may1 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    assert.equal(itcOth(may1).cgst, 250_00, 'filed period unchanged');
    const jun1 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '062026' });
    assert.equal(itcOth(jun1).cgst, 250_00, 'the extra credit is claimed in June');
    assert.ok(jun1.notes.some((n) => /GSTR-3B was already filed/.test(n)));

    // A purchase entered now but dated in May: confirmation, then listed as added.
    assert.throws(
      () => saveVoucher(k.t.ctx, { voucherTypeId: k.vt.purchase, date: '2026-05-20', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-2', items: [{ itemId: k.I.rice, qty: 10, rate: 100 }] }),
      (e: unknown) => e instanceof AppError && /already been filed/.test(e.message),
    );
    const p2 = save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-20', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-2', items: [{ itemId: k.I.rice, qty: 10, rate: 100 }] });
    log = await k.t.callOk<Gstr3bChangeRow[]>(routes, 'gst.gstr3b.changes', { period: '062026' });
    assert.deepEqual(log.map((r) => r.kind).sort(), ['added', 'altered']);
    const may2 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    assert.equal(itcOth(may2).cgst, 250_00, 'still the filed figure');
    const jun2 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '062026' });
    assert.equal(itcOth(jun2).cgst, 250_00 + 25_00, '+ 25 of the late purchase');

    // Deleting the first purchase: logged as removed; June now reverses the 250 claimed in May (4(B)(2)).
    deleteVoucher(k.t.ctx, p1.id);
    const jun3 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '062026' });
    assert.equal(itcOth(jun3).cgst, 25_00);
    assert.equal(rev2(jun3).cgst, 250_00);
    const may3 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    assert.equal(itcOth(may3).cgst, 250_00, 'May still shows what was filed');
    log = await k.t.callOk<Gstr3bChangeRow[]>(routes, 'gst.gstr3b.changes', { period: '062026' });
    const removed = log.find((r) => r.kind === 'removed')!;
    assert.equal(removed.voucherId, null, 'the voucher is gone; its log row stays');
    assert.equal(removed.itcDelta.cgst, -250_00);

    // Unmarking the filed return is refused while changes point at it.
    const un = await k.t.call(routes, 'gst.filing.unmark', { form: 'gstr3b', period: '052026' });
    assert.equal(un.ok, false);
    // A voucher with no GST effect (a payment) dated in May is not stopped.
    save(k, { voucherTypeId: k.vt.payment, date: '2026-05-25', mode: 'ledger', ledgers: [{ ledgerId: k.L.supplier, amount: 100_00 }, { ledgerId: k.L.cash, amount: -100_00 }] });
    void p2;
    k.t.close();
  });
});

// ───────────────────────────── Rule 37 ─────────────────────────────

describe('Rule 37 — purchases not paid within 180 days', () => {
  it('reports the credit for the unpaid part, posts the reversal through a stat adjustment, then the reclaim once paid', async () => {
    const k = setupKit({ today: '2026-12-15' });
    // 10-Apr-2026: purchase 10,000 @5% intra → invoice 10,500; CGST 250 + SGST 250.
    const p = save(k, { voucherTypeId: k.vt.purchase, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'R-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    // Paid 6,300 against it (60%); 4,200 (40%) unpaid.
    save(k, {
      voucherTypeId: k.vt.payment, date: '2026-05-10', mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.supplier, amount: 6_300_00, billAllocations: [{ refType: 'against', billName: 'R-1', amount: 6_300_00 }] },
        { ledgerId: k.L.bank, amount: -6_300_00 },
      ],
    });
    // Not yet 180 days on 06-Oct-2026 (day 179 → nothing); on 15-Dec-2026 it is overdue.
    const early = await k.t.callOk<Rule37Result>(routes, 'gst.rule37.report', { asOf: '2026-10-06' });
    assert.equal(early.rows.length, 0);
    const r = await k.t.callOk<Rule37Result>(routes, 'gst.rule37.report', { asOf: '2026-12-15' });
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    // Deadline 10-Apr + 180 days = 07-Oct-2026 → reversed in GSTR-3B for November 2026.
    assert.deepEqual([row.voucherId, row.value, row.unpaid, row.deadline, row.reportPeriod], [p.id, 10_500_00, 4_200_00, '2026-10-07', '112026']);
    // 250 × 4,200 ÷ 10,500 = 100 per head.
    assert.deepEqual([row.due.cgst, row.due.sgst, row.toReverse.cgst, row.toReverse.sgst], [100_00, 100_00, 100_00, 100_00]);

    const j = await k.t.callOk<VoucherSaveResult>(routes, 'gst.rule37.post', { asOf: '2026-12-15', date: '2026-12-15', kind: 'reversal' });
    const e = entryMap(k, j.id);
    assert.deepEqual([e['ITC Reversed (GST)'], e['Input CGST'], e['Input SGST/UTGST']], [200_00, -100_00, -100_00]);
    assert.equal(k.t.db.value('SELECT nature FROM gst_stat_lines WHERE voucher_id = :id LIMIT 1', { id: j.id }), 'itc_reversal_r37');
    // Nothing more to reverse: the link is counted.
    const after = await k.t.callOk<Rule37Result>(routes, 'gst.rule37.report', { asOf: '2026-12-15' });
    assert.deepEqual([after.rows[0].reversed.cgst, after.rows[0].toReverse.cgst], [100_00, 0]);
    const again = await k.t.call(routes, 'gst.rule37.post', { asOf: '2026-12-15', date: '2026-12-15', kind: 'reversal' });
    assert.equal(again.ok, false);
    // Duplicating the journal (Alt+2) keeps the nature but never the invoices (no double reversal).
    const dup = duplicateVoucher(k.t.ctx, j.id);
    assert.equal(dup.gstDetails?.adjustment?.nature, 'itc_reversal_r37');
    assert.equal(dup.gstDetails?.adjustment?.rule37, undefined);
    // December GSTR-3B shows it in 4(B)(2).
    const dec = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '122026' });
    assert.equal(rev2(dec).cgst, 100_00);

    // Paid in full later → reclaim the 100 + 100 (Rule 37(4)).
    save(k, {
      voucherTypeId: k.vt.payment, date: '2026-12-20', mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.supplier, amount: 4_200_00, billAllocations: [{ refType: 'against', billName: 'R-1', amount: 4_200_00 }] },
        { ledgerId: k.L.bank, amount: -4_200_00 },
      ],
    });
    const paid = await k.t.callOk<Rule37Result>(routes, 'gst.rule37.report', { asOf: '2026-12-31' });
    assert.deepEqual([paid.rows[0].unpaid, paid.rows[0].toReclaim.cgst, paid.rows[0].toReverse.cgst], [0, 100_00, 0]);
    const rc = await k.t.callOk<VoucherSaveResult>(routes, 'gst.rule37.post', { asOf: '2026-12-31', date: '2026-12-31', kind: 'reclaim' });
    assert.deepEqual([entryMap(k, rc.id)['Input CGST'], entryMap(k, rc.id)['ITC Reversed (GST)']], [100_00, -200_00]);
    const done = await k.t.callOk<Rule37Result>(routes, 'gst.rule37.report', { asOf: '2026-12-31' });
    assert.equal(done.rows.length, 0, 'paid and nothing left reversed');
    k.t.close();
  });
});
