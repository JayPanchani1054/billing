/**
 * Return filing status and GSTR-1 amendments, end to end through the dispatcher: a document of a filed
 * GSTR-1 period is altered (logged and reported in 9A of the next unfiled period; the filed period keeps
 * its filed figures in GSTR-3B), cannot be deleted, and a document added later is reported too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstAmendmentRow, GstFiling } from '../../../shared/types/gst-plus.ts';
import type { GstJsonFile, Gstr1Summary, Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import type { VoucherDetail, VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { setupKit } from '../vouchers/testkit.ts';

const osup = (s: Gstr3bSummary) => {
  const r = s.supplies.find((x) => x.key === 'osup_det')!;
  return [r.taxable, r.cgst, r.sgst];
};

describe('GSTR-1 amendments after filing', () => {
  it('logs an alteration of a filed invoice, reports it in 9A of the next period and keeps the filed figures', async () => {
    const k = setupKit({ today: '2026-06-10' });
    const sale = (over: Partial<VoucherInput>): VoucherInput => ({
      voucherTypeId: k.vt.sales,
      date: '2026-04-05',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      ledgers: [{ ledgerId: k.L.consult, amount: 10_000_00 }],
      ...over,
    });
    const s1 = await k.t.callOk<VoucherSaveResult>(routes, 'vouchers.save', sale({}));
    const filed = await k.t.callOk<GstFiling>(routes, 'gst.filing.mark', { form: 'gstr1', period: '042026', filedOn: '2026-05-11', arn: 'AA270526123456X' });
    assert.equal(filed.periodLabel, 'Apr 2026');
    await k.t.callOk(routes, 'gst.filing.mark', { form: 'gstr3b', period: '042026', filedOn: '2026-05-20' });

    // Alter: 10,000 → 12,000. The save asks for confirmation first.
    const detail = await k.t.callOk<VoucherDetail>(routes, 'vouchers.get', { id: s1.id });
    const altered = { ...detail.input, ledgers: [{ ledgerId: k.L.consult, amount: 12_000_00 }] };
    const first = await k.t.call(routes, 'vouchers.save', altered);
    assert.equal(first.ok, false);
    assert.match(!first.ok ? first.error.message : '', /GSTR-1 for Apr 2026 was filed/);
    await k.t.callOk(routes, 'vouchers.save', { ...altered, acknowledgeWarnings: true });

    const log = await k.t.callOk<GstAmendmentRow[]>(routes, 'gst.amendments.list', {});
    assert.equal(log.length, 1);
    const a = log[0];
    // May is the first period after April that is not filed (and not after June, the working date's period).
    assert.deepEqual([a.kind, a.table, a.originalPeriod, a.amendPeriod, a.origNumber], ['amended', '9A', '042026', '052026', s1.number]);
    // Δ = 12,000 − 10,000 taxable; CGST / SGST 1,080 − 900 = 180 each.
    assert.deepEqual([a.delta.taxable, a.delta.cgst, a.delta.sgst], [2_000_00, 180_00, 180_00]);

    // May's GSTR-1 reports it in 9A (JSON b2ba with the original number / date).
    const may = await k.t.callOk<Gstr1Summary>(routes, 'gst.gstr1.summary', { period: '052026' });
    assert.equal(may.amendments?.invoices.length, 1);
    const json = await k.t.callOk<GstJsonFile>(routes, 'gst.gstr1.json', { period: '052026' });
    const b2ba = (JSON.parse(json.json) as { b2ba: Array<{ inv: Array<{ oinum: string; oidt: string; val: number; inum: string }> }> }).b2ba;
    assert.deepEqual([b2ba[0].inv[0].oinum, b2ba[0].inv[0].oidt, b2ba[0].inv[0].val], [s1.number, '05-04-2026', 14160]);

    // GSTR-3B: April keeps what was filed; May carries the difference.
    const apr3b = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '042026' });
    assert.deepEqual(osup(apr3b), [10_000_00, 900_00, 900_00]);
    const may3b = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    assert.deepEqual(osup(may3b), [2_000_00, 180_00, 180_00]);
    // April's GSTR-1 totals also keep the filed figures.
    const apr1 = await k.t.callOk<Gstr1Summary>(routes, 'gst.gstr1.summary', { period: '042026' });
    assert.deepEqual([apr1.totals.taxable, apr1.totals.cgst], [10_000_00, 900_00]);
    assert.ok(apr1.notes.some((n) => /changed or added afterwards/.test(n)));

    // A filed invoice can be neither deleted nor cancelled.
    const del = await k.t.call(routes, 'vouchers.delete', { id: s1.id });
    assert.equal(!del.ok && del.error.code, 'BUSINESS_RULE');
    assert.match(!del.ok ? del.error.message : '', /issue a credit note/i);
    const cancel = await k.t.call(routes, 'vouchers.cancel', { id: s1.id, reason: 'mistake' });
    assert.equal(!cancel.ok && cancel.error.code, 'BUSINESS_RULE');

    // A second change in the same amendment period updates the row (original kept).
    const d2 = await k.t.callOk<VoucherDetail>(routes, 'vouchers.get', { id: s1.id });
    await k.t.callOk(routes, 'vouchers.save', { ...d2.input, ledgers: [{ ledgerId: k.L.consult, amount: 11_000_00 }], acknowledgeWarnings: true });
    const log2 = await k.t.callOk<GstAmendmentRow[]>(routes, 'gst.amendments.list', { period: '052026' });
    assert.equal(log2.length, 1);
    assert.deepEqual([log2[0].original?.items[0].taxable, log2[0].amended?.items[0].taxable], [10_000_00, 11_000_00]);

    // An invoice entered now but dated in April: listed as added after filing, reported in May.
    const late = await k.t.call(routes, 'vouchers.save', sale({ date: '2026-04-28', ledgers: [{ ledgerId: k.L.consult, amount: 5_000_00 }] }));
    assert.match(!late.ok ? late.error.message : '', /already been filed without this document/);
    await k.t.callOk(routes, 'vouchers.save', { ...sale({ date: '2026-04-28', ledgers: [{ ledgerId: k.L.consult, amount: 5_000_00 }] }), acknowledgeWarnings: true });
    const may2 = await k.t.callOk<Gstr1Summary>(routes, 'gst.gstr1.summary', { period: '052026' });
    assert.equal(may2.amendments?.late.length, 1);
    const apr3b2 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '042026' });
    assert.deepEqual(osup(apr3b2), [10_000_00, 900_00, 900_00], 'April still shows what was filed');
    const may3b2 = await k.t.callOk<Gstr3bSummary>(routes, 'gst.gstr3b.summary', { period: '052026' });
    // 1,000 (amendment) + 5,000 (late invoice) taxable; tax 90 + 450.
    assert.deepEqual(osup(may3b2), [6_000_00, 540_00, 540_00]);

    // The April filing cannot be unmarked while amendments point at it.
    const un = await k.t.call(routes, 'gst.filing.unmark', { form: 'gstr1', period: '042026' });
    assert.equal(!un.ok && un.error.code, 'BUSINESS_RULE');
    const list = await k.t.callOk<GstFiling[]>(routes, 'gst.filing.list', {});
    assert.deepEqual(list.map((f) => [f.form, f.period, f.arn]), [
      ['gstr1', '042026', 'AA270526123456X'],
      ['gstr3b', '042026', null],
    ]);
    k.t.close();
  });

  it('validates the filing mark', async () => {
    const k = setupKit({ today: '2026-06-10' });
    const early = await k.t.call(routes, 'gst.filing.mark', { form: 'gstr1', period: '052026', filedOn: '2026-05-15' });
    assert.equal(!early.ok && early.error.code, 'VALIDATION');
    const future = await k.t.call(routes, 'gst.filing.mark', { form: 'gstr1', period: '052026', filedOn: '2026-07-01' });
    assert.equal(!future.ok && future.error.code, 'VALIDATION');
    const cmp = await k.t.call(routes, 'gst.filing.mark', { form: 'cmp08', period: '2026-27-Q1', filedOn: '2026-07-01' });
    assert.equal(!cmp.ok && cmp.error.code, 'BUSINESS_RULE');
    k.t.close();
  });
});
