/**
 * GST Reconciliation's graphs and stats (SPEC-21 §4.8, WP-J2): the share's total equals the rows the
 * status filter counts (every reconciled row but duplicates and ignored), a segment filters the table,
 * the supplier graph adds up the table's differences and sits inline in a short table, the gates, and
 * stats that never repeat a table total (the screen is not allow-listed).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReconStatus, ReconSummary, SupplierReconRow, TaxHeads } from '../../../../shared/types/gstrecon.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { reconChart, reconStat, segmentLabels, supplierChart, supplierLabel } from './charts.ts';
import { statusFilterOptions } from './recon.ts';

const zero: TaxHeads = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
const counts: Partial<Record<ReconStatus, number>> = { matched: 20, accepted: 2, partial: 3, missing_in_books: 5, missing_in_portal: 4, duplicate: 1, ignored: 1 };

function summary(over: Partial<ReconSummary> = {}): ReconSummary {
  return {
    source: 'gstr2b',
    run: { id: 1, source: 'gstr2b', period: '092026', runAt: '2026-10-10T10:00:00Z', by: null, tolerance: { amountPaise: 100, dateDays: 0, fuzzyDocNo: true }, from: '2026-09-01', to: '2026-09-30', counts },
    itcAtRisk: { missingInPortal: { ...zero, igst: 2_280_00 }, excessInBooks: zero, itcNotAvailable: zero, creditNotesNotBooked: zero, total: 2_280_00 },
    itcNotBooked: { missingInBooks: { ...zero, igst: 500_00 }, shortInBooks: zero, total: 500_00 },
    reconciledPct: 91.7,
    ...over,
  } as ReconSummary;
}

const supplier = (gstin: string, name: string | null, taxDifference: number): SupplierReconRow => ({
  gstin, name, portalCount: 1, booksCount: 1, counts: {}, openCount: taxDifference ? 1 : 0, portalTaxable: 0, portalTax: 0, booksTaxable: 0, booksTax: 0, taxDifference, taxableDifference: 0,
});

describe('Documents by status (gstrecon.home — Purchases and GSTR-1 views)', () => {
  test('total = the rows the status filter counts, without duplicates and ignored ones; gaps are the problem pole', () => {
    const spec = reconChart(summary());
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    const all = Number(/\((\d+)\)/.exec(statusFilterOptions('gstr2b', counts).find((o) => o.value === 'all')?.label ?? '')?.[1]);
    assert.equal(spec.total, all - (counts.duplicate ?? 0) - (counts.ignored ?? 0));
    assert.equal(drawnTotal(spec), spec.total);
    assert.deepEqual(spec.series[0].values, [22, 3, 5, 4]);
    assert.deepEqual(spec.categories, ['Matched', 'Amount differs', 'Not in books', 'Not on portal']);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      ['other', 2, 2, 2],
    );
    assert.equal(spec.takeaway, '12 of 34 need action; most: not in books (5)');
  });

  test('a segment filters the table to its status (Matched shows the matched rows)', () => {
    const picked: ReconStatus[] = [];
    const spec = reconChart(summary(), (s) => picked.push(s));
    for (let i = 0; i < 4; i++) spec?.activate?.(i);
    assert.deepEqual(picked, ['matched', 'partial', 'missing_in_books', 'missing_in_portal']);
  });

  test('GSTR-1 wording; nothing before the first run; fewer than 2 non-zero segments → no graph (2.1.1 D2)', () => {
    assert.deepEqual(segmentLabels('gstr1'), ['Matched', 'Amount differs', 'Not in books', 'Not in GSTR-1']);
    assert.equal(reconChart(summary({ run: null })), null);
    const run = summary().run;
    assert.ok(run);
    assert.equal(reconChart(summary({ run: { ...run, counts: { matched: 10 } } })), null, 'one segment: no graph');
    assert.equal(reconChart(summary({ run: { ...run, counts: { matched: 10, partial: 1 } } }))?.total, 11, 'two segments: a graph');
    const clean = reconChart(summary({ run: { ...run, counts: { matched: 10, partial: 1, missing_in_books: 1 } } }));
    assert.equal(clean?.takeaway, '2 of 12 need action; most: amount differs (1)');
  });

  test('stat: ITC at risk · Reconciled · ITC not booked (purchases); Tax not reported (GSTR-1); never a table total', () => {
    const s = reconStat(summary());
    assert.deepEqual(s.map((x) => [x.label, x.value]), [['ITC at risk', 2_280_00], ['Reconciled', '91.7 %'], ['ITC not booked', 500_00]]);
    assert.equal(s[0].title, 'Not on portal 2,280.00');
    const g1 = reconStat(summary({ source: 'gstr1', itcNotBooked: { missingInBooks: zero, shortInBooks: zero, total: 0 } }));
    assert.deepEqual(g1.map((x) => x.label), ['Tax not reported']);
    assert.deepEqual(reconStat(summary({ run: null })), []);
    assert.equal(statTotalAllowed('gstrecon.home'), false);
    // The results table is a paged list of documents: it shows no total row.
    assert.equal(statRepeatsTotal(s.map((x) => x.value).filter((v): v is number => typeof v === 'number'), []), false);
  });
});

describe('Tax difference by supplier (gstrecon.home — Supplier-wise view)', () => {
  const rows = [supplier('27AAAAA0000A1Z5', 'Asha Traders', -1_200_00), supplier('27BBBBB0000B1Z5', 'Kumar Paints', 300_00), supplier('27CCCCC0000C1Z5', null, -50_00), supplier('27DDDDD0000D1Z5', 'Even Ltd', 0)];

  test('total = Σ |difference| of the table rows; a short table carries the bars inline', () => {
    const spec = supplierChart(rows);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, rows.reduce((a, r) => a + Math.abs(r.taxDifference), 0));
    assert.equal(drawnTotal(spec), spec.total);
    assert.equal(inlineBars(spec, rows.length), true);
    assert.deepEqual(spec.categories, ['Asha Traders · less on portal', 'Kumar Paints · more on portal', '27CCCCC0000C1Z5 · less on portal', 'Even Ltd']);
    assert.equal(spec.takeaway, 'Asha Traders: ₹1.2 K less on the portal than in your books');
  });

  test('many suppliers: Top 6 + Other (a strip), Σ preserved; Enter opens the supplier, Other nothing', () => {
    const many = Array.from({ length: 10 }, (_, i) => supplier(`27X${i}`, `S${i}`, (i + 1) * 100_00));
    const opened: string[] = [];
    const spec = supplierChart(many, (r) => opened.push(r.gstin));
    assert.ok(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(inlineBars(spec, many.length), false);
    assert.equal(spec.total, many.reduce((a, r) => a + r.taxDifference, 0));
    spec.activate?.(0);
    spec.activate?.(6);
    assert.deepEqual(opened, ['27X9']);
  });

  test('labels never carry a minus; fewer than 2 suppliers that differ → no graph (2.1.1 D2)', () => {
    assert.equal(supplierLabel({ name: null, gstin: '', taxDifference: -1 }), '(no GSTIN) · less on portal');
    assert.ok(!supplierChart(rows)?.categories.some((c) => /[−-]\d/.test(c)));
    assert.equal(supplierChart(rows.slice(2)), null, 'one supplier differs (the other is even): no graph');
    assert.equal(supplierChart(rows.slice(1))?.total, 350_00, 'two differ: a graph');
    // A supplier with neither name nor GSTIN is still named in the takeaway.
    assert.equal(supplierChart([supplier('', null, -5_000_00), ...rows.slice(0, 2)])?.takeaway, '(no GSTIN): ₹5.0 K less on the portal than in your books');
  });
});
