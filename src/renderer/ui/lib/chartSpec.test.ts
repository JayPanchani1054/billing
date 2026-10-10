/**
 * The pure graph contract (SPEC-21 §4.1, §4.8): Σ-preserving folds, the minimum-data gate, the
 * colour rules assertSpec enforces, inline bars, the stat rule and the takeaway templates.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSpec,
  byMonth,
  clipTakeaway,
  decimate,
  drawnTotal,
  enoughData,
  foldMonths,
  foldTop,
  fyLabel,
  inlineBars,
  markColor,
  monthRange,
  ordinalSteps,
  quarterLabel,
  specProblems,
  statRepeatsTotal,
  take,
} from './chartSpec.ts';
import type { ChartSpec } from './chartSpec.ts';

/** Deterministic PRNG (mulberry32) so the random checks are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function col(values: (number | null)[], extra: Partial<ChartSpec> = {}): ChartSpec {
  const categories = values.map((_, i) => `C${i + 1}`);
  const series = [{ name: 'Sales', values }];
  const base: ChartSpec = { kind: 'column', title: 'Sales by month', takeaway: 'Best month C2', categories, series, total: 0 };
  const spec = { ...base, ...extra };
  return { ...spec, total: extra.total ?? drawnTotal(spec) };
}

describe('foldTop', () => {
  test('preserves Σ (with negatives) on 500 random arrays; Other is last', () => {
    const r = rng(42);
    for (let k = 0; k < 500; k++) {
      const len = Math.floor(r() * 20);
      const items = Array.from({ length: len }, (_, i) => ({ name: `I${i}`, v: Math.round((r() - 0.4) * 1_000_000) }));
      const n = 1 + Math.floor(r() * 8);
      const out = foldTop(items, n, (t) => t.v, (t) => t.name);
      assert.equal(sum(out.values), sum(items.map((t) => t.v)), `Σ case ${k}`);
      assert.equal(out.categories.length, out.values.length);
      const otherAt = out.categories.indexOf('Other');
      if (otherAt >= 0) {
        assert.equal(otherAt, out.categories.length - 1, 'Other last');
        assert.equal(out.categories.length, n + 1, 'top n + Other');
      }
      assert.ok(out.categories.length <= Math.max(n + 1, 0));
    }
  });

  test('ranks by |value|, ties keep input order', () => {
    const items = [
      { n: 'a', v: 5 },
      { n: 'b', v: -50 },
      { n: 'c', v: 20 },
      { n: 'd', v: 20 },
      { n: 'e', v: 1 },
      { n: 'f', v: 2 },
    ];
    const out = foldTop(items, 3, (t) => t.v, (t) => t.n);
    assert.deepEqual(out.categories, ['b', 'c', 'd', 'Other']);
    assert.deepEqual(out.values, [-50, 20, 20, 8]);
  });

  test('no Other when n ≥ length, and never an Other of a single item', () => {
    const items = [1, 2, 3].map((v) => ({ v }));
    assert.ok(!foldTop(items, 3, (t) => t.v, (t) => String(t.v)).categories.includes('Other'));
    assert.ok(!foldTop(items, 5, (t) => t.v, (t) => String(t.v)).categories.includes('Other'));
    const seven = Array.from({ length: 7 }, (_, i) => ({ v: i + 1 }));
    const out = foldTop(seven, 6, (t) => t.v, (t) => String(t.v));
    assert.equal(out.categories.length, 7);
    assert.ok(!out.categories.includes('Other'), '7 items at n = 6 are 7 named bars');
    const custom = foldTop(Array.from({ length: 9 }, (_, i) => ({ v: i })), 6, (t) => t.v, (t) => String(t.v), 'Other suppliers');
    assert.equal(custom.categories[custom.categories.length - 1], 'Other suppliers');
  });

  test('a kept item named like the fold does not merge with it: "Other (k)"', () => {
    const tenders = [
      { n: 'Cash', v: 900 },
      { n: 'Other', v: 800 },
      { n: 'UPI', v: 700 },
      { n: 'Card', v: 3 },
      { n: 'Cheque', v: 2 },
    ];
    const out = foldTop(tenders, 3, (t) => t.v, (t) => t.n);
    assert.deepEqual(out.categories, ['Cash', 'Other', 'UPI', 'Other (2)']);
    assert.deepEqual(out.values, [900, 800, 700, 5]);
    assert.equal(new Set(out.categories).size, out.categories.length, 'categories stay distinct');
  });
});

describe('months', () => {
  test('monthRange is inclusive and crosses years', () => {
    assert.deepEqual(monthRange('2025-11-15', '2026-02-01'), ['2025-11', '2025-12', '2026-01', '2026-02']);
    assert.deepEqual(monthRange('2026-04', '2026-04'), ['2026-04']);
    assert.deepEqual(monthRange('2026-05-01', '2026-04-30'), []);
  });

  test('byMonth zero-fills and ignores rows outside the period', () => {
    const rows = [
      { d: '2026-04-03', v: 100 },
      { d: '2026-04-30', v: 50 },
      { d: '2026-06-10', v: 7 },
      { d: '2026-03-31', v: 999 },
      { d: '2026-08-01', v: 999 },
    ];
    const out = byMonth(rows, (r) => r.d, (r) => r.v, '2026-04-01', '2026-07-31');
    assert.deepEqual(out.months, ['2026-04', '2026-05', '2026-06', '2026-07']);
    assert.deepEqual(out.values, [150, 0, 7, 0]);
  });

  test('foldMonths: ≤ 13 monthly, 14–39 quarters, ≥ 40 years; Σ preserved', () => {
    const r = rng(7);
    for (const n of [1, 3, 12, 13, 14, 24, 39, 40, 61]) {
      const months = monthRange('2023-04-01', '2040-03-31').slice(0, n);
      const values = months.map(() => Math.round((r() - 0.3) * 100000));
      const out = foldMonths(months, values);
      assert.equal(out.grain, n <= 13 ? 'month' : n <= 39 ? 'quarter' : 'year', `grain at ${n}`);
      assert.equal(sum(out.values), sum(values), `Σ at ${n}`);
      assert.equal(out.categories.length, out.values.length);
      assert.ok(out.categories.length <= 13, `${out.categories.length} categories at ${n}`);
    }
  });

  test('foldMonths labels: month names, year suffix only on a repeat, FY quarters and years', () => {
    assert.deepEqual(foldMonths(['2026-04', '2026-05', '2026-06'], [1, 2, 3]).categories, ['Apr', 'May', 'Jun']);
    const thirteen = monthRange('2025-04', '2026-04');
    const labels = foldMonths(thirteen, thirteen.map(() => 1)).categories;
    assert.equal(labels[0], 'Apr 25');
    assert.equal(labels[12], 'Apr 26');
    assert.equal(quarterLabel('2026-04'), 'Q1 26-27');
    assert.equal(quarterLabel('2026-12'), 'Q3 26-27');
    assert.equal(quarterLabel('2027-03'), 'Q4 26-27');
    assert.equal(fyLabel('2027-03'), 'FY 26-27');
    assert.equal(fyLabel('2099-04'), 'FY 99-00');
    const q = foldMonths(monthRange('2026-02', '2027-05'), Array(16).fill(1));
    assert.deepEqual(q.categories, ['Q4 25-26', 'Q1 26-27', 'Q2 26-27', 'Q3 26-27', 'Q4 26-27', 'Q1 27-28']);
    assert.deepEqual(q.values, [2, 3, 3, 3, 3, 2]);
  });
});

describe('decimate', () => {
  test('keeps first, last, the global min and max, and ≤ max points', () => {
    const r = rng(9);
    for (let k = 0; k < 50; k++) {
      const n = 500 + Math.floor(r() * 5000);
      const pts = Array.from({ length: n }, (_, i) => ({ x: i, y: Math.round((r() - 0.5) * 1e6) }));
      const out = decimate(pts, 480);
      assert.ok(out.length <= 480, `${out.length} points`);
      assert.deepEqual(out[0], pts[0]);
      assert.deepEqual(out[out.length - 1], pts[n - 1]);
      const ys = out.map((p) => p.y);
      assert.equal(Math.min(...ys), Math.min(...pts.map((p) => p.y)));
      assert.equal(Math.max(...ys), Math.max(...pts.map((p) => p.y)));
      for (let i = 1; i < out.length; i++) assert.ok(out[i].x > out[i - 1].x, 'x order kept');
    }
  });

  test('short input is copied unchanged', () => {
    const pts = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
    ];
    const out = decimate(pts, 480);
    assert.deepEqual(out, pts);
    assert.notEqual(out, pts);
  });
});

describe('drawnTotal and enoughData', () => {
  test('drawnTotal equals spec.total for each kind', () => {
    const specs: ChartSpec[] = [
      col([100, null, 300, -50]),
      { kind: 'bar', title: 'Stock by group', takeaway: 'Paints hold most', categories: ['A', 'B', 'C'], series: [{ name: 'Value', values: [5, 7, 9] }], total: 21 },
      { kind: 'line', title: 'Balance', takeaway: '₹9 on 10-Oct', categories: ['1', '2', '3', '4'], series: [{ name: 'Balance', values: [1, 4, null, 9] }], total: 9 },
      { kind: 'share', title: 'Reconciliation', takeaway: 'Most matched', categories: ['Matched', 'Mismatch', 'Not in books'], series: [{ name: 'Documents', values: [80, 15, 5] }], color: 'problem', emphasis: [1, 2], valueFormat: 'number', total: 100 },
      { kind: 'meter', title: 'Credit limit', takeaway: 'Half the limit used', categories: ['Balance'], series: [{ name: 'Balance', values: [500] }], max: 1000, total: 1000 },
      { kind: 'column', title: 'Sales and purchases', takeaway: 'Sales ahead', categories: ['a', 'b', 'c'], series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'Purchases', values: [9, 9, 9], slot: 'other' }], total: 6 },
    ];
    assert.equal(drawnTotal(specs[0]), 350, 'column: Σ of the drawn values, nulls skipped, negatives netted');
    assert.equal(drawnTotal(specs[2]), 9, 'line: the last drawn point (the closing the table ends on)');
    assert.equal(drawnTotal(specs[4]), 1000, 'meter: the whole');
    assert.equal(drawnTotal(specs[5]), 6, 'the context series is never counted');
    for (const s of specs) {
      assert.equal(drawnTotal(s), s.total, s.title);
      assert.doesNotThrow(() => assertSpec(s), s.title);
    }
  });

  test('≥ 3 non-zero categories / ≥ 3 points / both meter parts > 0', () => {
    assert.equal(enoughData(col([1, 2])), false);
    assert.equal(enoughData(col([1, 2, 0])), false, 'a zero is not a category with data');
    assert.equal(enoughData(col([1, 2, 3])), true);
    const line = (values: (number | null)[]): ChartSpec => ({ kind: 'line', title: 'L', takeaway: 't', categories: values.map(String), series: [{ name: 'B', values }], total: 0 });
    assert.equal(enoughData(line([0, 0, 0])), true, 'a flat line of 3 points is data');
    assert.equal(enoughData(line([1, null, 2])), false);
    const meter = (v: number, max: number): ChartSpec => ({ kind: 'meter', title: 'M', takeaway: 't', categories: ['x'], series: [{ name: 'x', values: [v] }], max, total: max });
    assert.equal(enoughData(meter(5, 10)), true);
    assert.equal(enoughData(meter(0, 10)), false);
    assert.equal(enoughData(meter(5, 0)), false);
  });
});

describe('assertSpec', () => {
  const rejects = (spec: ChartSpec, pattern: RegExp) => {
    assert.throws(() => assertSpec(spec), pattern);
    assert.ok(specProblems(spec).some((p) => pattern.test(p)), `${pattern} in ${specProblems(spec).join(' | ')}`);
  };

  test('accepts a plain valid column', () => assert.doesNotThrow(() => assertSpec(col([1, 2, 3]))));

  test('rejects slot 3', () => rejects(col([1, 2, 3], { series: [{ name: 'S', values: [1, 2, 3], slot: 3 }], total: 6 }), /slot 3/));

  test('rejects a second series that is not context', () => {
    rejects(col([1, 2, 3], { series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'Purchases', values: [1, 1, 1] }], total: 6 }), /must be slot 'other'/);
    rejects(col([1, 2, 3], { series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'P', values: [1, 1, 1], slot: 1 }], total: 6 }), /must be slot 'other'/);
  });

  test("rejects slot 2 outside 'problem' / 'polarity'", () => {
    rejects(col([1, 2, 3], { series: [{ name: 'S', values: [1, 2, 3], slot: 2 }], total: 6 }), /slot 2/);
    assert.doesNotThrow(() => assertSpec(col([1, -2, 3], { color: 'polarity', axisCaptions: { up: 'Profit ↑', down: 'Loss ↓' } })));
    assert.doesNotThrow(() => assertSpec(col([1, 2, 3], { color: 'problem', emphasis: [1] })));
  });

  test('rejects partialLast on a bar or a two-series column', () => {
    rejects({ kind: 'bar', title: 'B', takeaway: 't', categories: ['a', 'b', 'c'], series: [{ name: 'v', values: [1, 2, 3] }], partialLast: true, total: 6 }, /partialLast/);
    rejects(col([1, 2, 3], { series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'P', values: [1, 1, 1], slot: 'other' }], partialLast: true, total: 6 }), /partialLast/);
    rejects(col([1, 2, 3], { color: 'polarity', axisCaptions: { up: 'Profit ↑', down: 'Loss ↓' }, partialLast: true }), /partialLast/);
    assert.doesNotThrow(() => assertSpec(col([1, 2, 3], { partialLast: true })));
  });

  test('rejects 5 share segments and 6 ordinal buckets', () => {
    rejects({ kind: 'share', title: 'S', takeaway: 't', categories: ['a', 'b', 'c', 'd', 'Other'], series: [{ name: 'v', values: [1, 2, 3, 4, 5] }], total: 15 }, /segments/);
    const six = col([1, 2, 3, 4, 5, 6], { color: 'ordinal' });
    rejects(six, /coloured buckets/);
    assert.doesNotThrow(() => assertSpec(col([1, 2, 3, 4, 5, 6], { color: 'ordinal', greyBefore: 1 })), 'Not due grey + 5 buckets');
  });

  test('rejects a takeaway over 90 characters', () => {
    rejects(col([1, 2, 3], { takeaway: 'x'.repeat(91) }), /takeaway is 91 chars/);
    assert.doesNotThrow(() => assertSpec(col([1, 2, 3], { takeaway: 'x'.repeat(90) })));
  });

  test('rejects too little data, a wrong total, fractional paise and mismatched lengths', () => {
    rejects(col([1, 2]), /not enough data/);
    rejects(col([1, 2, 3], { total: 7 }), /total 7/);
    rejects(col([1.5, 2, 3]), /integer paise/);
    assert.doesNotThrow(() => assertSpec(col([1.5, 2, 3], { valueFormat: 'number' })));
    rejects(col([1, 2, 3], { categories: ['a', 'b'] }), /3 values for 2 categories/);
  });

  test('rejects misplaced options', () => {
    rejects(col([1, 2, 3], { emphasis: [0] }), /emphasis needs/);
    rejects(col([1, 2, 3], { greyBefore: 1 }), /greyBefore/);
    rejects(col([1, 2, 3], { axisCaptions: { up: 'Profit ↑', down: 'Loss ↓' } }), /axis captions/);
    rejects(col([1, 2, 3], { label: 'tips' }), /tips/);
    rejects(col([1, 2, 3], { max: 3 }), /max is only/);
    rejects(col([1, 2, 3], { color: 'emphasis', emphasis: [3] }), /out of range/);
    rejects(col(Array.from({ length: 14 }, (_, i) => i + 1)), /14 categories/);
    rejects(col([5, 4, 3, 2], { color: 'ordinal', greyBefore: 4 }), /greyBefore 4 is not an index/);
    rejects(col([5, 4, 3, 2], { color: 'ordinal', greyBefore: -1 }), /greyBefore -1/);
  });

  test('size caps per kind: bar ≤ 10 rows, share ≤ 4 segments, meter one value', () => {
    const bar = (k: number): ChartSpec => ({ kind: 'bar', title: 'B', takeaway: 't', categories: Array.from({ length: k }, (_, i) => `r${i}`), series: [{ name: 'v', values: Array.from({ length: k }, (_, i) => i + 1) }], total: (k * (k + 1)) / 2 });
    assert.doesNotThrow(() => assertSpec(bar(10)), 'top 6 + 3 loss items + Other');
    rejects(bar(11), /bar has 11 rows \(max 10/);
    assert.doesNotThrow(() => assertSpec({ kind: 'share', title: 'S', takeaway: 't', categories: ['Matched', 'Differs', 'Not in books', 'Not on portal'], series: [{ name: 'n', values: [9, 3, 2, 1] }], color: 'problem', emphasis: [1, 2, 3], valueFormat: 'number', total: 15 }), '4 named statuses');
    rejects({ kind: 'meter', title: 'M', takeaway: 't', categories: ['a', 'b'], series: [{ name: 'v', values: [5, 9] }], max: 10, total: 10 }, /meter has 2 values/);
  });

  test('a polarity column needs its axis captions (absolute ticks, never a bare minus)', () => {
    rejects(col([5, -4, 3], { color: 'polarity' }), /needs axisCaptions/);
    rejects(col([5, -4, 3], { color: 'polarity', axisCaptions: { up: 'Profit ↑', down: ' ' } }), /needs axisCaptions/);
    assert.doesNotThrow(() => assertSpec(col([5, -4, 3], { color: 'polarity', axisCaptions: { up: 'In ↑', down: 'Out ↓' } })));
    const bars: ChartSpec = { kind: 'bar', title: 'Cash and bank', takeaway: 't', categories: ['Cash', 'HDFC', 'SBI OD'], series: [{ name: 'Closing', values: [5, 9, -3] }], color: 'polarity', total: 11 };
    assert.doesNotThrow(() => assertSpec(bars), 'polarity bars name their side in the row, no captions');
  });
});

describe('colour resolution', () => {
  test('ordinal steps: oldest always o5, o1/o3/o5 for three', () => {
    assert.deepEqual(ordinalSteps(3), [1, 3, 5]);
    assert.deepEqual(ordinalSteps(5), [1, 2, 3, 4, 5]);
    assert.deepEqual(ordinalSteps(1), [5]);
    for (let n = 1; n <= 7; n++) assert.equal(ordinalSteps(n)[n - 1], 5);
  });

  test('marks follow meaning, never rank', () => {
    const ageing = col([5, 4, 3, 2], { color: 'ordinal', greyBefore: 1 });
    assert.deepEqual([0, 1, 2, 3].map((i) => markColor(ageing, i)), ['other', 'o1', 'o3', 'o5']);
    const pl = col([5, -4, 3], { color: 'polarity' });
    assert.deepEqual([0, 1, 2].map((i) => markColor(pl, i)), [1, 2, 1]);
    const home = col([5, 4, 3], { color: 'emphasis', emphasis: [2] });
    assert.deepEqual([0, 1, 2].map((i) => markColor(home, i)), ['other', 'other', 1]);
    const exc = col([5, 4, 3], { color: 'problem', emphasis: [0] });
    assert.deepEqual([0, 1, 2].map((i) => markColor(exc, i)), [2, 'other', 'other']);
    const running = col([5, 4, 3], { partialLast: true });
    assert.deepEqual([0, 1, 2].map((i) => markColor(running, i)), [1, 1, 'partial']);
    const ctx = col([1, 2, 3], { series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'Purchases', values: [3, 2, 1], slot: 'other' }], total: 6 });
    assert.equal(markColor(ctx, 0, 1), 'other');
  });
});

describe('inlineBars and the stat rule', () => {
  const bar = (categories: string[]): ChartSpec => ({ kind: 'bar', title: 'B', takeaway: 't', categories, series: [{ name: 'v', values: categories.map(() => 1) }], total: categories.length });

  test('true only for an unfolded bar of ≤ 7 rows equal to the table', () => {
    assert.equal(inlineBars(bar(['a', 'b', 'c']), 3), true);
    assert.equal(inlineBars(bar(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 7), true);
    assert.equal(inlineBars(bar(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), 8), false, '> 7 rows');
    assert.equal(inlineBars(bar(['a', 'b', 'c']), 4), false, 'categories ≠ table rows');
    assert.equal(inlineBars(bar(['Cash', 'UPI', 'Other']), 3), true, 'a real row named Other (the POS tender) keeps its inline bar');
    assert.equal(inlineBars(bar(['a', 'b', 'c']), 0), false);
    assert.equal(inlineBars(bar(['a', 'b', 'c']), 2.5), false);
    assert.equal(inlineBars(col([1, 2, 3]), 3), false, 'columns never inline');
    assert.equal(inlineBars(null, 3), false);
  });

  test('a foldTop of the table rows is inline exactly when nothing was folded (500 random tables)', () => {
    const r = rng(11);
    for (let k = 0; k < 500; k++) {
      const rows = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => ({ name: r() < 0.2 ? 'Other' : `R${i}`, v: Math.round((r() - 0.3) * 1e6) || 1 }));
      const n = Math.floor(r() * 9);
      const f = foldTop(rows, n, (t) => t.v, (t) => t.name);
      const spec: ChartSpec = { kind: 'bar', title: 'B', takeaway: 't', categories: f.categories, series: [{ name: 'v', values: f.values }], total: sum(f.values) };
      const folded = f.categories.length < rows.length;
      assert.equal(inlineBars(spec, rows.length), !folded && rows.length <= 7, `case ${k}: ${rows.length} rows, n = ${n}`);
    }
  });

  test('statRepeatsTotal: equal magnitude to a table total, zeros ignored', () => {
    assert.equal(statRepeatsTotal([99_953_00], [99_953_00, 12]), true);
    assert.equal(statRepeatsTotal([-500], [500]), true, 'sign ignored');
    assert.equal(statRepeatsTotal([400], [500, 600]), false);
    assert.equal(statRepeatsTotal([0], [0]), false, 'a hidden ₹0 repeats nothing');
    assert.equal(statRepeatsTotal([], [1]), false);
  });
});

describe('takeaways', () => {
  test('max names the best period and the running one "so far"', () => {
    const s = col([5_000_00, 8_741_400, 4_230_000], { categories: ['Aug', 'Sep', 'Oct'], partialLast: true });
    assert.equal(take.max(s), 'Best month Sep ₹87.4 K · Oct so far ₹42.3 K');
    const q = col([1_00_000_00, 2_00_000_00, 50_000_00], { categories: ['Q1 26-27', 'Q2 26-27', 'Q3 26-27'] });
    assert.equal(take.max(q), 'Best quarter Q2 26-27 ₹2.00 L');
    const rates = col([1_00_000_00, 4_20_000_00, 3_00_000_00], { categories: ['5%', '18%', '12%'] });
    assert.equal(take.max(rates), 'Highest 18% ₹4.20 L');
  });

  test('the other templates read as the spec says', () => {
    assert.equal(take.share('Wood Primer 1L', 70.2, 'stock value'), 'Wood Primer 1L holds 70 % of stock value');
    assert.equal(take.last('₹1.67 L', '10-Oct', 'up ₹1.67 L since 1-Apr'), '₹1.67 L on 10-Oct, up ₹1.67 L since 1-Apr');
    assert.equal(take.last('₹1.67 L', '10-Oct', ''), '₹1.67 L on 10-Oct');
    assert.equal(take.polarity(6, 7, 'smallest in Sep (₹12.4 K)'), 'Loss in 6 of 7 months; smallest in Sep (₹12.4 K)');
    assert.equal(take.polarity(0, 7, 'best Sep (₹1.2 L)'), 'Profit in all 7 months; best Sep (₹1.2 L)');
    assert.equal(take.polarity(7, 7, ''), 'Loss in all 7 months');
    assert.equal(take.polarity(2, 8, '', 'quarter'), 'Loss in 2 of 8 quarters', 'a folded period names its grain');
    assert.equal(take.polarity(0, 4, '', 'year'), 'Profit in all 4 years');
    assert.equal(take.ordinal('₹1.91 L', '₹4.66 L in unpaid bills', '90 days'), 'Of ₹4.66 L in unpaid bills, ₹1.91 L is over 90 days');
  });

  test('every template stays within 90 characters', () => {
    const long = 'A very long stock item name that someone typed in full with its size and colour and grade';
    assert.ok(take.share(long, 55, 'stock value').length <= 90);
    assert.ok(take.share(long, 55, 'stock value').endsWith(' holds 55 % of stock value'));
    assert.ok(take.ordinal(long, long, '90 days').length <= 90);
    assert.ok(take.max(col([1, 9, 3], { categories: [long, `${long}!`, 'x'] })).length <= 90);
    assert.equal(clipTakeaway('x'.repeat(95)).length, 90);
    assert.ok(clipTakeaway('x'.repeat(95)).endsWith('…'));
  });
});

test('builders stay fast: folding 10,000 rows < 50 ms', () => {
  const r = rng(1);
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ d: `2026-${String(1 + (i % 12)).padStart(2, '0')}-15`, v: Math.round(r() * 1e7), name: `Item ${i}` }));
  let best = Infinity; // best of 3: a busy CI runner must not fail a pure O(n log n) fold
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    const m = byMonth(rows, (x) => x.d, (x) => x.v, '2026-01-01', '2026-12-31');
    foldMonths(m.months, m.values);
    foldTop(rows, 6, (x) => x.v, (x) => x.name);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 50, `${best.toFixed(1)} ms`);
});
