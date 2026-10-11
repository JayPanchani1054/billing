/**
 * The stock graphs and stats (SPEC-21 §5, §4.8): every builder's drawn total equals the table's total,
 * the null gates, the inline-bar rule (D26), the takeaways, and that no stat repeats a table total (D24).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  BatchRow,
  BatchSummaryResult,
  GodownSummaryResult,
  GodownSummaryRow,
  MovementPartyRow,
  NegativeStockRow,
  PendingOrdersResult,
  ProfitabilityResult,
  ProfitabilityRow,
  ReorderRow,
  ReorderStatusResult,
  StockAgeingResult,
  StockItemVoucherRow,
  StockItemVouchersResult,
  StockMovementResult,
  StockSummaryResult,
  StockSummaryRow,
} from '../../../../shared/types/stock.ts';
import { drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import {
  ageingThreshold,
  barSlots,
  batchesStat,
  godownBarValue,
  godownsChart,
  godownsInline,
  movementBarValue,
  movementChart,
  movementInline,
  negativeStat,
  pendingOrdersStat,
  profitabilityChart,
  profitabilityInline,
  profitabilitySlots,
  qtyFormat,
  reorderStat,
  stockAgeingChart,
  stockItemChart,
  stockSummaryChart,
  stockSummaryInline,
  summaryBarValue,
  summaryTopRows,
} from './charts.ts';
import { movementTree } from './model.ts';

/** A spec that passes every kit rule (assertSpec) — the builders never hand the strip an invalid graph. */
function valid(spec: ChartSpec | null): ChartSpec {
  assert.ok(spec, 'a graph');
  assert.deepEqual(specProblems(spec), []);
  assert.equal(spec.total, drawnTotal(spec));
  return spec;
}

// ───────────────────────────── Fixtures ─────────────────────────────

const qv = (qty: number | null, value: number) => ({ qty, value });

function sRow(key: string, name: string, closing: number, over: Partial<StockSummaryRow> = {}): StockSummaryRow {
  return {
    key,
    kind: 'item',
    id: Number(key.slice(2)) || null,
    name,
    level: 0,
    parentKey: null,
    hasChildren: false,
    unit: 'Nos',
    costingMethod: 'avg_cost',
    opening: qv(0, 0),
    inward: qv(0, 0),
    outward: qv(0, 0),
    closing: { qty: 1, value: closing, rate: null },
    ...over,
  };
}

function summary(rows: StockSummaryRow[], over: Partial<StockSummaryResult> = {}): StockSummaryResult {
  const closingValue = rows.filter((r) => r.parentKey === null).reduce((a, r) => a + r.closing.value, 0);
  return { from: '2026-04-01', to: '2026-10-10', groupId: null, categoryId: null, godownId: null, valuesShown: true, rows, totals: { openingValue: 0, inwardValue: 0, outwardValue: 0, closingValue }, ...over };
}

/** The seeded shop of the 2.0 snapshot 17: four items, Grand Total 3,93,744.00. */
const SHOP = summary([
  sRow('i:1', 'Brass Hinge 4in', 44_820_00),
  sRow('i:2', 'Door Handle Set', 40_320_00),
  sRow('i:3', 'Steel Bolt M8', 31_044_00),
  sRow('i:4', 'Wood Primer 1L', 2_77_560_00),
]);

/** Eleven top-level rows (a group with children among them), one of them below zero. */
const BIG = summary([
  sRow('g:10', 'Hardware', 5_00_000_00, { kind: 'group', hasChildren: true }),
  sRow('i:11', 'Hinge', 3_00_000_00, { level: 1, parentKey: 'g:10' }),
  sRow('i:12', 'Bolt', 2_00_000_00, { level: 1, parentKey: 'g:10' }),
  ...Array.from({ length: 9 }, (_, i) => sRow(`i:${20 + i}`, `Item ${i + 1}`, (9 - i) * 10_000_00)),
  sRow('i:40', 'Lost Item', -12_345_67),
]);

// ───────────────────────────── Stock Summary ─────────────────────────────

describe('stock.summary — where money is locked in stock', () => {
  test('graph total = Grand Total; one bar per level-0 row; drawn inline for ≤ 7 rows', () => {
    const spec = valid(stockSummaryChart(SHOP));
    assert.equal(spec.total, SHOP.totals.closingValue);
    assert.equal(spec.total, 3_93_744_00);
    assert.equal(spec.kind, 'bar');
    assert.deepEqual(spec.categories, ['Brass Hinge 4in', 'Door Handle Set', 'Steel Bolt M8', 'Wood Primer 1L']);
    assert.equal(spec.color, 'series');
    assert.equal(spec.title, 'Where money is locked in stock');
    assert.equal(spec.takeaway, 'Wood Primer 1L holds 70 % of stock value');
    assert.equal(stockSummaryInline(SHOP, spec), true);
    assert.equal(inlineBars(spec, summaryTopRows(SHOP).length), true, 'the kit agrees');
  });

  test('more than 7 level-0 rows: Top 6 + Other strip, Σ preserved, negatives in slot 2', () => {
    const spec = valid(stockSummaryChart(BIG));
    assert.equal(spec.total, BIG.totals.closingValue);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[0], 'Hardware');
    assert.equal(spec.categories[6], 'Other');
    assert.equal(spec.color, 'series', 'the row below zero is folded into Other (no bar of its own)');
    assert.equal(stockSummaryInline(BIG, spec), false);
    assert.equal(inlineBars(spec, summaryTopRows(BIG).length), false);
    const lost = summary([...summaryTopRows(SHOP), sRow('i:9', 'Lost Item', -5_000_00)]);
    const s2 = valid(stockSummaryChart(lost));
    assert.equal(markColor(s2, 4), 2, 'negative stock is the problem pole');
    assert.equal(markColor(s2, 0), 1);
    assert.equal(s2.total, lost.totals.closingValue);
  });

  test('inline bars sit on the level-0 rows only (the rows the Grand Total adds up)', () => {
    const d = summary([
      sRow('g:10', 'Hardware', 5_00_000_00, { kind: 'group', hasChildren: true }),
      sRow('i:11', 'Hinge', 3_00_000_00, { level: 1, parentKey: 'g:10' }),
      sRow('i:12', 'Bolt', 2_00_000_00, { level: 1, parentKey: 'g:10' }),
      sRow('i:20', 'Primer', 1_00_000_00),
      sRow('i:21', 'Putty', 50_000_00),
    ]);
    const spec = valid(stockSummaryChart(d));
    assert.equal(stockSummaryInline(d, spec), true, '3 level-0 rows: inline, though the table shows 5');
    assert.deepEqual(d.rows.map(summaryBarValue), [5_00_000_00, null, null, 1_00_000_00, 50_000_00]);
    const barred = d.rows.map(summaryBarValue).filter((v): v is number => v !== null);
    assert.equal(barred.reduce((a, v) => a + v, 0), d.totals.closingValue, 'the bars add up to the Grand Total');
    assert.equal(stockSummaryInline(d, null), false, 'no graph (Quantities only): no bars');
  });

  test('none in Quantities only, and with fewer than 2 non-zero rows (2.1.1 D2)', () => {
    assert.equal(stockSummaryChart({ ...SHOP, valuesShown: false }), null);
    assert.equal(stockSummaryChart(summary(summaryTopRows(SHOP).slice(0, 1))), null, 'one row: no graph');
    assert.equal(stockSummaryChart(summary([...summaryTopRows(SHOP).slice(0, 1), sRow('i:5', 'Zero', 0)])), null, 'one non-zero row: no graph');
    assert.ok(stockSummaryChart(summary(summaryTopRows(SHOP).slice(0, 2))), 'two rows: a graph');
    assert.equal(stockSummaryChart(summary([])), null);
  });

  test('Enter on a bar = Enter on its row; "Other" opens nothing', () => {
    const opened: string[] = [];
    const spec = valid(stockSummaryChart(BIG, 'group', (r) => opened.push(r.key)));
    spec.activate?.(0);
    spec.activate?.(6);
    assert.deepEqual(opened, ['g:10']);
  });

  test('categories: "Not categorised" grey, the categories slot 1', () => {
    const d = summary([
      sRow('c:1', 'Brand A', 2_00_000_00, { kind: 'category' }),
      sRow('c:2', 'Brand B', 1_00_000_00, { kind: 'category' }),
      sRow('c:none', 'Not categorised', 50_000_00, { kind: 'category', id: null }),
    ]);
    const spec = valid(stockSummaryChart(d, 'category'));
    assert.equal(spec.total, d.totals.closingValue);
    assert.equal(spec.color, 'emphasis');
    assert.deepEqual(spec.emphasis, [0, 1]);
    assert.equal(markColor(spec, 2), 'other');
    assert.equal(spec.title, 'Stock value by category');
    const noneless = summary(d.rows.slice(0, 2).concat(sRow('c:3', 'Brand C', 10_00, { kind: 'category' })));
    assert.equal(valid(stockSummaryChart(noneless, 'category')).color, 'series', 'nothing to grey');
    assert.equal(stockSummaryChart({ ...d, valuesShown: false }, 'category'), null, 'none in quantities mode');
  });
});

describe('barSlots — the bar↹ fold', () => {
  test('≤ 7 rows keep table order and zero rows (one bar per row)', () => {
    const rows = [5, 0, -3, 9].map((v, i) => ({ v, n: `r${i}` }));
    const s = barSlots(rows, (r) => r.v, (r) => r.n);
    assert.deepEqual(s.map((x) => x.label), ['r0', 'r1', 'r2', 'r3']);
  });

  test('more rows: zero rows leave, top 6 by |value|, "Other" sums the rest; one leftover keeps its name', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 0].map((v, i) => ({ v, n: `r${i}` }));
    const s = barSlots(rows, (r) => r.v, (r) => r.n);
    assert.deepEqual(s.map((x) => x.label), ['r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'Other']);
    assert.equal(s[6].value, 3);
    assert.equal(s.reduce((a, x) => a + x.value, 0), 36);
    const seven = [1, 2, 3, 4, 5, 6, 7, 0].map((v, i) => ({ v, n: `r${i}` }));
    assert.deepEqual(barSlots(seven, (r) => r.v, (r) => r.n).map((x) => x.label), ['r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0']);
  });

  test('Σ preserved on random data, with negatives', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k++) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 20) }, (_, i) => ({ v: Math.round((rnd() - 0.3) * 1e7), n: `r${i}` }));
      const slots = barSlots(rows, (r) => r.v, (r) => r.n);
      assert.equal(slots.reduce((a, s) => a + s.value, 0), rows.reduce((a, r) => a + r.v, 0));
      assert.ok(slots.length <= 7);
    }
  });
});

// ───────────────────────────── Ageing ─────────────────────────────

function ageing(values: number[], bounds: number[] = [30, 60, 90, 180]): StockAgeingResult {
  const labels = bounds.map((b, i) => ({ label: `${i === 0 ? 0 : bounds[i - 1] + 1}–${b} days`, fromDays: i === 0 ? 0 : bounds[i - 1] + 1, toDays: b as number | null }));
  labels.push({ label: `Over ${bounds[bounds.length - 1]} days`, fromDays: bounds[bounds.length - 1] + 1, toDays: null });
  const value = values.reduce((a, v) => a + v, 0);
  return {
    asOf: '2026-10-10',
    buckets: labels,
    rows: [{ itemId: 1, name: 'Wood Primer 1L', unit: 'Ltr', groupId: null, groupName: null, qty: 10, value, buckets: values.map((v) => ({ qty: 1, value: v })), oldestDate: '2026-04-01', averageAgeDays: 50 }],
    totals: { value, buckets: values },
  };
}

describe('stock.ageing — how much stock is old', () => {
  test('graph total = the table total (Σ buckets = Value total); ordinal columns; takeaway over the middle bound', () => {
    const d = ageing([2_00_000_00, 1_00_000_00, 50_000_00, 30_000_00, 13_744_00]);
    const spec = valid(stockAgeingChart(d));
    assert.equal(spec.total, d.totals.value);
    assert.equal(spec.kind, 'column');
    assert.equal(spec.color, 'ordinal');
    assert.deepEqual(spec.categories, ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days']);
    assert.equal(markColor(spec, 0), 'o1');
    assert.equal(markColor(spec, 4), 'o5');
    assert.equal(ageingThreshold(d), 90);
    assert.equal(spec.takeaway, 'Of ₹3.94 L in stock, ₹43.7 K is over 90 days');
  });

  test('the other presets', () => {
    assert.equal(ageingThreshold(ageing([1, 1, 1, 1, 1], [15, 30, 45, 60])), 45);
    const long = ageing([10_000_00, 20_000_00, 30_000_00, 0], [90, 180, 365]);
    assert.equal(ageingThreshold(long), 180);
    const spec = valid(stockAgeingChart(long));
    assert.equal(spec.total, long.totals.value);
    assert.equal(markColor(spec, 0), 'o2', '4 buckets: o2…o5');
    assert.equal(spec.takeaway, 'Of ₹60.0 K in stock, ₹30.0 K is over 180 days');
  });

  test('nothing old: said in words; gates', () => {
    const fresh = ageing([1_00_000_00, 50_000_00, 25_000_00, 0, 0]);
    assert.equal(valid(stockAgeingChart(fresh)).takeaway, 'None of ₹1.75 L in stock is over 90 days');
    assert.equal(stockAgeingChart(ageing([1_00_000_00, 0, 0, 0, 0])), null, 'one bucket only');
    assert.equal(stockAgeingChart({ ...ageing([0, 0, 0, 0, 0]), rows: [] }), null, 'no stock');
  });
});

// ───────────────────────────── Stock Item Vouchers ─────────────────────────────

function vRow(date: string, inQty: number, outQty: number, closingQty: number): StockItemVoucherRow {
  return { key: `v:${date}:${closingQty}`, voucherId: 1, date, voucherTypeName: 'Sales', baseType: 'sales', number: '1', particulars: 'Asha Retail', godowns: '', inward: { qty: inQty, value: 0 }, outward: { qty: outQty, value: 0 }, closing: { qty: closingQty, value: closingQty * 900_00 } };
}

function itemResult(rows: StockItemVoucherRow[], opening: number, closing: number, over: Partial<StockItemVouchersResult> = {}): StockItemVouchersResult {
  return {
    item: { id: 4, name: 'Wood Primer 1L', unit: 'Ltr', unitDecimals: 0, groupId: null, groupName: null, costingMethod: 'avg_cost', isService: false },
    from: '2026-04-01',
    to: '2026-10-10',
    godownId: null,
    opening: { qty: opening, value: opening * 900_00 },
    rows,
    totals: { inwardQty: 0, inwardValue: 0, outwardQty: 0, outwardValue: 0 },
    closing: { qty: closing, value: closing * 900_00, rate: 900 },
    ...over,
  };
}

describe('stock.item — is this item running down', () => {
  test('a line of the running closing quantity in the item unit; its last point = the footer closing qty', () => {
    const d = itemResult([vRow('2026-05-02', 200, 0, 550), vRow('2026-07-15', 0, 120, 430), vRow('2026-07-15', 0, 120, 310)], 350, 310);
    const spec = valid(stockItemChart(d));
    assert.equal(spec.kind, 'line');
    assert.equal(spec.total, d.closing.qty);
    assert.deepEqual(spec.categories, ['1-Apr', '2-May', '15-Jul', '10-Oct']);
    assert.deepEqual(spec.series[0].values, [350, 550, 310, 310], 'one point per day: its last voucher’s closing');
    assert.equal(spec.title, 'Quantity in stock');
    assert.equal(spec.takeaway, '310 Ltr on 10-Oct, down 40 Ltr since 1-Apr');
    const f = spec.valueFormat;
    if (!f || typeof f !== 'object') throw new Error('a quantity format');
    assert.equal(f.full(1250), '1,250 Ltr', 'tooltips in the unit');
    assert.equal(qtyFormat('Nos').full(0), '0 Nos');
  });

  test('the change is measured from the opening, even when a voucher falls on the first day', () => {
    const d = itemResult([vRow('2026-04-01', 0, 50, 50), vRow('2026-06-02', 0, 0, 50)], 100, 50);
    const spec = valid(stockItemChart(d));
    assert.deepEqual(spec.series[0].values, [50, 50, 50], 'one point per day (the first day ends at 50)');
    assert.equal(spec.takeaway, '50 Ltr on 10-Oct, down 50 Ltr since 1-Apr', 'not "unchanged": 100 at the opening');
  });

  test('up / unchanged; the year when the period spans two', () => {
    const up = itemResult([vRow('2026-05-02', 20, 0, 30), vRow('2026-06-02', 5, 0, 35)], 10, 35);
    assert.equal(valid(stockItemChart(up)).takeaway, '35 Ltr on 10-Oct, up 25 Ltr since 1-Apr');
    const same = itemResult([vRow('2026-05-02', 5, 0, 15), vRow('2026-06-02', 0, 5, 10)], 10, 10);
    assert.equal(valid(stockItemChart(same)).takeaway, '10 Ltr on 10-Oct, unchanged since 1-Apr');
    const span = itemResult([vRow('2026-12-02', 5, 0, 15)], 10, 15, { from: '2026-10-01', to: '2027-01-31' });
    assert.deepEqual(valid(stockItemChart(span)).categories, ['1-Oct-26', '2-Dec-26', '31-Jan-27']);
  });

  test('≥ 2 points (2.1.1 D2); never for a service; ≤ 480 points with the closing kept', () => {
    assert.equal(stockItemChart(itemResult([], 10, 10))?.categories.length, 2, 'opening + closing: a line of two points');
    const last = stockItemChart(itemResult([vRow('2026-10-10', 0, 1, 9)], 10, 9));
    assert.deepEqual(last?.series[0].values, [10, 9], 'a voucher on the last day: 2 points, ending on the closing');
    assert.equal(stockItemChart(itemResult([], 10, 10, { from: '2026-10-10', to: '2026-10-10' })), null, 'a one-day period: one point, no line');
    const svc = itemResult([vRow('2026-05-02', 1, 0, 1), vRow('2026-06-02', 1, 0, 2)], 0, 2);
    assert.equal(stockItemChart({ ...svc, item: { ...svc.item, isService: true } }), null);
    const many: StockItemVoucherRow[] = [];
    let q = 0;
    for (let i = 0; i < 900; i++) {
      q += i % 3 === 0 ? 5 : -2;
      const day = new Date(Date.UTC(2024, 3, 2) + i * 86_400_000).toISOString().slice(0, 10);
      many.push(vRow(day, 0, 0, q));
    }
    const long = itemResult(many, 0, q, { from: '2024-04-01', to: '2026-10-10' });
    const spec = valid(stockItemChart(long));
    assert.ok(spec.categories.length <= 480);
    assert.equal(spec.total, q);
  });
});

// ───────────────────────────── Item Profitability ─────────────────────────────

function pRow(itemId: number, name: string, gp: number): ProfitabilityRow {
  return { itemId, name, unit: 'Nos', groupId: null, groupName: null, salesQty: 1, salesValue: gp * 3, returnsQty: 0, returnsValue: 0, netQty: 1, netSales: gp * 3, cost: gp * 2, grossProfit: gp, gpPercent: 33.33 };
}

function profit(rows: ProfitabilityRow[]): ProfitabilityResult {
  const grossProfit = rows.reduce((a, r) => a + r.grossProfit, 0);
  return { from: '2026-04-01', to: '2026-10-10', groupId: null, rows, totals: { netSales: 0, cost: 0, grossProfit, gpPercent: null } };
}

describe('stock.profitability — which items make or lose money', () => {
  test('short table: one bar per item, inline, polarity; total = the Gross profit total', () => {
    const d = profit([pRow(1, 'Brass Hinge 4in', 12_000_00), pRow(2, 'Door Handle Set', 8_000_00), pRow(3, 'Steel Bolt M8', -1_500_00), pRow(4, 'Wood Primer 1L', 40_000_00)]);
    const spec = valid(profitabilityChart(d));
    assert.equal(spec.total, d.totals.grossProfit);
    assert.equal(spec.color, 'polarity');
    assert.equal(markColor(spec, 2), 2, 'a loss in slot 2');
    assert.equal(profitabilityInline(d, spec), true);
    assert.equal(spec.title, 'Gross profit by item');
    assert.equal(spec.takeaway, '1 item sold at a loss; Wood Primer 1L earns 67 % of gross profit');
  });

  test('long table: top 6 earners + Other + up to 3 losses (biggest last); Σ preserved; Enter opens the item', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => pRow(i + 1, `Earner ${i + 1}`, (10 - i) * 1_000_00)),
      pRow(20, 'Loss A', -100_00),
      pRow(21, 'Loss B', -900_00),
      pRow(22, 'Loss C', -500_00),
      pRow(23, 'Loss D', -50_00),
      pRow(24, 'Flat', 0),
    ];
    const d = profit(rows);
    const slots = profitabilitySlots(rows);
    assert.deepEqual(slots.map((s) => s.label), ['Earner 1', 'Earner 2', 'Earner 3', 'Earner 4', 'Earner 5', 'Earner 6', 'Other', 'Loss A', 'Loss C', 'Loss B']);
    assert.equal(slots[6].value, (4 + 3 + 2) * 1_000_00 - 50_00);
    const opened: number[] = [];
    const spec = valid(profitabilityChart(d, (r) => opened.push(r.itemId)));
    assert.equal(spec.total, d.totals.grossProfit);
    assert.equal(profitabilityInline(d, spec), false);
    assert.equal(spec.label, 'none', 'tips only for ≤ 7 bars');
    spec.activate?.(0);
    spec.activate?.(6);
    spec.activate?.(9);
    assert.deepEqual(opened, [1, 21]);
    assert.equal(spec.takeaway, '4 items sold at a loss; Earner 1 earns 19 % of gross profit');
  });

  test('a single leftover keeps its name; gates', () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => pRow(i + 1, `E${i + 1}`, (8 - i) * 100_00)), pRow(9, 'L', -50_00)];
    assert.deepEqual(profitabilitySlots(rows).map((s) => s.label), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'L']);
    assert.equal(profitabilityChart(profit([pRow(1, 'A', 100)])), null, 'one item: no graph (2.1.1 D2)');
    assert.ok(profitabilityChart(profit([pRow(1, 'A', 100), pRow(2, 'B', 200)])), 'two items: a graph');
    assert.equal(profitabilityChart(profit([])), null);
  });
});

// ───────────────────────────── Godowns ─────────────────────────────

function gRow(key: string, name: string, value: number, over: Partial<GodownSummaryRow> = {}): GodownSummaryRow {
  return { key, kind: 'godown', godownId: Number(key.split(':')[1]), itemId: null, name, level: 0, parentKey: null, hasChildren: true, unit: null, qty: null, rate: null, value, isThirdParty: false, ...over };
}

describe('stock.godowns — where is stock lying', () => {
  test('graph total = Grand Total (top-level godowns, sub-godowns inside); inline for ≤ 7', () => {
    const rows = [
      gRow('gd:1', 'Main Store', 3_00_000_00),
      gRow('gi:1:4', 'Wood Primer 1L', 2_00_000_00, { kind: 'item', itemId: 4, level: 1, parentKey: 'gd:1', hasChildren: false }),
      gRow('gd:4', 'Back Room', 1_00_000_00, { level: 1, parentKey: 'gd:1' }),
      gRow('gd:2', 'Shop Floor', 80_000_00),
      gRow('gd:3', 'Job Worker', 13_744_00, { isThirdParty: true }),
    ];
    const d: GodownSummaryResult = { asOf: '2026-10-10', godownId: null, rows, totalValue: 3_93_744_00 };
    const opened: string[] = [];
    const spec = valid(godownsChart(d, (r) => opened.push(r.key)));
    assert.equal(spec.total, d.totalValue);
    assert.deepEqual(spec.categories, ['Main Store', 'Shop Floor', 'Job Worker']);
    assert.equal(spec.takeaway, 'Main Store holds 76 % of stock value');
    assert.equal(godownsInline(d, spec), true);
    spec.activate?.(1);
    assert.deepEqual(opened, ['gd:2']);
    assert.equal(godownsChart({ ...d, rows: rows.slice(0, 3) }), null, 'one top-level godown');
    assert.deepEqual(rows.map(godownBarValue), [3_00_000_00, null, null, 80_000_00, 13_744_00], 'bars on the top-level godowns only');
    assert.equal(godownsInline(d, null), false);
  });
});

// ───────────────────────────── Movement ─────────────────────────────

function party(id: number, name: string, value: number): MovementPartyRow {
  return { key: `p:${id}`, partyLedgerId: id, partyName: name, qty: 1, value, avgRate: null, vouchers: 1, items: [] };
}

describe('stock.movement — biggest buyers / suppliers', () => {
  const out = [party(1, 'Asha Retail', 2_00_000_00), party(2, 'Kumar Builders', 1_00_000_00), party(3, 'Cash Sales', 50_000_00), party(4, 'Nil', 0)];
  const inn = Array.from({ length: 9 }, (_, i) => party(10 + i, `Supplier ${i + 1}`, (9 - i) * 10_000_00));
  const d: StockMovementResult = {
    from: '2026-04-01',
    to: '2026-10-10',
    itemId: null,
    groupId: null,
    unit: 'Nos',
    inward: { rows: inn, qty: null, value: inn.reduce((a, r) => a + r.value, 0), avgRate: null },
    outward: { rows: out, qty: null, value: out.reduce((a, r) => a + r.value, 0), avgRate: null },
    internal: { inwardQty: null, outwardQty: null, vouchers: 0 },
  };

  test('graph total = the side’s Total; one colour on both sides', () => {
    const o = valid(movementChart(d, 'outward'));
    assert.equal(o.total, d.outward.value);
    assert.equal(o.title, 'Biggest buyers');
    assert.equal(o.takeaway, 'Asha Retail took 57 % of the value sent out');
    assert.equal(movementInline(d, 'outward', o), true);
    const i = valid(movementChart(d, 'inward'));
    assert.equal(i.total, d.inward.value);
    assert.equal(i.title, 'Biggest suppliers');
    assert.equal(i.categories.length, 7);
    assert.equal(movementInline(d, 'inward', i), false);
    assert.equal(o.color, 'series');
    assert.equal(i.color, 'series');
    assert.equal(i.takeaway, 'Supplier 1 supplied 20 % of the value received');
  });

  test('inline bars on the party rows only, adding up to the Total', () => {
    const withItems = out.map((p) => ({ ...p, items: [{ itemId: 1, itemName: 'Bolt', unit: 'Nos', qty: 1, value: p.value, avgRate: null }] }));
    const tree = movementTree(withItems);
    const bars = tree.map(movementBarValue);
    assert.deepEqual(bars.filter((_, i) => tree[i].kind !== 'party'), [null, null, null, null], 'items carry no bar');
    assert.equal(bars.reduce<number>((a, v) => a + (v ?? 0), 0), d.outward.value);
  });

  test('Enter opens the party; gates', () => {
    const opened: string[] = [];
    valid(movementChart(d, 'outward', (r) => opened.push(r.partyName))).activate?.(1);
    assert.deepEqual(opened, ['Kumar Builders']);
    assert.equal(movementChart({ ...d, outward: { ...d.outward, rows: out.slice(0, 1) } }, 'outward'), null, 'one party: no graph (2.1.1 D2)');
    assert.ok(movementChart({ ...d, outward: { ...d.outward, rows: out.slice(0, 2) } }, 'outward'), 'two parties: a graph');
    assert.equal(movementChart({ ...d, outward: { rows: [], qty: null, value: 0, avgRate: null } }, 'outward'), null);
  });
});

// ───────────────────────────── Stats ─────────────────────────────

describe('stats of the screens without a graph (D24: never a table total)', () => {
  test('pending orders: "N overdue" only when some line is late', () => {
    const d: PendingOrdersResult = { kind: 'sales', asOf: '2026-10-10', rows: [], totals: { orders: 2, pendingValue: 45_000_00, overdueLines: 3 } };
    const s = pendingOrdersStat(d);
    assert.deepEqual(s, [{ label: 'Overdue', value: '3 lines', tone: 'danger', count: 3 }]);
    assert.equal(statRepeatsTotal(s.map((x) => x.count), [d.totals.pendingValue]), false);
    assert.deepEqual(pendingOrdersStat({ ...d, totals: { ...d.totals, overdueLines: 1 } })[0].value, '1 line');
    assert.deepEqual(pendingOrdersStat({ ...d, totals: { ...d.totals, overdueLines: 0 } }), []);
  });

  test('batches: expired and expiring counts, zero parts dropped', () => {
    const b = (status: BatchRow['status']): BatchRow => ({ key: `b:${Math.random()}`, itemId: 1, itemName: 'Syrup', unit: 'Btl', batchName: 'B1', mfgDate: null, expiryDate: null, qty: 5, daysToExpiry: null, status });
    const d: BatchSummaryResult = { asOf: '2026-10-10', windowDays: 30, rows: [b('expired'), b('expired'), b('expiring'), b('ok'), b('no_expiry')] };
    assert.deepEqual(batchesStat(d), [
      { label: 'Expired', value: '2 batches', tone: 'danger', count: 2 },
      { label: 'Expiring in 30 days', value: '1 batch', tone: 'warning', count: 1 },
    ]);
    assert.deepEqual(batchesStat({ ...d, windowDays: 90, rows: [b('expiring')] }), [{ label: 'Expiring in 90 days', value: '1 batch', tone: 'warning', count: 1 }]);
    assert.deepEqual(batchesStat({ ...d, rows: [b('ok')] }), []);
  });

  test('negative stock: "N items below zero"', () => {
    const n: NegativeStockRow = { itemId: 1, name: 'Bolt', unit: 'Nos', groupName: null, qty: -5, value: -30_00, negativeSince: '2026-09-01', godowns: [] };
    const s = negativeStat([n, { ...n, itemId: 2 }]);
    assert.deepEqual(s, [{ label: 'Below zero', value: '2 items', tone: 'danger', count: 2 }]);
    assert.equal(statRepeatsTotal(s.map((x) => x.count), []), false, 'the table has no total row');
    assert.deepEqual(negativeStat([]), []);
  });

  test('reorder: "Order now: N of M items"', () => {
    const r = (itemId: number, suggestedQty: number): ReorderRow => ({ itemId, name: `I${itemId}`, unit: 'Nos', groupName: null, closingQty: 1, reorderLevel: 10, minOrderQty: null, pendingPurchaseQty: 0, pendingSalesQty: 0, netAvailable: 1, shortfall: suggestedQty, suggestedQty });
    const d: ReorderStatusResult = { asOf: '2026-10-10', rows: [r(1, 9), r(2, 0), r(3, 4)], itemsWithLevel: 12 };
    assert.deepEqual(reorderStat(d), [{ label: 'Order now', value: '2 of 12 items', count: 2 }]);
    assert.deepEqual(reorderStat({ ...d, rows: [r(2, 0)] }), []);
  });
});

test('builders are single passes: 10,000 rows in under 50 ms each (§4.7)', () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => sRow(`i:${i + 1}`, `Item ${i + 1}`, ((i * 7919) % 100_000) * 100 - 5_000_00));
  const big = summary(rows);
  const prof = profit(rows.map((r, i) => pRow(i + 1, r.name, r.closing.value)));
  const vouchers = rows.map((_, i) => vRow(new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), 0, 0, i % 500));
  const item = itemResult(vouchers, 0, 9_999 % 500, { from: '2000-01-01', to: '2027-05-19' });
  for (const [name, run] of [
    ['summary', () => stockSummaryChart(big)],
    ['profitability', () => profitabilityChart(prof)],
    ['item', () => stockItemChart(item)],
  ] as const) {
    // Two warm-up runs (the JIT), then the best of five (the machine may be busy with other work); the
    // steady state is a few ms, so the 50 ms budget still catches a sort-every-row or quadratic builder.
    run();
    run();
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      run();
      ms = Math.min(ms, performance.now() - t0);
    }
    const spec = valid(run());
    assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
    assert.ok(spec.categories.length <= 480);
  }
  assert.equal(valid(stockSummaryChart(big)).total, big.totals.closingValue);
  assert.equal(valid(profitabilityChart(prof)).total, prof.totals.grossProfit);
  assert.equal(valid(stockItemChart(item)).total, item.closing.qty);
});
