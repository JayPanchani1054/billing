/**
 * Pure matcher tests: statuses, tolerance boundaries, document-number normalisation in matching,
 * duplicates, other periods, suggestions (never auto-linked) and decisions.
 * Fixture defaults (testkit prec/brec): taxable ₹1,000.00, CGST ₹90.00, SGST ₹90.00, 18%, POS 27.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RECON_TOLERANCE, type ReconTolerance } from '../../../shared/types/gstrecon.ts';
import { compareDocs, portalDocKey, reconcile, suggestionScore, type BooksRec, type Decision, type OtherPeriodDoc, type PortalRec, type ReconInput } from './matcher.ts';
import { brec, prec, S1, S2 } from './testkit.ts';

const TOL: ReconTolerance = { ...DEFAULT_RECON_TOLERANCE };

function run(portal: PortalRec[], books: BooksRec[], over: Partial<ReconInput> = {}): ReturnType<typeof reconcile> {
  return reconcile({ source: 'gstr2b', portal, books, decisions: [], tolerance: TOL, ...over });
}

const statusOf = (out: ReturnType<typeof reconcile>, docId: number): string => (out.portal.find((p) => p.docId === docId) as { status: string }).status;

describe('matcher: statuses and tolerance', () => {
  it('an identical pair is matched by document number with no differences', () => {
    const p = prec({ gstin: S1, docNo: 'INV-1', docDate: '2026-04-05' });
    const b = brec({ gstin: S1, docNo: 'INV-1', docDate: '2026-04-05' });
    const out = run([p], [b]);
    assert.equal(out.portal[0].status, 'matched');
    assert.equal(out.portal[0].method, 'exact');
    assert.equal(out.portal[0].voucherId, b.voucherId);
    assert.deepEqual(out.portal[0].diffs, []);
    assert.equal(out.booksOnly.length, 0);
    assert.equal(out.counts.matched, 1);
  });

  it('amount tolerance boundary: exactly ₹1.00 off is matched (info), ₹1.01 off is partial (mismatch)', () => {
    // Default tolerance 100 paise per head. CGST 90.00 vs 89.00 → |diff| = 100 ≤ 100 → info.
    const p1 = prec({ gstin: S1, docNo: 'A1', docDate: '2026-04-05', cgst: 90_00 });
    const b1 = brec({ gstin: S1, docNo: 'A1', docDate: '2026-04-05', cgst: 89_00 });
    // SGST 90.00 vs 88.99 → |diff| = 101 > 100 → mismatch.
    const p2 = prec({ gstin: S1, docNo: 'A2', docDate: '2026-04-05', sgst: 90_00 });
    const b2 = brec({ gstin: S1, docNo: 'A2', docDate: '2026-04-05', sgst: 88_99 });
    const out = run([p1, p2], [b1, b2]);
    const o1 = out.portal.find((o) => o.docId === p1.id);
    const o2 = out.portal.find((o) => o.docId === p2.id);
    assert.equal(o1?.status, 'matched');
    assert.deepEqual(o1?.diffs.map((d) => [d.field, d.difference, d.severity]), [['cgst', 100, 'info']]);
    assert.equal(o2?.status, 'partial');
    assert.deepEqual(o2?.diffs.map((d) => [d.field, d.portal, d.books, d.difference, d.severity]), [['sgst', 90_00, 88_99, 101, 'mismatch']]);
  });

  it('a stricter amount tolerance (0) turns a 1-paisa difference into partial', () => {
    const p = prec({ gstin: S1, docNo: 'A1', docDate: '2026-04-05', taxable: 1_000_01 });
    const b = brec({ gstin: S1, docNo: 'A1', docDate: '2026-04-05' });
    assert.equal(run([p], [b]).portal[0].status, 'matched');
    assert.equal(run([p], [b], { tolerance: { ...TOL, amountPaise: 0 } }).portal[0].status, 'partial');
  });

  it('date tolerance: 0 days makes a 2-day difference partial; 2 days keeps it matched', () => {
    const p = prec({ gstin: S1, docNo: 'D1', docDate: '2026-04-07' });
    const b = brec({ gstin: S1, docNo: 'D1', docDate: '2026-04-05' });
    const strict = run([p], [b]);
    assert.equal(strict.portal[0].status, 'partial');
    assert.deepEqual(strict.portal[0].diffs.map((d) => [d.field, d.difference, d.severity]), [['date', 2, 'mismatch']]);
    const loose = run([p], [b], { tolerance: { ...TOL, dateDays: 2 } });
    assert.equal(loose.portal[0].status, 'matched');
    assert.equal(loose.portal[0].diffs[0].severity, 'info');
  });

  it('place of supply, rate, reverse charge and ITC-not-available are mismatches', () => {
    const p = prec({ gstin: S1, docNo: 'M1', docDate: '2026-04-05', pos: '29', rates: [12], reverseCharge: true, itcAvailable: false });
    const b = brec({ gstin: S1, docNo: 'M1', docDate: '2026-04-05' });
    const diffs = compareDocs(p, b, TOL, 'gstr2b');
    assert.deepEqual(
      diffs.map((d) => [d.field, d.severity]),
      [['pos', 'mismatch'], ['rate', 'mismatch'], ['reverse_charge', 'mismatch'], ['itc', 'mismatch']],
    );
    // ITC claimed in books = 90 + 90 = 180.00
    assert.equal(diffs.find((d) => d.field === 'itc')?.difference, 180_00);
  });

  it('documents on one side only are missing_in_books / missing_in_portal', () => {
    const p = prec({ gstin: S1, docNo: 'ONLY-P', docDate: '2026-04-05' });
    const b = brec({ gstin: S2, docNo: 'ONLY-B', docDate: '2026-04-06' });
    const out = run([p], [b]);
    assert.equal(out.portal[0].status, 'missing_in_books');
    assert.deepEqual(out.booksOnly.map((x) => [x.voucherId, x.status]), [[b.voucherId, 'missing_in_portal']]);
    assert.equal(out.counts.missing_in_books, 1);
    assert.equal(out.counts.missing_in_portal, 1);
  });

  it('books totals are signed: purchase returns reduce', () => {
    const inv = brec({ gstin: S1, docNo: 'X1', docDate: '2026-04-05' });
    const ret = brec({ gstin: S1, docNo: 'R1', docDate: '2026-04-06', cls: 'dec', docType: 'credit_note', taxable: 100_00, cgst: 9_00, sgst: 9_00 });
    const out = run([], [inv, ret]);
    // taxable 1,000.00 − 100.00 = 900.00; CGST 90.00 − 9.00 = 81.00
    assert.deepEqual([out.books.count, out.books.taxable, out.books.cgst, out.books.sgst], [2, 900_00, 81_00, 81_00]);
  });
});

describe('matcher: document numbers', () => {
  it("'INV/001/25-26' pairs with 'inv-1-2526' on the exact key and with 'INV1' when the year part makes it unique", () => {
    const p1 = prec({ gstin: S1, docNo: 'INV/001/25-26', docDate: '2026-04-05' });
    const b1 = brec({ gstin: S1, docNo: 'inv-1-2526', docDate: '2026-04-05' });
    const p2 = prec({ gstin: S2, docNo: 'INV/002/25-26', docDate: '2026-04-05' });
    const b2 = brec({ gstin: S2, docNo: 'INV2', docDate: '2026-04-05' });
    const out = run([p1, p2], [b1, b2]);
    assert.deepEqual(out.portal.map((o) => [o.status, o.method]), [['matched', 'exact'], ['matched', 'fy_stripped']]);
    // The spelling difference is shown but does not change the status.
    assert.equal(out.portal[1].diffs.find((d) => d.field === 'doc_no')?.severity, 'info');
  });

  it('the year-free key is not used when it is ambiguous', () => {
    // Two portal invoices INV/1 of different years; books has a bare 'INV1' → no unique pair.
    const p1 = prec({ gstin: S1, docNo: 'INV/1/25-26', docDate: '2026-04-05' });
    const p2 = prec({ gstin: S1, docNo: 'INV/1/26-27', docDate: '2026-04-06' });
    const b = brec({ gstin: S1, docNo: 'INV1', docDate: '2026-04-05' });
    const out = run([p1, p2], [b]);
    assert.deepEqual(out.portal.map((o) => o.status), ['missing_in_books', 'missing_in_books']);
    assert.equal(out.booksOnly.length, 1);
  });

  it('with fuzzy matching off only case and spaces are ignored', () => {
    const p = prec({ gstin: S1, docNo: 'INV/001', docDate: '2026-04-05' });
    const b = brec({ gstin: S1, docNo: 'INV1', docDate: '2026-04-05' });
    const off = run([p], [b], { tolerance: { ...TOL, fuzzyDocNo: false } });
    assert.equal(off.portal[0].status, 'missing_in_books');
    const p2 = prec({ gstin: S1, docNo: 'inv 77', docDate: '2026-04-05' });
    const b2 = brec({ gstin: S1, docNo: 'INV77', docDate: '2026-04-05' });
    assert.equal(run([p2], [b2], { tolerance: { ...TOL, fuzzyDocNo: false } }).portal[0].status, 'matched');
  });

  it('an invoice and a credit note with the same number never pair', () => {
    const cn = prec({ gstin: S1, docNo: '1', docDate: '2026-04-05', docType: 'credit_note' });
    const b = brec({ gstin: S1, docNo: '1', docDate: '2026-04-05' });
    const out = run([cn], [b]);
    assert.equal(out.portal[0].status, 'missing_in_books');
    assert.equal(out.booksOnly[0].status, 'missing_in_portal');
  });

  it('portalDocKey is the stable identity decisions are stored under', () => {
    assert.equal(portalDocKey(S1, 'invoice', 'INV/001/25-26'), `${S1}|inc|INV12526`);
    assert.equal(portalDocKey(S1, 'debit_note', 'inv-1-2526'), `${S1}|inc|INV12526`);
    assert.equal(portalDocKey(S1, 'credit_note', 'CN 01'), `${S1}|dec|CN1`);
  });
});

describe('matcher: duplicates and other periods', () => {
  it('two vouchers with the same supplier invoice make the portal document a duplicate', () => {
    const p = prec({ gstin: S1, docNo: 'DUP-1', docDate: '2026-04-05' });
    const b1 = brec({ gstin: S1, docNo: 'DUP-1', docDate: '2026-04-05' });
    const b2 = brec({ gstin: S1, docNo: 'dup/1', docDate: '2026-04-09', taxable: 999_00 });
    const out = run([p], [b1, b2]);
    const o = out.portal[0];
    assert.equal(o.status, 'duplicate');
    assert.equal(o.voucherId, b1.voucherId, 'the closer voucher is the pair');
    assert.deepEqual(o.duplicateVoucherIds, [b2.voucherId]);
    assert.equal(out.booksOnly.length, 0, 'the extra voucher is reported on the duplicate row, not as missing in portal');
    assert.ok(o.notes.some((n) => /2 vouchers carry this supplier and document number/.test(n)));
  });

  it('a document repeated on the portal is a duplicate of the first one', () => {
    const p1 = prec({ gstin: S1, docNo: 'R-9', docDate: '2026-04-05' });
    const p2 = prec({ gstin: S1, docNo: 'R/9', docDate: '2026-04-05' });
    const b = brec({ gstin: S1, docNo: 'R9', docDate: '2026-04-05' });
    const out = run([p1, p2], [b]);
    const second = out.portal.find((o) => o.status === 'duplicate');
    const first = out.portal.find((o) => o.status === 'matched');
    assert.ok(first && second);
    assert.equal(second.duplicateOfDocId, first.docId);
  });

  it('a voucher of another period pairs with the portal document (supplier filed late) and is flagged', () => {
    // Invoice of 28-Mar-2026 reported by the supplier in April's 2B; booked in March.
    const p = prec({ gstin: S1, docNo: 'LATE-1', docDate: '2026-03-28' });
    const b = brec({ gstin: S1, docNo: 'LATE-1', docDate: '2026-03-28', inRange: false });
    const out = run([p], [b]);
    assert.equal(out.portal[0].status, 'matched');
    assert.equal(out.portal[0].method, 'other_period');
    assert.deepEqual(out.portal[0].diffs.map((d) => [d.field, d.books, d.severity]), [['books_period', 'March 2026', 'info']]);
    assert.equal(out.books.count, 0, 'vouchers outside the period are not in the period totals');
  });

  it('missing in portal but reported in another imported period → otherPeriod', () => {
    const b = brec({ gstin: S1, docNo: 'MAY-1', docDate: '2026-04-29' });
    const other: OtherPeriodDoc[] = [{ period: '052026', docId: 77, gstin: S1, docType: 'invoice', docNo: 'may/001' }];
    const out = run([], [b], { otherPeriods: other });
    assert.deepEqual([out.booksOnly[0].status, out.booksOnly[0].otherPeriod, out.booksOnly[0].otherPeriodDocId], ['missing_in_portal', '052026', 77]);
    assert.ok(out.booksOnly[0].notes.includes('Reported on the portal in May 2026.'));
  });
});

describe('matcher: suggestions and decisions', () => {
  it('a probable match (same GSTIN, same amount, number off by 2 characters) is suggested, never linked', () => {
    const p = prec({ gstin: S1, docNo: 'BC/79', docDate: '2026-04-05' });
    const b = brec({ gstin: S1, docNo: 'BC/97', docDate: '2026-04-10' });
    const out = run([p], [b]);
    assert.equal(out.portal[0].status, 'missing_in_books');
    assert.equal(out.portal[0].suggestionCount, 1);
    assert.equal(out.booksOnly[0].status, 'missing_in_portal');
    assert.equal(out.booksOnly[0].suggestionCount, 1);
  });

  it('suggestion score ranks same number/date/amount highest and rejects amounts beyond tolerance', () => {
    const p = prec({ gstin: S1, docNo: 'INV-100', docDate: '2026-04-05' });
    const exact = suggestionScore(p, brec({ gstin: S1, docNo: 'INV100', docDate: '2026-04-05' }), TOL);
    const oneOff = suggestionScore(p, brec({ gstin: S1, docNo: 'INV101', docDate: '2026-04-05' }), TOL);
    const twoOffLate = suggestionScore(p, brec({ gstin: S1, docNo: 'INV110X', docDate: '2026-04-08' }), TOL);
    // 100 − 0; 100 − 15 (1 edit); 100 − 30 (2 edits) − 3 (days)
    assert.deepEqual([exact?.score, oneOff?.score, twoOffLate?.score], [100, 85, 67]);
    assert.deepEqual(oneOff?.reasons, ['Same amount', 'Document number differs by 1 character', 'Same date']);
    // Total 1,180.00 vs 1,181.01: off by 101 paise > tolerance → no suggestion.
    assert.equal(suggestionScore(p, brec({ gstin: S1, docNo: 'INV100', docDate: '2026-04-05', taxable: 1_001_01 }), TOL), null);
    // Different number (3+ edits) and a different date → not probable.
    assert.equal(suggestionScore(p, brec({ gstin: S1, docNo: 'ZZZ-999', docDate: '2026-04-06' }), TOL), null);
    // Different number but the same date and amount → probable.
    assert.ok(suggestionScore(p, brec({ gstin: S1, docNo: 'ZZZ-999', docDate: '2026-04-05' }), TOL));
  });

  it('a manual link wins over document numbers and flags a GSTIN difference', () => {
    const p = prec({ gstin: S1, docNo: 'P-1', docDate: '2026-04-05' });
    const b = brec({ gstin: S2, docNo: 'XYZ', docDate: '2026-04-05' });
    const d: Decision = { docKey: portalDocKey(S1, 'invoice', 'P-1'), voucherId: null, linkVoucherId: b.voucherId, resolution: null, remarks: null };
    const out = run([p], [b], { decisions: [d] });
    assert.equal(out.portal[0].method, 'manual');
    assert.equal(out.portal[0].manual, true);
    assert.equal(out.portal[0].status, 'partial');
    assert.ok(out.portal[0].diffs.some((x) => x.field === 'gstin' && x.severity === 'mismatch'));
    assert.equal(out.booksOnly.length, 0);
  });

  it('accept keeps the computed base status; ignore applies to any row; accept on a matched row is a no-op', () => {
    const p1 = prec({ gstin: S1, docNo: 'A', docDate: '2026-04-05', taxable: 1_010_00 });
    const b1 = brec({ gstin: S1, docNo: 'A', docDate: '2026-04-05' });
    const p2 = prec({ gstin: S1, docNo: 'B', docDate: '2026-04-05' });
    const p3 = prec({ gstin: S1, docNo: 'C', docDate: '2026-04-05' });
    const b3 = brec({ gstin: S1, docNo: 'C', docDate: '2026-04-05' });
    const b4 = brec({ gstin: S2, docNo: 'Q', docDate: '2026-04-05' });
    const dk = (n: string): string => portalDocKey(S1, 'invoice', n);
    const decisions: Decision[] = [
      { docKey: dk('A'), voucherId: null, linkVoucherId: null, resolution: 'accept', remarks: 'Freight in taxable' },
      { docKey: dk('B'), voucherId: null, linkVoucherId: null, resolution: 'ignore', remarks: null },
      { docKey: dk('C'), voucherId: null, linkVoucherId: null, resolution: 'accept', remarks: null },
      { docKey: null, voucherId: b4.voucherId, linkVoucherId: null, resolution: 'ignore', remarks: 'Capital goods, claimed later' },
    ];
    const out = run([p1, p2, p3], [b1, b3, b4], { decisions });
    assert.deepEqual(
      out.portal.map((o) => [o.status, o.baseStatus, o.remarks]),
      [['accepted', 'partial', 'Freight in taxable'], ['ignored', 'missing_in_books', null], ['matched', 'matched', null]],
    );
    assert.deepEqual(out.booksOnly.map((o) => [o.status, o.remarks]), [['ignored', 'Capital goods, claimed later']]);
  });

  it('is deterministic: input order does not change the outcome', () => {
    const portal = [
      prec({ id: 1, gstin: S1, docNo: 'D-1', docDate: '2026-04-05' }),
      prec({ id: 2, gstin: S1, docNo: 'D-2', docDate: '2026-04-06' }),
      prec({ id: 3, gstin: S2, docNo: '7', docDate: '2026-04-07' }),
    ];
    const books = [
      brec({ voucherId: 11, gstin: S1, docNo: 'D1', docDate: '2026-04-05' }),
      brec({ voucherId: 12, gstin: S1, docNo: 'D1', docDate: '2026-04-05' }),
      brec({ voucherId: 13, gstin: S2, docNo: '007', docDate: '2026-04-07' }),
    ];
    const a = run(portal, books);
    const b = run([...portal].reverse(), [...books].reverse());
    assert.deepEqual(a, b);
  });
});

describe('matcher: amendments and document types (review)', () => {
  it('an amendment whose number changed pairs with the voucher that carries the original number', () => {
    // B2BA: supplier corrected 'SR/15' to 'SR/015A'; the books still say 'SR/15'.
    const p = prec({ gstin: S1, docNo: 'SR/015A', docDate: '2026-04-10', origDocNo: 'SR/15' });
    const b = brec({ gstin: S1, docNo: 'SR/15', docDate: '2026-04-10' });
    const out = run([p], [b]);
    assert.deepEqual([out.portal[0].status, out.portal[0].method, out.portal[0].voucherId], ['matched', 'original_no', b.voucherId]);
    assert.deepEqual(out.portal[0].diffs.map((d) => [d.field, d.severity]), [['doc_no', 'info']]);
    assert.match(out.portal[0].notes.join(' '), /original number SR\/15/);
    assert.equal(out.booksOnly.length, 0);
  });

  it('the original number also finds a voucher booked in an earlier month, but never an ambiguous one', () => {
    const p = prec({ gstin: S1, docNo: 'NEW-9', docDate: '2026-04-10', origDocNo: 'OLD-9' });
    const march = brec({ gstin: S1, docNo: 'OLD-9', docDate: '2026-03-28', inRange: false });
    const out = run([p], [march]);
    assert.deepEqual([out.portal[0].method, out.portal[0].voucherId], ['original_no', march.voucherId]);
    // Two vouchers with the original number → no guess.
    const b1 = brec({ gstin: S1, docNo: 'OLD-9', docDate: '2026-04-02' });
    const b2 = brec({ gstin: S1, docNo: 'OLD-9', docDate: '2026-04-03' });
    const amb = run([p], [b1, b2]);
    assert.equal(amb.portal[0].status, 'missing_in_books');
    // Same number before and after the amendment: the ordinary passes handle it (no 'original_no').
    const same = run([prec({ gstin: S1, docNo: 'K-1', docDate: '2026-04-10', origDocNo: 'K-1' })], [brec({ gstin: S1, docNo: 'K-1', docDate: '2026-04-10' })]);
    assert.equal(same.portal[0].method, 'exact');
  });

  it('a credit note linked to a purchase is a mismatch; an invoice booked as the supplier debit note is not (2B)', () => {
    const cn = prec({ gstin: S1, docNo: 'CN-1', docDate: '2026-04-05', docType: 'credit_note' });
    const purchase = brec({ gstin: S1, docNo: 'CN-1', docDate: '2026-04-05' });
    const d1 = compareDocs(cn, purchase, TOL, 'gstr2b').find((d) => d.field === 'doc_type');
    assert.equal(d1?.severity, 'mismatch');
    const dn = prec({ gstin: S1, docNo: 'DN-1', docDate: '2026-04-05', docType: 'debit_note' });
    const d2 = compareDocs(dn, brec({ gstin: S1, docNo: 'DN-1', docDate: '2026-04-05' }), TOL, 'gstr2b').find((d) => d.field === 'doc_type');
    assert.equal(d2?.severity, 'info');
    assert.equal(compareDocs(dn, brec({ gstin: S1, docNo: 'DN-1', docDate: '2026-04-05' }), TOL, 'gstr1').find((d) => d.field === 'doc_type')?.severity, 'mismatch');
  });
});

describe('matcher: the same document in two returns (review)', () => {
  it('a voucher already taken by another month is not matched again; an amendment may take it', () => {
    // March voucher INV-5, already matched with the March 2B's INV-5; April's 2B lists INV-5 again.
    const v = brec({ gstin: S1, docNo: 'INV-5', docDate: '2026-03-25', inRange: false });
    const p = prec({ id: 501, gstin: S1, docNo: 'INV-5', docDate: '2026-03-25' });
    const claimed = [{ voucherId: v.voucherId, period: '032026', docId: 77, docNo: 'INV-5' }];
    const out = run([p], [v], { claimed });
    const o = out.portal[0];
    assert.deepEqual([o.status, o.voucherId, o.duplicateOfDocId, o.otherPeriod], ['duplicate', null, 77, '032026']);
    assert.match(o.notes.join(' '), /Already matched with INV-5 in the return for March 2026.*claim the ITC only once/);
    // Without the earlier match it is the usual late-filing pair.
    assert.equal(run([p], [v]).portal[0].method, 'other_period');
    // A B2BA amendment of INV-5 replaces the original, so it pairs with the voucher.
    const a = run([prec({ id: 502, gstin: S1, docNo: 'INV-5', docDate: '2026-03-25', amendment: true })], [v], { claimed });
    assert.deepEqual([a.portal[0].status, a.portal[0].voucherId], ['matched', v.voucherId]);
  });

  it('a voucher of the period that another month also took is matched, with a warning note', () => {
    const v = brec({ gstin: S1, docNo: 'INV-6', docDate: '2026-04-02' });
    const p = prec({ gstin: S1, docNo: 'INV-6', docDate: '2026-04-02' });
    const out = run([p], [v], { claimed: [{ voucherId: v.voucherId, period: '052026', docId: 9, docNo: 'INV-6' }] });
    assert.equal(out.portal[0].status, 'matched');
    assert.match(out.portal[0].notes.join(' '), /also matched with INV-6 in the return for May 2026/);
  });
});
