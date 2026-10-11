/**
 * The GST registers' graphs and stats (SPEC-21 §4.8, WP-J2): for every builder the graph total equals
 * the visible table's total, the minimum-data and §5 gates, the colour by meaning, the takeaway, and
 * stats that never repeat a total the table shows (none of these screens is allow-listed).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { BoeReconResult, BoeReconRow, Gstr1AdvancesSummary, Table11Row } from '../../../../shared/types/gst-plus.ts';
import type { GstHsnRow, GstIssue, GstItcSupplierRow, GstRateSplit, GstRegisterResult, GstRegisterRow, TaxAmounts } from '../../../../shared/types/gst-returns.ts';
import { loadCompany } from '../../../../core/modules/gst/docs.ts';
import { exceptionsReport, gstRegister, hsnSummary, itcReport } from '../../../../core/modules/gst/reports.ts';
import { aprilDataset, insertDoc } from '../../../../core/modules/gst/testkit.ts';
import type { Dataset } from '../../../../core/modules/gst/testkit.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { countIssues } from './issues.ts';
import { advancesStat, boeChart, boeStat, eligibleOf, exceptionsChart, exceptionsStat, hsnChart, hsnLabel, itcChart, itcStat, pendingStat, rateChart, topItems } from './registerCharts.ts';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const tax = (igst: number, cgst = 0, sgst = 0, cess = 0): TaxAmounts => ({ igst, cgst, sgst, cess });
const NONE = tax(0);
const numbers = (items: ReadonlyArray<{ value: unknown }>) => items.map((i) => i.value).filter((v): v is number => typeof v === 'number');

// ───────────────────────────── fixtures ─────────────────────────────

const split = (rate: number, taxable: number, cessRate = 0): GstRateSplit => ({ rate, cessRate, taxable, igst: 0, cgst: (taxable * rate) / 200, sgst: (taxable * rate) / 200, cess: 0 });

function regRow(id: number, rates: GstRateSplit[], sign: 1 | -1 = 1): GstRegisterRow {
  const t = rates.reduce((a, r) => ({ taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst }), { taxable: 0, cgst: 0, sgst: 0 });
  return {
    voucherId: id, date: '2026-09-10', number: `S/${id}`, voucherTypeName: 'Sales', baseType: 'sales', partyName: `Party ${id}`, gstin: null,
    stateCode: '27', stateName: 'Maharashtra', nature: 'b2cs', natureLabel: 'B2C small', reverseCharge: false, supplierInvoiceNo: null, supplierInvoiceDate: null,
    invoiceValue: t.taxable + t.cgst + t.sgst, sign, rates, nonTaxable: 0, igst: 0, cess: 0, ...t,
  } as GstRegisterRow;
}

/** The register as the core builds it: rateTotals per (rate, cess rate), totals Σ rows. */
function register(rows: GstRegisterRow[], kind: 'sales' | 'purchase' = 'sales'): GstRegisterResult {
  const rates = new Map<string, GstRateSplit>();
  for (const r of rows) {
    for (const x of r.rates) {
      const k = `${x.rate}|${x.cessRate}`;
      const acc = rates.get(k) ?? { rate: x.rate, cessRate: x.cessRate, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      acc.taxable += x.taxable;
      acc.cgst += x.cgst;
      acc.sgst += x.sgst;
      rates.set(k, acc);
    }
  }
  const totals = { taxable: sum(rows.map((r) => r.taxable)), igst: 0, cgst: sum(rows.map((r) => r.cgst)), sgst: sum(rows.map((r) => r.sgst)), cess: 0, invoiceValue: sum(rows.map((r) => r.invoiceValue)), nonTaxable: 0 };
  return { from: '2026-09-01', to: '2026-09-30', kind, rows, totals, rateTotals: [...rates.values()].sort((a, b) => a.rate - b.rate || a.cessRate - b.cessRate) };
}

const hsn = (code: string, description: string, taxable: number, rate = 18): GstHsnRow => ({
  hsn: code, description, uqc: 'NOS', qty: 1, rate, taxable, igst: 0, cgst: (taxable * rate) / 200, sgst: (taxable * rate) / 200, cess: 0, total: taxable * (1 + rate / 100), supplyType: 'goods',
});

const supplier = (n: number, eligible: TaxAmounts, over: Partial<GstItcSupplierRow> = {}): GstItcSupplierRow => ({
  partyLedgerId: n, partyName: `Supplier ${n}`, gstin: null, documents: 1, taxable: eligible.igst * 5, eligible, ineligible: NONE, reverseCharge: NONE, imports: NONE, ...over,
});

const issue = (code: GstIssue['code'], severity: GstIssue['severity'], n = 1): GstIssue => ({
  code, severity, voucherId: n, voucherNumber: `S/${n}`, voucherTypeName: 'Sales', date: '2026-09-10', partyName: 'Asha Retail', section: null, message: 'What is wrong', fix: 'How to fix',
});

// ───────────────────────────── GST Register ─────────────────────────────

describe('Sales before GST, by rate (gst.register)', () => {
  const r = register([regRow(1, [split(5, 10_000_00), split(18, 40_000_00)]), regRow(2, [split(12, 8_000_00), split(18, 22_000_00, 1)]), regRow(3, [split(18, -2_000_00)], -1)]);

  test('graph total = the Taxable value total of the register; cess variants of a rate are one column', () => {
    const spec = rateChart(r);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.deepEqual(spec.categories, ['5%', '12%', '18%']);
    assert.deepEqual(spec.series[0].values, [10_000_00, 8_000_00, 60_000_00]);
    assert.equal(spec.total, r.totals.taxable);
    assert.equal(drawnTotal(spec), sum(r.rows.map((x) => x.taxable)));
    assert.equal(spec.title, 'Sales before GST, by rate');
    assert.equal(spec.takeaway, '18% carries 77 % of taxable sales');
    assert.equal(spec.label, 'max');
  });

  test('purchases are named as such', () => {
    const spec = rateChart({ ...r, kind: 'purchase' });
    assert.equal(spec?.title, 'Purchases before GST, by rate');
    assert.match(spec?.takeaway ?? '', /taxable purchases$/);
  });

  test('null with fewer than 2 rates (2.1.1 D2), and when a rate is negative (returns larger than sales)', () => {
    assert.equal(rateChart(register([regRow(1, [split(18, 2_000_00)])])), null, 'one rate: no graph');
    assert.equal(rateChart(register([regRow(1, [split(5, 1_000_00), split(18, 2_000_00)])]))?.total, 3_000_00, 'two rates: a graph');
    assert.equal(rateChart(register([regRow(1, [split(5, 1_000_00), split(12, 1_000_00), split(18, 2_000_00)]), regRow(2, [split(28, -500_00)], -1)])), null);
    assert.equal(rateChart(register([])), null);
  });
});

// ───────────────────────────── HSN ─────────────────────────────

describe('Taxable value by HSN/SAC (gst.hsn)', () => {
  test('graph total = the Taxable value total; one code per row and ≤ 7 rows → bars inline in the table', () => {
    const rows = [hsn('3208', 'Paints and varnishes based on synthetic polymers', 50_000_00), hsn('7318', 'Screws, bolts, nuts', 12_000_00), hsn('8467', 'Tools for working in the hand', 20_000_00)];
    const spec = hsnChart({ direction: 'outward', rows });
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, sum(rows.map((x) => x.taxable)));
    assert.equal(drawnTotal(spec), spec.total);
    assert.equal(inlineBars(spec, rows.length), true);
    assert.equal(spec.categories[0], '3208 · Paints and varnishes…');
    assert.equal(spec.takeaway, '3208 · Paints and varnishes… holds 61 % of the taxable value');
    assert.equal(spec.title, 'Taxable sales by HSN/SAC');
  });

  test('a code on several rows (two rates) is one bar: the graph is a strip, not inline', () => {
    const rows = [hsn('3208', 'Paints', 50_000_00, 18), hsn('3208', 'Paints', 5_000_00, 12), hsn('7318', 'Screws', 12_000_00), hsn('8467', 'Tools', 20_000_00)];
    const spec = hsnChart({ direction: 'inward', rows });
    assert.ok(spec);
    assert.deepEqual(spec.series[0].values, [55_000_00, 20_000_00, 12_000_00]);
    assert.equal(spec.total, sum(rows.map((x) => x.taxable)));
    assert.equal(inlineBars(spec, rows.length), false);
    assert.equal(spec.title, 'Taxable purchases by HSN/SAC');
  });

  test('more than 7 codes fold into Top 6 + Other with Σ preserved; a missing code is named', () => {
    const rows = Array.from({ length: 10 }, (_, i) => hsn(i === 9 ? '' : String(1000 + i), '', (i + 1) * 1_000_00));
    const spec = hsnChart({ direction: 'outward', rows });
    assert.ok(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[0], 'No HSN/SAC');
    assert.equal(spec.categories[6], 'Other');
    assert.equal(spec.total, sum(rows.map((x) => x.taxable)));
    assert.deepEqual(specProblems(spec), []);
  });

  test('gates: fewer than 2 codes (2.1.1 D2), a negative code', () => {
    assert.equal(hsnChart({ direction: 'outward', rows: [hsn('1', 'a', 1_00)] }), null, 'one code: no graph');
    assert.equal(hsnChart({ direction: 'outward', rows: [hsn('1', 'a', 1_00), hsn('2', 'b', 2_00)] })?.total, 3_00, 'two codes: a graph');
    assert.equal(hsnChart({ direction: 'inward', rows: [hsn('1', 'a', 1_00), hsn('2', 'b', 2_00), hsn('3', 'c', -5_00)] }), null);
  });

  test('hsnLabel', () => {
    assert.equal(hsnLabel('8471', ''), '8471');
    assert.equal(hsnLabel('', 'Labour'), 'No HSN/SAC · Labour');
  });
});

// ───────────────────────────── ITC ─────────────────────────────

describe('Eligible ITC by supplier (gst.itc)', () => {
  const rows = [
    supplier(1, tax(9_000_00)),
    supplier(2, tax(0, 1_800_00, 1_800_00)),
    supplier(3, tax(2_000_00, 0, 0, 500_00), { ineligible: tax(1_000_00) }),
    supplier(4, NONE, { ineligible: tax(3_000_00) }),
  ];
  const totals = {
    taxable: sum(rows.map((r) => r.taxable)),
    eligible: rows.reduce((a, r) => tax(a.igst + r.eligible.igst, a.cgst + r.eligible.cgst, a.sgst + r.eligible.sgst, a.cess + r.eligible.cess), NONE),
    ineligible: tax(4_000_00),
    reverseCharge: NONE,
    imports: NONE,
  };
  /** The totals the table shows: Docs, Taxable, the four Eligible heads, Reverse charge, On imports (Blocked shows none). */
  const visible = [sum(rows.map((r) => r.documents)), totals.taxable, totals.eligible.igst, totals.eligible.cgst, totals.eligible.sgst, totals.eligible.cess, 0, 0];

  test('graph total = the eligible ITC of the table (its four Eligible columns added); suppliers without credit leave the graph', () => {
    const spec = itcChart({ rows });
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, totals.eligible.igst + totals.eligible.cgst + totals.eligible.sgst + totals.eligible.cess);
    assert.equal(drawnTotal(spec), sum(rows.map(eligibleOf)));
    assert.deepEqual(spec.categories, ['Supplier 1', 'Supplier 2', 'Supplier 3']);
    assert.equal(spec.takeaway, 'Supplier 1 holds 60 % of eligible ITC');
    assert.equal(spec.color, undefined);
  });

  test('Enter on a bar opens that supplier; Top 6 + Other for many suppliers, Other opens nothing', () => {
    const many = Array.from({ length: 9 }, (_, i) => supplier(i + 1, tax((i + 1) * 1_000_00)));
    const opened: number[] = [];
    const spec = itcChart({ rows: many }, (r) => opened.push(r.partyLedgerId ?? 0));
    assert.ok(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.total, sum(many.map(eligibleOf)));
    spec.activate?.(0);
    spec.activate?.(6);
    assert.deepEqual(opened, [9]);
  });

  test('a supplier with more returns than purchases turns the graph to polarity (slot 2)', () => {
    const spec = itcChart({ rows: [...rows, supplier(5, tax(-700_00))] });
    assert.ok(spec);
    assert.equal(spec.color, 'polarity');
    assert.equal(markColor(spec, spec.categories.indexOf('Supplier 5')), 2);
    assert.deepEqual(specProblems(spec), []);
  });

  test('stat: Blocked only when > 0, never a total the table shows', () => {
    const stat = itcStat({ totals });
    assert.deepEqual(stat.map((s) => [s.label, s.value]), [['Blocked', 4_000_00]]);
    assert.equal(statTotalAllowed('gst.itc'), false);
    assert.equal(statRepeatsTotal(numbers(stat), visible), false);
    assert.deepEqual(itcStat({ totals: { ...totals, ineligible: NONE } }), []);
  });

  test('null with fewer than 2 suppliers with credit (2.1.1 D2)', () => {
    assert.equal(itcChart({ rows: rows.slice(0, 1) }), null, 'one supplier: no graph');
    assert.ok(itcChart({ rows: rows.slice(0, 2) }), 'two suppliers: a graph');
  });
});

// ───────────────────────────── Exceptions ─────────────────────────────

describe('Problems by type (gst.exceptions)', () => {
  const issues = [
    issue('hsn_missing', 'error', 1),
    issue('hsn_missing', 'error', 2),
    issue('hsn_missing', 'error', 3),
    issue('gstin_invalid', 'error', 4),
    issue('hsn_short', 'warning', 5),
    issue('hsn_short', 'warning', 6),
  ];

  test('graph total = the rows of the table; error types are the problem pole, warning types grey', () => {
    const spec = exceptionsChart(issues);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, issues.length);
    assert.equal(drawnTotal(spec), issues.length);
    assert.deepEqual(spec.categories, ['HSN/SAC missing', 'HSN/SAC too short', 'GSTIN invalid']);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      [2, 'other', 2],
    );
    assert.equal(spec.takeaway, '2 of 3 types block filing; most often HSN/SAC missing (3)');
  });

  test('a bar filters the table to its type; Other clears the filter', () => {
    const many = Array.from({ length: 9 }, (_, i) => issue((['gstin_missing', 'gstin_invalid', 'b2c_with_gstin', 'hsn_missing', 'hsn_short', 'hsn_invalid', 'pos_missing', 'doc_no_missing', 'doc_series_gap'] as const)[i], i % 2 ? 'warning' : 'error', i));
    const picked: Array<string | null> = [];
    const spec = exceptionsChart(many, (c) => picked.push(c));
    assert.ok(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.total, many.length);
    spec.activate?.(0);
    spec.activate?.(6);
    assert.equal(picked.length, 2);
    assert.equal(typeof picked[0], 'string');
    assert.equal(picked[1], null);
  });

  test('none without problems (the success line says it) and with fewer than 2 types (2.1.1 D2)', () => {
    assert.equal(exceptionsChart([]), null);
    assert.equal(exceptionsChart(issues.filter((i) => i.code === issues[0].code)), null, 'one type: no graph');
    const twoTypes = issues.filter((i) => i.code === issues[0].code || i.code === issues.find((x) => x.code !== issues[0].code)?.code);
    assert.equal(exceptionsChart(twoTypes)?.total, twoTypes.length, 'two types: a graph');
  });

  test('stat in counts; the table has no totals to repeat', () => {
    assert.deepEqual(exceptionsStat({ errors: 4, warnings: 2 }).map((s) => `${s.label} ${s.value}`), ['Errors 4', 'Warnings 2']);
    assert.deepEqual(exceptionsStat({ errors: 0, warnings: 1 }).map((s) => s.label), ['Warnings']);
    assert.equal(statRepeatsTotal(numbers(exceptionsStat({ errors: 4, warnings: 2 })), []), false);
  });
});

// ───────────────────────────── Bills of entry ─────────────────────────────

describe('Bills of entry against GSTR-2B (gst.boe, reconcile view)', () => {
  const row = (status: BoeReconRow['status']): BoeReconRow => ({ status } as BoeReconRow);
  const result = (statuses: BoeReconRow['status'][]): BoeReconResult => {
    const counts = { matched: 0, mismatch: 0, missing_in_books: 0, missing_in_portal: 0 };
    for (const s of statuses) counts[s]++;
    return { period: null, rows: statuses.map(row), counts, warnings: [] };
  };

  test('graph total = the rows of the reconciliation table; Matched grey, the gaps slot 2', () => {
    const r = result(['matched', 'matched', 'matched', 'mismatch', 'missing_in_books', 'missing_in_portal']);
    const spec = boeChart(r);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, r.rows.length);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      ['other', 2, 2, 2],
    );
    assert.equal(spec.takeaway, '3 of 6 bills of entry do not agree with GSTR-2B');
    assert.deepEqual(boeStat(r).map((s) => `${s.label} ${s.value}`), ['Matched 3 of 6']);
  });

  test('fewer than 2 non-zero segments: no graph (the stat says it; 2.1.1 D2)', () => {
    assert.equal(boeChart(result(['matched', 'matched'])), null, 'one segment: no graph');
    assert.equal(boeChart(result(['matched', 'matched', 'mismatch']))?.total, 3, 'two segments: a graph');
    assert.deepEqual(boeStat(result([])), []);
  });
});

// ───────────────────────────── Stats of the queues and Table 11 ─────────────────────────────

describe('stats without a graph', () => {
  test('e-Invoice / e-Way Bills: Pending N · Ready M (counts, not money)', () => {
    const s = pendingStat([{ ready: true }, { ready: false }, { ready: true }]);
    assert.deepEqual(s.map((x) => `${x.label} ${x.value}`), ['Pending 3', 'Ready 2']);
    assert.equal(numbers(s).length, 0);
    assert.deepEqual(pendingStat([]), []);
  });

  test('Advances: the net tax in 3.1(a), never a total of the 11A / 11B tables', () => {
    const t11 = (igst: number, cgst = 0, sgst = 0): Table11Row => ({ pos: '27', posName: 'Maharashtra', supplyKind: 'INTRA', rate: 18, gross: 0, taxable: 0, igst, cgst, sgst, cess: 0 } as Table11Row);
    const a: Gstr1AdvancesSummary = { received: [t11(0, 900_00, 900_00), t11(1_800_00)], adjusted: [t11(0, 450_00, 450_00)], vouchers: [], net: { taxable: 15_000_00, igst: 1_800_00, cgst: 450_00, sgst: 450_00, cess: 0 } };
    const stat = advancesStat(a);
    assert.deepEqual(stat.map((s) => [s.label, s.value]), [['Net tax in 3.1(a)', 2_700_00]]);
    const visible = [...['taxable', 'igst', 'cgst', 'sgst', 'cess'].flatMap((k) => [sum(a.received.map((r) => r[k as 'igst'])), sum(a.adjusted.map((r) => r[k as 'igst']))])];
    assert.equal(statRepeatsTotal(numbers(stat), visible), false);
    assert.deepEqual(advancesStat({ received: [], adjusted: [], net: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 } }), []);
  });

  test('none of these screens may repeat a total (not allow-listed)', () => {
    for (const id of ['gst.register', 'gst.hsn', 'gst.itc', 'gst.exceptions', 'gst.boe', 'gst.einvoice', 'gst.ewaybill', 'gst.advances']) assert.equal(statTotalAllowed(id), false, id);
  });
});

// ───────────────────────── tie-out with the core's own reports ─────────────────────────

/**
 * The fixtures above are hand-built; here the builders read what the core really returns for the
 * April-2026 GST dataset (core/modules/gst/testkit.ts, + one 12 % sale so the register has 3 rates),
 * and the drawn total must equal the figure the table prints under its column.
 */
describe('graph total = table total on the core reports (April 2026 dataset)', () => {
  let ds: Dataset;
  const A = ['2026-04-01', '2026-04-30'] as const;
  before(() => {
    ds = aprilDataset();
    insertDoc(ds.t, { type: 'sales', number: 'R12-1', date: '2026-04-20', party: ds.P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '39269099', desc: 'Plastic fittings', uqc: 'NOS', qty: 4, rate: 12, taxable: 40000, cgst: 2400, sgst: 2400 }] });
  });
  after(() => ds.t.close());

  test('GST Register: Σ columns = the Taxable value total (sales and purchases)', () => {
    const sales = gstRegister(ds.t.db, loadCompany(ds.t.db), ...A, 'sales', ds.t.today);
    const spec = rateChart(sales);
    assert.ok(spec, 'three rates on the sales side');
    assert.deepEqual(specProblems(spec), []);
    assert.equal(drawnTotal(spec), sales.totals.taxable);
    assert.equal(sales.totals.taxable, sum(sales.rows.map((r) => r.taxable)));
    const purchases = gstRegister(ds.t.db, loadCompany(ds.t.db), ...A, 'purchase', ds.t.today);
    const p = rateChart(purchases);
    if (p) assert.equal(drawnTotal(p), purchases.totals.taxable);
  });

  test('HSN/SAC Summary: Σ bars = the Taxable value total, both directions', () => {
    for (const direction of ['outward', 'inward'] as const) {
      const r = hsnSummary(ds.t.db, loadCompany(ds.t.db), ...A, direction, ds.t.today);
      const spec = hsnChart(r);
      assert.ok(spec, `the ${direction} summary has ≥ 3 codes`);
      assert.deepEqual(specProblems(spec), [], direction);
      assert.equal(drawnTotal(spec), r.totals.taxable, direction);
      assert.equal(drawnTotal(spec), sum(r.rows.map((x) => x.taxable)), direction);
    }
  });

  test('Input Tax Credit: Σ bars = the four Eligible columns added; the stat is the blocked credit', () => {
    const r = itcReport(ds.t.db, loadCompany(ds.t.db), ...A, ds.t.today);
    const eligible = r.totals.eligible.igst + r.totals.eligible.cgst + r.totals.eligible.sgst + r.totals.eligible.cess;
    const spec = itcChart(r);
    assert.ok(spec, '≥ 3 suppliers with credit');
    assert.deepEqual(specProblems(spec), []);
    assert.equal(drawnTotal(spec), eligible);
    const blocked = r.totals.ineligible.igst + r.totals.ineligible.cgst + r.totals.ineligible.sgst + r.totals.ineligible.cess;
    assert.deepEqual(numbers(itcStat(r)), blocked ? [blocked] : []);
  });

  test('GST Exceptions: Σ bars = the rows of the table; the stat = the report\'s counts', () => {
    const r = exceptionsReport(ds.t.db, loadCompany(ds.t.db), ...A, ds.t.today);
    const spec = exceptionsChart(r.issues);
    assert.ok(spec, '≥ 3 problem types');
    assert.deepEqual(specProblems(spec), []);
    assert.equal(drawnTotal(spec), r.issues.length);
    assert.deepEqual(countIssues(r.issues), { errors: r.counts.errors, warnings: r.counts.warnings });
    const stat = exceptionsStat(countIssues(r.issues));
    assert.deepEqual(
      stat.map((x) => Number(x.value)),
      [r.counts.errors, r.counts.warnings].filter((n) => n > 0),
    );
  });
});

describe('topItems (the fold of foldTop, keeping the items)', () => {
  test('n + 1 items are all shown; more fold, Σ preserved', () => {
    assert.deepEqual(topItems([1, 2, 3, 4, 5, 6, 7], (x) => x).rest, []);
    const f = topItems([1, -9, 3, 4, 5, 6, 7, 8], (x) => x);
    assert.deepEqual(f.head, [-9, 8, 7, 6, 5, 4]);
    assert.deepEqual(f.rest, [3, 1]);
  });

  test('builders stay fast on 10,000 rows (best of 3 runs, so a busy machine does not fail it)', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => supplier(i, tax(i * 100)));
    const hsnRows = rows.map((r, i) => hsn(String(i % 500), 'x', r.eligible.igst));
    const issues = Array.from({ length: 10_000 }, (_, i) => issue(i % 2 ? 'hsn_missing' : i % 3 ? 'gstin_invalid' : 'hsn_short', 'error', i));
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      itcChart({ rows });
      hsnChart({ direction: 'outward', rows: hsnRows });
      exceptionsChart(issues);
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 150, `built in ${best.toFixed(1)} ms`);
  });
});
