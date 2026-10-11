/**
 * The banking graphs and stat lines (SPEC-21 §5, §4.8): graph total = table total for every builder,
 * the null gates, the takeaways, and "a stat never repeats a visible total" (D24).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BankSummaryRow, ChequeRegisterResult, ChequeRegisterRow, PdcRow } from '../../../../shared/types/banking.ts';
import { assertSpec, inlineBars, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { bankBalancesChart, bankBars, bankSummaryStat, bankSummaryTotals, bankTakeaway, brsStat, chequeRegisterStat, pdcBucket, PDC_BUCKETS, pdcChart, pdcIn, pdcOut, pdcTableTotals, pdcTakeaway } from './charts.ts';

let nextId = 1;
function bank(name: string, balance: number, extra: Partial<BankSummaryRow> = {}): BankSummaryRow {
  return {
    id: nextId++,
    name,
    isOd: false,
    accountNo: null,
    bankName: null,
    ifsc: null,
    branch: null,
    balanceAsPerBooks: balance,
    balanceAsPerBank: balance,
    unreconciled: { count: 0, depositsCount: 0, deposits: 0, issuedCount: 0, issued: 0 },
    lastReconciledDate: null,
    lastStatement: null,
    statementLines: { unmatched: 0, matched: 0, ignored: 0, created: 0 },
    ...extra,
  };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('Bank Overview — bar per account (polarity)', () => {
  test('no graph with fewer than 3 accounts (§5: the seeded shop has one bank) or fewer than 3 non-zero balances', () => {
    assert.equal(bankBalancesChart([]), null);
    assert.equal(bankBalancesChart([bank('HDFC Bank', 1_00_000_00), bank('SBI', 50_000_00)]), null);
    assert.equal(bankBalancesChart([bank('HDFC Bank', 1_00_000_00), bank('SBI', 0), bank('ICICI', 0)]), null);
  });

  test('graph total = the table total of "As per books"; inline in the table for ≤ 7 accounts', () => {
    const banks = [bank('HDFC Bank', 2_50_000_00), bank('SBI', 75_000_50), bank('Kotak OD', -44_000_00, { isOd: true })];
    const spec = bankBalancesChart(banks);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, bankSummaryTotals(banks)[0]);
    assert.equal(spec.total, sum(banks.map((b) => b.balanceAsPerBooks)));
    assert.equal(spec.color, 'polarity', 'an overdrawn account is left of 0 in slot 2');
    assert.deepEqual(spec.categories, ['HDFC Bank', 'SBI', 'Kotak OD (OD/CC)'], 'table order, OD named');
    assert.equal(inlineBars(spec, banks.length), true, 'categories are the table rows: bars inside the table');
    assert.equal(spec.label, 'tips');
  });

  test('more than 7 accounts: Top 6 + Other strip, Σ preserved, never inline', () => {
    const banks = Array.from({ length: 10 }, (_, i) => bank(`Bank ${i + 1}`, (i + 1) * 10_000_00 * (i === 9 ? -1 : 1)));
    const spec = bankBalancesChart(banks);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[6], 'Other');
    assert.equal(spec.total, bankSummaryTotals(banks)[0]);
    assert.equal(inlineBars(spec, banks.length), false);
    assert.equal(spec.categories[0], 'Bank 10', 'by |balance|: the overdrawn Bank 10 is the largest');
    assert.equal(spec.label, 'tips', 'a strip of 6 + Other is 7 rows: every tip labelled');
  });

  test('eight accounts with one leftover keep every name (no "Other" of one), zero balances dropped from the strip', () => {
    const banks = [...Array.from({ length: 7 }, (_, i) => bank(`B${i}`, (i + 1) * 1_000_00)), bank('Zero', 0)];
    const bars = bankBars(banks);
    assert.equal(bars.length, 7);
    assert.ok(!bars.some((b) => b.label === 'Other' || b.label === 'Zero'));
    assert.equal(sum(bars.map((b) => b.value)), sum(banks.map((b) => b.balanceAsPerBooks)));
  });

  test('Enter on a bar opens that account (Other opens nothing)', () => {
    const banks = Array.from({ length: 9 }, (_, i) => bank(`Bank ${i}`, (9 - i) * 1_000_00));
    const opened: number[] = [];
    const spec = bankBalancesChart(banks, (id) => opened.push(id));
    assert.ok(spec?.activate);
    spec.activate(0);
    spec.activate(spec.categories.length - 1);
    assert.deepEqual(opened, [banks[0].id]);
  });

  test('takeaway names the bank holding most and counts the overdrawn ones', () => {
    assert.equal(bankTakeaway([bank('HDFC Bank', 70_00), bank('SBI', 30_00), bank('CC', -10_00, { isOd: true })]), 'HDFC Bank holds 70 % of the money in banks · 1 overdrawn');
    assert.equal(bankTakeaway([bank('A', -10_00), bank('B', -4_20_000_00), bank('C', -1_00)]), 'All 3 accounts overdrawn; most on B (₹4.20 L)');
    const long = bankTakeaway([bank('X'.repeat(120), 10_00), bank('Y', 10_00), bank('Z', 1_00)]);
    assert.ok(long.length <= 90, long);
    assert.match(long, /holds 48 % of the money in banks$/);
  });

  test('stat: entries not in the bank + statement lines to match (one link); zeros dropped; never a table total', () => {
    const banks = [
      bank('HDFC Bank', 1_00_000_00, { unreconciled: { count: 3, depositsCount: 1, deposits: 12_000_00, issuedCount: 2, issued: 30_000_00 }, statementLines: { unmatched: 4, matched: 1, ignored: 0, created: 0 } }),
      bank('SBI', 5_000_00, { unreconciled: { count: 2, depositsCount: 2, deposits: 1_000_00, issuedCount: 0, issued: 0 } }),
    ];
    const stat = bankSummaryStat(banks);
    assert.deepEqual(
      stat.map((s) => [s.id, s.label, s.value, s.link ?? false]),
      [
        ['open', 'Not in the bank yet', '5 entries', false],
        ['match', 'statement lines to match', '4', true],
      ],
    );
    const money = stat.map((s) => s.value).filter((v): v is number => typeof v === 'number');
    assert.equal(statRepeatsTotal(money, bankSummaryTotals(banks)), false);
    assert.deepEqual(bankSummaryStat([bank('A', 1)]), [], 'nothing waiting: no stat');
  });
});

let pdcId = 1;
function pdc(kind: PdcRow['kind'], amount: number, daysToMaturity: number): PdcRow {
  const id = pdcId++;
  return {
    ledgerEntryId: id,
    voucherId: id,
    date: '2026-10-20',
    voucherType: kind === 'receivable' ? 'Receipt' : 'Payment',
    baseType: kind === 'receivable' ? 'receipt' : 'payment',
    number: String(id),
    particulars: 'Party',
    bankLedgerId: 1,
    bankLedgerName: 'HDFC Bank',
    kind,
    instrumentType: 'cheque',
    instrumentNo: '000123',
    instrumentDate: null,
    drawnOn: null,
    amount,
    daysToMaturity,
    matured: daysToMaturity <= 0,
    bankDate: null,
  };
}

describe('Post-dated cheques — net in / out by week (polarity columns)', () => {
  test('buckets: Due now, Week 1 (days 1–7) … Week 8 (50–56), Later', () => {
    assert.equal(PDC_BUCKETS.length, 10);
    assert.deepEqual([0, -3, 1, 7, 8, 14, 56, 57, 400].map((d) => PDC_BUCKETS[pdcBucket({ daysToMaturity: d, matured: d <= 0 })]), ['Due now', 'Due now', 'Week 1', 'Week 1', 'Week 2', 'Week 2', 'Week 8', 'Later', 'Later']);
  });

  test('graph total = In total − Out total of the table; captions In ↑ / Out ↓', () => {
    const rows = [pdc('receivable', 1_20_000_00, 3), pdc('receivable', 30_000_00, 10), pdc('payable', 40_000_00, 30), pdc('payable', 5_000_00, 3), pdc('receivable', 2_500_25, 90), pdc('payable', 1_00, 0)];
    const spec = pdcChart({ rows });
    assert.ok(spec);
    assertSpec(spec);
    const t = pdcTableTotals(rows);
    assert.equal(spec.total, t.in - t.out);
    assert.deepEqual(spec.axisCaptions, { up: 'In ↑', down: 'Out ↓' });
    assert.equal(spec.series[0].values[1], 1_15_000_00, 'Week 1 nets 1,20,000 in and 5,000 out');
    assert.equal(spec.series[0].values[0], -1_00, 'a matured cheque is "Due now"');
    assert.deepEqual(specProblems(spec), []);
  });

  test('the table cells: a received cheque is In only, an issued one Out only (the columns use these)', () => {
    const r = pdc('receivable', 12_345_00, 4);
    const p = pdc('payable', 6_789_00, 4);
    assert.deepEqual([pdcIn(r), pdcOut(r), pdcIn(p), pdcOut(p)], [12_345_00, 0, 0, 6_789_00]);
    assert.deepEqual(pdcTableTotals([r, p, r]), { in: 24_690_00, out: 6_789_00 });
  });

  test('null with fewer than 3 weeks that have a net (enoughData)', () => {
    assert.equal(pdcChart({ rows: [] }), null);
    assert.equal(pdcChart({ rows: [pdc('receivable', 10_00, 2), pdc('payable', 10_00, 3), pdc('receivable', 5_00, 20)] }), null, 'Week 1 nets to 0');
  });

  test('takeaway: the week most comes in and the week most goes out', () => {
    const v = PDC_BUCKETS.map(() => 0);
    v[2] = 1_20_000_00;
    v[5] = -40_000_00;
    v[9] = 5_000_00;
    assert.equal(pdcTakeaway(v), 'Most coming in: Week 2 (₹1.20 L) · most going out: Week 5 (₹40.0 K)');
    const onlyIn = PDC_BUCKETS.map((_, i) => (i === 3 ? 10_000_00 : 0));
    assert.equal(pdcTakeaway(onlyIn), 'Most coming in: Week 3 (₹10.0 K)');
  });

  test('10,000 cheques build in well under 50 ms (§4.7)', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => pdc(i % 3 ? 'receivable' : 'payable', 1_000_00 + i, (i % 80) - 5));
    const t0 = performance.now();
    const spec = pdcChart({ rows });
    assert.ok(performance.now() - t0 < 50);
    const t = pdcTableTotals(rows);
    assert.equal(spec?.total, t.in - t.out);
  });
});

function chq(direction: 'issued' | 'received', amount: number): ChequeRegisterRow {
  const id = pdcId++;
  return {
    ledgerEntryId: id,
    voucherId: id,
    date: '2026-10-01',
    voucherType: 'Payment',
    baseType: 'payment',
    number: String(id),
    particulars: 'Party',
    bankLedgerId: 1,
    bankLedgerName: 'HDFC Bank',
    direction,
    instrumentType: 'cheque',
    instrumentNo: '1',
    instrumentDate: null,
    drawnOn: null,
    favouring: null,
    amount,
    bankDate: null,
    status: 'uncleared',
    stale: false,
  };
}

describe('Cheque Register — no graph, a stat of two numbers', () => {
  const totals = (issued: number, received: number, stale = 0): ChequeRegisterResult['totals'] => ({
    issued: { count: 3, amount: 9_00_000_00, uncleared: 2, unclearedAmount: issued },
    received: { count: 4, amount: 7_00_000_00, uncleared: 1, unclearedAmount: received },
    stale,
  });

  test('not cleared, issued ₹x · received ₹y · stale N — never the visible table total', () => {
    const rows = [chq('issued', 5_00_000_00), chq('received', 7_00_000_00)];
    const r: ChequeRegisterResult = { rows, totals: totals(1_20_000_00, 30_000_00, 3) };
    const stat = chequeRegisterStat(r);
    assert.deepEqual(
      stat.map((s) => [s.label, s.value, s.tone ?? null]),
      [
        ['Issued, not cleared', 1_20_000_00, null],
        ['Received, not cleared', 30_000_00, null],
        ['Stale', '3 cheques', 'danger'],
      ],
    );
    const money = stat.map((s) => s.value).filter((v): v is number => typeof v === 'number');
    assert.equal(statRepeatsTotal(money, [rows.reduce((a, x) => a + x.amount, 0)]), false);
  });

  test('the Not cleared view of issued cheques: the table total is that figure, so the stat leaves it out', () => {
    const rows = [chq('issued', 80_000_00), chq('issued', 40_000_00)];
    const stat = chequeRegisterStat({ rows, totals: totals(1_20_000_00, 0) });
    assert.deepEqual(stat, []);
  });
});

describe('Bank Reconciliation — no graph, the check as a stat', () => {
  test('Agrees ✓ / the difference (danger while unexplained, warning when explained) / nothing before a statement', () => {
    assert.deepEqual(brsStat({ difference: null, unexplainedDifference: null }, 'no_statement'), []);
    assert.deepEqual(brsStat({ difference: 0, unexplainedDifference: 0 }, 'agrees').map((s) => s.value), ['Agrees ✓']);
    const un = brsStat({ difference: -1_250_00, unexplainedDifference: -1_250_00 }, 'unexplained');
    assert.deepEqual(un.map((s) => [s.label, s.value, s.tone]), [['Difference', 1_250_00, 'danger']]);
    const ex = brsStat({ difference: 590_00, unexplainedDifference: 0 }, 'explained');
    assert.deepEqual(ex.map((s) => [s.label, s.value, s.tone]), [['Difference, explained', 590_00, 'warning']]);
  });
});
