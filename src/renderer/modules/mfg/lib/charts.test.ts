/**
 * The manufacturing graphs and stats (SPEC-21 §4.8, WP-L1): graph total = table total, the gates,
 * colours by meaning, takeaways, and stats that repeat no visible total.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Itc04Result, PendingJobWorkResult, PendingJobWorkRow, ProductionRegisterResult, ProductionRegisterRow } from '../../../../shared/types/mfg.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { drawnTotal, markColor, specProblems } from '../../../ui/lib/chartSpec.ts';
import { itc04Stat, jobWorkChart, jobWorkStat, overdueBannerShown, productionChart } from './charts.ts';

let seq = 0;
const made = (date: string, productValue: number): ProductionRegisterRow => ({
  voucherId: ++seq,
  date,
  number: String(seq),
  typeName: 'Manufacturing Journal',
  class: 'manufacturing',
  itemId: 1,
  itemName: 'Bolt Kit',
  unit: 'Nos',
  qty: 10,
  bomName: 'Standard',
  partyName: null,
  consumed: productValue,
  additional: 0,
  byProducts: 0,
  productValue,
  productRate: productValue / 1000,
  bomEstimate: null,
});

const register = (rows: ProductionRegisterRow[], from = '2026-04-01', to = '2026-10-11'): ProductionRegisterResult => {
  const t = (k: 'consumed' | 'additional' | 'byProducts' | 'productValue') => rows.reduce((a, r) => a + r[k], 0);
  return { from, to, rows, totals: { consumed: t('consumed'), additional: t('additional'), byProducts: t('byProducts'), productValue: t('productValue') } };
};

const pending = (status: PendingJobWorkRow['status'], pendingValue: number): PendingJobWorkRow => ({
  key: `p${++seq}`,
  direction: 'out',
  voucherId: seq,
  lineNo: 1,
  challanNo: String(seq),
  sentOn: '2025-09-01',
  partyLedgerId: 7,
  partyName: 'Shree Machining',
  godownId: 3,
  godownName: 'At Shree Machining',
  itemId: 1,
  itemName: 'Steel rod',
  unit: 'Kg',
  goodsType: 'inputs',
  sentQty: 100,
  returnedQty: 0,
  pendingQty: 100,
  pendingValue,
  dueDate: status === 'no_limit' ? null : '2026-09-01',
  daysLeft: status === 'overdue' ? -10 : status === 'due_soon' ? 12 : status === 'ok' ? 200 : null,
  status,
  ageDays: 300,
  orderNo: null,
});

const pendingResult = (rows: PendingJobWorkRow[]): PendingJobWorkResult => ({
  asOf: '2026-10-11',
  rows,
  unexplained: [],
  counts: { overdue: rows.filter((r) => r.status === 'overdue').length, dueSoon: rows.filter((r) => r.status === 'due_soon').length, total: rows.length },
  overdueValue: rows.filter((r) => r.status === 'overdue').reduce((a, r) => a + r.pendingValue, 0),
});

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('Production Register by month (mfg.production)', () => {
  const rows = [made('2026-04-10', 40_000_00), made('2026-04-20', 10_000_00), made('2026-06-05', 80_000_00), made('2026-09-15', 30_000_00), made('2026-10-02', 12_000_00)];

  test('graph total = the Cost of production total of the table', () => {
    const r = register(rows);
    const spec = productionChart(r);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, r.totals.productValue);
    assert.equal(spec.total, sum(rows.map((x) => x.productValue)));
    assert.equal(drawnTotal(spec), spec.total);
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    assert.deepEqual(spec.series[0].values, [50_000_00, 0, 80_000_00, 0, 0, 30_000_00, 12_000_00]);
  });

  test('the running month is drawn "so far" and never named the best', () => {
    const spec = productionChart(register(rows), '2026-10');
    assert.ok(spec);
    assert.equal(spec.partialLast, true);
    assert.equal(markColor(spec, spec.categories.length - 1), 'partial');
    assert.equal(spec.takeaway, 'Best month Jun ₹80.0 K · Oct so far ₹12.0 K');
    assert.equal(productionChart(register(rows, '2026-04-01', '2026-09-30'), '2026-10')?.partialLast, undefined, 'a closed period has no running month');
  });

  test('a whole financial year seen mid-year stops at the running month (no empty future months)', () => {
    const r = register(rows, '2026-04-01', '2027-03-31');
    const spec = productionChart(r, '2026-10');
    assert.ok(spec);
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    assert.equal(spec.partialLast, true);
    assert.equal(spec.total, r.totals.productValue);
    // A post-dated row after the running month is still drawn (graph total = table total).
    const later = register([...rows, made('2026-12-05', 5_000_00)], '2026-04-01', '2027-03-31');
    const withLater = productionChart(later, '2026-10');
    assert.ok(withLater);
    assert.equal(withLater.categories[withLater.categories.length - 1], 'Dec');
    assert.equal(withLater.partialLast, undefined, 'the last month drawn is not the running one');
    assert.equal(withLater.total, later.totals.productValue);
    // Without a working date the whole period is drawn.
    assert.equal(productionChart(r)?.categories.length, 12);
  });

  test('a long period folds into quarters, Σ preserved', () => {
    const long = [made('2024-04-10', 1_000_00), made('2025-01-10', 2_000_00), made('2025-08-10', 3_000_00), made('2026-03-10', 4_000_00)];
    const r = register(long, '2024-04-01', '2026-03-31');
    const spec = productionChart(r);
    assert.ok(spec);
    assert.match(spec.title, /by quarter$/);
    assert.equal(spec.total, r.totals.productValue);
  });

  test('one month with production draws (a time series, 2.1.1 D2); none → no graph', () => {
    assert.equal(productionChart(register([made('2026-04-10', 1_00), made('2026-05-10', 1_00)]))?.total, 2_00);
    const one = productionChart(register([made('2026-05-10', 7_00)]));
    assert.ok(one, 'one month with production: a graph');
    assert.equal(one.xKind, 'time');
    assert.equal(one.total, 7_00);
    assert.equal(productionChart(register([])), null);
  });
});

describe('Pending job work by return date (mfg.jobWork.pending)', () => {
  const rows = [pending('ok', 200_000_00), pending('ok', 50_000_00), pending('due_soon', 30_000_00), pending('overdue', 20_000_00)];

  test('graph total = the Value total of the table; ordinal colour by lateness', () => {
    const spec = jobWorkChart(pendingResult(rows), 'out', false);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, sum(rows.map((r) => r.pendingValue)));
    assert.equal(drawnTotal(spec), spec.total);
    assert.deepEqual(spec.categories, ['Later', 'Due within 30 days', 'Overdue']);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      ['o1', 'o3', 'o5'],
    );
    assert.equal(spec.takeaway, 'Of ₹3.00 L with job workers, ₹20.0 K is past the return date');
  });

  test('goods with no time limit are context (grey); the statuses keep their colours', () => {
    const spec = jobWorkChart(pendingResult([...rows, pending('no_limit', 10_000_00)]), 'out', false);
    assert.ok(spec);
    assert.deepEqual(spec.categories, ['No time limit', 'Later', 'Due within 30 days', 'Overdue']);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      ['other', 'o1', 'o3', 'o5'],
    );
    assert.equal(spec.total, 310_000_00);
  });

  test('nothing overdue: the takeaway names what is due soon', () => {
    const spec = jobWorkChart(pendingResult([pending('ok', 100_00), pending('due_soon', 50_00), pending('no_limit', 10_00)]), 'in', false);
    assert.ok(spec);
    assert.equal(spec.takeaway, "Of ₹160 of principals' goods with us, ₹50 is due back within 30 days");
  });

  test('gates: "only overdue / due soon" (Ctrl+3) and fewer than 2 statuses with a value (2.1.1 D2)', () => {
    assert.equal(jobWorkChart(pendingResult(rows), 'out', true), null);
    assert.equal(jobWorkChart(pendingResult([pending('ok', 100_00), pending('ok', 10_00)]), 'out', false), null, 'one status: no graph');
    assert.equal(jobWorkChart(pendingResult([pending('ok', 100_00), pending('overdue', 10_00)]), 'out', false)?.total, 110_00, 'two statuses: a graph');
  });

  test('stat: counts of challan lines, never a money total', () => {
    const items = jobWorkStat(pendingResult(rows));
    assert.deepEqual(
      items.map((i) => [i.label, i.value, i.tone]),
      [
        ['Overdue', '1', 'danger'],
        ['Due within 30 days', '1', undefined],
      ],
    );
    assert.equal(items.some((i) => typeof i.value === 'number'), false);
    assert.equal(statTotalAllowed('mfg.jobWork.pending'), false);
    assert.deepEqual(jobWorkStat(pendingResult([pending('ok', 1_00)])), []);
  });

  test('the overdue count is said once: by the s.143 banner (goods with job workers) or by the stat', () => {
    const res = pendingResult(rows);
    assert.equal(overdueBannerShown(res, 'out'), true);
    assert.equal(overdueBannerShown(res, 'in'), false, "principals' goods: no s.143 banner of ours");
    assert.equal(overdueBannerShown(pendingResult([pending('ok', 1_00)]), 'out'), false);
    assert.deepEqual(
      jobWorkStat(res, { overdueInBanner: true }).map((i) => i.label),
      ['Due within 30 days'],
    );
    assert.deepEqual(
      jobWorkStat(res, { overdueInBanner: false }).map((i) => i.label),
      ['Overdue', 'Due within 30 days'],
    );
  });
});

describe('ITC-04 (mfg.itc04): a statutory form, no graph', () => {
  test('stat: the size of each part of the return', () => {
    const res = { sent: [{}, {}, {}], returned: [{}] } as unknown as Itc04Result;
    assert.deepEqual(
      itc04Stat(res).map((i) => [i.label, i.value]),
      [
        ['Table 4', '3 lines'],
        ['Tables 5A–5C', '1 line'],
      ],
    );
  });
});

describe('builders are fast (§4.7)', () => {
  test('10,000 rows in under 50 ms each (best of three)', () => {
    const big = register(Array.from({ length: 10_000 }, (_, i) => made(`2026-${String((i % 6) + 4).padStart(2, '0')}-10`, 1_00 + i)));
    const jw = pendingResult(Array.from({ length: 10_000 }, (_, i) => pending((['ok', 'due_soon', 'overdue', 'no_limit'] as const)[i % 4], 1_00 + i)));
    const best = (run: () => void) => Math.min(...[0, 1, 2].map(() => (((t0) => (run(), performance.now() - t0))(performance.now()))));
    const a = best(() => productionChart(big));
    const b = best(() => jobWorkChart(jw, 'out', false));
    assert.ok(a < 50, `production ${a} ms`);
    assert.ok(b < 50, `job work ${b} ms`);
  });
});
