/**
 * End-to-end: purchases, purchase returns and sales posted through the real vouchers service,
 * reconciled against GSTR-2B / GSTR-1 files. Values come from gst_lines written by the posting engine.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReconResultsPage, ReconSummary } from '../../../shared/types/gstrecon.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { deleteVoucher } from '../vouchers/service.ts';
import { purchaseInput, salesInput, save, setupKit } from '../vouchers/testkit.ts';
import { enc, gstr2bJson, inv2a, nt2a, routes } from './testkit.ts';

const APR = '042026';
const SUPPLIER = makeGstin('27', testPan(4)); // vouchers testkit 'Supreme Suppliers'
const BLR = makeGstin('29', testPan(2)); // vouchers testkit 'Bangalore Retail'

describe('integration with the vouchers service', () => {
  it('a purchase and its return reconcile against GSTR-2B invoice and credit note', async () => {
    const k = setupKit();
    const t = k.t;
    const own = makeGstin('27');
    // Rice 20 × ₹80 = ₹1,600.00; CGST 2.5% = 40.00, SGST 40.00 (posting engine).
    const pur = save(k, purchaseInput(k, { referenceNo: 'SS/0101/26-27', referenceDate: '2026-04-10', date: '2026-04-12' }));
    // Return 5 × ₹80 = ₹400.00 + 10.00 + 10.00, supplier credit note SCN-7 dated 14-Apr.
    const ret = save(k, {
      voucherTypeId: k.vt.debit_note,
      date: '2026-04-14',
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      originalInvoiceNo: 'SS/0101/26-27',
      referenceNo: 'SCN-7',
      referenceDate: '2026-04-14',
      items: [{ itemId: k.I.rice, qty: 5, rate: 80 }],
    });
    // A purchase from the same supplier the supplier has not reported.
    const late = save(k, purchaseInput(k, { referenceNo: 'SS-120', referenceDate: '2026-04-15', items: [{ itemId: k.I.mixer, qty: 1, rate: 100 }] }));

    const file = gstr2bJson({
      gstin: own,
      rtnprd: APR,
      b2b: [{ ctin: SUPPLIER, trdnm: 'SUPREME', inv: [{ inum: 'SS-101-2627', dt: '10-04-2026', items: [[5, 1600, 0, 40, 40]] }] }],
      cdnr: [{ ctin: SUPPLIER, nt: [{ ntnum: 'SCN-7', typ: 'C', dt: '14-04-2026', items: [[5, 400, 0, 10, 10]] }] }],
    });
    await t.callOk(routes, 'gstrecon.import', { source: 'gstr2b', fileName: '2b.json', bytes: enc(file) });
    const s = await t.callOk<ReconSummary>(routes, 'gstrecon.run', { period: APR, source: 'gstr2b' });
    assert.deepEqual(s.run?.counts, { matched: 2, missing_in_portal: 1 });
    const page = await t.callOk<ReconResultsPage>(routes, 'gstrecon.results', { period: APR, source: 'gstr2b' });
    const inv = page.rows.find((r) => r.portal?.docNo === 'SS-101-2627');
    assert.deepEqual([inv?.voucherId, inv?.books?.docDate, inv?.books?.dateBasis], [pur.id, '2026-04-10', 'reference_date']);
    const cn = page.rows.find((r) => r.portal?.docNo === 'SCN-7');
    assert.deepEqual([cn?.voucherId, cn?.books?.docType, cn?.books?.taxable], [ret.id, 'credit_note', 40000]);
    // Books ITC: CGST 40.00 − 10.00 + 9.00 (mixer ₹100 @18% → 9.00 + 9.00) = 39.00
    assert.equal(s.booksItc?.cgst, 3900);
    // Portal ITC: 40.00 − 10.00 = 30.00 → difference −9.00, all of it at risk (SS-120 missing in portal)
    assert.equal(s.difference?.cgst, -900);
    assert.equal(s.itcAtRisk.total, 1800);
    const missing = page.rows.find((r) => r.kind === 'books');
    assert.equal(missing?.voucherId, late.id);

    // Deleting the voucher makes the result stale and drops it on the next run.
    deleteVoucher(t.ctx, late.id);
    const stale = await t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(stale.stale, true);
    const again = await t.callOk<ReconSummary>(routes, 'gstrecon.run', { period: APR, source: 'gstr2b' });
    assert.deepEqual(again.run?.counts, { matched: 2 });
    t.close();
  });

  it('GSTR-1 vs sales books: gstrecon.gstr1.compare', async () => {
    const k = setupKit();
    const t = k.t;
    // Inter-state sale to Bangalore: mixer 5 × ₹200 = ₹1,000.00, IGST 18% = 180.00.
    const s1 = save(k, salesInput(k, { partyLedgerId: k.L.blr }));
    // Second sale to Bangalore, filed with a different value in GSTR-1.
    const s2 = save(k, salesInput(k, { partyLedgerId: k.L.blr, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] }));
    assert.ok(s1.number && s2.number);
    const g1 = {
      gstin: makeGstin('27'),
      fp: APR,
      b2b: [
        {
          ctin: BLR,
          inv: [
            inv2a({ inum: s1.number, idt: '15-04-2026', pos: '29', items: [[18, 1000, 180, 0, 0]] }),
            // 1 × ₹200 reported as ₹220 (IGST 39.60 vs 36.00)
            inv2a({ inum: s2.number, idt: '15-04-2026', pos: '29', items: [[18, 220, 39.6, 0, 0]] }),
          ],
        },
      ],
      cdnr: [{ ctin: BLR, nt: [nt2a({ nt_num: 'CN-404', nt_dt: '15-04-2026', ntty: 'C', pos: '29', items: [[18, 100, 18, 0, 0]] })] }],
      b2cs: [],
    };
    await t.callOk(routes, 'gstrecon.import', { source: 'gstr1', fileName: 'gstr1.json', bytes: enc(g1) });
    const s = await t.callOk<ReconSummary>(routes, 'gstrecon.gstr1.compare', { period: APR });
    // A quarterly filer picks the quarter: the April file (fp 042026) is not Q1's (fp 062026).
    const q = await t.call(routes, 'gstrecon.import', { source: 'gstr1', period: '2026-27-Q1', fileName: 'gstr1.json', bytes: enc(g1), replace: true });
    assert.equal(q.ok, false);
    if (!q.ok) assert.match(q.error.message, /for April 2026 \(042026\), but you chose June 2026/);
    assert.equal(s.source, 'gstr1');
    assert.deepEqual(s.run?.counts, { matched: 1, partial: 1, missing_in_books: 1 });
    const page = await t.callOk<ReconResultsPage>(routes, 'gstrecon.results', { period: APR, source: 'gstr1', status: 'partial' });
    const diff = page.rows[0];
    assert.equal(diff.voucherId, s2.id);
    // taxable 220.00 − 200.00 = +20.00; IGST 39.60 − 36.00 = +3.60
    assert.deepEqual([diff.difference?.taxable, diff.difference?.igst], [2000, 360]);

    // Quarterly (QRMP) GSTR-1 for Q1 2026-27, filed under fp 062026: imported with the quarter key and
    // compared with the sales of April–June.
    const g1q = { ...g1, fp: '062026' };
    const imp = await t.callOk<{ period: string }>(routes, 'gstrecon.import', { source: 'gstr1', period: '2026-27-Q1', fileName: 'q1.json', bytes: enc(g1q) });
    assert.equal(imp.period, '062026');
    const qs = await t.callOk<ReconSummary>(routes, 'gstrecon.gstr1.compare', { period: '2026-27-Q1' });
    assert.deepEqual([qs.period, qs.from, qs.to], ['062026', '2026-04-01', '2026-06-30']);
    assert.deepEqual(qs.run?.counts, { matched: 1, partial: 1, missing_in_books: 1 });
    const qr = await t.callOk<ReconResultsPage>(routes, 'gstrecon.results', { period: '2026-27-Q1', source: 'gstr1', status: 'partial' });
    assert.equal(qr.rows[0].voucherId, s2.id);
    t.close();
  });
});
