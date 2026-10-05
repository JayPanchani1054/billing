import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ComputedLine, InvoiceComputation, InvoiceContext, InvoiceLineInput } from '../types/gst.ts';
import { computeInvoice, taxableFromInclusive, taxAt } from './engine.ts';
import { GST_RATES } from './rates.ts';

// ───────────────────────────── helpers ─────────────────────────────

const ctx = (over: Partial<InvoiceContext> = {}): InvoiceContext => ({
  direction: 'outward',
  invoiceDate: '2026-10-05',
  companyStateCode: '27',
  companyRegistration: 'regular',
  partyRegistration: 'regular',
  partyStateCode: '27',
  ...over,
});

const item = (key: string, qty: number, rate: number, gstRate: number, over: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  key,
  kind: 'item',
  qty,
  rate,
  taxability: 'taxable',
  gstRate,
  supplyKind: 'goods',
  hsnSac: '84713010',
  uqc: 'NOS',
  ...over,
});

const ledger = (key: string, amount: number, gstRate: number, over: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  key,
  kind: 'ledger',
  amount,
  taxability: 'taxable',
  gstRate,
  supplyKind: 'services',
  hsnSac: '996511',
  ...over,
});

const nil = (key: string, amount: number): InvoiceLineInput => ledger(key, amount, 0, { taxability: 'nil_rated', supplyKind: 'goods', hsnSac: '1006' });

const line = (r: InvoiceComputation, key: string): ComputedLine => {
  const l = r.lines.find((x) => x.key === key);
  assert.ok(l, `line ${key}`);
  return l;
};

/** Invariants every computation must satisfy. Returns the computation for chaining. */
function check(r: InvoiceComputation): InvoiceComputation {
  const sumLines = (f: (l: ComputedLine) => number): number => r.lines.reduce((a, l) => a + f(l), 0);
  for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
    assert.equal(sumLines((l) => l[head]), r.totals[head], `Σ line ${head} = total`);
    assert.equal(r.buckets.reduce((a, b) => a + b[head], 0), r.totals[head], `Σ bucket ${head} = total`);
    assert.equal(r.hsnSummary.reduce((a, h) => a + h[head], 0), r.totals[head], `Σ HSN ${head} = total`);
  }
  assert.equal(sumLines((l) => l.taxableValue), r.totals.taxable, 'Σ line taxable');
  assert.equal(r.buckets.reduce((a, b) => a + b.taxableValue, 0), r.totals.taxable, 'Σ bucket taxable');
  assert.equal(r.hsnSummary.reduce((a, h) => a + h.taxableValue, 0), r.totals.taxable, 'Σ HSN taxable');
  assert.equal(sumLines((l) => l.postingAmount), r.totals.taxable, 'Σ posting = taxable');
  assert.equal(sumLines((l) => l.apportioned), 0, 'Σ apportioned = 0');
  for (const l of r.lines) {
    assert.equal(l.cgst, l.sgst, `${l.key}: CGST = SGST`);
    assert.equal(l.tax, l.igst + l.cgst + l.sgst + l.cess, `${l.key}: tax`);
    assert.equal(l.total, l.taxableValue + l.tax, `${l.key}: total`);
    assert.equal(l.postingAmount, l.taxableValue - l.apportioned, `${l.key}: posting`);
    for (const [k, v] of Object.entries(l)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${l.key}.${k} finite`);
  }
  const t = r.totals;
  for (const [k, v] of Object.entries(t)) assert.ok(Number.isSafeInteger(v), `totals.${k} is a safe integer`);
  assert.equal(t.tax, t.igst + t.cgst + t.sgst + t.cess);
  assert.equal(t.invoiceValueBeforeRound, t.taxable + t.tax - t.reverseChargeTax);
  assert.equal(t.grandTotal, t.invoiceValueBeforeRound + t.roundOff);
  assert.equal(t.payableToParty, t.grandTotal);
  return r;
}

// ───────────────────────────── tax mode & place of supply ─────────────────────────────

describe('tax mode and place of supply', () => {
  test('intra-state B2B at 18% → CGST 9% + SGST 9%', () => {
    // 10 × ₹100 = ₹1,000.00 = 100000 paise; CGST = SGST = 100000 × 9% = 9000
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx()));
    assert.equal(r.taxMode, 'cgst_sgst');
    assert.equal(r.interState, false);
    assert.equal(r.placeOfSupply, '27');
    assert.equal(r.nature, 'b2b');
    assert.equal(r.documentKind, 'tax_invoice');
    assert.deepEqual([r.totals.taxable, r.totals.cgst, r.totals.sgst, r.totals.igst], [100000, 9000, 9000, 0]);
    assert.equal(r.totals.grandTotal, 118000);
    assert.deepEqual(r.warnings, []);
  });

  test('inter-state → IGST 18%', () => {
    // 100000 × 18% = 18000
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyStateCode: '29' })));
    assert.equal(r.taxMode, 'igst');
    assert.equal(r.interState, true);
    assert.equal(r.placeOfSupply, '29');
    assert.deepEqual([r.totals.igst, r.totals.cgst, r.totals.sgst], [18000, 0, 0]);
  });

  test('Chandigarh (UT without legislature) → CGST + UTGST', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ companyStateCode: '04', partyStateCode: '04' })));
    assert.equal(r.taxMode, 'cgst_utgst');
    assert.deepEqual([r.totals.cgst, r.totals.sgst], [9000, 9000]);
  });

  test('Ladakh uses UTGST; Delhi, Puducherry and J&K (legislatures) use SGST', () => {
    const mode = (s: string): string => computeInvoice([item('a', 1, 100, 18)], ctx({ companyStateCode: s, partyStateCode: s })).taxMode;
    assert.equal(mode('38'), 'cgst_utgst');
    assert.equal(mode('26'), 'cgst_utgst');
    assert.equal(mode('07'), 'cgst_sgst');
    assert.equal(mode('34'), 'cgst_sgst');
    assert.equal(mode('01'), 'cgst_sgst');
  });

  test('SEZ party in the same state → inter-state; LUT → zero tax, with payment → IGST', () => {
    const lut = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyRegistration: 'sez' })));
    assert.equal(lut.interState, true);
    assert.equal(lut.taxMode, 'igst');
    assert.equal(lut.nature, 'sez_lut');
    assert.equal(lut.totals.tax, 0);
    assert.equal(lut.totals.grandTotal, 100000);
    assert.equal(line(lut, 'a').taxCharged, false);
    assert.equal(line(lut, 'a').rate, 18, 'nominal rate kept for GSTR-1');

    const wpay = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyRegistration: 'sez', exportWithPayment: true })));
    assert.equal(wpay.nature, 'sez_wpay');
    assert.equal(wpay.totals.igst, 18000);
  });

  test('our company is an SEZ unit: supply to a DTA buyer in the same state is inter-state', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ companyIsSez: true })));
    assert.equal(r.interState, true);
    assert.equal(r.totals.igst, 18000);
  });

  test('export under LUT → POS 96, zero tax; with payment → IGST', () => {
    const lut = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyRegistration: 'overseas', partyStateCode: null })));
    assert.equal(lut.placeOfSupply, '96');
    assert.match(lut.posReason, /Export/);
    assert.equal(lut.nature, 'export_lut');
    assert.equal(lut.taxMode, 'igst');
    assert.equal(lut.totals.tax, 0);
    assert.equal(lut.totals.grandTotal, 100000);

    const wpay = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyRegistration: 'overseas', partyStateCode: null, exportWithPayment: true })));
    assert.equal(wpay.nature, 'export_wpay');
    assert.equal(wpay.totals.igst, 18000);
    assert.equal(wpay.totals.grandTotal, 118000);
  });

  test('explicit place of supply wins over party state', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ placeOfSupply: '29' })));
    assert.equal(r.placeOfSupply, '29');
    assert.match(r.posReason, /entered on the voucher/);
    assert.equal(r.totals.igst, 18000);
  });

  test('goods shipped to a consignee in another state → POS = consignee state', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ consigneeStateCode: '29' })));
    assert.equal(r.placeOfSupply, '29');
    assert.equal(r.taxMode, 'igst');
    // Services ignore the consignee: POS stays with the recipient.
    const s = check(computeInvoice([ledger('s', 100000, 18)], ctx({ consigneeStateCode: '29' })));
    assert.equal(s.placeOfSupply, '27');
    assert.equal(s.taxMode, 'cgst_sgst');
  });

  test('walk-in consumer without a state → POS = company state (intra-state)', () => {
    const r = check(computeInvoice([item('a', 1, 100, 18)], ctx({ partyRegistration: 'consumer', partyStateCode: null })));
    assert.equal(r.placeOfSupply, '27');
    assert.equal(r.taxMode, 'cgst_sgst');
    assert.equal(r.nature, 'b2cs');
  });

  test('party state is taken from the GSTIN when not entered', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyStateCode: null, partyGstin: '29AAGCB7383J1Z4' })));
    assert.equal(r.placeOfSupply, '29');
    assert.equal(r.totals.igst, 18000);
    assert.deepEqual(r.warnings, []);
  });
});

// ───────────────────────────── buckets & rounding ─────────────────────────────

describe('bucket computation and exact allocation', () => {
  test('mixed 5% and 18% → two buckets', () => {
    // A: 2 × ₹500 = 100000 @5% → CGST/SGST 2.5% = 2500 each
    // B: 1 × ₹2000 = 200000 @18% → 9% = 18000 each
    const r = check(computeInvoice([item('a', 2, 500, 5), item('b', 1, 2000, 18)], ctx()));
    assert.deepEqual(
      r.buckets.map((b) => [b.rate, b.taxableValue, b.cgst, b.sgst]),
      [
        [5, 100000, 2500, 2500],
        [18, 200000, 18000, 18000],
      ],
    );
    assert.equal(r.totals.tax, 41000);
    assert.equal(r.totals.grandTotal, 341000);
  });

  test('CGST rounding per bucket differs from per-line rounding, lines still sum exactly', () => {
    // Each line ₹10.10 = 1010 paise @5% intra. Per-line CGST = 1010 × 2.5% = 25.25 → 25; 3 lines → 75.
    // Bucket: 3030 × 2.5% = 75.75 → 76. allocate(76, [1010,1010,1010]) = 25.33 each → floors 75,
    // remainder 1 to the first line → [26, 25, 25].
    const lines = [item('a', 1, 10.1, 5), item('b', 1, 10.1, 5), item('c', 1, 10.1, 5)];
    const r = check(computeInvoice(lines, ctx()));
    const naive = r.lines.reduce((a, l) => a + taxAt(l.taxableValue, 2.5), 0);
    assert.equal(naive, 75);
    assert.equal(r.totals.cgst, 76);
    assert.deepEqual(r.lines.map((l) => l.cgst), [26, 25, 25]);
    assert.deepEqual(r.lines.map((l) => l.sgst), [26, 25, 25]);
  });

  test('IGST half-paise case: bucket 151.5 → 152 while per-line rounding gives 153', () => {
    // 1010 × 5% = 50.5 → 51 per line (153 naive). Bucket 3030 × 5% = 151.5 → 152 →
    // 50.67 each → floors 150, remainder 2 → [51, 51, 50].
    const lines = [item('a', 1, 10.1, 5), item('b', 1, 10.1, 5), item('c', 1, 10.1, 5)];
    const r = check(computeInvoice(lines, ctx({ partyStateCode: '29' })));
    assert.equal(r.totals.igst, 152);
    assert.deepEqual(r.lines.map((l) => l.igst), [51, 51, 50]);
  });

  test('seven ₹0.99 lines at 18%: per-line rounding would overstate by one paise', () => {
    // 99 × 18% = 17.82 → 18 per line = 126 naive. Bucket 693 × 18% = 124.74 → 125 →
    // 17.857 each → floors 119, remainder 6 → first six lines 18, last 17.
    const lines = Array.from({ length: 7 }, (_, i) => item(`l${i}`, 1, 0.99, 18));
    const r = check(computeInvoice(lines, ctx({ partyStateCode: '29' })));
    assert.equal(r.totals.igst, 125);
    assert.deepEqual(r.lines.map((l) => l.igst), [18, 18, 18, 18, 18, 18, 17]);
  });

  test('negative (discount) line inside a bucket is allocated a negative share', () => {
    // 100000 − 10000 = 90000 @18% → IGST 16200; shares 16200 × 100000/90000 = 18000 and −1800.
    const r = check(
      computeInvoice([item('a', 1, 1000, 18), ledger('d', -10000, 18, { supplyKind: 'goods', description: 'Trade discount' })], ctx({ partyStateCode: '29' })),
    );
    assert.equal(r.totals.igst, 16200);
    assert.deepEqual(r.lines.map((l) => l.igst), [18000, -1800]);
  });

  test('lines that cancel out to a zero bucket still show their own tax', () => {
    // +10000 and −10000 @18%: bucket taxable 0 → IGST 0; lines keep ±1800 (sum 0).
    const r = check(computeInvoice([ledger('p', 10000, 18), ledger('n', -10000, 18)], ctx({ partyStateCode: '29' })));
    assert.equal(r.totals.igst, 0);
    assert.deepEqual(r.lines.map((l) => l.igst), [1800, -1800]);
    assert.ok(r.warnings.length === 0);
  });

  test('special rates are exact: 0.25%, 0.1% and 3%', () => {
    // 100000 @0.25% → IGST 250; intra CGST 0.125% = 125
    assert.equal(check(computeInvoice([ledger('a', 100000, 0.25, { supplyKind: 'goods' })], ctx({ partyStateCode: '29' }))).totals.igst, 250);
    assert.equal(check(computeInvoice([ledger('a', 100000, 0.25, { supplyKind: 'goods' })], ctx())).totals.cgst, 125);
    // 1005 @0.1% = 1.005 → 1; CGST 0.05% = 0.5025 → 1 each
    assert.equal(check(computeInvoice([ledger('a', 1005, 0.1, { supplyKind: 'goods' })], ctx({ partyStateCode: '29' }))).totals.igst, 1);
    assert.equal(check(computeInvoice([ledger('a', 1005, 0.1, { supplyKind: 'goods' })], ctx())).totals.cgst, 1);
    // Gold: 1234567 @3% intra → 1.5% = 18518.505 → 18519 each
    assert.equal(check(computeInvoice([ledger('a', 1234567, 3, { supplyKind: 'goods' })], ctx())).totals.cgst, 18519);
  });

  test('very large amounts round exactly (no binary floating-point error)', () => {
    // ₹55,55,55,55,555.50 = 5555555555550 paise × 9% = 499999999999.5 → 500000000000
    const r = check(computeInvoice([ledger('a', 5555555555550, 18, { supplyKind: 'goods' })], ctx()));
    assert.equal(r.totals.cgst, 500000000000);
    assert.equal(r.totals.grandTotal, 5555555555550 + 2 * 500000000000);
  });

  test('taxAt and taxableFromInclusive helpers', () => {
    assert.equal(taxAt(1010, 5), 51); // 50.5 → 51
    assert.equal(taxAt(-1010, 5), -51); // half away from zero
    assert.equal(taxAt(0, 18), 0);
    assert.equal(taxableFromInclusive(11800, 18), 10000);
    assert.equal(taxableFromInclusive(10000, 18), 8475); // 8474.576
    assert.equal(taxableFromInclusive(500, 0), 500);
  });
});

// ───────────────────────────── inclusive pricing & discounts ─────────────────────────────

describe('tax-inclusive rates and discounts', () => {
  test('₹118 inclusive of 18% → taxable ₹100, CGST/SGST ₹9 each', () => {
    // 11800 × 100/118 = 10000; 10000 × 9% = 900
    const r = check(computeInvoice([item('a', 1, 118, 18, { rateInclusiveOfTax: true })], ctx()));
    const l = line(r, 'a');
    assert.equal(l.inclusive, true);
    assert.deepEqual([l.gross, l.taxableValue, l.cgst, l.sgst, l.total], [11800, 10000, 900, 900, 11800]);
  });

  test('₹100 inclusive of 18% keeps the entered value exactly (residual stays in taxable)', () => {
    // Back-calc 10000 × 100/118 = 8474.58 → 8475. IGST on bucket 8475 × 18% = 1525.5 → 1526.
    // Total must stay 10000 → taxable = 10000 − 1526 = 8474.
    const inter = check(computeInvoice([item('a', 1, 100, 18, { rateInclusiveOfTax: true })], ctx({ partyStateCode: '29' })));
    assert.deepEqual([line(inter, 'a').taxableValue, line(inter, 'a').igst, line(inter, 'a').total], [8474, 1526, 10000]);
    // Intra: 8475 × 9% = 762.75 → 763 each (equal halves), taxable 10000 − 1526 = 8474.
    const intra = check(computeInvoice([item('a', 1, 100, 18, { rateInclusiveOfTax: true })], ctx()));
    assert.deepEqual([line(intra, 'a').taxableValue, line(intra, 'a').cgst, line(intra, 'a').sgst, line(intra, 'a').total], [8474, 763, 763, 10000]);
  });

  test('two inclusive lines in one bucket: tax on the bucket, each line total exact', () => {
    // Each back-calc 8475 → bucket 16950 × 18% = 3051 → allocate 1525.5 each → [1526, 1525].
    // Taxables: 10000 − 1526 = 8474 and 10000 − 1525 = 8475; bucket taxable 16949.
    const lines = [item('a', 1, 100, 18, { rateInclusiveOfTax: true }), item('b', 1, 100, 18, { rateInclusiveOfTax: true })];
    const r = check(computeInvoice(lines, ctx({ partyStateCode: '29' })));
    assert.deepEqual(r.lines.map((l) => [l.igst, l.taxableValue, l.total]), [
      [1526, 8474, 10000],
      [1525, 8475, 10000],
    ]);
    assert.deepEqual([r.buckets[0].taxableValue, r.buckets[0].igst], [16949, 3051]);
  });

  test('inclusive of GST + cess: ₹130 at 18% + 12% cess', () => {
    // 13000 × 100/130 = 10000 → IGST 1800, cess 1200, total 13000
    const r = check(computeInvoice([item('a', 1, 130, 18, { rateInclusiveOfTax: true, cessRate: 12 })], ctx({ partyStateCode: '29' })));
    assert.deepEqual([r.totals.taxable, r.totals.igst, r.totals.cess, r.totals.grandTotal], [10000, 1800, 1200, 13000]);
  });

  test('inclusive rate is not back-calculated when no GST is charged (composition)', () => {
    const r = check(computeInvoice([item('a', 1, 118, 18, { rateInclusiveOfTax: true })], ctx({ companyRegistration: 'composition' })));
    assert.equal(line(r, 'a').taxableValue, 11800);
    assert.equal(line(r, 'a').inclusive, false);
  });

  test('discount percent: 10 × ₹100 less 10%', () => {
    // gross 100000; net = round(10 × 100 × 100 × 0.9) = 90000; CGST = 90000 × 9% = 8100
    const r = check(computeInvoice([item('a', 10, 100, 18, { discountPct: 10 })], ctx()));
    const l = line(r, 'a');
    assert.deepEqual([l.gross, l.discount, l.taxableValue, l.cgst, l.sgst], [100000, 10000, 90000, 8100, 8100]);
    assert.equal(r.totals.lineGross, 100000);
    assert.equal(r.totals.discount, 10000);
    assert.equal(r.totals.grandTotal, 106200);
  });

  test('discount on an amount rounds the net once (half away from zero)', () => {
    // 1005 × 90% = 904.5 → 905; discount = 1005 − 905 = 100
    const r = check(computeInvoice([{ ...nil('a', 1005), discountPct: 10 }], ctx()));
    assert.deepEqual([line(r, 'a').taxableValue, line(r, 'a').discount], [905, 100]);
  });

  test('item amount overrides qty × rate', () => {
    const r = check(computeInvoice([item('a', 3, 33.33, 18, { amount: 10000 })], ctx({ partyStateCode: '29' })));
    assert.deepEqual([line(r, 'a').gross, line(r, 'a').igst, line(r, 'a').qty], [10000, 1800, 3]);
  });
});

// ───────────────────────────── additional charges ─────────────────────────────

describe('apportioned additional charges', () => {
  test('freight apportioned by value into goods lines', () => {
    // A ₹1000, B ₹3000, freight ₹200: A gets 20000 × 1/4 = 5000, B 15000.
    // Taxable A 105000, B 315000; bucket 420000 × 18% = 75600 → A 18900, B 56700.
    const r = check(
      computeInvoice(
        [item('a', 1, 1000, 18), item('b', 1, 3000, 18), ledger('f', 20000, 18, { apportion: 'value', description: 'Freight' })],
        ctx({ partyStateCode: '29' }),
      ),
    );
    assert.deepEqual([line(r, 'a').apportioned, line(r, 'b').apportioned, line(r, 'f').apportioned], [5000, 15000, -20000]);
    assert.deepEqual([line(r, 'a').taxableValue, line(r, 'b').taxableValue, line(r, 'f').taxableValue], [105000, 315000, 0]);
    assert.deepEqual([line(r, 'a').igst, line(r, 'b').igst, line(r, 'f').igst], [18900, 56700, 0]);
    // Posting: each ledger keeps its own value; the freight ledger is posted at ₹200.
    assert.deepEqual([line(r, 'a').postingAmount, line(r, 'b').postingAmount, line(r, 'f').postingAmount], [100000, 300000, 20000]);
    assert.equal(r.totals.grandTotal, 495600);
    assert.equal(r.hsnSummary.length, 1, 'absorbed charge has no HSN row of its own');
    assert.equal(r.placeOfSupply, '29');
  });

  test('freight apportioned by quantity', () => {
    // A qty 1 (₹1000), B qty 3 (₹300 each); freight ₹100 → A 10000 × 1/4 = 2500, B 7500.
    // Bucket 200000 × 18% = 36000 → A 36000 × 102500/200000 = 18450, B 17550.
    const r = check(
      computeInvoice([item('a', 1, 1000, 18), item('b', 3, 300, 18), ledger('f', 10000, 18, { apportion: 'quantity' })], ctx({ partyStateCode: '29' })),
    );
    assert.deepEqual([line(r, 'a').apportioned, line(r, 'b').apportioned], [2500, 7500]);
    assert.deepEqual([line(r, 'a').igst, line(r, 'b').igst], [18450, 17550]);
  });

  test('apportioned charge takes the rate of each goods line it is absorbed into', () => {
    // ₹1000 @5% and ₹1000 @18% share ₹100 freight by value → 5000 each.
    // A 105000 × 5% = 5250; B 105000 × 18% = 18900.
    const r = check(
      computeInvoice([item('a', 1, 1000, 5), item('b', 1, 1000, 18), ledger('f', 10000, 18, { apportion: 'value' })], ctx({ partyStateCode: '29' })),
    );
    assert.deepEqual([line(r, 'a').igst, line(r, 'b').igst], [5250, 18900]);
  });

  test('charge with no goods lines to absorb it is taxed on its own and warned about', () => {
    // Consulting 100000 + freight 20000, both 18% → bucket 120000 × 18% = 21600
    const r = check(computeInvoice([ledger('s', 100000, 18), ledger('f', 20000, 18, { apportion: 'value', description: 'Freight' })], ctx({ partyStateCode: '29' })));
    assert.equal(line(r, 'f').taxableValue, 20000);
    assert.equal(r.totals.igst, 21600);
    assert.ok(r.warnings.some((w) => /Freight.*no goods lines/.test(w)));
  });

  test('quantity apportionment falls back to value when goods have no quantity', () => {
    const r = check(
      computeInvoice([ledger('g1', 30000, 18, { supplyKind: 'goods' }), ledger('g2', 10000, 18, { supplyKind: 'goods' }), ledger('f', 4000, 18, { apportion: 'quantity' })], ctx()),
    );
    assert.deepEqual([line(r, 'g1').apportioned, line(r, 'g2').apportioned], [3000, 1000]);
    assert.ok(r.warnings.some((w) => /apportioned by value/.test(w)));
  });
});

// ───────────────────────────── cess ─────────────────────────────

describe('compensation cess', () => {
  test('ad valorem + per-unit cess', () => {
    // 10 × ₹1000 = 1000000 @28% → IGST 280000; cess 12% = 120000 + 10 × ₹4.00 = 4000 → 124000.
    const r = check(
      computeInvoice([item('a', 10, 1000, 28, { cessRate: 12, cessPerUnit: 400 })], ctx({ partyStateCode: '29', invoiceDate: '2025-06-01' })),
    );
    assert.deepEqual([r.totals.igst, r.totals.cess, r.totals.grandTotal], [280000, 124000, 1404000]);
    assert.deepEqual(r.buckets.map((b) => [b.rate, b.cessRate]), [[28, 12]]);
    assert.deepEqual(r.warnings, []);
  });

  test('per-unit cess on fractional quantities rounds at the bucket', () => {
    // 2.5 × 333 = 832.5 → 833
    const one = check(computeInvoice([item('a', 2.5, 100, 18, { cessPerUnit: 333 })], ctx()));
    assert.equal(one.totals.cess, 833);
    // Two lines of 1.5 × 333 = 499.5 each → bucket 999 (per-line rounding would give 1000) → [500, 499]
    const two = check(computeInvoice([item('a', 1.5, 100, 18, { cessPerUnit: 333 }), item('b', 1.5, 100, 18, { cessPerUnit: 333 })], ctx()));
    assert.deepEqual(two.lines.map((l) => l.cess), [500, 499]);
  });

  test('cess is ignored on non-taxable lines', () => {
    const r = check(computeInvoice([item('a', 1, 100, 18, { taxability: 'exempt', cessRate: 12, cessPerUnit: 100 })], ctx()));
    assert.equal(r.totals.cess, 0);
    assert.equal(line(r, 'a').rate, 0);
  });
});

// ───────────────────────────── registration regimes ─────────────────────────────

describe('company and party registration', () => {
  test('composition company: bill of supply, no tax', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ companyRegistration: 'composition' })));
    assert.equal(r.taxMode, 'none');
    assert.equal(r.nature, 'composition_outward');
    assert.equal(r.documentKind, 'bill_of_supply');
    assert.equal(r.totals.tax, 0);
    assert.equal(r.totals.grandTotal, 100000);
  });

  test('composition company cannot supply goods inter-state (warning)', () => {
    const r = computeInvoice([item('a', 1, 100, 18)], ctx({ companyRegistration: 'composition', partyStateCode: '29' }));
    assert.ok(r.warnings.some((w) => /Composition dealers cannot make inter-state/.test(w)));
  });

  test('composition company still records GST charged by a regular supplier', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', companyRegistration: 'composition' })));
    assert.equal(r.totals.cgst, 9000);
    assert.equal(r.nature, 'inward_b2b');
  });

  test('unregistered company: no GST in either direction', () => {
    const out = check(computeInvoice([item('a', 10, 100, 18)], ctx({ companyRegistration: 'unregistered' })));
    assert.deepEqual([out.taxMode, out.nature, out.documentKind, out.totals.tax], ['none', 'no_gst', 'invoice', 0]);
    const inw = check(computeInvoice([item('a', 10, 100, 18)], ctx({ companyRegistration: 'unregistered', direction: 'inward' })));
    assert.deepEqual([inw.taxMode, inw.nature, inw.totals.tax], ['none', 'no_gst', 0]);
  });

  test('UIN holder is B2B; deemed export carries normal GST', () => {
    assert.equal(computeInvoice([item('a', 1, 100, 18)], ctx({ partyRegistration: 'uin' })).nature, 'b2b');
    const de = check(computeInvoice([item('a', 10, 100, 18)], ctx({ partyRegistration: 'deemed_export' })));
    assert.equal(de.nature, 'deemed_export');
    assert.equal(de.totals.cgst, 9000);
  });

  test('only exempt / nil lines → nil_exempt, bill of supply', () => {
    const r = check(computeInvoice([item('a', 1, 100, 0, { taxability: 'exempt' }), nil('b', 5000)], ctx()));
    assert.equal(r.nature, 'nil_exempt');
    assert.equal(r.documentKind, 'bill_of_supply');
    assert.equal(r.totals.tax, 0);
  });

  test('mixed exempt + taxable lines stay B2B with separate buckets', () => {
    const r = check(computeInvoice([item('a', 1, 100, 18), item('b', 1, 50, 18, { taxability: 'exempt' })], ctx()));
    assert.equal(r.nature, 'b2b');
    assert.deepEqual(r.buckets.map((b) => [b.taxability, b.rate, b.taxableValue, b.tax]), [
      ['taxable', 18, 10000, 1800],
      ['exempt', 0, 5000, 0],
    ]);
  });
});

// ───────────────────────────── inward & reverse charge ─────────────────────────────

describe('inward supplies and reverse charge', () => {
  test('inward reverse charge: tax computed for liability/ITC but not payable to the supplier', () => {
    // Legal services ₹10,000 = 1000000 paise @18% intra: CGST = SGST = 1000000 × 9% = 90000; RCM tax 180000.
    const r = check(computeInvoice([ledger('s', 1000000, 18)], ctx({ direction: 'inward', reverseCharge: true })));
    assert.equal(r.nature, 'inward_rcm');
    assert.equal(r.reverseCharge, true);
    assert.deepEqual([r.totals.cgst, r.totals.sgst, r.totals.reverseChargeTax], [90000, 90000, 180000]);
    assert.equal(r.totals.payableToParty, 1000000);
    assert.equal(line(r, 's').taxPayableToParty, false);
    assert.equal(line(r, 's').reverseCharge, true);
  });

  test('line-level reverse charge mixed with forward charge', () => {
    // Goods 100000 @18% forward (9000 + 9000 payable); GTA freight 50000 @5% RCM (1250 + 1250 not payable).
    // Payable = 150000 + 18000 = 168000.
    const r = check(
      computeInvoice([item('g', 1, 1000, 18), ledger('t', 50000, 5, { reverseCharge: true, hsnSac: '996511' })], ctx({ direction: 'inward' })),
    );
    assert.equal(r.nature, 'inward_rcm');
    assert.equal(r.totals.reverseChargeTax, 2500);
    assert.equal(r.totals.payableToParty, 168000);
    assert.deepEqual([line(r, 'g').taxPayableToParty, line(r, 't').taxPayableToParty], [true, false]);
  });

  test('outward supply under reverse charge: recipient pays the tax', () => {
    const r = check(computeInvoice([ledger('s', 100000, 5)], ctx({ reverseCharge: true })));
    assert.equal(r.nature, 'b2b');
    assert.equal(r.reverseCharge, true);
    assert.equal(r.totals.tax, 5000);
    assert.equal(r.totals.payableToParty, 100000);
  });

  test('purchase from an unregistered supplier carries no GST unless under reverse charge', () => {
    const plain = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', partyRegistration: 'unregistered' })));
    assert.deepEqual([plain.nature, plain.totals.tax, plain.documentKind], ['inward_unregistered', 0, 'invoice']);
    const rcm = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', partyRegistration: 'unregistered', reverseCharge: true })));
    assert.deepEqual([rcm.nature, rcm.totals.tax, rcm.totals.payableToParty], ['inward_rcm', 18000, 100000]);
  });

  test('purchase from a composition dealer: bill of supply, no tax', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', partyRegistration: 'composition' })));
    assert.deepEqual([r.nature, r.totals.tax, r.documentKind], ['inward_composition', 0, 'bill_of_supply']);
  });

  test('inter-state purchase: POS is our state, supplier state from party', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', partyStateCode: '29' })));
    assert.deepEqual([r.placeOfSupply, r.supplierStateCode, r.taxMode, r.totals.igst], ['27', '29', 'igst', 18000]);
    assert.equal(r.nature, 'inward_b2b');
    assert.equal(r.totals.payableToParty, 118000);
  });

  test('purchase from SEZ: IGST charged by the SEZ supplier', () => {
    const r = check(computeInvoice([ledger('s', 100000, 18)], ctx({ direction: 'inward', partyRegistration: 'sez' })));
    assert.deepEqual([r.nature, r.taxMode, r.totals.igst, r.totals.payableToParty], ['inward_sez', 'igst', 18000, 118000]);
  });

  test('import of goods: IGST computed (customs) but not payable to the supplier', () => {
    const r = check(computeInvoice([item('a', 10, 100, 18)], ctx({ direction: 'inward', partyRegistration: 'overseas', partyStateCode: null })));
    assert.deepEqual([r.nature, r.placeOfSupply, r.supplierStateCode, r.interState], ['import_goods', '27', '96', true]);
    assert.equal(r.reverseCharge, false);
    assert.equal(r.totals.igst, 18000);
    assert.equal(r.totals.reverseChargeTax, 18000);
    assert.equal(r.totals.payableToParty, 100000);
  });

  test('import of services: IGST under reverse charge', () => {
    const r = check(computeInvoice([ledger('s', 100000, 18)], ctx({ direction: 'inward', partyRegistration: 'overseas', partyStateCode: null })));
    assert.equal(r.nature, 'import_services');
    assert.equal(r.reverseCharge, true);
    assert.equal(line(r, 's').reverseCharge, true);
    assert.equal(r.totals.payableToParty, 100000);
  });
});

// ───────────────────────────── round off ─────────────────────────────

describe('round off', () => {
  const ro = (amount: number, method: 'nearest' | 'up' | 'down', unit = 100) =>
    check(computeInvoice([nil('a', amount)], ctx({ roundOff: { enabled: true, method, unit } }))).totals;

  test('nearest / up / down to the rupee', () => {
    // 475.55 → nearest 476.00 (+0.45), up 476.00 (+0.45), down 475.00 (−0.55)
    assert.deepEqual([ro(47555, 'nearest').grandTotal, ro(47555, 'nearest').roundOff], [47600, 45]);
    assert.deepEqual([ro(47555, 'up').grandTotal, ro(47555, 'up').roundOff], [47600, 45]);
    assert.deepEqual([ro(47555, 'down').grandTotal, ro(47555, 'down').roundOff], [47500, -55]);
  });

  test('exact half rounds away from zero; whole rupees do not move', () => {
    assert.deepEqual([ro(12350, 'nearest').grandTotal, ro(12350, 'nearest').roundOff], [12400, 50]);
    assert.equal(ro(12300, 'up').roundOff, 0);
    assert.equal(ro(12300, 'down').roundOff, 0);
  });

  test('zero and negative totals', () => {
    assert.deepEqual([ro(0, 'nearest').grandTotal, ro(0, 'nearest').roundOff], [0, 0]);
    // −123.45: nearest −123.00 (+0.45); up (toward +∞) −123.00; down (toward −∞) −124.00 (−0.55)
    assert.deepEqual([ro(-12345, 'nearest').grandTotal, ro(-12345, 'nearest').roundOff], [-12300, 45]);
    assert.equal(ro(-12345, 'up').grandTotal, -12300);
    assert.deepEqual([ro(-12345, 'down').grandTotal, ro(-12345, 'down').roundOff], [-12400, -55]);
    assert.equal(ro(-12350, 'nearest').grandTotal, -12400);
  });

  test('other units, disabled and invalid settings', () => {
    assert.equal(ro(47555, 'nearest', 1000).grandTotal, 48000); // nearest ₹10
    assert.equal(ro(47555, 'nearest', 1).roundOff, 0); // unit 1 paise = no rounding
    const off = check(computeInvoice([nil('a', 47555)], ctx({ roundOff: { enabled: false, method: 'nearest', unit: 100 } })));
    assert.equal(off.totals.roundOff, 0);
    const bad = computeInvoice([nil('a', 47555)], ctx({ roundOff: { enabled: true, method: 'nearest', unit: 0 } }));
    assert.equal(bad.totals.roundOff, 0);
    assert.ok(bad.warnings.some((w) => /Round-off unit/.test(w)));
  });

  test('round off applies to the amount payable, not to reverse-charge tax', () => {
    // RCM: taxable 100050 payable; tax 5003 (100050 × 5% = 5002.5 → 5003) excluded; payable rounds to 100100.
    const r = check(computeInvoice([ledger('s', 100050, 5)], ctx({ direction: 'inward', reverseCharge: true, partyStateCode: '29', roundOff: { enabled: true, method: 'nearest', unit: 100 } })));
    assert.deepEqual([r.totals.igst, r.totals.invoiceValueBeforeRound, r.totals.grandTotal, r.totals.roundOff], [5003, 100050, 100100, 50]);
  });
});

// ───────────────────────────── B2CL / B2CS ─────────────────────────────

describe('B2C large threshold', () => {
  // ₹78,125 @28% → IGST 2187500 → invoice value exactly ₹1,00,000.00 (10000000 paise).
  const b2c = (amount: number, over: Partial<InvoiceContext> = {}) =>
    check(
      computeInvoice(
        [ledger('a', amount, 28, { supplyKind: 'goods', hsnSac: '' })],
        ctx({ partyRegistration: 'unregistered', partyStateCode: '29', invoiceDate: '2025-06-01', ...over }),
      ),
    );

  test('invoice value equal to the threshold is B2CS', () => {
    const r = b2c(7812500);
    assert.equal(r.totals.grandTotal, 10000000);
    assert.equal(r.nature, 'b2cs');
  });

  test('one paise above the threshold is B2CL', () => {
    // 7812501 × 28% = 2187500.28 → 2187500 → 10000001
    const r = b2c(7812501);
    assert.equal(r.totals.grandTotal, 10000001);
    assert.equal(r.nature, 'b2cl');
  });

  test('threshold applies to the rounded invoice value', () => {
    assert.equal(b2c(7812501, { roundOff: { enabled: true, method: 'nearest', unit: 100 } }).nature, 'b2cs');
  });

  test('default threshold follows the invoice date: ₹2,50,000 before 1-Aug-2024', () => {
    // 15625000 @28% → IGST 4375000 → ₹2,00,000.00 (20000000 paise).
    assert.equal(b2c(15625000, { invoiceDate: '2024-07-31' }).nature, 'b2cs');
    assert.equal(b2c(15625000, { invoiceDate: '2024-08-01' }).nature, 'b2cl');
    // 19531251 × 28% = 5468750.28 → 5468750 → 25000001: one paise above ₹2,50,000.
    assert.equal(b2c(19531251, { invoiceDate: '2024-07-31' }).nature, 'b2cl');
    // A configured threshold always wins.
    assert.equal(b2c(15625000, { invoiceDate: '2024-07-31', b2clThresholdPaise: 1_00_000_00 }).nature, 'b2cl');
  });

  test('intra-state B2C is always B2CS; custom thresholds are honoured', () => {
    assert.equal(b2c(9000000, { partyStateCode: '27' }).nature, 'b2cs');
    assert.equal(b2c(7812500, { b2clThresholdPaise: 9999999 }).nature, 'b2cl');
    assert.equal(b2c(7812500, { partyRegistration: 'consumer' }).nature, 'b2cs');
  });
});

// ───────────────────────────── HSN summary ─────────────────────────────

describe('HSN summary', () => {
  test('groups by HSN + UQC + rate; services report UQC NA and no quantity', () => {
    const r = check(
      computeInvoice(
        [
          item('a', 2, 100, 18, { description: 'Laptop bag' }),
          item('b', 3, 100, 18),
          item('c', 1, 100, 5),
          ledger('s', 5000, 18, { hsnSac: '998313', description: 'Installation' }),
        ],
        ctx(),
      ),
    );
    assert.deepEqual(
      r.hsnSummary.map((h) => [h.hsnSac, h.uqc, h.rate, h.qty, h.taxableValue, h.cgst]),
      [
        ['84713010', 'NOS', 5, 1, 10000, 250],
        ['84713010', 'NOS', 18, 5, 50000, 4500],
        ['998313', 'NA', 18, 0, 5000, 450],
      ],
    );
    assert.equal(r.hsnSummary[1].description, 'Laptop bag');
  });

  test('goods without a UQC default to OTH', () => {
    const r = check(computeInvoice([item('a', 1, 100, 18, { uqc: undefined })], ctx()));
    assert.equal(r.hsnSummary[0].uqc, 'OTH');
  });
});

// ───────────────────────────── warnings & robustness ─────────────────────────────

describe('warnings and input validation', () => {
  test('negative quantity and zero rate on a taxable line', () => {
    const r = check(computeInvoice([item('a', -2, 100, 18), item('b', 1, 100, 0)], ctx()));
    assert.ok(r.warnings.some((w) => /Line 1: quantity is negative/.test(w)));
    assert.ok(r.warnings.some((w) => /Line 2: GST rate is 0%/.test(w)));
  });

  test('party GSTIN state differs from the party state', () => {
    const r = computeInvoice([item('a', 1, 100, 18)], ctx({ partyGstin: '29AAGCB7383J1Z4' }));
    assert.ok(r.warnings.some((w) => w.includes('29-Karnataka') && w.includes('27-Maharashtra')));
  });

  test('party GSTIN with a wrong check character; registered party without GSTIN', () => {
    assert.ok(computeInvoice([item('a', 1, 100, 18)], ctx({ partyGstin: '27AAPFU0939F1ZW' })).warnings.some((w) => /check character/.test(w)));
    assert.ok(computeInvoice([item('a', 1, 100, 18)], ctx({ partyGstin: '' })).warnings.some((w) => /no GSTIN/.test(w)));
  });

  test('missing HSN is flagged on B2B but not on B2CS', () => {
    const b2b = computeInvoice([item('a', 1, 100, 18, { hsnSac: '' })], ctx());
    assert.ok(b2b.warnings.some((w) => /HSN\/SAC code is required/.test(w)));
    const b2cs = computeInvoice([item('a', 1, 100, 18, { hsnSac: '' })], ctx({ partyRegistration: 'consumer' }));
    assert.ok(!b2cs.warnings.some((w) => /HSN/.test(w)));
  });

  test('NaN / infinite numbers never leak into results', () => {
    const r = check(
      computeInvoice(
        [item('a', Number.NaN, 100, 18), item('b', 1, Number.POSITIVE_INFINITY, 18), item('c', 1, 100, Number.NaN), item('d', 1, 100, 18, { discountPct: Number.NaN })],
        ctx(),
      ),
    );
    assert.ok(r.warnings.filter((w) => /not a valid number/.test(w)).length >= 4);
    assert.equal(line(r, 'd').taxableValue, 10000);
  });

  test('invalid, non-standard and retired rates', () => {
    const r = computeInvoice([item('a', 1, 100, -5), item('b', 1, 100, 150), item('c', 1, 100, 13), item('d', 1, 100, 12)], ctx());
    assert.ok(r.warnings.some((w) => /Line 1: GST rate -5% is not valid/.test(w)));
    assert.ok(r.warnings.some((w) => /Line 2: GST rate 150% is not valid/.test(w)));
    assert.ok(r.warnings.some((w) => /Line 3: 13% is not a standard GST rate/.test(w)));
    assert.ok(r.warnings.some((w) => /Line 4: the 12% slab/.test(w)));
    // Before 22-Sep-2025 the 12% slab is normal.
    assert.ok(!computeInvoice([item('d', 1, 100, 12)], ctx({ invoiceDate: '2025-09-21' })).warnings.some((w) => /slab/.test(w)));
  });

  test('discount outside 0–100% is clamped', () => {
    const r = check(computeInvoice([item('a', 1, 100, 0, { taxability: 'nil_rated', discountPct: 150 })], ctx()));
    assert.equal(line(r, 'a').taxableValue, 0);
    assert.ok(r.warnings.some((w) => /discount must be between/.test(w)));
  });

  test('empty invoice and unknown company state', () => {
    const r = check(computeInvoice([], ctx({ companyStateCode: '' })));
    assert.equal(r.totals.grandTotal, 0);
    assert.ok(r.warnings.some((w) => /no lines/.test(w)));
    assert.ok(r.warnings.some((w) => /Company state is not set/.test(w)));
  });

  test('float noise in rates does not split buckets; duplicate keys are tolerated', () => {
    const r = check(computeInvoice([item('a', 1, 100, 18), item('a', 1, 100, 18.000000000001)], ctx()));
    assert.equal(r.buckets.length, 1);
    assert.equal(r.lines[1].rate, 18);
    assert.deepEqual([r.hsnSummary.length, r.hsnSummary[0].qty], [1, 2]);
  });

  test('deterministic: same input gives identical output', () => {
    const lines = [item('a', 3, 33.33, 18, { discountPct: 7.5 }), item('b', 1.25, 99.99, 5, { rateInclusiveOfTax: true })];
    assert.deepEqual(computeInvoice(lines, ctx()), computeInvoice(lines, ctx()));
  });
});

// ───────────────────────────── review regressions ─────────────────────────────

describe('review regressions', () => {
  const inter = (over: Partial<InvoiceContext> = {}): InvoiceContext => ctx({ partyStateCode: '29', ...over });
  const goods = (key: string, amount: number, over: Partial<InvoiceLineInput> = {}): InvoiceLineInput =>
    ledger(key, amount, 18, { supplyKind: 'goods', hsnSac: '8471', ...over });

  test('mixed-sign bucket: line tax starts from each line’s own share (no amplification)', () => {
    // +100001 and −99000 @18%: exact 18000.18 and −17820; bucket 1001 × 18% = 180.18 → 180.
    // Own-share floors [18000, −17820] already sum to 180 → [18000, −17820].
    // (Scaling 180 × w / 1001 used to give 17982 / −17802.)
    const a = check(computeInvoice([goods('p', 100001), goods('n', -99000)], inter()));
    assert.equal(a.totals.igst, 180);
    assert.deepEqual(a.lines.map((l) => l.igst), [18000, -17820]);
    // +100000 and −99999: bucket 1 × 18% = 0.18 → 0. Shares 18000 and −17999.82 → floors 18000, −18000
    // (sum 0 = total). Scaling used to give both lines 0.
    const b = check(computeInvoice([goods('p', 100000), goods('n', -99999)], inter()));
    assert.equal(b.totals.igst, 0);
    assert.deepEqual(b.lines.map((l) => l.igst), [18000, -18000]);
  });

  test('per-unit cess on lines that cancel out keeps each line’s own cess', () => {
    // +10 and −10 units × ₹1.00 cess → +1000 / −1000 (sum 0); used to be 0 / 0.
    const r = check(computeInvoice([item('a', 10, 100, 18, { cessPerUnit: 100 }), item('b', -10, 100, 18, { cessPerUnit: 100 })], ctx()));
    assert.deepEqual(r.lines.map((l) => l.cess), [1000, -1000]);
    assert.equal(r.totals.cess, 0);
  });

  test('charges are apportioned only over lines with a positive quantity/value', () => {
    // Quantities 2 and −1 share ₹30 freight by quantity → weights [2, 0] → +3000 / 0.
    // (Signed weights used to give +6000 / −3000.) CGST on A: 203000 × 9% = 18270.
    const q = check(
      computeInvoice([item('a', 2, 1000, 18), item('b', -1, 500, 18), ledger('f', 3000, 18, { apportion: 'quantity' })], ctx()),
    );
    assert.deepEqual([line(q, 'a').apportioned, line(q, 'b').apportioned, line(q, 'f').apportioned], [3000, 0, -3000]);
    assert.deepEqual([line(q, 'a').taxableValue, line(q, 'a').cgst], [203000, 18270]);
    assert.ok(q.warnings.some((w) => /negative quantity or value do not share/.test(w)));
    // By value with a negative goods line (accounting-mode discount): +100000 takes all of ₹60.
    const v = check(computeInvoice([goods('g', 100000), goods('d', -20000), ledger('f', 6000, 18, { apportion: 'value' })], inter()));
    assert.deepEqual([line(v, 'g').apportioned, line(v, 'd').apportioned], [6000, 0]);
    // All targets negative (a return): shares by absolute value, signs follow the charge.
    const neg = check(computeInvoice([goods('g1', -30000), goods('g2', -10000), ledger('f', -4000, 18, { apportion: 'value' })], inter()));
    assert.deepEqual([line(neg, 'g1').apportioned, line(neg, 'g2').apportioned], [-3000, -1000]);
  });

  test('a blank row does not turn an exempt invoice into a tax invoice', () => {
    const r = check(computeInvoice([item('a', 1, 100, 0, { taxability: 'exempt' }), item('blank', 0, 0, 18)], ctx()));
    assert.deepEqual([r.nature, r.documentKind], ['nil_exempt', 'bill_of_supply']);
    // A blank taxable row next to taxable goods changes nothing either.
    const t = check(computeInvoice([item('a', 1, 100, 18), item('blank', 0, 0, 18)], ctx()));
    assert.deepEqual([t.nature, t.documentKind], ['b2b', 'tax_invoice']);
  });

  test('reverse-charge lines are bucketed apart from forward-charge lines at the same rate', () => {
    // Goods 1010 @5% forward + GTA 1010 @5% RCM, inter-state purchase. Separately: 50.5 → 51 each.
    // (One shared bucket used to give 2020 × 5% = 101 → 51 / 50, so RCM tax was 50.)
    const r = check(
      computeInvoice([item('g', 1, 10.1, 5), ledger('t', 1010, 5, { reverseCharge: true })], ctx({ direction: 'inward', partyStateCode: '29' })),
    );
    assert.deepEqual(r.lines.map((l) => l.igst), [51, 51]);
    assert.deepEqual(r.buckets.map((b) => [b.rate, b.reverseCharge, b.igst]), [[5, false, 51], [5, true, 51]]);
    assert.equal(r.totals.reverseChargeTax, 51);
    assert.equal(r.totals.payableToParty, 1010 + 1010 + 51);
  });

  test('invoice-level size cap keeps every total a safe integer', () => {
    // Two lines of ₹6,000 crore: the second would push Σ beyond MAX_INVOICE_PAISE (9e14) → treated as 0.
    const r = check(computeInvoice([goods('a', 6e14), goods('b', 6e14)], ctx()));
    assert.equal(line(r, 'b').taxableValue, 0);
    assert.equal(r.totals.taxable, 6e14);
    assert.ok(r.warnings.some((w) => /Line 2: the invoice total is too large/.test(w)));
    // Per-unit cess × quantity is bounded too.
    const c = check(computeInvoice([item('a', 1e12, 0.01, 18, { cessPerUnit: 1e6 })], ctx()));
    assert.equal(c.totals.cess, 0);
    assert.ok(c.warnings.some((w) => /cess per unit × quantity is too large/.test(w)));
  });

  test('tax-inclusive rate is ignored on imports and on apportioned charges', () => {
    // Import of goods: IGST is paid at customs, so ₹118 is the assessable value; IGST 11800 × 18% = 2124.
    const imp = check(computeInvoice([item('a', 1, 118, 18, { rateInclusiveOfTax: true })], ctx({ direction: 'inward', partyRegistration: 'overseas', partyStateCode: null })));
    assert.deepEqual([line(imp, 'a').inclusive, line(imp, 'a').taxableValue, imp.totals.igst, imp.totals.payableToParty], [false, 11800, 2124, 11800]);
    assert.ok(imp.warnings.some((w) => /not paid to the supplier/.test(w)));
    // An inclusive freight line that is apportioned is absorbed at its entered value, with a warning.
    const chg = check(computeInvoice([item('a', 1, 1000, 18), ledger('f', 11800, 18, { apportion: 'value', rateInclusiveOfTax: true })], ctx()));
    assert.equal(line(chg, 'a').taxableValue, 111800);
    assert.ok(chg.warnings.some((w) => /charge is apportioned/.test(w)));
    // With nothing to absorb it, the charge stays a line of its own and its inclusive rate applies:
    // 11800 × 100/118 = 10000 → CGST = SGST = 900.
    const own = check(computeInvoice([ledger('s', 100000, 18), ledger('f', 11800, 18, { apportion: 'value', rateInclusiveOfTax: true })], ctx()));
    assert.deepEqual([line(own, 'f').inclusive, line(own, 'f').taxableValue, line(own, 'f').cgst], [true, 10000, 900]);
    assert.ok(!own.warnings.some((w) => /charge is apportioned/.test(w)));
  });

  test('invalid state codes and a GSTIN on an unregistered party are flagged', () => {
    const s = computeInvoice([item('a', 1, 100, 18)], ctx({ partyStateCode: '45', consigneeStateCode: 'MH' }));
    assert.ok(s.warnings.includes("Party state '45' is not a valid GST state code"));
    assert.ok(s.warnings.includes("Consignee state 'MH' is not a valid GST state code"));
    const u = computeInvoice([item('a', 1, 100, 18)], ctx({ partyRegistration: 'unregistered', partyGstin: '27AAPFU0939F1ZV' }));
    assert.ok(u.warnings.some((w) => /has a GSTIN but is marked as unregistered/.test(w)));
    assert.equal(u.nature, 'b2cs');
  });

  test('UQC: unit symbols are mapped, unknown units fall back to OTH, services report NA in the HSN summary', () => {
    const r = check(
      computeInvoice(
        [
          item('kg', 2, 100, 18, { uqc: 'Kg' }),
          item('odd', 1, 100, 18, { uqc: 'widget', hsnSac: '8472' }),
          ledger('svc', 5000, 18, { uqc: 'OTH', qty: 5, hsnSac: '998313' }),
        ],
        ctx(),
      ),
    );
    assert.deepEqual(r.lines.map((l) => l.uqc), ['KGS', 'OTH', 'OTH']);
    assert.ok(r.warnings.some((w) => /unit 'widget' is not a GST UQC/.test(w)));
    assert.ok(!r.warnings.some((w) => /unit 'Kg'/.test(w)));
    const svc = r.hsnSummary.find((h) => h.hsnSac === '998313');
    assert.deepEqual([svc?.uqc, svc?.qty], ['NA', 0]);
  });

  test('absorbed flag marks charges that need no gst_line', () => {
    const r = check(computeInvoice([item('a', 1, 1000, 18), ledger('f', 2000, 18, { apportion: 'value' })], ctx()));
    assert.deepEqual(r.lines.map((l) => l.absorbed), [false, true]);
    // Nothing to absorb into → taxed on its own, not absorbed.
    const s = check(computeInvoice([ledger('s', 1000, 18), ledger('f', 2000, 18, { apportion: 'value' })], ctx()));
    assert.deepEqual(s.lines.map((l) => l.absorbed), [false, false]);
  });

  test('overseas party with an Indian place of supply is not an export (regression: zero-rated)', () => {
    // E.g. repair of goods physically in Maharashtra for a foreign client: POS entered as 27.
    // ₹1,000 @18% intra-state → CGST = SGST = 100000 × 9% = 9000; B2C (no GSTIN), not export_lut.
    const intra = check(computeInvoice([ledger('s', 100000, 18)], ctx({ partyRegistration: 'overseas', partyStateCode: null, placeOfSupply: '27' })));
    assert.deepEqual([intra.taxMode, intra.interState, intra.nature, intra.totals.cgst, intra.totals.sgst], ['cgst_sgst', false, 'b2cs', 9000, 9000]);
    assert.ok(intra.warnings.some((w) => /not an export/.test(w)));
    // POS in another state → IGST 18000.
    const inter = check(computeInvoice([ledger('s', 100000, 18)], ctx({ partyRegistration: 'overseas', partyStateCode: null, placeOfSupply: '29' })));
    assert.deepEqual([inter.taxMode, inter.nature, inter.totals.igst], ['igst', 'b2cs', 18000]);
    // POS 96 (or none) is still an export.
    const exp = check(computeInvoice([ledger('s', 100000, 18)], ctx({ partyRegistration: 'overseas', partyStateCode: null, placeOfSupply: '96' })));
    assert.deepEqual([exp.nature, exp.totals.tax], ['export_lut', 0]);
  });

  test('holes in the line array become blank lines instead of throwing', () => {
    const lines = [item('a', 1, 100, 18), null as unknown as InvoiceLineInput];
    const r = check(computeInvoice(lines, ctx()));
    assert.equal(r.lines.length, 2);
    assert.equal(r.totals.taxable, 10000);
    assert.ok(r.warnings.some((w) => /Line 2: line data is missing/.test(w)));
  });
});

// ───────────────────────────── property test ─────────────────────────────

/** Small seeded PRNG (mulberry32) so failures are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: invariants hold for random invoices', () => {
  test('600 random invoices', () => {
    const rnd = prng(20261005);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const scenarios: Array<Partial<InvoiceContext>> = [
      {},
      { partyStateCode: '29' },
      { companyStateCode: '04', partyStateCode: '04' },
      { partyRegistration: 'sez' },
      { partyRegistration: 'overseas', partyStateCode: null, exportWithPayment: true },
      { partyRegistration: 'consumer', partyStateCode: '29' },
      { direction: 'inward', reverseCharge: true },
      { direction: 'inward', partyRegistration: 'overseas', partyStateCode: null },
      { companyRegistration: 'composition' },
    ];
    for (let n = 0; n < 600; n++) {
      const count = 1 + Math.floor(rnd() * 8);
      const lines: InvoiceLineInput[] = [];
      for (let i = 0; i < count; i++) {
        const goods = rnd() < 0.75;
        lines.push({
          key: `k${i}`,
          kind: goods ? 'item' : 'ledger',
          // Mostly positive quantities; ~5% negative (returns) to exercise mixed-sign buckets.
          qty: goods ? (rnd() < 0.05 ? -1 : 1) * (Math.round(rnd() * 100000) / 1000) : undefined,
          rate: goods ? Math.round(rnd() * 500000) / 100 : undefined,
          amount: goods ? undefined : Math.round((rnd() - 0.1) * 1_000_000),
          discountPct: rnd() < 0.3 ? Math.round(rnd() * 2500) / 100 : 0,
          rateInclusiveOfTax: rnd() < 0.3,
          taxability: rnd() < 0.85 ? 'taxable' : pick(['exempt', 'nil_rated', 'non_gst'] as const),
          gstRate: pick(GST_RATES),
          cessRate: rnd() < 0.15 ? pick([1, 12, 15, 22]) : 0,
          cessPerUnit: rnd() < 0.1 ? Math.round(rnd() * 500) : 0,
          supplyKind: goods ? 'goods' : 'services',
          hsnSac: goods ? '8471' : '9983',
          apportion: !goods && rnd() < 0.3 ? pick(['value', 'quantity'] as const) : 'none',
          reverseCharge: rnd() < 0.05,
        });
      }
      const c = ctx({ ...pick(scenarios), roundOff: { enabled: rnd() < 0.7, method: pick(['nearest', 'up', 'down'] as const), unit: pick([100, 1000]) } });
      const r = check(computeInvoice(lines, c));

      for (const l of r.lines) {
        // Tax-inclusive lines (not absorbing a charge) keep their entered value to the paise.
        if (l.inclusive && l.apportioned === 0) assert.equal(l.total, l.gross - l.discount, `inclusive line exact (#${n})`);
        if (!l.taxCharged) assert.equal(l.tax, 0);
        if (l.absorbed) assert.deepEqual([l.taxableValue, l.tax, l.postingAmount], [0, 0, -l.apportioned], `absorbed charge (#${n})`);
        // Each exclusive line's tax is within 1.5 paise of its own exact share, however the bucket's
        // lines are signed (largest remainder never moves a line by more than one paise).
        if (l.taxCharged && !l.inclusive && !l.absorbed) {
          const [head, exact] = r.taxMode === 'igst' ? [l.igst, (l.taxableValue * l.rate) / 100] : [l.cgst, (l.taxableValue * l.rate) / 200];
          assert.ok(Math.abs(head - exact) < 1.5, `line ${l.key} tax ${head} vs exact ${exact} (#${n})`);
        }
      }
      // Buckets made only of exclusive lines satisfy tax = round(taxable × rate) exactly.
      for (const b of r.buckets) {
        const members = r.lines.filter(
          (l) =>
            l.taxability === b.taxability &&
            l.rate === b.rate &&
            l.cessRate === b.cessRate &&
            l.taxCharged === b.taxCharged &&
            l.reverseCharge === b.reverseCharge &&
            !l.absorbed,
        );
        if (!b.taxCharged || members.some((l) => l.inclusive || l.cessPerUnit > 0)) continue;
        if (r.taxMode === 'igst') assert.equal(b.igst, taxAt(b.taxableValue, b.rate), `bucket IGST (#${n})`);
        else assert.equal(b.cgst, taxAt(b.taxableValue, b.rate / 2), `bucket CGST (#${n})`);
        assert.equal(b.cess, taxAt(b.taxableValue, b.cessRate), `bucket cess (#${n})`);
      }
    }
  });
});
