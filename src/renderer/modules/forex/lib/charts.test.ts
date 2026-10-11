/**
 * Multi-currency graphs and stats (SPEC-21 §4.8, §5): every builder's drawn total equals the table's
 * figure, the null gates hold, and the stat stays within the stat-line rule.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ForexCurrency, ForexLedgerRow, ForexLedgerStatement, ForexOutstandingBill, ForexOutstandingResult, ForexRevaluationLine, ForexRevaluationResult } from '../../../../shared/types/forex.ts';
import { assertSpec, drawnTotal, inlineBars, markColor, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { statProblems } from '../../../ui/lib/statLine.ts';
import { ageBucket, currencyFormat, ledgerChart, outstandingChart, outstandingStat, revaluationChart } from './charts.ts';
import { outstandingRows } from './model.ts';

const usd: ForexCurrency = { id: 2, symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2, isBase: false };
const eur: ForexCurrency = { id: 3, symbol: '€', formalName: 'Euro', isoCode: 'EUR', decimalPlaces: 2, isBase: false };
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

// ───────────────────────────── Outstanding ─────────────────────────────

function bill(ledgerId: number, name: string, inr: number, overdueDays: number | null, revalued: number | null): ForexOutstandingBill {
  return {
    billName: name,
    billDate: '2026-04-01',
    dueDate: overdueDays === null ? null : '2026-05-01',
    amount: inr,
    forexAmount: inr / 8_300,
    bookedRate: 83,
    source: 'voucher',
    voucherId: 1,
    ledgerId,
    ledgerName: `Party ${ledgerId}`,
    currencyId: 2,
    overdueDays,
    closingRate: revalued === null ? null : 85,
    revaluedAmount: revalued,
    difference: revalued === null ? null : revalued - inr,
  };
}

function outstanding(bills: ForexOutstandingBill[]): ForexOutstandingResult {
  const byParty = new Map<number, ForexOutstandingBill[]>();
  for (const b of bills) byParty.set(b.ledgerId, [...(byParty.get(b.ledgerId) ?? []), b]);
  const parties = [...byParty].map(([ledgerId, bs]) => ({
    ledgerId,
    ledgerName: `Party ${ledgerId}`,
    currencyId: 2,
    forexBalance: sum(bs.map((b) => b.forexAmount)),
    inrBalance: sum(bs.map((b) => b.amount)),
    revaluedBalance: bs.every((b) => b.revaluedAmount !== null) ? sum(bs.map((b) => b.revaluedAmount ?? 0)) : null,
    difference: bs.every((b) => b.difference !== null) ? sum(bs.map((b) => b.difference ?? 0)) : null,
    bills: bs,
  }));
  const inr = sum(bills.map((b) => b.amount));
  return {
    asOf: '2026-09-30',
    rateType: 'standard',
    currencies: [usd],
    parties,
    totals: [{ currencyId: 2, forex: sum(bills.map((b) => b.forexAmount)), inr, revalued: sum(bills.map((b) => b.revaluedAmount ?? b.amount)), difference: sum(bills.map((b) => b.difference ?? 0)) }],
  };
}

describe('forex.outstanding — bills of one side by age', () => {
  const d = outstanding([
    bill(7, 'A1', 8_30_000_00, null, 8_50_000_00),
    bill(7, 'A2', 4_15_000_00, 12, 4_25_000_00),
    bill(8, 'B1', 2_49_000_00, 45, null),
    bill(8, 'B2', 1_66_000_00, 120, 1_70_000_00),
  ]);

  test('total = Σ of the bill rows at the closing rate (as carried without a rate); Not due grey, then the ramp', () => {
    const spec = outstandingChart(d, 'receivable');
    assert.ok(spec);
    assertSpec(spec);
    const billRows = outstandingRows(d).filter((r) => r.level === 1);
    assert.equal(spec.total, sum(billRows.map((r) => r.revalued ?? r.inr)));
    assert.equal(drawnTotal(spec), spec.total);
    assert.deepEqual(spec.series[0].values, [8_50_000_00, 4_25_000_00, 2_49_000_00, 0, 1_70_000_00]);
    assert.equal(markColor(spec, 0), 'other');
    assert.equal(markColor(spec, 1), 'o2');
    assert.equal(markColor(spec, 4), 'o5');
    assert.equal(spec.title, 'Foreign receivables by age');
    assert.equal(spec.takeaway, 'Of ₹16.94 L in foreign bills to collect, ₹1.70 L is over 90 days');
  });

  test('payables read in absolute rupees; "All" draws nothing', () => {
    const p = outstanding([bill(9, 'P1', -1_000_00, null, -1_020_00), bill(9, 'P2', -2_000_00, 10, -2_050_00), bill(9, 'P3', -3_000_00, 70, -3_060_00)]);
    const spec = outstandingChart(p, 'payable');
    assert.ok(spec);
    assert.equal(spec.total, 6_130_00);
    assert.equal(spec.takeaway, 'Of ₹6.1 K in foreign bills to pay, ₹5.1 K is overdue');
    assert.equal(outstandingChart(d, 'all'), null);
  });

  test('an advance (a bill on the other side) is not drawn — it never inflates the side', () => {
    const withAdvance = outstanding([
      bill(7, 'A1', 8_30_000_00, null, 8_50_000_00),
      bill(7, 'A2', 4_15_000_00, 12, 4_25_000_00),
      bill(7, 'Adv', -1_00_000_00, null, -1_02_000_00),
      bill(8, 'B2', 1_66_000_00, 120, 1_70_000_00),
    ]);
    const spec = outstandingChart(withAdvance, 'receivable');
    assert.ok(spec);
    assertSpec(spec);
    assert.deepEqual(spec.series[0].values, [8_50_000_00, 4_25_000_00, 0, 0, 1_70_000_00]);
    const unpaid = outstandingRows(withAdvance).filter((r) => r.level === 1 && (r.revalued ?? r.inr) > 0);
    assert.equal(spec.total, sum(unpaid.map((r) => r.revalued ?? r.inr)));
    // Payables: a Dr bill (an advance paid to the supplier) is the other side.
    const p = outstanding([bill(9, 'P1', -1_000_00, null, null), bill(9, 'P2', -2_000_00, 10, null), bill(9, 'P3', -3_000_00, 70, null), bill(9, 'Adv', 500_00, null, null)]);
    assert.equal(outstandingChart(p, 'payable')?.total, 6_000_00);
  });

  test('null with fewer than 2 buckets holding bills (2.1.1 D2)', () => {
    assert.equal(outstandingChart(outstanding([bill(7, 'A1', 100_00, null, 100_00), bill(7, 'A2', 50_00, null, 50_00)]), 'receivable'), null, 'one bucket');
    assert.equal(outstandingChart(outstanding([bill(7, 'A1', 100_00, null, 100_00), bill(7, 'A2', 100_00, 5, 100_00)]), 'receivable')?.total, 200_00, 'two buckets: a graph');
  });

  test('buckets', () => {
    assert.deepEqual([null, -3, 0, 1, 30, 31, 60, 61, 90, 91].map(ageBucket), [0, 0, 0, 1, 1, 2, 2, 3, 3, 4]);
  });

  test('stat: one figure per currency, exact rupees, ≤ 3 figures, no table total repeated', () => {
    const stat = outstandingStat(d);
    assert.equal(stat.length, 1);
    assert.equal(stat[0].label, 'USD');
    // In brackets: " · " is the stat line's own separator between items.
    assert.match(String(stat[0].value), /^\$ [\d,]+\.\d\d Dr \(₹[\d,]+ gain\)$/);
    assert.ok(!String(stat[0].value).includes(' · '));
    assert.equal(statRepeatsTotal(stat.flatMap((s) => (typeof s.value === 'number' ? [s.value] : [])), []), false);
    const many: ForexOutstandingResult = {
      ...d,
      currencies: [usd, eur, { ...usd, id: 4, isoCode: 'GBP', symbol: '£' }, { ...usd, id: 5, isoCode: 'AED', symbol: 'AED' }],
      totals: [2, 3, 4, 5].map((id) => ({ currencyId: id, forex: 100, inr: 8_300_00, revalued: null, difference: null })),
    };
    const four = outstandingStat(many);
    assert.equal(four.length, 3);
    assert.deepEqual(statProblems(four), []);
    assert.equal(four[2].value, '2');
  });
});

// ───────────────────────────── Revaluation ─────────────────────────────

function line(ledgerId: number, adjustment: number, billName: string | null = null): ForexRevaluationLine {
  return { ledgerId, ledgerName: `Party ${ledgerId}`, billName, currencyId: 2, forexAmount: 100, bookedAmount: 8_300_00, closingRate: 85, revaluedAmount: 8_300_00 + adjustment, adjustment };
}

function revaluation(lines: ForexRevaluationLine[]): ForexRevaluationResult {
  return { asOf: '2026-09-30', rateType: 'standard', rates: [], missingRates: [], lines, net: sum(lines.map((l) => l.adjustment)), posted: [] };
}

describe('forex.revaluation — unrealised gain / loss by party', () => {
  test('one line per party: inline polarity bars, total = net; loss in slot 2', () => {
    const d = revaluation([line(7, 160_000), line(9, -30_000), line(11, 45_000)]);
    const spec = revaluationChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.net);
    assert.equal(inlineBars(spec, d.lines.length), true);
    assert.equal(markColor(spec, 1), 2);
    assert.equal(markColor(spec, 0), 1);
    assert.equal(spec.takeaway, 'Gain on 2 parties, loss on 1; largest loss Party 9 (₹300)');
  });

  test('bill-wise lines are summed per party: a strip, Σ = net', () => {
    const d = revaluation([line(7, 100_00, '1'), line(7, 50_00, '2'), line(9, -30_00), line(11, 45_00), line(12, -5_00)]);
    const spec = revaluationChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.net);
    assert.deepEqual(spec.categories, ['Party 7', 'Party 11', 'Party 9', 'Party 12']);
    assert.equal(inlineBars(spec, d.lines.length), false);
  });

  test('the takeaway counts parties, never the folded "Other" bar', () => {
    // 9 parties: 8 gains, 1 small loss that folds into "Other" — still named in the takeaway.
    const lines = [...Array.from({ length: 8 }, (_, i) => line(20 + i, (i + 1) * 100_00)), line(40, -5_00)];
    const spec = revaluationChart(revaluation(lines));
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.categories[spec.categories.length - 1], 'Other');
    assert.equal(spec.total, sum(lines.map((l) => l.adjustment)));
    assert.equal(spec.takeaway, 'Gain on 8 parties, loss on 1; largest loss Party 40 (₹5)');
    assert.equal(revaluationChart(revaluation([line(7, 100), line(9, 200), line(11, 300)]))?.takeaway, 'Gain on all 3 parties');
  });

  test('null with fewer than 2 parties to restate (2.1.1 D2)', () => {
    assert.equal(revaluationChart(revaluation([line(7, 100)])), null);
    assert.equal(revaluationChart(revaluation([line(7, 100), line(9, 0)])), null);
    assert.equal(revaluationChart(revaluation([line(7, 100), line(9, -100)]))?.total, 0, 'two parties: a graph (gain and loss net to 0)');
    assert.equal(revaluationChart(revaluation([])), null);
  });
});

// ───────────────────────────── Ledger in the currency ─────────────────────────────

function row(i: number, date: string, forexAmount: number, balance: number): ForexLedgerRow {
  return { voucherId: i, date, voucherType: 'Sales', baseType: 'sales', number: String(i), particulars: 'Sales', narration: null, forexAmount, rate: 83, amount: Math.round(forexAmount * 8_300), forexBalance: balance, inrBalance: Math.round(balance * 8_300) };
}

function statement(rows: ForexLedgerRow[], opening = 500): ForexLedgerStatement {
  const closing = rows.length ? rows[rows.length - 1].forexBalance : opening;
  return {
    ledgerId: 7,
    ledgerName: 'Pacific Retail LLC',
    currency: usd,
    from: '2026-04-01',
    to: '2026-09-30',
    openingForex: opening,
    openingInr: opening * 8_300,
    rows,
    totals: { forexDr: 0, forexCr: 0, inrDr: 0, inrCr: 0 },
    closingForex: closing,
    closingInr: closing * 8_300,
    closingRate: null,
    revaluedInr: null,
    unrealised: null,
  };
}

describe('forex.ledger — balance in the currency', () => {
  test('opening, then one point per day; the last point is the closing balance', () => {
    const d = statement([row(1, '2026-05-02', 800, 1_300), row(2, '2026-05-02', -300, 1_000), row(3, '2026-06-10', 250.5, 1_250.5), row(4, '2026-07-01', -1_250.5, 0)]);
    const spec = ledgerChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.closingForex);
    assert.equal(drawnTotal(spec), d.closingForex);
    assert.deepEqual(spec.series[0].values, [500, 1_000, 1_250.5, 0]);
    assert.deepEqual(spec.categories, ['Opening 1-Apr-26', '2-May-26', '10-Jun-26', '1-Jul-26']);
    assert.equal(spec.title, 'Balance in USD');
    assert.equal(spec.takeaway, '$ 0.00 on 1-Jul-26, down $ 500.00 since 1-Apr-26');
  });

  test('ticks say Cr for a credit balance, never a bare minus', () => {
    const f = currencyFormat(usd);
    assert.ok(typeof f === 'object');
    assert.equal(f.tick(-1_200), '$ 1,200 Cr');
    assert.equal(f.full(-1_200), '$ 1,200.00 Cr');
    assert.equal(f.full(0), '$ 0.00');
  });

  test('no voucher row: no graph; one draws (2.1.1 D2); 5,000 rows decimated to ≤ 480 points ending on the closing', () => {
    assert.equal(ledgerChart(statement([])), null);
    assert.equal(ledgerChart(statement([row(1, '2026-05-02', 1, 501)]))?.total, 501, 'opening + one voucher: two points');
    assert.equal(ledgerChart(statement([row(1, '2026-05-02', 1, 501), row(2, '2026-05-03', 1, 502)]))?.total, 502);
    const rows: ForexLedgerRow[] = [];
    let bal = 500;
    for (let i = 0; i < 5_000; i++) {
      bal += i % 7 === 0 ? -40 : 10;
      const day = new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      rows.push(row(i, day, 10, bal));
    }
    const d = statement(rows);
    // The fastest of three runs (a loaded CI machine stalls single runs, not the builder).
    let best = Infinity;
    let spec = ledgerChart(d);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      spec = ledgerChart(d);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 50, `${best} ms`);
    assert.ok(spec);
    assert.ok(spec.categories.length <= 480);
    assert.equal(spec.total, d.closingForex);
    assertSpec(spec);
  });
});
