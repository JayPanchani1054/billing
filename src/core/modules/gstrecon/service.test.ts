/**
 * gstrecon through the real dispatcher: import (dedupe / replace / period checks), run, summary with
 * hand-verified ITC figures, results filters, manual decisions that survive re-runs and re-imports,
 * suggestions, exports, follow-up e-mail and permissions.
 *
 * Books are written directly (testkit.addBooksDoc) so every paisa is controlled; recon.integration.test.ts
 * posts real vouchers through the vouchers service.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ImportBatchView,
  ReconDecisionResult,
  ReconImportConflict,
  ReconResultsPage,
  ReconRow,
  ReconSuggestion,
  ReconSummary,
  SupplierFollowUp,
  SupplierReconRow,
} from '../../../shared/types/gstrecon.ts';
import { readXlsx } from '../../lib/xlsx.ts';
import { createZip } from '../../lib/zip.ts';
import { addBooksDoc, enc, excel2b, gstr2bJson, importFile, P, routes, S1, S2, S3, setupRecon, type Item, type ReconKit } from './testkit.ts';

const APR = '042026';
const MAY = '052026';

/** IGST purchase line (18%). */
const igst = (taxable: number, tax: number) => [{ rate: 18, taxable: P(taxable), igst: P(tax) }];
/** CGST + SGST purchase line. */
const local = (taxable: number, half: number, rate = 18) => [{ rate, taxable: P(taxable), cgst: P(half), sgst: P(half) }];

interface Scenario {
  k: ReconKit;
  v: Record<string, number>;
}

/**
 * April 2026 books (supplier invoice no. / date as reference):
 *   v1 S1 INV/001/26-27 05-Apr 10,000 + 900 + 900       portal INV-1-2627 identical           → matched
 *   v2 S1 INV/002/26-27 07-Apr  1,000 +  90 +  90       portal same, ITC not available (P)    → partial
 *   v3 S2 BC/77         12-Apr 20,000 + IGST 3,600      portal IGST 3,601.01 (₹1.01 more)     → partial
 *   v4 S2 BC/78         13-Apr  5,000 + IGST   900      portal IGST   901.00 (exactly ₹1.00)  → matched
 *   v5 S3 LT-5          15-Apr  3,000 + 270 + 270       not on the portal                     → missing in portal
 *   v6 S3 LT-6          16-Apr  4,000 + 240 + 240 (12%) on May's 2B                           → missing in portal, other period
 *   v7/v8 S1 DUP-9      18-Apr  2,000 + 180 + 180 twice portal once                           → duplicate
 *   v9 S3 LT/007        20-Apr  7,000 + 630 + 630       portal LT/700 (2 edits, same amounts) → suggestion only
 *   portal only: S3 LT-99 22-Apr 500 + 45 + 45                                                  → missing in books
 */
async function scenario(opts: { security?: boolean } = {}): Promise<Scenario> {
  const k = setupRecon({ security: opts.security });
  const v: Record<string, number> = {
    v1: addBooksDoc(k, { gstin: S1, date: '2026-04-06', referenceNo: 'INV/001/26-27', referenceDate: '2026-04-05', lines: local(10000, 900) }),
    v2: addBooksDoc(k, { gstin: S1, date: '2026-04-07', referenceNo: 'INV/002/26-27', lines: local(1000, 90) }),
    v3: addBooksDoc(k, { gstin: S2, date: '2026-04-12', referenceNo: 'BC/77', pos: '27', lines: igst(20000, 3600) }),
    v4: addBooksDoc(k, { gstin: S2, date: '2026-04-13', referenceNo: 'BC/78', lines: igst(5000, 900) }),
    v5: addBooksDoc(k, { gstin: S3, date: '2026-04-15', referenceNo: 'LT-5', lines: local(3000, 270) }),
    v6: addBooksDoc(k, { gstin: S3, date: '2026-04-16', referenceNo: 'LT-6', lines: local(4000, 240, 12) }),
    v7: addBooksDoc(k, { gstin: S1, date: '2026-04-18', referenceNo: 'DUP-9', lines: local(2000, 180) }),
    v8: addBooksDoc(k, { gstin: S1, date: '2026-04-18', referenceNo: 'DUP-9', lines: local(2000, 180) }),
    v9: addBooksDoc(k, { gstin: S3, date: '2026-04-20', referenceNo: 'LT/007', lines: local(7000, 630) }),
  };
  const may = gstr2bJson({ gstin: k.gstin, rtnprd: MAY, b2b: [{ ctin: S3, inv: [{ inum: 'LT-6', dt: '16-04-2026', items: [[12, 4000, 0, 240, 240]] }] }] });
  await importFile(k, 'gstr2b', enc(may), { fileName: 'may.json' });
  await importFile(k, 'gstr2b', enc(april2b(k)), { fileName: 'april.json' });
  return { k, v };
}

function april2b(k: ReconKit, extra: { dropLt99?: boolean } = {}): Record<string, unknown> {
  return gstr2bJson({
    gstin: k.gstin,
    rtnprd: APR,
    b2b: [
      {
        ctin: S1,
        trdnm: 'SUPREME SUPPLIERS',
        inv: [
          { inum: 'INV-1-2627', dt: '05-04-2026', items: [[18, 10000, 0, 900, 900]] },
          { inum: 'INV/002/26-27', dt: '07-04-2026', itcavl: 'N', rsn: 'P', items: [[18, 1000, 0, 90, 90]] },
          { inum: 'DUP-9', dt: '18-04-2026', items: [[18, 2000, 0, 180, 180]] },
        ],
      },
      {
        ctin: S2,
        trdnm: 'BANGALORE COMPONENTS',
        inv: [
          { inum: 'BC/77', dt: '12-04-2026', items: [[18, 20000, 3601.01, 0, 0]] },
          { inum: 'BC/78', dt: '13-04-2026', items: [[18, 5000, 901, 0, 0]] },
        ],
      },
      {
        ctin: S3,
        trdnm: 'LOCAL TRADERS',
        inv: [
          ...(extra.dropLt99 ? [] : [{ inum: 'LT-99', dt: '22-04-2026', items: [[18, 500, 0, 45, 45] as Item] }]),
          { inum: 'LT/700', dt: '20-04-2026', items: [[18, 7000, 0, 630, 630]] },
        ],
      },
    ],
  });
}

const run = (k: ReconKit, tolerance?: Record<string, unknown>): Promise<ReconSummary> => k.t.callOk<ReconSummary>(routes, 'gstrecon.run', { period: APR, source: 'gstr2b', tolerance });
const results = (k: ReconKit, extra: Record<string, unknown> = {}): Promise<ReconResultsPage> =>
  k.t.callOk<ReconResultsPage>(routes, 'gstrecon.results', { period: APR, source: 'gstr2b', limit: 500, ...extra });
const rowByDoc = (page: ReconResultsPage, docNo: string): ReconRow => {
  const r = page.rows.find((x) => x.portal?.docNo === docNo || (x.kind === 'books' && x.books?.docNo === docNo));
  assert.ok(r, `row ${docNo}`);
  return r;
};

describe('gstrecon.import', () => {
  it('imports a 2B JSON, detects the period and lists the batch', async () => {
    const k = setupRecon();
    const res = await importFile(k, 'gstr2b', enc(april2b(k)));
    assert.equal(res.period, APR);
    assert.equal(res.docCount, 7);
    const batches = await k.t.callOk<ImportBatchView[]>(routes, 'gstrecon.batches', {});
    assert.equal(batches.length, 1);
    assert.equal(batches[0].periodLabel, 'April 2026');
    // Totals (all invoices, signed +): taxable 10,000 + 1,000 + 2,000 + 20,000 + 5,000 + 500 + 7,000 = 45,500.00
    assert.equal(batches[0].totals.taxable, P(45500));
    // IGST 3,601.01 + 901.00 = 4,502.01; CGST 900 + 90 + 180 + 45 + 630 = 1,845.00
    assert.equal(batches[0].totals.igst, 450201);
    assert.equal(batches[0].totals.cgst, P(1845));
    assert.equal(batches[0].lastRunAt, null);
    const audit = k.t.db.get<{ action: string; entity_type: string }>("SELECT action, entity_type FROM audit_log WHERE entity_type = 'gst_import_batch'");
    assert.deepEqual({ ...audit }, { action: 'import', entity_type: 'gst_import_batch' });
    k.t.close();
  });

  it('refuses a period that differs from the file, another GSTIN, and a file without period', async () => {
    const k = setupRecon();
    const r1 = await k.t.call(routes, 'gstrecon.import', { source: 'gstr2b', period: MAY, fileName: 'a.json', bytes: enc(april2b(k)) });
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.equal(r1.error.code, 'VALIDATION');
      assert.match(r1.error.message, /The file is the GSTR-2B for April 2026 \(042026\), but you chose May 2026/);
    }
    const other = gstr2bJson({ gstin: '29AAPFU0939F1ZR', rtnprd: APR, b2b: [] });
    const r2 = await k.t.call(routes, 'gstrecon.import', { source: 'gstr2b', fileName: 'b.json', bytes: enc(other) });
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      assert.equal(r2.error.code, 'BUSINESS_RULE');
      assert.match(r2.error.message, /belongs to GSTIN 29AAPFU0939F1ZR/);
    }
    const noPeriod = { b2b: [{ ctin: S1, cfs: 'Y', inv: [] }], tds: [] };
    const r3 = await k.t.call(routes, 'gstrecon.import', { source: 'gstr2a', fileName: 'c.json', bytes: enc(noPeriod) });
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.match(r3.error.message, /does not say which return period/);
    const ok = await importFile(k, 'gstr2a', enc(noPeriod), { period: APR });
    assert.equal(ok.period, APR);
    k.t.close();
  });

  it('a second import of the same source + period needs replace (CONFLICT with both counts)', async () => {
    const { k, v } = await scenario();
    await run(k);
    const docKey = (await results(k)).rows.find((r) => r.portal?.docNo === 'LT/700') as ReconRow;
    await k.t.callOk(routes, 'gstrecon.link', { portalDocId: docKey.portalDocId, voucherId: v.v9 });

    const again = await k.t.call(routes, 'gstrecon.import', { source: 'gstr2b', fileName: 'april-v2.json', bytes: enc(april2b(k, { dropLt99: true })) });
    assert.equal(again.ok, false);
    if (!again.ok) {
      assert.equal(again.error.code, 'CONFLICT');
      const d = again.error.details as ReconImportConflict;
      assert.deepEqual([d.existingDocCount, d.newDocCount, d.existingFileName, d.period], [7, 6, 'april.json', APR]);
    }
    const replaced = await k.t.callOk<{ replacedBatchId: number | null; docCount: number }>(routes, 'gstrecon.import', {
      source: 'gstr2b',
      fileName: 'april-v2.json',
      bytes: enc(april2b(k, { dropLt99: true })),
      replace: true,
    });
    assert.equal(replaced.docCount, 6);
    assert.ok(replaced.replacedBatchId);
    const batches = await k.t.callOk<ImportBatchView[]>(routes, 'gstrecon.batches', { period: APR, source: 'gstr2b' });
    assert.equal(batches.length, 1);
    const before = await k.t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(before.stale, true);
    assert.match(before.staleReason ?? '', /new file was imported/);
    // The manual link survives the re-import.
    await run(k);
    const row = rowByDoc(await results(k), 'LT/700');
    assert.deepEqual([row.status, row.method, row.voucherId], ['matched', 'manual', v.v9]);
    k.t.close();
  });

  it('imports a multi-part ZIP and a 2B Excel workbook through the route', async () => {
    const k = setupRecon();
    const a = gstr2bJson({ gstin: k.gstin, rtnprd: APR, b2b: [{ ctin: S1, inv: [{ inum: '1', dt: '01-04-2026', items: [[5, 100, 0, 2.5, 2.5]] }] }] });
    const b = gstr2bJson({ gstin: k.gstin, rtnprd: APR, b2b: [{ ctin: S2, inv: [{ inum: '2', dt: '02-04-2026', items: [[18, 100, 18, 0, 0]] }] }] });
    const zip = createZip([{ name: 'GSTR2B_1.json', data: JSON.stringify(a) }, { name: 'GSTR2B_2.json', data: JSON.stringify(b) }]);
    const z = await importFile(k, 'gstr2b', zip, { fileName: 'gstr2b.zip' });
    assert.equal(z.docCount, 2);
    const xlsx = excel2b({
      readme: [['GSTR-2B'], ['Financial Year', '2026-27'], ['Tax Period', 'May'], ['GSTIN', k.gstin]],
      b2b: [[S1, 'SUPREME', 'X-1', 'Regular', '03-05-2026', 1180, '27-Maharashtra', 'No', 1000, 0, 90, 90, 0, "May'26", '11-06-2026', 'Yes', '', '', '', '', '']],
    });
    const x = await importFile(k, 'gstr2b', xlsx, { fileName: 'gstr2b.xlsx' });
    assert.deepEqual([x.period, x.docCount], [MAY, 1]);
    k.t.close();
  });

  it('deleting a batch removes its documents and results; decisions stay', async () => {
    const { k } = await scenario();
    await run(k);
    const [batch] = await k.t.callOk<ImportBatchView[]>(routes, 'gstrecon.batches', { period: APR, source: 'gstr2b' });
    const lt99 = rowByDoc(await results(k), 'LT-99');
    await k.t.callOk(routes, 'gstrecon.ignore', { portalDocIds: [lt99.portalDocId], remarks: 'Not ours' });
    const del = await k.t.callOk<{ deletedDocs: number }>(routes, 'gstrecon.batch.delete', { id: batch.id });
    assert.equal(del.deletedDocs, 7);
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM gst_portal_docs WHERE batch_id = :id', { id: batch.id }), 0);
    assert.equal(k.t.db.value<number>("SELECT COUNT(*) FROM gstrecon_books_only WHERE return_period = '042026'"), 0);
    assert.equal(k.t.db.value<number>("SELECT COUNT(*) FROM gstrecon_decisions WHERE return_period = '042026'"), 1);
    const r = await k.t.call(routes, 'gstrecon.run', { period: APR, source: 'gstr2b' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'NOT_FOUND');
    k.t.close();
  });
});

describe('gstrecon.run and summary', () => {
  it('classifies every row of the scenario', async () => {
    const { k, v } = await scenario();
    const s = await run(k);
    assert.deepEqual(s.run?.counts, { matched: 2, partial: 2, duplicate: 1, missing_in_books: 2, missing_in_portal: 3 });
    const page = await results(k);
    assert.equal(page.total, 10); // 7 portal rows + 3 books-only rows
    assert.deepEqual([rowByDoc(page, 'INV-1-2627').status, rowByDoc(page, 'INV-1-2627').voucherId], ['matched', v.v1]);
    const v2 = rowByDoc(page, 'INV/002/26-27');
    assert.equal(v2.status, 'partial');
    assert.deepEqual(v2.diffs.map((d) => d.field), ['itc']);
    assert.match(v2.portal?.itcReason ?? '', /^P: /);
    const bc77 = rowByDoc(page, 'BC/77');
    assert.equal(bc77.status, 'partial');
    assert.deepEqual(bc77.difference, { taxable: 0, igst: 101, cgst: 0, sgst: 0, cess: 0, tax: 101 });
    const bc78 = rowByDoc(page, 'BC/78');
    assert.equal(bc78.status, 'matched', 'exactly ₹1.00 is within the default tolerance');
    assert.deepEqual(bc78.diffs.map((d) => [d.field, d.difference, d.severity]), [['igst', 100, 'info']]);
    const dup = rowByDoc(page, 'DUP-9');
    assert.equal(dup.status, 'duplicate');
    assert.equal(dup.voucherId, v.v7);
    assert.deepEqual(dup.duplicateVoucherIds, [v.v8]);
    const lt6 = page.rows.find((r) => r.kind === 'books' && r.voucherId === v.v6) as ReconRow;
    assert.deepEqual([lt6.status, lt6.otherPeriod], ['missing_in_portal', MAY]);
    const lt5 = page.rows.find((r) => r.kind === 'books' && r.voucherId === v.v5) as ReconRow;
    assert.deepEqual([lt5.status, lt5.otherPeriod], ['missing_in_portal', null]);
    const lt700 = rowByDoc(page, 'LT/700');
    assert.deepEqual([lt700.status, lt700.voucherId, lt700.suggestionCount], ['missing_in_books', null, 1]);
    k.t.close();
  });

  it('summary: ITC per head books vs portal, ITC at risk and not booked (hand-verified)', async () => {
    const { k } = await scenario();
    const s = await run(k);
    // Portal ITC (2B, ITC available — leaves out INV/002 1,000 + 90 + 90):
    //   taxable 45,500 − 1,000 = 44,500.00; IGST 4,502.01; CGST/SGST 1,845 − 90 = 1,755.00
    assert.deepEqual([s.portalItc.taxable, s.portalItc.igst, s.portalItc.cgst, s.portalItc.sgst], [P(44500), 450201, P(1755), P(1755)]);
    // Books (9 vouchers): taxable 10,000 + 1,000 + 20,000 + 5,000 + 3,000 + 4,000 + 2,000 × 2 + 7,000 = 54,000.00
    //   IGST 3,600 + 900 = 4,500.00; CGST 900 + 90 + 270 + 240 + 180 × 2 + 630 = 2,490.00
    assert.deepEqual([s.booksItc?.count, s.booksItc?.taxable, s.booksItc?.igst, s.booksItc?.cgst], [9, P(54000), P(4500), P(2490)]);
    // Difference portal − books: IGST +2.01, CGST 1,755 − 2,490 = −735.00
    assert.deepEqual([s.difference?.igst, s.difference?.cgst, s.difference?.taxable], [201, -P(735), -P(9500)]);
    // At risk: missing in portal LT-5 (270 + 270) + LT-6 (240 + 240) + LT/007 (630 + 630) = 2,280.00;
    //          ITC not available INV/002 (90 + 90) = 180.00; excess in books 0 → 2,460.00
    assert.deepEqual(s.itcAtRisk.missingInPortal, { igst: 0, cgst: P(1140), sgst: P(1140), cess: 0 });
    assert.deepEqual(s.itcAtRisk.itcNotAvailable, { igst: 0, cgst: P(90), sgst: P(90), cess: 0 });
    assert.equal(s.itcAtRisk.total, P(2460));
    // Not booked: missing in books LT-99 (45 + 45) + LT/700 (630 + 630) = 1,350.00; short in books BC/77 IGST 1.01
    assert.equal(s.itcNotBooked.total, P(1350) + 101);
    assert.equal(s.otherPeriodCount, 1);
    assert.equal(s.openCount, 2 + 1 + 2 + 3); // partial + duplicate + missing both sides
    // 2 matched of 7 portal documents = 28.6 %
    assert.equal(s.reconciledPct, 28.6);
    assert.equal(s.stale, false);
    k.t.close();
  });

  it('tolerance settings change the outcome and are remembered by the run', async () => {
    const { k } = await scenario();
    const s = await run(k, { amountPaise: 0 });
    assert.equal(s.run?.tolerance.amountPaise, 0);
    assert.equal(rowByDoc(await results(k), 'BC/78').status, 'partial', '₹1.00 is a mismatch with a zero tolerance');
    const loose = await run(k, { amountPaise: 200 });
    assert.equal(loose.run?.counts.matched, 3, 'BC/77 (₹1.01) is matched with a ₹2.00 tolerance');
    const runs = await k.t.callOk<Array<{ tolerance: { amountPaise: number } }>>(routes, 'gstrecon.runs', { period: APR, source: 'gstr2b' });
    assert.deepEqual(runs.map((r) => r.tolerance.amountPaise), [200, 0]);
    k.t.close();
  });

  it('books filter: optional, cancelled and future post-dated vouchers are left out', async () => {
    const k = setupRecon();
    addBooksDoc(k, { gstin: S1, date: '2026-04-05', referenceNo: 'OPT-1', optional: true, lines: local(100, 9) });
    addBooksDoc(k, { gstin: S1, date: '2026-04-05', referenceNo: 'CAN-1', cancelled: true, lines: local(100, 9) });
    const pd = addBooksDoc(k, { gstin: S1, date: '2026-04-30', referenceNo: 'PD-1', lines: local(100, 9) });
    k.t.db.run('UPDATE vouchers SET is_post_dated = 1, date = :d WHERE id = :id', { id: pd, d: '2026-06-30' });
    addBooksDoc(k, { gstin: S1, date: '2026-04-05', referenceNo: 'REAL-1', lines: local(100, 9) });
    await importFile(k, 'gstr2b', enc(gstr2bJson({ gstin: k.gstin, rtnprd: APR, b2b: [] })));
    const s = await run(k);
    assert.deepEqual(s.run?.counts, { missing_in_portal: 1 });
    assert.equal((await results(k)).rows[0].books?.docNo, 'REAL-1');
    k.t.close();
  });

  it('marks the result stale when a voucher changes after the run', async () => {
    const { k, v } = await scenario();
    await run(k);
    k.t.clock.setToday('2026-05-21');
    k.t.db.run('UPDATE vouchers SET updated_at = :at WHERE id = :id', { id: v.v1, at: k.t.clock.now().toISOString() });
    const s = await k.t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(s.stale, true);
    assert.match(s.staleReason ?? '', /Vouchers were entered or altered/);
    k.t.close();
  });
});

describe('gstrecon.results, supplier summary, suggestions', () => {
  it('filters by status, open, other period, supplier and search, with paging', async () => {
    const { k } = await scenario();
    await run(k);
    assert.equal((await results(k, { status: 'partial' })).total, 2);
    assert.equal((await results(k, { status: 'open' })).total, 8);
    assert.equal((await results(k, { status: 'other_period' })).total, 1);
    const s3 = await results(k, { supplierGstin: S3.toLowerCase() });
    assert.equal(s3.total, 5); // LT-99, LT/700 on the portal; LT-5, LT-6, LT/007 in the books
    assert.deepEqual(s3.counts, { missing_in_books: 2, missing_in_portal: 3 });
    assert.equal((await results(k, { search: 'bc/7' })).total, 2);
    const page = await results(k, { limit: 3, offset: 3 });
    assert.equal(page.rows.length, 3);
    assert.equal(page.total, 10);
    k.t.close();
  });

  it('supplier-wise summary puts suppliers with open rows first', async () => {
    const { k } = await scenario();
    await run(k);
    const rows = await k.t.callOk<SupplierReconRow[]>(routes, 'gstrecon.supplierSummary', { period: APR, source: 'gstr2b' });
    assert.deepEqual(rows.map((r) => [r.gstin, r.openCount]), [[S3, 5], [S1, 2], [S2, 1]]);
    const s2 = rows[2];
    // Portal tax 3,601.01 + 901.00 = 4,502.01; books 3,600 + 900 = 4,500.00 → +2.01
    assert.deepEqual([s2.portalTax, s2.booksTax, s2.taxDifference], [450201, P(4500), 201]);
    k.t.close();
  });

  it('suggestions for a portal document and for a books row, best first; nothing is linked', async () => {
    const { k, v } = await scenario();
    // A weaker candidate for LT/700: same amount, number 'LT/70' (1 edit from LT700) but dated 5 days later.
    const v10 = addBooksDoc(k, { gstin: S3, date: '2026-04-25', referenceNo: 'LT/70', lines: local(7000, 630) });
    await run(k);
    const lt700 = rowByDoc(await results(k), 'LT/700');
    const sug = await k.t.callOk<ReconSuggestion[]>(routes, 'gstrecon.suggestions', { portalDocId: lt700.portalDocId });
    // LT/70: 100 − 15 (1 edit) − 5 (days) = 80; LT/007: 100 − 30 (2 edits) − 0 = 70
    assert.deepEqual(sug.map((s) => [s.voucherId, s.score]), [[v10, 80], [v.v9, 70]]);
    assert.ok(sug[1].reasons.includes('Same date'));
    const back = await k.t.callOk<ReconSuggestion[]>(routes, 'gstrecon.suggestions', { voucherId: v.v9, period: APR, source: 'gstr2b' });
    assert.deepEqual(back.map((s) => [s.portalDocId, s.docNo]), [[lt700.portalDocId, 'LT/700']]);
    assert.equal(rowByDoc(await results(k), 'LT/700').status, 'missing_in_books');
    k.t.close();
  });
});

describe('manual decisions', () => {
  it('link / accept / ignore persist across re-runs; unlink restores automatic matching', async () => {
    const { k, v } = await scenario();
    await run(k);
    let page = await results(k);
    const lt700 = rowByDoc(page, 'LT/700');
    const linked = await k.t.callOk<ReconRow>(routes, 'gstrecon.link', { portalDocId: lt700.portalDocId, voucherId: v.v9 });
    assert.deepEqual([linked.status, linked.method, linked.manual], ['matched', 'manual', true]);

    const bc77 = rowByDoc(page, 'BC/77');
    const acc = await k.t.callOk<ReconDecisionResult>(routes, 'gstrecon.accept', { portalDocIds: [bc77.portalDocId], remarks: 'Rounding by supplier' });
    assert.equal(acc.updated, 1);
    await k.t.callOk(routes, 'gstrecon.ignore', { voucherIds: [v.v5], period: APR, source: 'gstr2b', remarks: 'Blocked credit' });

    await run(k);
    await run(k, { amountPaise: 50 });
    page = await results(k);
    assert.deepEqual([rowByDoc(page, 'LT/700').status, rowByDoc(page, 'LT/700').voucherId], ['matched', v.v9]);
    const b = rowByDoc(page, 'BC/77');
    assert.deepEqual([b.status, b.baseStatus, b.remarks], ['accepted', 'partial', 'Rounding by supplier']);
    const v5 = page.rows.find((r) => r.kind === 'books' && r.voucherId === v.v5) as ReconRow;
    assert.deepEqual([v5.status, v5.remarks], ['ignored', 'Blocked credit']);
    assert.equal(page.rows.some((r) => r.kind === 'books' && r.voucherId === v.v9), false);
    // Ignoring LT-5 is a decision, not a portal entry: its ITC stays at risk.
    // missing in portal: LT-5 CGST 270.00 (ignored) + LT-6 240.00 = 510.00 (LT/007 is now linked).
    const sum = await k.t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(sum.itcAtRisk.missingInPortal.cgst, P(510));

    await k.t.callOk(routes, 'gstrecon.unlink', { portalDocId: lt700.portalDocId });
    await k.t.callOk(routes, 'gstrecon.unlink', { voucherId: v.v5, period: APR, source: 'gstr2b' });
    page = await results(k);
    assert.equal(rowByDoc(page, 'LT/700').status, 'missing_in_books');
    assert.equal((page.rows.find((r) => r.kind === 'books' && r.voucherId === v.v5) as ReconRow).status, 'missing_in_portal');
    const audits = k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity_type IN ('gst_portal_doc', 'voucher') AND action = 'alter'");
    assert.equal(audits, 5); // link, accept, ignore, unlink × 2
    k.t.close();
  });

  it('refuses links that cannot hold', async () => {
    const { k, v } = await scenario();
    await run(k);
    const page = await results(k);
    const lt700 = rowByDoc(page, 'LT/700');
    const lt99 = rowByDoc(page, 'LT-99');
    const cancelled = addBooksDoc(k, { gstin: S3, date: '2026-04-21', referenceNo: 'LT-X', cancelled: true, lines: local(500, 45) });
    const c = await k.t.call(routes, 'gstrecon.link', { portalDocId: lt99.portalDocId, voucherId: cancelled });
    assert.equal(c.ok, false);
    if (!c.ok) {
      assert.equal(c.error.code, 'BUSINESS_RULE');
      assert.match(c.error.message, /is cancelled, so it cannot be linked/);
    }
    await k.t.callOk(routes, 'gstrecon.link', { portalDocId: lt700.portalDocId, voucherId: v.v9 });
    const twice = await k.t.call(routes, 'gstrecon.link', { portalDocId: lt99.portalDocId, voucherId: v.v9 });
    assert.equal(twice.ok, false);
    if (!twice.ok) {
      assert.equal(twice.error.code, 'CONFLICT');
      assert.match(twice.error.message, /already linked to document LT\/700/);
    }
    const wrong = await k.t.call(routes, 'gstrecon.accept', { voucherIds: [v.v1], period: APR, source: 'gstr2b' });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.match(wrong.error.message, /is not a "missing in portal" row/);
    const none = await k.t.call(routes, 'gstrecon.ignore', { portalDocIds: [] });
    assert.equal(none.ok, false);
    k.t.close();
  });
});

describe('exports and follow-up', () => {
  it('xlsx export is readable back, multi-sheet, amounts in rupees', async () => {
    const { k } = await scenario();
    await run(k);
    const out = await k.t.callOk<{ fileName: string; bytes: Uint8Array }>(routes, 'gstrecon.export', { period: APR, source: 'gstr2b', format: 'xlsx' });
    assert.equal(out.fileName, 'GSTR-2B_Reconciliation_042026.xlsx');
    const wb = readXlsx(out.bytes);
    assert.deepEqual(wb.sheets.map((s) => s.name), ['Summary', 'Matched', 'Partial', 'Missing in Books', 'Missing in Portal', 'Duplicates', 'Accepted & Ignored', 'Supplier-wise']);
    const partial = wb.sheets[2];
    const header = partial.rows.findIndex((r) => r[0] === 'GSTIN');
    assert.ok(header >= 0);
    const cols = partial.rows[header] as string[];
    const bc = partial.rows.slice(header + 1).find((r) => r[3] === 'BC/77') as Array<string | number | null>;
    assert.equal(bc[cols.indexOf('IGST (portal)')], 3601.01);
    assert.equal(bc[cols.indexOf('IGST (books)')], 3600);
    assert.equal(bc[cols.indexOf('Tax diff.')], 1.01);
    const missing = wb.sheets[4].rows.filter((r) => r[0] === S3);
    assert.equal(missing.length, 3);
    const audit = k.t.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE action = 'export' AND entity_type = 'gst_reconciliation'");
    assert.equal(audit, 1);
    k.t.close();
  });

  it('csv export has a BOM, a header and one line per row', async () => {
    const { k } = await scenario();
    await run(k);
    const out = await k.t.callOk<{ fileName: string; bytes: Uint8Array }>(routes, 'gstrecon.export', { period: APR, source: 'gstr2b', format: 'csv' });
    assert.deepEqual([...out.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(out.bytes.slice(3)).trim().split(/\r?\n/);
    assert.match(lines[0], /^Status,GSTIN,Name,Type,/);
    assert.equal(lines.length, 11);
    assert.ok(lines.some((l) => l.includes('BC/77') && l.includes('3601.01')));
    k.t.close();
  });

  it('supplier follow-up e-mail lists what the supplier must fix', async () => {
    const { k } = await scenario();
    await run(k);
    const f = await k.t.callOk<SupplierFollowUp>(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S3 });
    // LT-6 is on the May 2B: listed for information only, not as something to report.
    assert.deepEqual(f.counts, { missingInPortal: 2, mismatched: 0, missingInBooks: 2 });
    assert.match(f.subject, /April 2026: differences in your documents/);
    assert.match(f.body, /^Dear Local Traders \(GSTIN 27/);
    assert.match(f.body, /A\. Documents not appearing in our GSTR-2B/);
    assert.match(f.body, /Invoice LT-5 dated 15-04-2026 — taxable value ₹ 3,000\.00, tax ₹ 540\.00/);
    assert.match(f.body, /B\. Documents you reported in another month's return — no action needed[^\n]*\n {2}1\. Invoice LT-6 dated 16-04-2026 — reported in your return for May 2026/);
    assert.doesNotMatch(f.body.split('B. ')[0], /LT-6/);
    assert.match(f.body, /C\. Documents in your return that we could not find in our books/);
    const s2 = await k.t.callOk<SupplierFollowUp>(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S2 });
    assert.match(s2.body, /IGST: as per our books 3,600\.00, as per your return 3,601\.01/);
    // S1: INV/002 (ITC not available, POS rule) is for the supplier; DUP-9 entered twice in our books is not.
    const s1 = await k.t.callOk<SupplierFollowUp>(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S1 });
    assert.deepEqual(s1.counts, { missingInPortal: 0, mismatched: 1, missingInBooks: 0 });
    assert.match(s1.body, /Invoice INV\/002\/26-27 dated 07-04-2026:\n\s+ITC availability: as per our books Claimed, as per your return Not available/);
    assert.doesNotMatch(s1.body, /DUP-9/);
    const g1 = await k.t.call(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S1, source: 'gstr1' });
    assert.equal(g1.ok, false);
    if (!g1.ok) assert.equal(g1.error.code, 'VALIDATION');
    k.t.close();
  });
});

describe('permissions', () => {
  it('viewing and the follow-up need gst.view; import, run and decisions need gst.file; export needs data.export', async () => {
    const { k } = await scenario({ security: true });
    const auditor = k.t.sessionAs({ role: 'Auditor' });
    const read = await k.t.call(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' }, { session: auditor });
    assert.equal(read.ok, true);
    for (const [name, input] of [
      ['gstrecon.run', { period: APR, source: 'gstr2b' }],
      ['gstrecon.import', { source: 'gstr2b', fileName: 'x.json', bytes: enc(april2b(k)), replace: true }],
      ['gstrecon.accept', { portalDocIds: [1] }],
      ['gstrecon.link', { portalDocId: 1, voucherId: 1 }],
      ['gstrecon.batch.delete', { id: 1 }],
    ] as const) {
      const r = await k.t.call(routes, name, input, { session: auditor });
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN', name);
    }
    // Read-only roles can export (gst.view + data.export) and prepare the supplier e-mail (gst.view).
    const exp = await k.t.call(routes, 'gstrecon.export', { period: APR, source: 'gstr2b', format: 'csv' }, { session: auditor });
    assert.equal(exp.ok, true, 'Auditor exports');
    const dataEntry = k.t.sessionAs({ role: 'Data Entry' }); // gst.view without data.export / gst.file
    const fu = await k.t.call(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S3 }, { session: dataEntry });
    assert.equal(fu.ok, true, 'follow-up is a read');
    const noExport = await k.t.call(routes, 'gstrecon.export', { period: APR, source: 'gstr2b', format: 'csv' }, { session: dataEntry });
    assert.equal(noExport.ok, false);
    if (!noExport.ok) {
      assert.equal(noExport.error.code, 'FORBIDDEN');
      assert.match(noExport.error.message, /Export data/);
    }
    const noGst = k.t.sessionAs({ permissions: ['company.view', 'vouchers.view'] });
    const denied = await k.t.call(routes, 'gstrecon.results', { period: APR, source: 'gstr2b' }, { session: noGst });
    assert.equal(denied.ok, false);
    k.t.close();
  });
});

describe('review fixes: credit notes, blocked credit, amendments, stale scope', () => {
  it('ITC at risk counts supplier credit notes not booked and returns booked short; blocked credit is not "not booked"', async () => {
    const k = setupRecon();
    addBooksDoc(k, { gstin: S1, date: '2026-04-05', referenceNo: 'P-1', lines: local(10000, 900) });
    // Purchase return of S2 for half the note: IGST 180.00 on 1,000.00 (the supplier's note says 360.00 on 2,000.00).
    addBooksDoc(k, { baseType: 'debit_note', gstin: S2, date: '2026-04-12', referenceNo: 'CN-2', lines: igst(1000, 180) });
    // S3 invoice booked with blocked credit (s.17(5)): CGST/SGST 450.00 each, ITC ineligible; portal CGST 452.00.
    addBooksDoc(k, { gstin: S3, date: '2026-04-15', referenceNo: 'P-3', lines: [{ rate: 18, taxable: P(5000), cgst: P(450), sgst: P(450), itc: 'ineligible' }] });
    const file = gstr2bJson({
      gstin: k.gstin,
      rtnprd: APR,
      b2b: [
        { ctin: S1, inv: [{ inum: 'P-1', dt: '05-04-2026', items: [[18, 10000, 0, 900, 900]] }] },
        { ctin: S3, inv: [{ inum: 'P-3', dt: '15-04-2026', items: [[18, 5000, 0, 452, 450]] }] },
      ],
      cdnr: [
        { ctin: S1, nt: [{ ntnum: 'CN-1', typ: 'C', dt: '10-04-2026', items: [[18, 1000, 0, 90, 90]] }] },
        { ctin: S2, nt: [{ ntnum: 'CN-2', typ: 'C', dt: '12-04-2026', items: [[18, 2000, 360, 0, 0]] }] },
      ],
    });
    await importFile(k, 'gstr2b', enc(file));
    const s = await run(k);
    assert.deepEqual(s.run?.counts, { matched: 1, partial: 2, missing_in_books: 1 });
    // CN-1 not booked: CGST 90.00 + SGST 90.00 should have been reversed.
    assert.deepEqual(s.itcAtRisk.creditNotesNotBooked, { igst: 0, cgst: P(90), sgst: P(90), cess: 0 });
    // CN-2: the note reduces IGST by 360.00, the return by 180.00 → 180.00 too much ITC in the books.
    assert.deepEqual(s.itcAtRisk.excessInBooks, { igst: P(180), cgst: 0, sgst: 0, cess: 0 });
    assert.equal(s.itcAtRisk.total, P(180) + P(180));
    // P-3: short in books is portal − tax booked (452.00 − 450.00 = 2.00 CGST), not portal − eligible ITC (902.00).
    assert.deepEqual(s.itcNotBooked.shortInBooks, { igst: 0, cgst: P(2), sgst: 0, cess: 0 });
    assert.deepEqual(s.itcNotBooked.missingInBooks, { igst: 0, cgst: 0, sgst: 0, cess: 0 }, 'a credit note is not ITC to take');
    assert.equal(s.itcNotBooked.total, P(2));
    // Linking the credit note to a purchase invoice is refused.
    const page = await results(k);
    const cn1 = rowByDoc(page, 'CN-1');
    const p1 = rowByDoc(page, 'P-1');
    const bad = await k.t.call(routes, 'gstrecon.link', { portalDocId: cn1.portalDocId, voucherId: p1.voucherId });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.error.code, 'BUSINESS_RULE');
      assert.match(bad.error.message, /Credit Note CN-1 can only be linked to a purchase return \(debit note\)/);
    }
    // The Excel summary carries the new line and the totals.
    const x = await k.t.callOk<{ bytes: Uint8Array }>(routes, 'gstrecon.export', { period: APR, source: 'gstr2b', format: 'xlsx' });
    const summary = readXlsx(x.bytes).sheets[0].rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join('|'));
    assert.ok(summary.includes('ITC at risk – supplier credit notes not booked (reverse ITC)|||0|90|90|0|180'), summary.join('\n'));
    assert.ok(summary.some((l) => l === 'Total ITC at risk|||||||360'), summary.join('\n'));
    k.t.close();
  });

  it('a B2BA amendment with a new number pairs through its original number (import → run)', async () => {
    const k = setupRecon();
    const v = addBooksDoc(k, { gstin: S1, date: '2026-03-20', referenceNo: 'OLD/5', referenceDate: '2026-03-20', lines: local(1000, 90) });
    const file = gstr2bJson({
      gstin: k.gstin,
      rtnprd: APR,
      b2ba: [{ ctin: S1, inv: [{ inum: 'NEW/5', dt: '20-03-2026', oinum: 'OLD/5', oidt: '20-03-2026', items: [[18, 1000, 0, 90, 90]] }] }],
    });
    await importFile(k, 'gstr2b', enc(file));
    await run(k);
    const row = rowByDoc(await results(k), 'NEW/5');
    assert.deepEqual([row.status, row.method, row.voucherId, row.portal?.section, row.portal?.original?.docNo], ['matched', 'original_no', v, 'b2ba', 'OLD/5']);
    assert.ok(row.diffs.some((d) => d.field === 'books_period' && d.severity === 'info'), 'booked in March');
    k.t.close();
  });

  it('only vouchers that can affect the period make the result stale', async () => {
    const { k } = await scenario();
    await run(k);
    k.t.clock.setToday('2026-05-21');
    // A purchase of January 2027 (beyond the 183-day window around April) does not touch April's result.
    addBooksDoc(k, { gstin: S1, date: '2027-01-15', referenceNo: 'FAR-1', lines: local(100, 9) });
    const quiet = await k.t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(quiet.stale, false);
    // A purchase dated in April does.
    addBooksDoc(k, { gstin: S1, date: '2026-04-25', referenceNo: 'NEW-1', lines: local(100, 9) });
    const stale = await k.t.callOk<ReconSummary>(routes, 'gstrecon.summary', { period: APR, source: 'gstr2b' });
    assert.equal(stale.stale, true);
    k.t.close();
  });
});

describe('review fixes: a document reported in two returns', () => {
  it('April does not match the March voucher again; the e-mail asks the supplier to remove the duplicate', async () => {
    const k = setupRecon();
    const v = addBooksDoc(k, { gstin: S1, date: '2026-03-25', referenceNo: 'INV-5', lines: local(1000, 90) });
    const doc = { inum: 'INV-5', dt: '25-03-2026', items: [[18, 1000, 0, 90, 90]] as Item[] };
    await importFile(k, 'gstr2b', enc(gstr2bJson({ gstin: k.gstin, rtnprd: '032026', b2b: [{ ctin: S1, inv: [doc] }] })));
    await importFile(k, 'gstr2b', enc(gstr2bJson({ gstin: k.gstin, rtnprd: APR, b2b: [{ ctin: S1, inv: [doc] }] })));
    const march = await k.t.callOk<ReconSummary>(routes, 'gstrecon.run', { period: '032026', source: 'gstr2b' });
    assert.deepEqual(march.run?.counts, { matched: 1 });
    const april = await run(k);
    assert.deepEqual(april.run?.counts, { duplicate: 1 });
    // Not "ITC available but not booked": it was claimed in March.
    assert.equal(april.itcNotBooked.total, 0);
    const row = (await results(k)).rows[0];
    assert.deepEqual([row.status, row.voucherId, row.otherPeriod], ['duplicate', null, '032026']);
    const mail = await k.t.callOk<SupplierFollowUp>(routes, 'gstrecon.supplierFollowUp', { period: APR, supplierGstin: S1 });
    assert.match(mail.body, /A\. Documents reported in more than one return[^\n]*\n {2}1\. Invoice INV-5 dated 25-03-2026 — also in your return for March 2026/);
    assert.ok(v > 0);
    k.t.close();
  });
});
