import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BooksDocView, PortalDocView, ReconImportConflict, ReconRow, ReconSummary } from '../../../../shared/types/gstrecon.ts';
import {
  compareLines,
  conflictMessage,
  decisionTarget,
  headLines,
  importResultText,
  itcRiskCaption,
  itcTiles,
  resultsExport,
  rowActions,
  rowExplanation,
  signedMoney,
  statusFilterOptions,
  statusLabel,
  toleranceErrors,
  toleranceFromDraft,
  toleranceText,
} from './recon.ts';
import { defaultPeriod, fyOf, isQuarterKey, periodLabel, periodOptionGroups, quarterMonths, quarterOf, shiftPeriod, storageMonth } from './periods.ts';

const G = '27AAAPA0011A1Z5';

function portal(over: Partial<PortalDocView> = {}): PortalDocView {
  return {
    id: 1, section: 'b2b', gstin: G, name: 'SUPREME', docType: 'invoice', docNo: 'BC/77', docDate: '2026-04-12', pos: '27', reverseCharge: false,
    taxable: 2_000_000, igst: 360_101, cgst: 0, sgst: 0, cess: 0, tax: 360_101, invoiceValue: 2_360_101, rates: [18], itcAvailable: true, itcReason: null,
    supplierPeriod: '042026', filingDate: '2026-05-11', filingStatus: null, invoiceType: 'R', original: null, applicablePct: null, ...over,
  };
}

function books(over: Partial<BooksDocView> = {}): BooksDocView {
  return {
    voucherId: 9, voucherNumber: '12', voucherType: 'Purchase', baseType: 'purchase', docNo: 'BC/77', docNoBasis: 'reference_no', docDate: '2026-04-12',
    dateBasis: 'reference_date', voucherDate: '2026-04-12', partyLedgerId: 3, partyName: 'Supreme Suppliers', gstin: G, gstinFromLedger: false, pos: '27',
    reverseCharge: false, docType: 'invoice', taxable: 2_000_000, igst: 360_000, cgst: 0, sgst: 0, cess: 0, tax: 360_000, eligibleTax: 360_000,
    itc: { igst: 360_000, cgst: 0, sgst: 0, cess: 0 }, invoiceValue: 2_360_000, rates: [18], period: '042026', inPeriod: true, ...over,
  };
}

function row(over: Partial<ReconRow> = {}): ReconRow {
  const p = over.portal === undefined ? portal() : over.portal;
  const b = over.books === undefined ? books() : over.books;
  return {
    kind: 'portal', key: 'p1', portalDocId: 1, voucherId: b?.voucherId ?? null, status: 'partial', baseStatus: 'partial', gstin: G, name: 'SUPREME', docType: 'invoice',
    portal: p, books: b,
    diffs: [{ field: 'igst', label: 'IGST', portal: 360_101, books: 360_000, difference: 101, severity: 'mismatch' }],
    difference: p && b ? { taxable: p.taxable - b.taxable, igst: p.igst - b.igst, cgst: 0, sgst: 0, cess: 0, tax: p.tax - b.tax } : null,
    method: 'exact', manual: false, otherPeriod: null, duplicateVoucherIds: [], duplicateOfDocId: null, suggestionCount: 0, notes: [], remarks: null, ...over,
  };
}

describe('gstrecon display logic', () => {
  it('signed differences use an explicit sign and a true minus', () => {
    assert.equal(signedMoney(101), '+1.01');
    assert.equal(signedMoney(-12_345_67), '−12,345.67');
    assert.equal(signedMoney(0), '');
    assert.equal(signedMoney(null), '');
  });

  it('compare lines highlight mismatches and mark info differences', () => {
    const r = row({
      diffs: [
        { field: 'igst', label: 'IGST', portal: 360_101, books: 360_000, difference: 101, severity: 'mismatch' },
        { field: 'date', label: 'Document date', portal: '2026-04-12', books: '2026-04-10', difference: 2, severity: 'info' },
      ],
      books: books({ docDate: '2026-04-10' }),
    });
    const lines = compareLines(r);
    const igst = lines.find((l) => l.key === 'igst');
    assert.deepEqual([igst?.portal, igst?.books, igst?.difference, igst?.mismatch], ['3,601.01', '3,600.00', '+1.01', true]);
    const date = lines.find((l) => l.key === 'date');
    assert.deepEqual([date?.portal, date?.books, date?.difference, date?.info, date?.mismatch], ['12-04-2026', '10-04-2026', '+2 days', true, false]);
    assert.equal(lines.find((l) => l.key === 'taxable')?.difference, '');
    assert.equal(lines.find((l) => l.key === 'tax')?.difference, '+1.01');
    assert.equal(lines.find((l) => l.key === 'itc')?.portal, 'Yes');
  });

  it('compare lines for a one-sided row leave the other side blank', () => {
    const lines = compareLines(row({ books: null, voucherId: null, status: 'missing_in_books', baseStatus: 'missing_in_books', diffs: [], difference: null }));
    const t = lines.find((l) => l.key === 'taxable');
    assert.deepEqual([t?.portal, t?.books, t?.difference], ['20,000.00', '', '']);
  });

  it('status wording depends on the side', () => {
    assert.equal(statusLabel('missing_in_portal', 'gstr2b'), 'Missing in portal');
    assert.equal(statusLabel('missing_in_portal', 'gstr1'), 'Not in GSTR-1');
    const opts = statusFilterOptions('gstr2b', { matched: 2, partial: 2, missing_in_books: 2, missing_in_portal: 3, duplicate: 1 });
    assert.equal(opts[0].label, 'Needs action (8)');
    assert.equal(opts[1].label, 'All rows (10)');
    assert.ok(opts.some((o) => o.value === 'other_period'));
  });

  it('explanations say what to do', () => {
    assert.match(rowExplanation(row(), 'gstr2b'), /1 detail differs/);
    assert.match(rowExplanation(row({ status: 'missing_in_portal', baseStatus: 'missing_in_portal', kind: 'books', portal: null, otherPeriod: '052026' }), 'gstr2b'), /reported it in May 2026/);
    assert.match(rowExplanation(row({ status: 'missing_in_books', books: null, suggestionCount: 2 }), 'gstr2b'), /2 probable matches/);
    assert.equal(rowExplanation(row({ status: 'accepted', remarks: 'Rounding' }), 'gstr2b'), 'Differences accepted: Rounding.');
    assert.match(
      rowExplanation(row({ status: 'duplicate', baseStatus: 'duplicate', books: null, voucherId: null, duplicateOfDocId: 4, otherPeriod: '032026' }), 'gstr2b'),
      /Already matched in the return for March 2026: the supplier reported it twice/,
    );
    assert.equal(rowExplanation(row({ status: 'duplicate', baseStatus: 'duplicate', books: null, duplicateOfDocId: 4 }), 'gstr2b'), 'The portal lists this document twice.');
  });

  it('row actions and decision targets', () => {
    assert.deepEqual(rowActions(row()), { canAccept: true, canIgnore: true, canUndo: false, canLink: false, canUnlink: false });
    assert.equal(rowActions(row({ status: 'matched', baseStatus: 'matched' })).canAccept, false);
    const books1 = row({ kind: 'books', portalDocId: null, portal: null, status: 'ignored', baseStatus: 'missing_in_portal' });
    assert.deepEqual(rowActions(books1), { canAccept: false, canIgnore: false, canUndo: true, canLink: true, canUnlink: false });
    assert.deepEqual(decisionTarget(row(), '042026', 'gstr2b'), { portalDocIds: [1] });
    assert.deepEqual(decisionTarget(books1, '042026', 'gstr2b'), { voucherIds: [9], period: '042026', source: 'gstr2b' });
    assert.equal(rowActions(row({ manual: true, method: 'manual' })).canUnlink, true);
  });

  it('tolerance form: validation, conversion and summary text', () => {
    assert.deepEqual(toleranceErrors({ amountPaise: 100, dateDays: 0, fuzzyDocNo: true }), {});
    assert.ok(toleranceErrors({ amountPaise: null, dateDays: -1, fuzzyDocNo: true }).dateDays);
    assert.equal(toleranceFromDraft({ amountPaise: null, dateDays: 0, fuzzyDocNo: true }), null);
    assert.deepEqual(toleranceFromDraft({ amountPaise: 150, dateDays: 3, fuzzyDocNo: false }), { amountPaise: 150, dateDays: 3, fuzzyDocNo: false });
    assert.equal(toleranceText({ amountPaise: 100, dateDays: 0, fuzzyDocNo: true }), '±₹1.00 per head · same date · smart number matching');
  });

  it('import and conflict messages', () => {
    const c: ReconImportConflict = { existingBatchId: 3, existingDocCount: 7, existingFileName: 'april.json', existingImportedAt: '2026-05-14T10:00:00.000Z', newDocCount: 6, source: 'gstr2b', period: '042026' };
    const m = conflictMessage(c);
    assert.equal(m.title, 'Replace the GSTR-2B for April 2026?');
    assert.match(m.message, /imported on 14-May-2026 from april\.json with 7 documents\. The new file has 6\./);
    assert.equal(
      importResultText({ batchId: 1, source: 'gstr2b', period: '042026', periodLabel: 'April 2026', format: 'json', docCount: 7, sections: {}, skipped: { ISD: 2 }, totals: { count: 7, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 }, warnings: [], replacedBatchId: 4 }),
      '7 documents imported for April 2026 · the earlier file was replaced · not reconciled: ISD 2',
    );
  });

  it('ITC heads and tiles from a summary', () => {
    const t = (taxable: number, igst: number, cgst: number) => ({ count: 1, taxable, igst, cgst, sgst: cgst, cess: 0, tax: igst + 2 * cgst });
    const zero = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const s = {
      source: 'gstr2b', sourceLabel: 'GSTR-2B', portal: t(4_450_000, 450_201, 175_500), portalItc: t(4_450_000, 450_201, 175_500), booksItc: t(5_400_000, 450_000, 249_000),
      itcAtRisk: { missingInPortal: { ...zero, cgst: 114_000, sgst: 114_000 }, excessInBooks: zero, itcNotAvailable: { ...zero, cgst: 9_000, sgst: 9_000 }, creditNotesNotBooked: zero, total: 246_000 },
      itcNotBooked: { missingInBooks: zero, shortInBooks: zero, total: 135_101 },
    } as unknown as ReconSummary;
    const heads = headLines(s);
    assert.deepEqual(heads.find((h) => h.key === 'cgst'), { key: 'cgst', label: 'CGST', portal: 175_500, books: 249_000, difference: -73_500 });
    const tiles = itcTiles(s);
    assert.deepEqual(tiles.map((x) => x.value), [450_201 + 351_000, 450_000 + 498_000, 246_000, 135_101]);
    assert.equal(tiles[2].caption, 'Not on portal 2,280.00 · ITC not available 180.00');
    // Only the parts that are not zero; credit notes not booked are named.
    const cn = { ...s, itcAtRisk: { missingInPortal: zero, excessInBooks: zero, itcNotAvailable: zero, creditNotesNotBooked: { ...zero, igst: 36_000 }, total: 36_000 } } as ReconSummary;
    assert.equal(itcRiskCaption(cn), 'Credit notes not booked 360.00');
    assert.equal(itcRiskCaption({ ...s, itcAtRisk: { missingInPortal: zero, excessInBooks: zero, itcNotAvailable: zero, creditNotesNotBooked: zero, total: 0 } } as ReconSummary), 'Nothing at risk');
  });

  it('status filter options carry counts, incl. "reported in another month" when known', () => {
    const opts = statusFilterOptions('gstr2b', { matched: 2, partial: 2, missing_in_portal: 3 }, 1);
    assert.deepEqual(opts.slice(0, 2).map((o) => o.label), ['Needs action (5)', 'All rows (7)']);
    assert.equal(opts[opts.length - 1].label, 'Missing — reported in another month (1)');
    assert.equal(statusFilterOptions('gstr1', {}).find((o) => o.value === 'missing_in_portal')?.label, 'Not in GSTR-1 (0)');
    assert.equal(statusFilterOptions('gstr2b', {}).at(-1)?.label, 'Missing — reported in another month');
  });

  it('results export keeps paise and ISO dates for the shell formatter', () => {
    const def = resultsExport([row()], 'gstr2b', 'April 2026', 'Needs action');
    assert.equal(def.title, 'GSTR-2B Reconciliation');
    assert.deepEqual(def.rows[0], ['Partially matched', G, 'SUPREME', 'BC/77', '2026-04-12', 'Purchase 12', 2_000_000, 360_101, 360_000, 101, '']);
    assert.equal(def.columns.length, def.rows[0].length);
  });
});

describe('gstrecon periods', () => {
  it('labels, financial years and shifting', () => {
    assert.equal(periodLabel('042026'), 'April 2026');
    assert.equal(fyOf('032026'), '2025-26');
    assert.equal(fyOf('042026'), '2026-27');
    assert.equal(shiftPeriod('012026', -1), '122025');
  });

  it('options run from the books beginning to the working month, newest first, by FY', () => {
    const g = periodOptionGroups('2026-02-10', '2026-05-20');
    assert.deepEqual(g.map((x) => [x.label, x.options.map((o) => o.value)]), [['FY 2026-27', ['052026', '042026']], ['FY 2025-26', ['032026', '022026']]]);
    const capped = periodOptionGroups('2015-04-01', '2026-05-20', 3);
    assert.deepEqual(capped.flatMap((x) => x.options.map((o) => o.value)), ['052026', '042026', '032026']);
  });

  it('opens on the previous month unless the books began this month', () => {
    assert.equal(defaultPeriod('2026-05-20', '2025-04-01'), '042026');
    assert.equal(defaultPeriod('2026-05-20', '2026-05-01'), '052026');
    assert.equal(defaultPeriod('2026-05-20', '2025-04-01', '022026'), '022026');
    assert.equal(defaultPeriod('2026-05-20', '2025-04-01', 'junk'), '042026');
    assert.equal(defaultPeriod('2026-05-20', '2025-04-01', '2026-27-Q1'), '042026', 'a quarter only where allowed');
    assert.equal(defaultPeriod('2026-05-20', '2025-04-01', '2026-27-Q1', true), '2026-27-Q1');
  });

  it('quarters for quarterly (QRMP) GSTR-1: keys, labels, storage month and options', () => {
    assert.equal(quarterOf('052026'), '2026-27-Q1');
    assert.equal(quarterOf('122026'), '2026-27-Q3');
    assert.equal(quarterOf('022027'), '2026-27-Q4');
    assert.deepEqual(quarterMonths('2026-27-Q4'), ['012027', '032027']);
    assert.equal(storageMonth('2026-27-Q1'), '062026');
    assert.equal(storageMonth('052026'), '052026');
    assert.equal(periodLabel('2026-27-Q1'), 'Apr–Jun 2026 (Q1)');
    assert.equal(isQuarterKey('2026-28-Q1'), false, 'years must be consecutive');
    // Months newest first; each quarter above its last month, the running quarter above the working month.
    const g = periodOptionGroups('2026-02-10', '2026-05-20', 36, true);
    assert.deepEqual(g.map((x) => x.options.map((o) => o.value)), [['2026-27-Q1', '052026', '042026'], ['2025-26-Q4', '032026', '022026']]);
    assert.equal(g[1].options[0].label, 'Quarter Jan–Mar 2026 (Q4)');
  });
});

describe('gstrecon follow-up link', () => {
  it('builds an encoded mailto: link and refuses one that is too long', async () => {
    const { mailtoUrl } = await import('./recon.ts');
    assert.equal(mailtoUrl('GST: April', 'Dear Sir,\nLine 2 & more'), 'mailto:?subject=GST%3A%20April&body=Dear%20Sir%2C%0D%0ALine%202%20%26%20more');
    assert.equal(mailtoUrl('x', 'y'.repeat(3000)), null);
  });
});
