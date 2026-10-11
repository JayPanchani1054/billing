import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaPath, bandLayout, linePath, linearScale, niceStep, niceTicks, sparkline } from './chart.ts';
import { paginationRange, pageBounds, pageCountOf } from './pagination.ts';

test('niceStep picks 1/2/2.5/5 × 10^k', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(130), 200);
  assert.equal(niceStep(0), 1);
});

test('niceTicks include zero and cover the domain', () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(13, 87, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(-40, 60, 5), [-50, -25, 0, 25, 50, 75]);
  assert.deepEqual(niceTicks(0, 0, 5), [0, 0.25, 0.5, 0.75, 1]);
  const big = niceTicks(0, 12_345_600, 5); // paise
  assert.equal(big[0], 0);
  assert.ok(big[big.length - 1] >= 12_345_600);
  assert.ok(big.length >= 4 && big.length <= 7);
  assert.deepEqual(niceTicks(0, 0.3, 4), [0, 0.1, 0.2, 0.3]);
});

test('linear scale and bands', () => {
  const s = linearScale([0, 100], [200, 0]);
  assert.equal(s(0), 200);
  assert.equal(s(50), 100);
  assert.equal(linearScale([5, 5], [0, 10])(5), 5);
  const b = bandLayout(4, 0, 400, 0.2, 0.1);
  assert.ok(Math.abs(b.start(0) - b.step * 0.1) < 1e-9);
  assert.ok(Math.abs(b.start(3) + b.bandwidth + b.step * 0.1 - 400) < 1e-6);
  assert.ok(Math.abs(b.center(1) - (b.start(1) + b.bandwidth / 2)) < 1e-9);
});

test('path builders', () => {
  assert.equal(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 20, y: 1 }, { x: 30, y: 2.555 }]), 'M0 0 L10 5 M20 1 L30 2.56');
  assert.equal(areaPath([{ x: 0, y: 5 }, { x: 10, y: 2 }], 10), 'M0 10 L0 5 L10 2 L10 10 Z');
  assert.equal(areaPath([], 10), '');
});

test('sparkline geometry', () => {
  const g = sparkline([1, 3, 2], 100, 20, 2);
  assert.equal(g.points.length, 3);
  assert.equal(g.points[0].x, 2);
  assert.equal(g.points[2].x, 98);
  assert.equal(g.points[1].y, 2); // max at top inset
  assert.equal(g.points[0].y, 18); // min at bottom inset
  assert.deepEqual(g.last, g.points[2]);
  assert.equal(sparkline([], 100, 20).line, '');
  assert.equal(sparkline([5, 5], 100, 20).points[0].y, 10);
});

test('pagination range', () => {
  assert.deepEqual(paginationRange(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationRange(1, 20), [1, 2, 3, 4, 5, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(10, 20), [1, 'ellipsis-start', 9, 10, 11, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(20, 20), [1, 'ellipsis-start', 16, 17, 18, 19, 20]);
  assert.deepEqual(paginationRange(4, 20), [1, 2, 3, 4, 5, 'ellipsis-end', 20]);
  assert.deepEqual(paginationRange(99, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pageCountOf(0, 50), 1);
  assert.equal(pageCountOf(101, 50), 3);
  assert.deepEqual(pageBounds(2, 50, 120), { from: 51, to: 100 });
  assert.deepEqual(pageBounds(3, 50, 120), { from: 101, to: 120 });
  assert.deepEqual(pageBounds(1, 50, 0), { from: 0, to: 0 });
});

test('barPath rounds only the data end and anchors square at the baseline', async () => {
  const { barPath, nearestIndex } = await import('./chart.ts');
  assert.equal(barPath(10, 20, 100, 40), 'M10 100 V44 Q10 40 14 40 H26 Q30 40 30 44 V100 Z');
  // negative value grows downward, rounding at the bottom
  assert.equal(barPath(10, 20, 100, 160), 'M10 100 V156 Q10 160 14 160 H26 Q30 160 30 156 V100 Z');
  // radius clamps to tiny bars
  assert.equal(barPath(0, 4, 10, 9), 'M0 10 V10 Q0 9 1 9 H3 Q4 9 4 10 V10 Z');
  assert.equal(barPath(0, 10, 10, 10), '');
  assert.equal(nearestIndex(33, [10, 30, 50]), 1);
  assert.equal(nearestIndex(0, []), -1);
});

// 2.1 kit geometry (SPEC-21 §4.2, §4.8)

test('hbarLayout: 20 px pitch, 12 px bars, one zero line, value labels outside the tip', async () => {
  const { hbarLayout, HBAR_PITCH, HBAR_THICKNESS } = await import('./chart.ts');
  const g = hbarLayout([100, 50, 0, 25], { width: 600, nameWidth: 200, labelWidth: 60, top: 4 });
  assert.equal(HBAR_PITCH, 20);
  assert.equal(HBAR_THICKNESS, 12);
  assert.deepEqual(g.rows.map((r) => r.cy), [14, 34, 54, 74]);
  for (let i = 1; i < g.rows.length; i++) assert.equal(g.rows[i].y - g.rows[i - 1].y, 20);
  assert.ok(g.rows.every((r) => r.height === 12));
  assert.equal(g.height, 4 + 4 * 20 + 4);
  // all positive: zero at the left of the plot, after the name column; the longest bar leaves room for its label
  assert.equal(g.zeroX, 208);
  assert.equal(g.rows[0].x1, 600 - 64);
  assert.ok(g.rows[0].labelX > g.rows[0].x1 && g.rows[0].labelAnchor === 'start');
  assert.ok(g.rows[0].labelX + 60 <= 600, 'the tip label fits inside the width');
  assert.equal(g.rows[2].x0, g.rows[2].x1, 'a zero value draws no bar');
  assert.ok(Math.abs(g.rows[1].x1 - g.zeroX - (g.rows[0].x1 - g.zeroX) / 2) < 1e-9, 'length ∝ value');
});

test('hbarLayout: polarity — negatives grow left of zero with their label outside on the left', async () => {
  const { hbarLayout } = await import('./chart.ts');
  const g = hbarLayout([-40, 60, null], { width: 500, nameWidth: 100, labelWidth: 50 });
  const [neg, pos, none] = g.rows;
  assert.ok(neg.negative && !pos.negative && !none.negative);
  assert.equal(neg.x1, g.zeroX);
  assert.equal(pos.x0, g.zeroX);
  assert.ok(neg.x0 < g.zeroX && pos.x1 > g.zeroX);
  assert.equal(neg.labelAnchor, 'end');
  assert.ok(neg.labelX < neg.x0 && neg.labelX - 50 >= 100, 'the left label stays clear of the names');
  assert.ok(Math.abs((g.zeroX - neg.x0) / (pos.x1 - g.zeroX) - 40 / 60) < 1e-9, 'one scale both sides');
});

test('hbarPath rounds only the tip and stays square at the zero line', async () => {
  const { hbarPath } = await import('./chart.ts');
  assert.equal(hbarPath(10, 12, 100, 160), 'M100 10 H156 Q160 10 160 14 V18 Q160 22 156 22 H100 Z');
  assert.equal(hbarPath(10, 12, 100, 40), 'M100 10 H44 Q40 10 40 14 V18 Q40 22 44 22 H100 Z');
  assert.equal(hbarPath(10, 12, 100, 100), '');
});

test('shareSegments: 2 px gaps, every drawn segment ≥ 4 px, Σ widths = width − gaps', async () => {
  const { shareSegments } = await import('./chart.ts');
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const s = shareSegments([700, 200, 100], 1000);
  assert.deepEqual(s.map((x) => x.index), [0, 1, 2]);
  assert.ok(near(s.reduce((a, x) => a + x.width, 0), 1000 - 2 * 2));
  assert.ok(near(s[0].width / s[1].width, 3.5));
  for (let i = 1; i < s.length; i++) assert.ok(near(s[i].x - (s[i - 1].x + s[i - 1].width), 2), 'one 2 px gap');
  // a sliver is lifted to 4 px, taken from the others
  const t = shareSegments([99_990, 5, 5], 300);
  assert.ok(t.every((x) => x.width >= 4 - 1e-9));
  assert.ok(near(t.reduce((a, x) => a + x.width, 0), 300 - 4));
  // zero, negative and null values are not drawn (and take no gap)
  const u = shareSegments([0, 50, null, -3, 50], 102);
  assert.deepEqual(u.map((x) => x.index), [1, 4]);
  assert.ok(near(u[0].width, 50) && near(u[1].width, 50) && near(u[1].x, 52));
  assert.deepEqual(shareSegments([0, 0], 100), []);
  // random inputs: the invariants hold
  for (let k = 0; k < 200; k++) {
    const vals = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => Math.floor(Math.random() * 1000));
    const w = 40 + Math.random() * 900;
    const seg = shareSegments(vals, w);
    if (seg.length === 0) continue;
    assert.ok(near(seg.reduce((a, x) => a + x.width, 0), w - 2 * (seg.length - 1)), `Σ for ${vals} in ${w}`);
    assert.ok(seg.every((x) => x.width >= 4 - 1e-9), `min for ${vals} in ${w}`);
  }
});

test('polarityTicks label absolute values — never a minus sign', async () => {
  const { polarityTicks } = await import('./chart.ts');
  const { formatCompactINR } = await import('../../../shared/format.ts');
  const ticks = polarityTicks(-1_240_000, 870_000, (v) => (v === 0 ? '0' : formatCompactINR(v)));
  assert.ok(ticks.some((t) => t.value < 0) && ticks.some((t) => t.value > 0) && ticks.some((t) => t.value === 0));
  for (const t of ticks) assert.doesNotMatch(t.label, /[-−]/, `${t.value} → ${t.label}`);
  const lo = ticks.find((t) => t.value < 0)!;
  const hi = ticks.find((t) => t.value === -lo.value);
  if (hi) assert.equal(hi.label, lo.label, 'symmetric ticks read the same');
  // even a formatter that signs its output is stripped
  assert.ok(polarityTicks(-10, 10, (v) => `−${v}`).every((t) => !/^[-−]/.test(t.label)));
});

test('text fitting and default plot heights', async () => {
  const { fitText, textWidth, plotHeight } = await import('./chart.ts');
  assert.equal(textWidth('abcd', 10), 24);
  assert.equal(fitText('Wood Primer 1L', 200), 'Wood Primer 1L');
  const cut = fitText('A very long stock item name that cannot fit', 100, 11);
  assert.ok(cut.endsWith('…') && textWidth(cut, 11) <= 100 + 11);
  assert.equal(fitText('abc', 1), '');
  assert.equal(plotHeight('column'), 148);
  assert.equal(plotHeight('line'), 148);
  assert.equal(plotHeight('bar', 7), 7 * 20 + 8);
  assert.equal(plotHeight('share'), 52);
  assert.equal(plotHeight('meter'), 44);
});

test('compactTick: Indian compact axis text (0 · 50 K · 1 L · 1 Cr)', async () => {
  const { compactTick } = await import('./chart.ts');
  assert.deepEqual([0, 500, 50_000, 100_000, 150_000, 2_25_00_000, -50_000, 12.5].map(compactTick), ['0', '500', '50 K', '1 L', '1.5 L', '2.25 Cr', '-50 K', '12.5']);
});

test('seriesColor + colorClass: meaning decides the class; a 2.0 slot-2 second series is kept apart', async () => {
  const { seriesColor, colorClass } = await import('./chart.ts');
  const base = { kind: 'column' as const, title: 't', takeaway: 'x', categories: ['a', 'b', 'c'], total: 6 };
  const one = { ...base, series: [{ name: 'Sales', values: [1, 2, 3] }] };
  assert.equal(colorClass(seriesColor(one, 0)), 'bx-chart--s-1');
  assert.equal(colorClass(seriesColor({ ...one, partialLast: true }, 2)), 'bx-chart--s-partial');
  assert.equal(colorClass(seriesColor({ ...one, color: 'polarity', series: [{ name: 'P', values: [1, -2, 3] }] }, 1)), 'bx-chart--s-2');
  assert.equal(colorClass(seriesColor({ ...one, color: 'emphasis', emphasis: [2] }, 0)), 'bx-chart--s-other');
  assert.equal(colorClass(seriesColor({ ...one, color: 'emphasis', emphasis: [2] }, 2)), 'bx-chart--s-1');
  assert.equal(colorClass(seriesColor({ ...one, color: 'problem', emphasis: [1] }, 1)), 'bx-chart--s-2');
  assert.deepEqual([0, 1, 2].map((i) => colorClass(seriesColor({ ...one, color: 'ordinal' }, i))), ['bx-chart--o-1', 'bx-chart--o-3', 'bx-chart--o-5']);
  assert.equal(colorClass(seriesColor({ ...one, color: 'ordinal', greyBefore: 1 }, 0)), 'bx-chart--s-other');
  const two = { ...base, series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'Purchases', values: [1, 1, 1], slot: 'other' as const }] };
  assert.equal(colorClass(seriesColor(two, 0, 1)), 'bx-chart--s-other', 'a second series is context');
  const legacy = { ...base, series: [{ name: 'Sales', values: [1, 2, 3] }, { name: 'Purchases', values: [1, 1, 1], slot: 2 as const }] };
  assert.equal(colorClass(seriesColor(legacy, 0, 1)), 'bx-chart--s-2', '2.0 Dashboard: Purchases keep slot 2 until WP-M');
});

test('legacySpec: the 2.0 BarChart/LineChart props become a spec (or null when there is nothing to draw)', async () => {
  const { legacySpec, drawnTotal } = await import('./chartSpec.ts');
  assert.equal(legacySpec('column', { title: 'T', categories: [], series: [{ name: 'S', values: [] }] }), null);
  assert.equal(legacySpec('column', { title: 'T', categories: ['a'], series: [{ name: 'S', values: [null] }] }), null);
  const s = legacySpec('column', {
    title: 'Sales and purchases',
    description: 'Sales peaked in Mar',
    categories: ['Jan', 'Feb', 'Mar'],
    series: [
      { name: 'Sales', values: [100, 0, 300], slot: 'other' },
      { name: 'Purchases', values: [50, 60, null], slot: 2 },
      { name: 'Other', values: [1, 1, 1] },
    ],
    label: 'none',
  });
  assert.ok(s);
  assert.equal(s.kind, 'column');
  assert.equal(s.takeaway, 'Sales peaked in Mar');
  assert.deepEqual(s.series.map((x) => x.slot), [1, 2, 'other'], 'the first series is measured; slot 2 kept; the rest context');
  assert.equal(s.total, 400);
  assert.equal(s.total, drawnTotal(s));
  assert.equal(s.valueFormat, 'inr');
  const line = legacySpec('line', { title: 'Balance', categories: ['a', 'b', 'c'], series: [{ name: 'B', values: [5, 7, 9] }], valueFormat: 'number' });
  assert.ok(line);
  assert.equal(line.total, 9, 'a line ends on its last point');
  assert.ok(legacySpec('column', { title: 'T', description: 'x'.repeat(200), categories: ['a'], series: [{ name: 'S', values: [1] }] })!.takeaway.length <= 90);
});

test('graphKeyStep: one keyboard model — arrows step and clamp, Home/End jump, a first arrow enters from its end', async () => {
  const { graphKeyStep } = await import('./chart.ts');
  // columns, lines, share: ←/→
  assert.equal(graphKeyStep('ArrowRight', -1, 5), 0, '→ with nothing highlighted starts at the first category');
  assert.equal(graphKeyStep('ArrowLeft', -1, 5), 4, '← with nothing highlighted starts at the last');
  assert.equal(graphKeyStep('ArrowRight', 2, 5), 3);
  assert.equal(graphKeyStep('ArrowLeft', 2, 5), 1);
  assert.equal(graphKeyStep('ArrowRight', 4, 5), 4, 'clamped at the end');
  assert.equal(graphKeyStep('ArrowLeft', 0, 5), 0, 'clamped at the start');
  assert.equal(graphKeyStep('Home', 3, 5), 0);
  assert.equal(graphKeyStep('End', -1, 5), 4);
  assert.equal(graphKeyStep('ArrowDown', 1, 5), null, '↑/↓ are not graph keys on a column graph');
  // horizontal bars: ↑/↓
  assert.equal(graphKeyStep('ArrowDown', -1, 3, true), 0);
  assert.equal(graphKeyStep('ArrowDown', 1, 3, true), 2);
  assert.equal(graphKeyStep('ArrowUp', -1, 3, true), 2);
  assert.equal(graphKeyStep('ArrowRight', 1, 3, true), null);
  // other keys keep their global meaning
  for (const k of ['Enter', 'Escape', 'Tab', 'j', 'PageDown']) assert.equal(graphKeyStep(k, 1, 5), null, k);
  assert.equal(graphKeyStep('ArrowRight', -1, 0), null, 'an empty graph takes no key');
});

test('Chart and MiniColumns share the keyboard model and leave modified keys (Ctrl+J, Alt+←) to the app', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['../Chart.tsx', '../MiniColumns.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /graphKeyStep\(e\.key,/, `${f} routes keys through graphKeyStep`);
    assert.match(src, /if \([^)]*e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey\) return;/, `${f} ignores modified keys`);
    assert.match(src, /e\.key === 'Enter' && \w+ >= 0/, `${f}: Enter acts only on a highlighted category`);
  }
});

test('labelIndexes: the extreme or the endpoint, never every mark; a running period is always labelled', async () => {
  const { labelIndexes } = await import('./chart.ts');
  const spec = (values: (number | null)[], extra: object = {}) => ({ kind: 'column' as const, title: 't', takeaway: 'x', categories: values.map((_, i) => `c${i}`), series: [{ name: 'S', values }], total: 0, ...extra });
  assert.deepEqual(labelIndexes(spec([5, -90, 40, 0]), 'max'), [1], 'max = largest |value| (a loss can be the extreme)');
  assert.deepEqual(labelIndexes(spec([0, 0, 0]), 'max'), [], 'zeros are never labelled');
  assert.deepEqual(labelIndexes(spec([5, 9, null]), 'last'), [1], 'last = the last drawn point');
  assert.deepEqual(labelIndexes(spec([5, 9, 3], { label: 'none' }), 'max'), []);
  assert.deepEqual(labelIndexes(spec([5, 90, 3], { partialLast: true }), 'max'), [1, 2], 'the running month carries "so far"');
  assert.deepEqual(labelIndexes(spec([5, 9, 30], { partialLast: true }), 'max'), [2], 'once, even when it is the extreme');
  assert.deepEqual(labelIndexes(spec([5, 9, 3], { partialLast: true, kind: 'line' }), 'last'), [2]);
  assert.deepEqual(labelIndexes({ ...spec([1]), series: [] }, 'max'), []);
});

test('a column or line plot carries the strip height itself (the strip plot box has none)', async () => {
  const { STRIP_PLOT_HEIGHT, plotHeight } = await import('./chart.ts');
  assert.equal(STRIP_PLOT_HEIGHT, 'calc(var(--graph-h, 168px) - 20px)');
  assert.equal(168 - 20, plotHeight('column'), 'the fallback equals the comfortable strip');
  const { readFileSync } = await import('node:fs');
  const chart = readFileSync(new URL('../Chart.tsx', import.meta.url), 'utf8');
  const lazy = readFileSync(new URL('../lazyChart.tsx', import.meta.url), 'utf8');
  assert.match(chart, /height: fixedHeight \?\? STRIP_PLOT_HEIGHT/);
  assert.match(lazy, /return STRIP_PLOT_HEIGHT;/, 'the lazy placeholder holds the same height');
  assert.doesNotMatch(chart + lazy, /'100%'/, 'never a percentage of an unsized host');
});
