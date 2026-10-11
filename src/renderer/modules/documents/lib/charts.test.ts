/**
 * The documents graphs and stats (SPEC-21 §4.8, WP-L1): every graph's drawn total equals the table's
 * total, the gates return null, takeaways say the shape, and no stat repeats a visible table total.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BillsPendingRow, BudgetVarianceRow, DocumentListResult, RecurringDueRow } from '../../../../shared/types/documents.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { billsPendingChart, budgetVarianceChart, quotationsShown, quotationsStat, recurringDueStat, statMoneyValues, tickedTotal, varianceBarValue } from './charts.ts';
import { groupBills } from './model.ts';

let seq = 0;
const bill = (ageDays: number, pendingValue: number, over: Partial<BillsPendingRow> = {}): BillsPendingRow => ({
  key: `n:${++seq}:1`,
  noteId: seq,
  noteNo: String(seq),
  noteDate: '2026-09-01',
  noteBaseType: 'delivery_note',
  noteTypeName: 'Delivery Note',
  invoiceBaseType: 'sales',
  partyLedgerId: (seq % 3) + 1,
  partyName: `Party ${(seq % 3) + 1}`,
  itemId: (seq % 2) + 1,
  itemName: `Item ${(seq % 2) + 1}`,
  unit: 'Nos',
  qty: 10,
  billedQty: 0,
  pendingQty: 10,
  rate: 100,
  discountPct: 0,
  pendingValue,
  ageDays,
  ...over,
});

const line = (name: string, budget: number, actual: number, over: Partial<BudgetVarianceRow> = {}): BudgetVarianceRow => {
  const variance = actual - budget;
  const sameSide = Math.sign(actual) === Math.sign(budget) || actual === 0;
  return {
    key: `l:${name}`,
    kind: 'ledger',
    refId: ++seq,
    name,
    under: null,
    basis: 'net_transactions',
    budget,
    actual,
    variance,
    variancePct: budget === 0 ? null : Math.round((variance / Math.abs(budget)) * 10000) / 100,
    overBudget: budget !== 0 && sameSide && Math.abs(actual) > Math.abs(budget),
    inTotal: true,
    ...over,
  };
};

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('Bills pending by age (documents.billsPending)', () => {
  const rows = [bill(2, 100_00), bill(5, 50_00), bill(12, 300_00), bill(45, 120_00), bill(120, 80_00), bill(200, 20_00)];

  test('graph total = the table total (lines view and the grouped views)', () => {
    const spec = billsPendingChart(rows, 'sales');
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    const table = sum(rows.map((r) => r.pendingValue));
    assert.equal(spec.total, table);
    assert.equal(drawnTotal(spec), table);
    assert.equal(sum(groupBills(rows, 'party').map((g) => g.pendingValue)), spec.total, 'By party total');
    assert.equal(sum(groupBills(rows, 'item').map((g) => g.pendingValue)), spec.total, 'By item total');
    assert.deepEqual(spec.series[0].values, [150_00, 300_00, 120_00, 100_00]);
  });

  test('ordinal: 0–7 days grey, then o1 o3 o5 (colour by age, never by rank)', () => {
    const spec = billsPendingChart(rows, 'sales');
    assert.ok(spec);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      ['other', 'o1', 'o3', 'o5'],
    );
  });

  test('takeaway names the value older than 7 days, per side', () => {
    assert.equal(billsPendingChart(rows, 'sales')?.takeaway, 'Of ₹670 unbilled, ₹520 is over 7 days');
    assert.match(billsPendingChart(rows, 'purchase')?.takeaway ?? '', /awaiting bills/);
    assert.match(billsPendingChart(rows, 'purchase')?.title ?? '', /Bills awaited/);
  });

  test('fewer than 2 ages with a value: no graph (2.1.1 D2)', () => {
    assert.equal(billsPendingChart([bill(1, 10_00)], 'sales'), null);
    assert.equal(billsPendingChart([bill(1, 10_00), bill(2, 5_00)], 'sales'), null, 'two bills, one age');
    assert.equal(billsPendingChart([bill(1, 10_00), bill(40, 10_00)], 'sales')?.total, 20_00, 'two ages: a graph');
    assert.equal(billsPendingChart([], 'sales'), null);
  });
});

describe('Budget variance (documents.budget.variance)', () => {
  // Expense budgets (Dr +): Rent over, Salaries under, Power on budget, Travel over.
  const expense = [line('Rent', 120_000_00, 130_000_00), line('Salaries', 500_000_00, 470_000_00), line('Power', 40_000_00, 40_000_00), line('Travel', 20_000_00, 26_000_00)];
  const totals = { variance: sum(expense.map((r) => r.variance)) };

  test('graph total = the table variance total read from the budget side (expense budgets: −Σ variance)', () => {
    const spec = budgetVarianceChart(expense);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, -totals.variance);
    assert.equal(drawnTotal(spec), spec.total);
  });

  test('each bar is its row: |bar| = |variance|, over budget below zero (slot 2), under above (slot 1)', () => {
    const income = line('Sales', -900_000_00, -950_000_00); // earned more than the target: over budget
    assert.equal(income.overBudget, true);
    assert.equal(varianceBarValue(income), -50_000_00);
    assert.equal(varianceBarValue(expense[0]), -10_000_00);
    assert.equal(varianceBarValue(expense[1]), 30_000_00);
    const spec = budgetVarianceChart([...expense, income]);
    assert.ok(spec);
    for (const r of [...expense, income]) {
      const i = spec.categories.indexOf(r.name);
      assert.equal(Math.abs(spec.series[0].values[i] ?? NaN), Math.abs(r.variance), r.name);
      assert.equal(markColor(spec, i), r.overBudget ? 2 : 1, r.name);
    }
  });

  test('lines inside another line and lines without a budget stay in the table only', () => {
    const inner = line('Rent – shop', 60_000_00, 70_000_00, { inTotal: false });
    const unbudgeted = line('Repairs', 0, 5_000_00);
    assert.equal(varianceBarValue(inner), null);
    assert.equal(varianceBarValue(unbudgeted), null);
    const rows = [...expense, inner, unbudgeted];
    const spec = budgetVarianceChart(rows);
    assert.ok(spec);
    assert.deepEqual([...spec.categories].sort(), ['Power', 'Rent', 'Salaries', 'Travel']);
    assert.equal(spec.total, -totals.variance, 'still the counted lines only');
    assert.equal(inlineBars(spec, rows.length), false, 'the table has rows the graph leaves out: a strip, not inline bars');
    assert.equal(inlineBars(spec, expense.length), true, 'the table is the graph: inline bars');
  });

  test('income and expense lines together: each bar keeps its row\'s size, read from the budget\'s side', () => {
    // Earning more than an income target (Cr) is "over budget" on its own side, as the table's Status says.
    const sales = line('Sales', -900_000_00, -950_000_00);
    const commission = line('Commission', -50_000_00, -40_000_00);
    const rows = [...expense, sales, commission];
    const spec = budgetVarianceChart(rows);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    // The graph total is Σ of the drawn (budget-side) bars; the table's Dr/Cr variance total nets income
    // against expense, so the two are equal only when every line is on the same side (tested above).
    assert.equal(spec.total, sum(rows.map((r) => varianceBarValue(r) ?? 0)));
    assert.equal(sum(spec.series[0].values.map((v) => Math.abs(v ?? 0))), sum(rows.map((r) => Math.abs(r.variance))));
    assert.equal(spec.takeaway, '3 of 6 lines over budget; most: Sales ₹50.0 K');
  });

  test('more than 7 lines fold into Top 6 + Other lines, Σ preserved', () => {
    const many = Array.from({ length: 10 }, (_, i) => line(`Ledger ${i + 1}`, 10_000_00, 10_000_00 + (i + 1) * 1_000_00 * (i % 2 ? 1 : -1)));
    const spec = budgetVarianceChart(many);
    assert.ok(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[6], 'Other lines');
    assert.equal(spec.total, sum(many.map((r) => varianceBarValue(r) ?? 0)));
    assert.equal(inlineBars(spec, many.length), false);
  });

  test('takeaway: how many lines are over and the worst one; words, never a bare minus', () => {
    assert.equal(budgetVarianceChart(expense)?.takeaway, '2 of 4 lines over budget; most: Rent ₹10.0 K');
    const under = [line('A', 10_000_00, 9_000_00), line('B', 10_000_00, 8_000_00), line('C', 10_000_00, 7_000_00)];
    assert.equal(budgetVarianceChart(under)?.takeaway, 'All 3 lines within budget');
    const fmt = budgetVarianceChart(expense)?.valueFormat;
    assert.ok(fmt && typeof fmt === 'object');
    assert.equal(fmt.full(-10_000_00), '₹10,000.00 over budget');
    assert.equal(fmt.full(30_000_00), '₹30,000.00 under budget');
    assert.doesNotMatch(fmt.tick(-10_000_00), /[−-]/);
  });

  test('fewer than 3 lines off budget: no graph', () => {
    assert.equal(budgetVarianceChart([line('A', 100_00, 120_00), line('B', 100_00, 100_00), line('C', 100_00, 100_00)]), null);
  });
});

describe('stats: never a visible table total (D24)', () => {
  const summary = (open: number, accepted: number, converted: number): DocumentListResult['summary'] => ({
    count: 6,
    value: open + accepted + converted,
    byStatus: {
      open: { count: 3, value: open },
      accepted: { count: 1, value: accepted },
      expired: { count: 0, value: 0 },
      converted: { count: 2, value: converted },
      rejected: { count: 0, value: 0 },
      cancelled: { count: 0, value: 0 },
    },
    conversionRatePct: 33.33,
  });

  test('Quotation Register: "Open ₹x · Conversion y %"', () => {
    const s = summary(30_000_00, 10_000_00, 50_000_00);
    const items = quotationsStat(s);
    assert.deepEqual(
      items.map((i) => [i.label, i.value]),
      [
        ['Open', 40_000_00],
        ['Conversion', '33.33 %'],
      ],
    );
    assert.equal(statTotalAllowed('documents.quotations'), false);
    assert.equal(statRepeatsTotal(statMoneyValues(items), [s.value]), false);
  });

  test('Quotation Register: every document still open — the Open figure is the total row, so it goes', () => {
    const s = { ...summary(40_000_00, 0, 0), conversionRatePct: 0 };
    const items = quotationsStat(s);
    assert.deepEqual(
      items.map((i) => i.label),
      ['Conversion'],
    );
    assert.equal(statRepeatsTotal(statMoneyValues(items), [s.value]), false);
    assert.deepEqual(quotationsStat({ ...s, conversionRatePct: null }), []);
  });

  test('Quotation Register under a status filter: the total row is the listed documents, and the stat never repeats it', () => {
    const s = summary(30_000_00, 0, 50_000_00);
    assert.deepEqual(quotationsShown(s, 'all'), { count: 6, value: 80_000_00 });
    assert.deepEqual(quotationsShown(s, 'open'), { count: 3, value: 30_000_00 }, 'Show open: the open documents only');
    assert.deepEqual(quotationsShown(s, 'converted'), { count: 2, value: 50_000_00 });
    // Show open with nothing accepted: "Open ₹30,000" is the total row of the list on screen.
    assert.deepEqual(
      quotationsStat(s, 'open').map((i) => i.label),
      ['Conversion'],
    );
    assert.equal(statRepeatsTotal(statMoneyValues(quotationsStat(s, 'open')), [quotationsShown(s, 'open').value]), false);
    // Show converted: the open value is another figure, so it stays.
    assert.deepEqual(
      quotationsStat(s, 'converted').map((i) => [i.label, i.value]),
      [
        ['Open', 30_000_00],
        ['Conversion', '33.33 %'],
      ],
    );
  });

  const due = (key: string, amount: number | null): RecurringDueRow => ({
    key,
    templateId: 1,
    templateName: 'Rent',
    voucherTypeId: 1,
    voucherTypeName: 'Journal',
    baseType: 'journal',
    partyName: null,
    periodKey: key,
    date: `${key}-05`,
    overdueDays: 0,
    amount,
    overridable: true,
  });

  test('Due Recurring Vouchers: "To post ₹x" = the ticked amounts, changed amounts included', () => {
    const rows = [due('2026-08', 25_000_00), due('2026-09', 25_000_00), due('2026-10', null)];
    const selected = new Set(['2026-08', '2026-10']);
    assert.equal(tickedTotal(rows, selected, { '2026-08': 20_000_00 }), 20_000_00);
    const items = recurringDueStat(rows, selected, { '2026-08': 20_000_00 });
    assert.deepEqual(
      items.map((i) => [i.label, i.value]),
      [['To post', 20_000_00]],
    );
    // The table's footer shows the ticked count only (no amount), so the stat repeats no total.
    assert.equal(statTotalAllowed('documents.recurring.due'), false);
    assert.equal(statRepeatsTotal(statMoneyValues(items), []), false);
    assert.deepEqual(recurringDueStat(rows, new Set(), {}), [], 'nothing ticked: no stat');
  });
});

describe('builders are fast (§4.7)', () => {
  /** Best of three runs (the first warms the JIT): the time of the builder, not of a busy machine. */
  const best = (run: () => void): number => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      run();
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };

  test('10,000 rows in under 50 ms each', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => bill(i % 200, 1_00 + i));
    const lines = Array.from({ length: 10_000 }, (_, i) => line(`L${i}`, 10_000_00, 9_000_00 + (i % 7) * 500_00));
    const a = best(() => billsPendingChart(rows, 'sales'));
    const b = best(() => budgetVarianceChart(lines));
    assert.ok(a < 50, `bills pending ${a} ms`);
    assert.ok(b < 50, `budget variance ${b} ms`);
  });
});
