/**
 * The POS Day-end Summary's graph and stat (SPEC-21 §4.8, WP-L1): graph total = the By tender table's
 * Net total, inline bars for a short table, the minimum-data gate, and a stat that never repeats a
 * total the visible table shows.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PosSummary, PosSummaryTenderRow } from '../../../../shared/types/pos.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { summaryStat, tenderChart, visibleTotals } from './charts.ts';

const tender = (modeId: number, name: string, net: number, kind: PosSummaryTenderRow['kind'] = 'upi'): PosSummaryTenderRow => ({ modeId, name, kind, ledgerName: name, received: net, refunded: 0, net, count: 1 });

const day: PosSummary = {
  from: '2026-10-11',
  to: '2026-10-11',
  bills: 12,
  sales: 59_000_00,
  taxable: 50_000_00,
  tax: 9_000_00,
  returns: 1,
  returnValue: 1_180_00,
  returnTax: 180_00,
  net: 57_820_00,
  creditSales: 5_000_00,
  creditReturns: 0,
  netCash: 30_000_00,
  changeGiven: 450_00,
  exchangeIssued: 0,
  exchangeUsed: 0,
  mrpSavings: 1_200_00,
  byTender: [tender(1, 'Cash', 30_000_00, 'cash'), tender(2, 'UPI', 15_000_00), tender(3, 'Card', 7_820_00, 'card')],
  byUser: [],
  byCounter: [],
};

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('Takings by tender (pos.summary)', () => {
  test('graph total = the Net total of the By tender table; one colour', () => {
    const spec = tenderChart(day);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, sum(day.byTender.map((t) => t.net)));
    assert.equal(drawnTotal(spec), spec.total);
    assert.deepEqual(
      spec.categories.map((_, i) => markColor(spec, i)),
      [1, 1, 1],
    );
    assert.equal(spec.takeaway, 'Cash holds 57 % of the takings');
  });

  test('a short table carries the bars inline; a long one gets Top 6 + Other, Σ preserved', () => {
    const spec = tenderChart(day);
    assert.equal(inlineBars(spec, day.byTender.length), true);
    const many = { byTender: Array.from({ length: 9 }, (_, i) => tender(i + 1, `Mode ${i + 1}`, (i + 1) * 1_000_00)) };
    const folded = tenderChart(many);
    assert.ok(folded);
    assert.equal(folded.categories.length, 7);
    assert.equal(folded.total, sum(many.byTender.map((t) => t.net)));
    assert.equal(inlineBars(folded, many.byTender.length), false);
  });

  test('a real tender called "Other" keeps its inline bar', () => {
    const spec = tenderChart({ byTender: [tender(1, 'Cash', 3_00, 'cash'), tender(2, 'UPI', 2_00), tender(3, 'Other', 1_00)] });
    assert.ok(spec);
    assert.equal(inlineBars(spec, 3), true);
  });

  test('Enter on a bar opens that tender’s bills, as Enter on its row does', () => {
    const opened: number[] = [];
    const spec = tenderChart(day, (id) => opened.push(id));
    assert.ok(spec?.activate);
    spec.activate(spec.categories.indexOf('UPI'));
    assert.deepEqual(opened, [2]);
  });

  test('fewer than 2 tenders with takings: no graph; two draw (2.1.1 D2)', () => {
    assert.equal(tenderChart({ byTender: day.byTender.slice(0, 1) }), null, 'one tender: no graph');
    assert.ok(tenderChart({ byTender: day.byTender.slice(0, 2) }), 'two tenders: a graph');
    assert.equal(tenderChart({ byTender: [] }), null);
  });
});

describe('Day-end stat (D24)', () => {
  test('By tender: "Cash in drawer · Net sales · On credit · GST" with the float; the details in the tooltip', () => {
    // The By tender table's totals are what was paid (52,820): net sales (57,820) is not on screen.
    const items = summaryStat(day, 2_000_00, visibleTotals(day, 'tender'));
    assert.deepEqual(
      items.map((i) => [i.label, i.value]),
      [
        ['Cash in drawer', 32_000_00],
        ['Net sales', 57_820_00],
        ['On credit', 5_000_00],
        ['GST', 8_820_00],
      ],
    );
    assert.equal(statRepeatsTotal(items.map((i) => i.value), visibleTotals(day, 'tender')), false);
  });

  test('By cashier / by counter: net sales is the table total, so the stat leaves it out', () => {
    const items = summaryStat(day, 2_000_00, [57_820_00]);
    assert.deepEqual(
      items.map((i) => [i.label, i.value]),
      [
        ['Cash in drawer', 32_000_00],
        ['On credit', 5_000_00],
        ['GST', 8_820_00],
      ],
    );
    assert.match(items[0].title ?? '', /12 bills · 1 return · change given ₹450\.00 · customers saved ₹1,200\.00 on MRP/);
    assert.equal(statTotalAllowed('pos.summary'), false);
    assert.equal(statRepeatsTotal(items.map((i) => i.value), [57_820_00]), false);
  });

  test('a figure that is a visible table total is left out; zero credit is left out', () => {
    // Only cash taken and no float: the drawer is the By tender table's Net total.
    const cashOnly = { ...day, creditSales: 0, netCash: 10_000_00, net: 10_000_00 };
    const items = summaryStat(cashOnly, 0, [10_000_00]);
    assert.deepEqual(
      items.map((i) => i.label),
      ['GST'],
    );
    assert.equal(statRepeatsTotal(items.map((i) => i.value), [10_000_00]), false);
  });

  test('the visible totals are the footer of the view on screen', () => {
    assert.deepEqual(visibleTotals(day, 'tender'), [52_820_00, 0, 52_820_00]);
    assert.deepEqual(visibleTotals(day, 'user'), [59_000_00, 1_180_00, 57_820_00]);
    assert.deepEqual(visibleTotals(day, 'counter'), [59_000_00, 1_180_00, 57_820_00]);
    assert.deepEqual(visibleTotals(day, 'bills', { sums: { billValue: 57_820_00, paid: 52_820_00, credit: 5_000_00 } }), [57_820_00, 5_000_00]);
    // On the bills view the credit total is the table's On account total: the stat drops "On credit".
    const items = summaryStat(day, 0, visibleTotals(day, 'bills', { sums: { billValue: 57_820_00, paid: 52_820_00, credit: 5_000_00 } }));
    assert.deepEqual(
      items.map((i) => i.label),
      ['Cash in drawer', 'GST'],
    );
  });

  test('cash in drawer stays even at zero (the answer of the day)', () => {
    const items = summaryStat({ ...day, net: 0, netCash: 0, creditSales: 0, tax: 0, returnTax: 0 }, 0, [7_820_00]);
    assert.deepEqual(
      items.map((i) => [i.label, i.value]),
      [['Cash in drawer', 0]],
    );
  });
});
