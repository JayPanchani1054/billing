/**
 * TDS / TCS graphs and stats (SPEC-21 §4.8, §5): every builder's drawn total equals the table's total,
 * the null gates hold, the takeaways read right, and no stat repeats a visible table total.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  TdsChallanRegister,
  TdsChallanRow,
  TdsComputationResult,
  TdsComputationRow,
  TdsExceptionRow,
  TdsOutstandingResult,
  TdsOutstandingRow,
  TdsReceivableResult,
  TdsReceivableRow,
  TdsReturnData,
} from '../../../../shared/types/tds.ts';
import { assertSpec, drawnTotal, inlineBars, markColor, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { challansChart, computationChart, exceptionsStat, outstandingChart, outstandingStat, receivableChart, receivableStat, returnChart, returnStat } from './charts.ts';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const numbers = (items: ReadonlyArray<{ value: number | string }>) => items.flatMap((i) => (typeof i.value === 'number' ? [i.value] : []));

// ───────────────────────────── Computation ─────────────────────────────

function compRow(i: number, section: string, deducted: number, deposited: number): TdsComputationRow {
  return {
    key: `k${i}`,
    kind: 'tds',
    partyLedgerId: i,
    partyName: `Party ${i}`,
    pan: null,
    panStatus: 'valid',
    deducteeType: 'company',
    natureId: i,
    natureName: `Nature ${section}`,
    section,
    count: 1,
    credited: deducted * 50,
    belowThreshold: 0,
    base: deducted * 50,
    deducted,
    deposited,
    balance: deducted - deposited,
  };
}

function computation(rows: TdsComputationRow[]): TdsComputationResult {
  const t = (k: 'credited' | 'belowThreshold' | 'base' | 'deducted' | 'deposited' | 'balance') => sum(rows.map((r) => r[k]));
  return { rows, totals: { count: rows.length, credited: t('credited'), belowThreshold: t('belowThreshold'), base: t('base'), deducted: t('deducted'), deposited: t('deposited'), balance: t('balance') } };
}

describe('tds.computation — not yet deposited, by section', () => {
  test('one row per section: drawn inline, total = the Balance total, zero rows kept as rows', () => {
    const d = computation([compRow(1, '194C', 50_000_00, 10_000_00), compRow(2, '194J(b)', 30_000_00, 0), compRow(3, '194H', 8_000_00, 2_000_00), compRow(4, '194I', 5_000_00, 5_000_00)]);
    const spec = computationChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.totals.balance);
    assert.equal(drawnTotal(spec), d.totals.balance);
    assert.deepEqual(spec.categories, ['194C', '194J(b)', '194H', '194I']);
    assert.equal(inlineBars(spec, d.rows.length), true);
    assert.equal(spec.takeaway, '194C holds 53 % of what is not yet deposited');
    assert.equal(spec.title, 'Not yet deposited, by section');
  });

  test('several parties per section: a Top 6 + Other strip of the non-zero sections, Σ preserved', () => {
    const rows: TdsComputationRow[] = [];
    const sections = ['194C', '194J(b)', '194H', '194I', '194A', '194Q', '194R', '194T', '195'];
    sections.forEach((s, i) => {
      rows.push(compRow(i * 2, s, (i + 1) * 1_000_00, 0));
      rows.push(compRow(i * 2 + 1, s, (i + 1) * 500_00, (i + 1) * 200_00));
    });
    rows.push(compRow(99, '206C(1)', 1_000_00, 1_000_00)); // fully deposited: no bar
    const d = computation(rows);
    const spec = computationChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.totals.balance);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[6], 'Other');
    assert.ok(!spec.categories.includes('206C(1)'));
    assert.equal(inlineBars(spec, d.rows.length), false);
  });

  test('null when fewer than 3 sections have something left to deposit (or nothing at all)', () => {
    assert.equal(computationChart(computation([])), null);
    assert.equal(computationChart(computation([compRow(1, '194C', 100_00, 0), compRow(2, '194J(b)', 100_00, 0), compRow(3, '194H', 100_00, 100_00)])), null);
  });

  test('10,000 rows in well under 50 ms', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => compRow(i, `19${i % 12}`, 1_000_00 + i, i));
    const d = computation(rows);
    // The fastest of three runs (a loaded CI machine stalls single runs, not the builder).
    let best = Infinity;
    let spec = computationChart(d);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      spec = computationChart(d);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 50, `${best} ms`);
    assert.equal(spec?.total, d.totals.balance);
  });
});

// ───────────────────────────── Outstanding ─────────────────────────────

function outRow(period: string, section: string, deducted: number, deposited: number, status: TdsOutstandingRow['status'], interest = 0, interestPaid = 0): TdsOutstandingRow {
  return {
    key: `${period}:${section}`,
    kind: 'tds',
    section,
    period,
    periodLabel: period,
    payableLedgerName: `TDS Payable - ${section}`,
    deducted,
    deposited,
    balance: deducted - deposited,
    dueDate: `${period}-28`,
    daysOverdue: status === 'overdue' ? 30 : 0,
    status,
    interest,
    interestPaid,
    lastDeposit: null,
    lines: 1,
  };
}

function outstanding(rows: TdsOutstandingRow[]): TdsOutstandingResult {
  const t = (k: 'deducted' | 'deposited' | 'balance' | 'interest' | 'interestPaid') => sum(rows.map((r) => r[k]));
  return { asOf: '2026-10-10', kind: 'tds', rows, statements: [], totals: { deducted: t('deducted'), deposited: t('deposited'), balance: t('balance'), interest: t('interest'), interestPaid: t('interestPaid'), lateFee: 0 } };
}

describe('tds.outstanding — left to deposit, by month', () => {
  const d = outstanding([
    outRow('2026-06', '194C', 12_000_00, 0, 'overdue', 540_00),
    outRow('2026-07', '194C', 8_000_00, 3_000_00, 'overdue', 225_00),
    outRow('2026-07', '194J(b)', 4_000_00, 0, 'overdue', 180_00),
    outRow('2026-09', '194C', 9_000_00, 0, 'due'),
  ]);

  test('total = the Balance total; months zero-filled; overdue months in the problem colour', () => {
    let opened: string | null = null;
    const spec = outstandingChart(d, (m) => (opened = m));
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.totals.balance);
    assert.equal(drawnTotal(spec), d.totals.balance);
    assert.deepEqual(spec.categories, ['Jun', 'Jul', 'Aug', 'Sep']);
    assert.deepEqual(spec.series[0].values, [12_000_00, 9_000_00, 0, 9_000_00]);
    assert.equal(spec.color, 'problem');
    assert.deepEqual(spec.emphasis, [0, 1]);
    assert.equal(markColor(spec, 0), 2);
    assert.equal(markColor(spec, 3), 'other');
    assert.equal(spec.takeaway, 'Overdue in 2 of 3 months with a balance; oldest Jun');
    spec.activate?.(1);
    assert.equal(opened, '2026-07');
  });

  test('nothing overdue: all grey and said in words', () => {
    const spec = outstandingChart(outstanding([outRow('2026-07', '194C', 100_00, 0, 'due'), outRow('2026-08', '194C', 100_00, 0, 'due'), outRow('2026-09', '194C', 100_00, 0, 'due')]));
    assert.ok(spec);
    assert.deepEqual(spec.emphasis, []);
    assert.match(spec.takeaway, /^Nothing overdue/);
  });

  test('more than 13 months fold to quarters (no drill), Σ preserved', () => {
    const rows = Array.from({ length: 18 }, (_, i) => {
      const y = 2025 + Math.floor((3 + i) / 12);
      const m = ((3 + i) % 12) + 1;
      return outRow(`${y}-${String(m).padStart(2, '0')}`, '194C', 1_000_00 + i, 0, i < 3 ? 'overdue' : 'due');
    });
    const x = outstanding(rows);
    const spec = outstandingChart(x, () => undefined);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, x.totals.balance);
    assert.match(spec.categories[0], /^Q1 /);
    assert.equal(spec.activate, undefined);
    assert.deepEqual(spec.emphasis, [0]);
  });

  test('null with fewer than 3 months holding a balance', () => {
    assert.equal(outstandingChart(outstanding([])), null);
    assert.equal(outstandingChart(outstanding([outRow('2026-07', '194C', 100_00, 0, 'due'), outRow('2026-08', '194C', 100_00, 0, 'due')])), null);
  });

  test('stat: interest still to pay, only once some interest was paid (else the Interest total says it)', () => {
    assert.deepEqual(outstandingStat(d), []);
    const paid = outstanding([outRow('2026-06', '194C', 12_000_00, 12_000_00, 'paid_late', 540_00, 300_00), outRow('2026-07', '194C', 8_000_00, 0, 'overdue', 225_00)]);
    const stat = outstandingStat(paid);
    assert.deepEqual(numbers(stat), [465_00]);
    const t = paid.totals;
    assert.equal(statRepeatsTotal(numbers(stat), [t.deducted, t.deposited, t.balance, t.interest, t.interestPaid]), false);
    assert.equal(statTotalAllowed('tds.outstanding'), false);
  });
});

// ───────────────────────────── Challans ─────────────────────────────

function challan(id: number, depositDate: string, total: number, late: boolean): TdsChallanRow {
  return {
    id,
    voucherId: id,
    number: String(id),
    kind: 'tds',
    section: '194C',
    period: depositDate.slice(0, 7),
    periodLabel: depositDate.slice(0, 7),
    bsrCode: '0510308',
    challanNo: String(10_000 + id),
    depositDate,
    minorHead: '200',
    bankName: 'HDFC Bank',
    tax: total,
    surcharge: 0,
    cess: 0,
    interest: 0,
    fee: 0,
    others: 0,
    total,
    cleared: total,
    unconsumed: 0,
    late,
  };
}

describe('tds.challans — deposited, by month', () => {
  test('total = the Total column; the period zero-filled; late months in the problem colour', () => {
    const rows = [challan(1, '2026-05-07', 9_000_00, false), challan(2, '2026-06-12', 8_000_00, true), challan(3, '2026-06-07', 1_000_00, false), challan(4, '2026-08-05', 7_000_00, false)];
    const d: TdsChallanRegister = { rows, totals: { total: sum(rows.map((r) => r.total)) } };
    const spec = challansChart(d, '2026-04-01', '2026-09-30');
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, d.totals.total);
    assert.equal(spec.total, sum(rows.map((r) => r.total)));
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
    assert.deepEqual(spec.emphasis, [2]);
    assert.equal(spec.takeaway, 'Late in 1 of 3 months with a deposit; last late Jun');
  });

  test('a challan dated outside the period still counts (the axis widens)', () => {
    const rows = [challan(1, '2026-03-30', 100_00, false), challan(2, '2026-04-07', 100_00, false), challan(3, '2026-05-07', 100_00, false)];
    const spec = challansChart({ rows, totals: {} }, '2026-04-01', '2026-05-31');
    assert.ok(spec);
    assert.equal(spec.total, 300_00);
    assert.match(spec.takeaway, /on time/);
  });

  test('null with no challans or fewer than 3 months paid', () => {
    assert.equal(challansChart({ rows: [], totals: {} }, '2026-04-01', '2027-03-31'), null);
    assert.equal(challansChart({ rows: [challan(1, '2026-04-07', 100_00, false), challan(2, '2026-05-07', 100_00, true)], totals: {} }, '2026-04-01', '2027-03-31'), null);
  });
});

// ───────────────────────────── 26AS ─────────────────────────────

function rec(i: number, books: number, form26as: number, status?: TdsReceivableRow['status']): TdsReceivableRow {
  const difference = form26as - books;
  return { key: `r${i}`, partyLedgerId: i, partyName: `Customer ${i}`, tan: null, books, form26as, amountPaid: 0, difference, status: status ?? (difference === 0 ? 'matched' : 'mismatch') };
}

function receivable(rows: TdsReceivableRow[]): TdsReceivableResult {
  return {
    fyStart: 2026,
    receivableLedgers: [{ id: 1, name: 'TDS Receivable' }],
    rows,
    totals: { books: sum(rows.map((r) => r.books)), form26as: sum(rows.map((r) => r.form26as)), difference: sum(rows.map((r) => r.difference)) },
    imported: { rows: rows.length, importedAt: null },
  };
}

describe('tds.receivable — difference from 26AS', () => {
  test('short table: inline, matched rows are 0, total = Σ |difference| (= |Difference total| when one-sided)', () => {
    const d = receivable([rec(1, 10_000_00, 7_000_00), rec(2, 5_000_00, 5_000_00), rec(3, 2_000_00, 0, 'books_only'), rec(4, 3_000_00, 2_500_00)]);
    const spec = receivableChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, sum(d.rows.map((r) => Math.abs(r.difference))));
    assert.equal(spec.total, Math.abs(d.totals.difference));
    assert.deepEqual(spec.series[0].values, [3_000_00, 0, 2_000_00, 500_00]);
    assert.equal(inlineBars(spec, d.rows.length), true);
    assert.equal(spec.takeaway, 'Customer 1 holds 55 % of the difference');
    assert.deepEqual(receivableStat(d), []);
  });

  test('long table: a Top 6 + Other strip of the gaps, Σ |difference| preserved across both signs', () => {
    const rows = Array.from({ length: 12 }, (_, i) => rec(i, 1_000_00 * (i + 1), i % 2 ? 0 : 2_000_00 * (i + 1)));
    const d = receivable(rows);
    const spec = receivableChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, sum(rows.map((r) => Math.abs(r.difference))));
    assert.equal(spec.categories.length, 7);
    assert.equal(inlineBars(spec, d.rows.length), false);
  });

  test('all match: no graph, the stat says the check', () => {
    const d = receivable([rec(1, 100_00, 100_00), rec(2, 200_00, 200_00), rec(3, 300_00, 300_00)]);
    assert.equal(receivableChart(d), null);
    const stat = receivableStat(d);
    assert.equal(stat.length, 1);
    // The words are the value: the stat line hides labels below 1200 px, and a bare "✓" says nothing.
    assert.equal(stat[0].value, 'Books agree with 26AS ✓');
    assert.equal(stat[0].label, '');
    assert.equal(statRepeatsTotal(numbers(stat), [d.totals.books, d.totals.form26as, d.totals.difference]), false);
    assert.deepEqual(receivableStat(receivable([])), [], 'nothing to agree about');
  });
});

// ───────────────────────────── Quarterly return ─────────────────────────────

function ret(tax: number, deposited: number): TdsReturnData {
  return {
    form: '26Q',
    fyStart: 2026,
    quarter: 1,
    from: '2026-04-01',
    to: '2026-06-30',
    tan: 'MUMA12345B',
    deductees: [],
    challans: [],
    totals: { amountPaid: tax * 50, tax, deposited, challanTotal: deposited },
    dueDate: '2026-07-31',
    filedOn: null,
    tokenNo: null,
    lateFee: 0,
    daysLate: 0,
    warnings: [],
  };
}

describe('tds.return — deposited against the tax', () => {
  test('meter: the whole is the Tax total; takeaway in compact rupees', () => {
    const d = ret(1_20_000_00, 90_000_00);
    const spec = returnChart(d);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.kind, 'meter');
    assert.equal(spec.total, d.totals.tax);
    assert.equal(drawnTotal(spec), d.totals.tax);
    assert.equal(spec.takeaway, 'Deposited ₹90.0 K of tax ₹1.20 L');
  });

  test('both parts must be above 0', () => {
    assert.equal(returnChart(ret(1_000_00, 0)), null);
    assert.equal(returnChart(ret(0, 0)), null);
  });

  test('stat: the part not covered, never a visible total; words when nothing is deposited', () => {
    const d = ret(1_20_000_00, 90_000_00);
    const stat = returnStat(d);
    assert.deepEqual(numbers(stat), [30_000_00]);
    assert.equal(statRepeatsTotal(numbers(stat), [d.totals.amountPaid, d.totals.tax, d.totals.deposited]), false);
    const none = returnStat(ret(1_000_00, 0));
    assert.deepEqual(numbers(none), [], 'the Tax total is not repeated as a number');
    assert.equal(none[0].value, 'No challan yet');
    assert.equal(none[0].label, '');
    assert.deepEqual(returnStat(ret(1_000_00, 1_000_00)), []);
    assert.equal(statTotalAllowed('tds.return'), false);
  });
});

// ───────────────────────────── Exceptions ─────────────────────────────

describe('tds.exceptions — no graph; the stat is the one total', () => {
  const ex = (i: number, shortfall: number, interest: number): TdsExceptionRow => ({
    key: `e${i}`,
    type: shortfall > 0 ? 'short_deducted' : 'no_pan',
    severity: shortfall > 0 ? 'error' : 'warning',
    voucherId: i,
    number: String(i),
    typeName: 'Purchase',
    date: '2026-06-01',
    partyLedgerId: i,
    partyName: `Party ${i}`,
    section: '194C',
    amount: 100_000_00,
    shortfall,
    interest,
    message: 'x',
  });

  test('shortfall and its interest; zeros dropped', () => {
    assert.deepEqual(exceptionsStat([ex(1, 1_000_00, 15_00), ex(2, 500_00, 0), ex(3, 0, 0)]).map((s) => [s.label, s.value]), [
      ['Shortfall', 1_500_00],
      ['Interest', 15_00],
    ]);
    assert.deepEqual(exceptionsStat([ex(3, 0, 0)]), []);
    assert.equal(statTotalAllowed('tds.exceptions'), false);
  });
});
