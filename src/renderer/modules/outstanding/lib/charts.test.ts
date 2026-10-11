import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgeingBucket, AgeingResult, LedgerBillsResult, PartyOutstandingRow, PartySummaryResult, StatementLine, StatementResult } from '../../../../shared/types/outstanding.ts';
import { STAT_TOTAL_ALLOWED, statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { assertSpec, drawnTotal, enoughData, inlineBars, markColor, specProblems, statRepeatsTotal } from '../../../ui/lib/chartSpec.ts';
import {
  OPENING_LABEL,
  ageingChart,
  ageingColumns,
  daysText,
  isLate,
  oldThreshold,
  overCreditLimit,
  partiesChart,
  partiesTableTotals,
  partyChart,
  receivablesStat,
  sideBalance,
  statementChart,
  statementPoints,
} from './charts.ts';
import { ageingExport, ledgerSign, partiesInView } from './model.ts';

type Totals = PartySummaryResult['totals'];
const totals = (over: Partial<Totals>): Totals => ({ pending: 0, billsPending: 0, overdue: 0, notDue: 0, advance: 0, onAccount: 0, partyCount: 0, overLimitCount: 0, ...over });
const summary = (side: PartySummaryResult['side'], t: Partial<Totals>): PartySummaryResult => ({ side, asOf: '2026-10-10', rows: [], totals: totals(t) });

/** The seeded shop of the 2.0 snapshot (snaps20/13): bills 4,65,953 overdue + 8,449 not due, advances/on account −3,71,000. */
const seeded = (): PartySummaryResult => {
  const overdue = 4_65_953_00;
  const notDue = 8_449_00;
  const advance = -2_00_000_00;
  const onAccount = -1_71_000_00;
  return summary('receivable', { overdue, notDue, billsPending: overdue + notDue, advance, onAccount, pending: overdue + notDue + advance + onAccount, partyCount: 4 });
};

describe('receivablesStat (D25): the answer in the owner’s words', () => {
  it('"To collect" = totals.pending, "Overdue" = totals.overdue, "not matched" = advances + on account', () => {
    const r = seeded();
    const s = receivablesStat(r);
    const by = (id: string) => s.find((x) => x.id === id);
    assert.deepEqual(
      s.map((x) => [x.id, x.label]),
      [
        ['net', 'To collect'],
        ['overdue', 'Overdue'],
        ['unmatched', 'not matched to bills'],
      ],
    );
    assert.equal(by('net')?.amount, r.totals.pending);
    assert.equal(by('net')?.value, 1_03_402_00);
    assert.equal(by('overdue')?.amount, r.totals.overdue);
    assert.equal(by('overdue')?.value, 4_65_953_00);
    assert.equal(by('unmatched')?.amount, r.totals.advance + r.totals.onAccount);
    // Shown without a sign — "not matched to bills" carries the meaning.
    assert.equal(by('unmatched')?.value, 3_71_000_00);
    assert.equal(s.filter((x) => x.link).length, 1, 'one link: the not-matched amount');
    // The parts add up: what is to collect = the bills less what is not matched to them.
    assert.equal(by('net')!.amount, r.totals.billsPending + by('unmatched')!.amount);
  });

  it('advances only, on account only, and both', () => {
    const adv = receivablesStat(summary('receivable', { pending: 70_000_00, billsPending: 1_00_000_00, overdue: 1_00_000_00, advance: -30_000_00 }));
    assert.equal(adv.find((x) => x.id === 'unmatched')?.amount, -30_000_00);
    assert.equal(adv.find((x) => x.id === 'net')?.amount, 70_000_00);
    // A debit on account (an opening balance not split into bills) is also money not matched to bills.
    const oa = receivablesStat(summary('receivable', { pending: 1_25_000_00, billsPending: 1_00_000_00, notDue: 1_00_000_00, onAccount: 25_000_00 }));
    assert.deepEqual(
      oa.map((x) => [x.id, x.value, x.amount]),
      [
        ['net', 1_25_000_00, 1_25_000_00],
        ['unmatched', 25_000_00, 25_000_00],
      ],
    );
    const both = receivablesStat(summary('receivable', { pending: 50_000_00, billsPending: 1_00_000_00, overdue: 40_000_00, notDue: 60_000_00, advance: -80_000_00, onAccount: 30_000_00 }));
    assert.equal(both.find((x) => x.id === 'unmatched')?.amount, -50_000_00);
    assert.equal(both.find((x) => x.id === 'unmatched')?.value, 50_000_00);
  });

  it('drops zero items (an advance and an equal on-account debit cancel out)', () => {
    assert.deepEqual(receivablesStat(summary('receivable', {})), []);
    const s = receivablesStat(summary('receivable', { pending: 40_000_00, billsPending: 40_000_00, notDue: 40_000_00, advance: -5_000_00, onAccount: 5_000_00 }));
    assert.deepEqual(
      s.map((x) => x.id),
      ['net'],
    );
  });

  it('payables say "To pay"; more advance than bills says so in words, never with a minus', () => {
    assert.equal(receivablesStat(summary('payable', { pending: 2_15_880_00, overdue: 2_36_880_00, billsPending: 2_36_880_00, onAccount: -21_000_00 }))[0].label, 'To pay');
    const rec = receivablesStat(summary('receivable', { pending: -10_000_00, billsPending: 20_000_00, notDue: 20_000_00, advance: -30_000_00 }));
    assert.deepEqual([rec[0].label, rec[0].value, rec[0].amount], ['Received in advance', 10_000_00, -10_000_00]);
    const pay = receivablesStat(summary('payable', { pending: -10_000_00, advance: -10_000_00 }));
    assert.equal(pay[0].label, 'Paid in advance');
    for (const s of [rec, pay]) assert.ok(s.every((x) => x.value >= 0 || x.id === 'overdue'));
  });

  it('repeats a visible total only because the screens are allow-listed ("To collect" is the Net total)', () => {
    for (const side of ['receivable', 'payable'] as const) {
      const r = { ...seeded(), side };
      const repeats = statRepeatsTotal(
        receivablesStat(r).map((x) => x.amount),
        partiesTableTotals(r),
      );
      assert.equal(repeats, true);
      const id = side === 'receivable' ? 'outstanding.receivables' : 'outstanding.payables';
      assert.equal(statTotalAllowed(id), true, id);
      assert.ok(STAT_TOTAL_ALLOWED[id].length > 10);
    }
  });

  it('a 10,000-party result builds in under 50 ms (it reads the totals only)', () => {
    const r = seeded();
    r.rows = Array.from({ length: 10_000 }, (_, i): PartySummaryResult['rows'][number] => ({
      ledgerId: i + 1,
      ledgerName: `Party ${i + 1}`,
      groupId: 9,
      groupName: 'Sundry Debtors',
      billWise: true,
      pending: 1_00_00,
      billsPending: 1_00_00,
      overdue: 1_00_00,
      notDue: 0,
      advance: 0,
      onAccount: 0,
      billCount: 1,
      overdueBillCount: 1,
      oldestDueDays: 40,
      creditLimit: null,
      creditDays: null,
      utilisationPercent: null,
      overLimit: false,
      mobile: null,
      email: null,
    }));
    const t0 = performance.now();
    receivablesStat(r);
    assert.ok(performance.now() - t0 < 50);
  });
});

describe('days', () => {
  it('reads "190 d"; danger only beyond the last ageing period', () => {
    assert.deepEqual([0, -3, 1, 190].map(daysText), ['', '', '1 d', '190 d']);
    assert.equal(isLate(180, [30, 60, 90, 180]), false);
    assert.equal(isLate(181, [30, 60, 90, 180]), true);
    assert.equal(isLate(46, [15, 45]), true);
    assert.equal(isLate(500, []), false);
  });
});

// ───────────────────────────── Ageing ─────────────────────────────

const buckets = (limits: number[]): AgeingBucket[] => {
  const out: AgeingBucket[] = [{ index: 0, label: 'Not due', minDays: null, maxDays: 0 }];
  let min = 1;
  limits.forEach((max, i) => {
    out.push({ index: i + 1, label: `${min}–${max} days`, minDays: min, maxDays: max });
    min = max + 1;
  });
  out.push({ index: limits.length + 1, label: `> ${limits[limits.length - 1]} days`, minDays: min, maxDays: null });
  return out;
};

const ageing = (limits: number[], amounts: number[], advance = 0, onAccount = 0, side: AgeingResult['side'] = 'receivable'): AgeingResult => {
  const bills = amounts.reduce((s, a) => s + a, 0);
  return {
    side,
    asOf: '2026-10-10',
    basis: 'due_date',
    buckets: buckets(limits),
    rows: [{ ledgerId: 1, ledgerName: 'Asha Retail', groupId: 9, groupName: 'Sundry Debtors', billWise: true, amounts, advance, onAccount, total: bills + advance + onAccount }],
    totals: { amounts, advance, onAccount, total: bills + advance + onAccount },
  };
};

describe('ageingChart: unpaid bills by age (the Ageing view, Ctrl+3)', () => {
  // Default periods: Not due · 1–30 · 31–60 · 61–90 · 91–180 · > 180.
  const r = ageing([30, 60, 90, 180], [8_449_00, 50_000_00, 1_00_000_00, 1_24_953_00, 1_11_000_00, 80_000_00], -2_00_000_00, -1_71_000_00);

  it('its total equals the Ageing table’s age-range columns (and the Total column less advances and on account)', () => {
    const spec = ageingChart(r)!;
    assertSpec(spec);
    assert.equal(spec.total, drawnTotal(spec));
    assert.equal(spec.total, r.totals.amounts.reduce((s, a) => s + a, 0));
    assert.equal(spec.total + r.totals.advance + r.totals.onAccount, r.totals.total);
    // The export (the table as printed) carries the same bucket totals, ledger-signed.
    const exp = ageingExport(r);
    const bucketCells = (exp.totals ?? []).slice(1, 1 + r.buckets.length) as number[];
    assert.equal(bucketCells.reduce((s, c) => s + c, 0) * ledgerSign(r.side), spec.total);
  });

  it('is ordinal: Not due grey, the age ranges on the ramp; the takeaway names its base', () => {
    const spec = ageingChart(r)!;
    assert.equal(spec.kind, 'column');
    assert.equal(spec.color, 'ordinal');
    assert.equal(spec.greyBefore, 1);
    assert.equal(spec.label, 'max');
    assert.deepEqual(spec.categories, ['Not due', '1–30 days', '31–60 days', '61–90 days', '91–180 days', '> 180 days']);
    assert.equal(spec.title, 'Receivables by age');
    // Over 90 days: 1,11,000 + 80,000 = 1,91,000 of 4,74,402.
    assert.equal(spec.takeaway, 'Of ₹4.74 L in unpaid bills, ₹1.91 L is over 90 days');
    assert.ok(spec.takeaway.length <= 90);
    assert.equal(ageingChart({ ...r, side: 'payable' })!.title, 'Payables by age');
  });

  it('Enter on a column hands over the first overdue day of that range (null for Not due)', () => {
    const seen: Array<number | null> = [];
    const spec = ageingChart(r, (d) => seen.push(d))!;
    for (let i = 0; i < spec.categories.length; i++) spec.activate?.(i);
    assert.deepEqual(seen, [null, 1, 31, 61, 91, 181]);
    assert.equal(ageingChart(r)!.activate, undefined, 'not interactive without a handler');
  });

  it('folds the oldest ranges beyond five into one, Σ preserved', () => {
    const many = ageing([15, 30, 45, 60, 90, 120], [1, 2, 3, 4, 5, 6, 7, 8].map((n) => n * 1_000_00));
    const cols = ageingColumns(many.buckets, many.totals.amounts);
    assert.deepEqual(
      cols.map((c) => [c.label, c.amount, c.minDays]),
      [
        ['Not due', 1_000_00, null],
        ['1–15 days', 2_000_00, 1],
        ['16–30 days', 3_000_00, 16],
        ['31–45 days', 4_000_00, 31],
        ['46–60 days', 5_000_00, 46],
        ['> 60 days', 6_000_00 + 7_000_00 + 8_000_00, 61],
      ],
    );
    const spec = ageingChart(many)!;
    assertSpec(spec);
    assert.equal(spec.total, many.totals.amounts.reduce((s, a) => s + a, 0));
    // Five ranges or fewer are left alone.
    assert.equal(ageingColumns(r.buckets, r.totals.amounts).length, 6);
  });

  it('picks the "old" threshold: the largest limit up to 90 days, else the first', () => {
    assert.equal(oldThreshold(buckets([30, 60, 90, 180])), 90);
    assert.equal(oldThreshold(buckets([15, 45])), 45);
    assert.equal(oldThreshold(buckets([120, 365])), 120);
    const none = ageingChart(ageing([30, 60, 90, 180], [10_000_00, 20_000_00, 30_000_00, 0, 0, 0]))!;
    assert.equal(none.takeaway, 'Of ₹60.0 K in unpaid bills, none is over 90 days');
  });

  it('no graph below two non-zero columns (2.1.1 D2), or when nothing is unpaid', () => {
    assert.equal(ageingChart(ageing([30, 60, 90, 180], [10_000_00, 0, 0, 0, 0, 0])), null, 'all not due: one column, no graph');
    assert.equal(ageingChart(ageing([30, 60, 90, 180], [10_000_00, 0, 0, 0, 0, 5_000_00]))?.total, 15_000_00, 'two columns: a graph');
    assert.equal(ageingChart(ageing([30, 60, 90, 180], [0, 0, 0, 0, 0, 0], -5_000_00)), null);
    assert.equal(ageingChart(ageing([30, 60, 90, 180], [-10_000_00, -1_00, -2_00, 0, 0, 0])), null);
    const ok = ageingChart(ageing([30, 60, 90, 180], [1_00, 2_00, 3_00, 0, 0, 0]))!;
    assert.equal(enoughData(ok), true);
  });

  it('a 10,000-party result builds in under 50 ms', () => {
    const big = ageing([30, 60, 90, 180], [1, 2, 3, 4, 5, 6].map((n) => n * 1_00_000_00));
    big.rows = Array.from({ length: 10_000 }, (_, i) => ({ ...big.rows[0], ledgerId: i + 1 }));
    const t0 = performance.now();
    ageingChart(big);
    assert.ok(performance.now() - t0 < 50);
  });
});

// ───────────────────────────── Party ─────────────────────────────

type Ledger = LedgerBillsResult['ledger'];
const party = (over: Partial<Ledger>, balance: number): Pick<LedgerBillsResult, 'ledger' | 'balance'> => ({
  ledger: { id: 7, name: 'Asha Retail', groupId: 9, groupName: 'Sundry Debtors', billWise: true, side: 'receivable', creditDays: 30, creditLimit: 1_00_000_00, interestRate: null, ...over },
  balance,
});

describe('partyChart: balance against the credit limit (a meter)', () => {
  it('fills with the balance the footer shows; the whole is the limit', () => {
    const d = party({}, 54_356_00);
    const spec = partyChart(d)!;
    assertSpec(spec);
    assert.equal(spec.kind, 'meter');
    assert.equal(spec.series[0].values[0], d.balance);
    assert.equal(spec.total, 1_00_000_00);
    assert.equal(spec.takeaway, '54 % of the ₹1.00 L credit limit is used');
    assert.equal(overCreditLimit(d), false);
  });

  it('a supplier’s Cr balance is its own side', () => {
    const d = party({ side: 'payable', groupName: 'Sundry Creditors', creditLimit: 2_00_000_00 }, -2_17_800_00);
    assert.equal(sideBalance(d), 2_17_800_00);
    const spec = partyChart(d)!;
    assert.equal(spec.series[0].values[0], 2_17_800_00);
    assert.equal(spec.takeaway, '₹17.8 K over the ₹2.00 L credit limit');
    assert.equal(overCreditLimit(d), true);
  });

  it('none without a limit, without a balance on the party’s side, or without a side', () => {
    assert.equal(partyChart(party({ creditLimit: null }, 54_356_00)), null);
    assert.equal(partyChart(party({ creditLimit: 0 }, 54_356_00)), null);
    assert.equal(partyChart(party({}, -48_975_00)), null, 'an advance (Cr) on a customer');
    assert.equal(partyChart(party({}, 0)), null);
    assert.equal(partyChart(party({ side: null }, 0)), null);
    assert.equal(overCreditLimit(party({ creditLimit: null }, 9_99_999_00)), false);
  });
});

// ───────────────────────────── Statement ─────────────────────────────

const line = (date: string, debit: number, credit: number, balance: number, id: number): StatementLine => ({
  date,
  voucherId: id,
  voucherType: debit ? 'Sales' : 'Receipt',
  baseType: debit ? 'sales' : 'receipt',
  voucherNumber: String(id),
  referenceNo: null,
  particulars: debit ? 'Sales' : 'Cash',
  narration: null,
  debit,
  credit,
  balance,
});

const statement = (opening: number, moves: Array<[string, number, number]>): Pick<StatementResult, 'from' | 'to' | 'openingBalance' | 'closingBalance' | 'transactions'> => {
  let bal = opening;
  const transactions = moves.map(([date, dr, cr], i) => {
    bal += dr - cr;
    return line(date, dr, cr, bal, i + 1);
  });
  return { from: '2026-04-01', to: '2026-10-10', openingBalance: opening, closingBalance: bal, transactions };
};

describe('statementChart: the running balance (screen only)', () => {
  it('ends on the closing balance the table shows; one point per day after the opening', () => {
    const s = statement(10_000_00, [
      ['2026-04-05', 50_000_00, 0],
      ['2026-04-05', 0, 20_000_00],
      ['2026-05-10', 30_000_00, 0],
      ['2026-06-01', 0, 15_000_00],
    ]);
    const spec = statementChart(s)!;
    assertSpec(spec);
    assert.equal(spec.kind, 'line');
    assert.equal(spec.total, s.closingBalance);
    assert.deepEqual(spec.categories, [OPENING_LABEL, '5-Apr-26', '10-May-26', '1-Jun-26']);
    assert.deepEqual(spec.series[0].values, [10_000_00, 40_000_00, 70_000_00, 55_000_00]);
    assert.equal(spec.takeaway, '₹55.0 K Dr on 10-Oct-26, up ₹45.0 K since 1-Apr-26');
    assert.equal(spec.label, 'last');
  });

  it('a supplier is drawn on its Cr side (rising while more is owed), in Dr/Cr words', () => {
    const s = statement(-10_000_00, [
      ['2026-04-02', 0, 90_000_00],
      ['2026-04-20', 40_000_00, 0],
      ['2026-05-02', 0, 10_000_00],
    ]);
    const spec = statementChart(s)!;
    assertSpec(spec);
    assert.equal(spec.total, -s.closingBalance);
    assert.equal(Math.abs(spec.total), Math.abs(s.closingBalance));
    assert.deepEqual(spec.series[0].values, [10_000_00, 1_00_000_00, 60_000_00, 70_000_00]);
    const f = spec.valueFormat;
    assert.ok(f && typeof f === 'object');
    assert.equal(f.full(70_000_00), '70,000.00 Cr');
    assert.equal(f.tick(70_000_00), '₹70.0 K Cr');
    assert.equal(f.tick(-5_000_00), '₹5.0 K Dr');
    assert.match(spec.takeaway, /^₹70\.0 K Cr on 10-Oct-26, up ₹60\.0 K since 1-Apr-26$/);
  });

  it('keeps the opening as its own point when the first entry is on the first day', () => {
    const pts = statementPoints({ from: '2026-04-01', openingBalance: 5_00, transactions: [line('2026-04-01', 1_00, 0, 6_00, 1), line('2026-04-01', 1_00, 0, 7_00, 2)] });
    assert.deepEqual(
      pts.map((p) => [p.date, p.balance, !!p.opening]),
      [
        ['2026-04-01', 5_00, true],
        ['2026-04-01', 7_00, false],
      ],
    );
  });

  it('none below two points (2.1.1 D2)', () => {
    assert.equal(statementChart(statement(10_000_00, [])), null);
    assert.equal(statementChart(statement(10_000_00, [['2026-04-05', 1_00, 0]]))?.categories.length, 2, 'opening + one entry: a line');
    assert.ok(statementChart(statement(0, [['2026-04-05', 1_00, 0], ['2026-04-06', 1_00, 0]])));
  });

  it('thins a long statement to 480 points, first and last kept (the closing stays the total)', () => {
    const moves: Array<[string, number, number]> = [];
    const d0 = Date.UTC(2020, 0, 1);
    for (let i = 0; i < 10_000; i++) {
      const date = new Date(d0 + i * 86_400_000).toISOString().slice(0, 10);
      moves.push([date, (i % 7) * 1_000_00, (i % 5) * 1_300_00]);
    }
    const s = { ...statement(0, moves), from: '2019-12-31' };
    const t0 = performance.now();
    const spec = statementChart(s)!;
    assert.ok(performance.now() - t0 < 50, 'builds in < 50 ms');
    assert.ok(spec.categories.length <= 480);
    assert.equal(spec.categories[0], OPENING_LABEL);
    assertSpec(spec);
    assert.equal(spec.total, s.closingBalance * (s.closingBalance < 0 ? -1 : 1));
  });
});

// ───────────────────────────── 2.1.2: the Parties view ─────────────────────────────

/** A party row with the fields the view shows (side-signed: + = owes / is owed; − = in advance). */
function partyRow(ledgerId: number, ledgerName: string, pending: number, o: Partial<PartyOutstandingRow> = {}): PartyOutstandingRow {
  const billsPending = Math.max(0, pending);
  return {
    ledgerId,
    ledgerName,
    groupId: 1,
    groupName: 'Sundry Debtors',
    billWise: true,
    pending,
    billsPending,
    overdue: billsPending,
    notDue: 0,
    advance: pending < 0 ? pending : 0,
    onAccount: 0,
    billCount: 1,
    overdueBillCount: 1,
    oldestDueDays: 10,
    creditLimit: null,
    creditDays: null,
    utilisationPercent: null,
    overLimit: false,
    mobile: null,
    email: null,
    ...o,
  };
}

/** The view as the screen holds it: rows and the totals the route sums over them. */
function partiesOf(side: PartySummaryResult['side'], rows: PartyOutstandingRow[]): PartySummaryResult {
  const sum = (f: (p: PartyOutstandingRow) => number) => rows.reduce((a, p) => a + f(p), 0);
  return {
    side,
    asOf: '2026-10-11',
    rows,
    totals: { pending: sum((p) => p.pending), billsPending: sum((p) => p.billsPending), overdue: sum((p) => p.overdue), notDue: sum((p) => p.notDue), advance: sum((p) => p.advance), onAccount: 0, partyCount: rows.length, overLimitCount: rows.filter((p) => p.overLimit).length },
  };
}

describe('partiesChart (2.1.2): "Who owes me the most?" on the Parties view', () => {
  // Four customers: ₹59,000 + ₹23,600 + ₹14,750 + ₹5,900 = ₹1,03,250 owed; one paid ₹10,000 in advance.
  const five = (): PartySummaryResult =>
    partiesOf('receivable', [partyRow(1, 'Asha Retail', 59_000_00), partyRow(2, 'Kumar Builders', 23_600_00), partyRow(3, 'Nisha Traders', -10_000_00), partyRow(4, 'Patel & Sons', 14_750_00), partyRow(5, 'Rao Hardware', 5_900_00)]);

  it('graph total = the Net outstanding total of the rows shown; bars by size on the natural side', () => {
    const r = five();
    const spec = partiesChart(r);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, r.totals.pending);
    assert.equal(drawnTotal(spec), r.totals.pending);
    assert.deepEqual(spec.categories, ['Asha Retail', 'Kumar Builders', 'Patel & Sons', 'Nisha Traders', 'Rao Hardware']);
    assert.equal(spec.title, 'Net outstanding by customer');
    // The table's Net outstanding cells are ledger-signed (Dr for a customer): the same amounts, side-signed.
    assert.equal(spec.total * ledgerSign('receivable'), partiesTableTotals(r)[3]);
  });

  it('a party in advance: slot 2, said "advance" in words — never a bare minus', () => {
    const spec = partiesChart(five());
    assert.ok(spec);
    const i = spec.categories.indexOf('Nisha Traders');
    assert.equal(markColor(spec, i), 2);
    assert.equal(markColor(spec, 0), 1);
    const f = spec.valueFormat;
    assert.ok(f && typeof f === 'object');
    assert.equal(f.tick(-10_000_00), '₹10.0 K advance');
    assert.equal(f.full(-10_000_00), '₹ 10,000.00 advance');
    assert.ok(!/[−-]/.test(f.full(-10_000_00)));
  });

  it('takeaway: the top three of what customers owe, in words ("Top 3 customers owe 94 % of ₹1.03 L")', () => {
    // (59,000 + 23,600 + 14,750) / 1,03,250 = 94.3 %.
    assert.equal(partiesChart(five())?.takeaway, 'Top 3 customers owe 94 % of ₹1.03 L · advance from 1 customer');
    const pay = partiesOf('payable', [partyRow(1, 'Ravi Paints', 80_000_00), partyRow(2, 'Mehta Steel', 20_000_00)]);
    assert.equal(partiesChart(pay)?.takeaway, 'Ravi Paints is owed 80 % of ₹1.00 L');
    assert.equal(partiesChart(pay)?.title, 'Net outstanding by supplier');
    const adv = partiesOf('receivable', [partyRow(1, 'Asha Retail', -5_000_00), partyRow(2, 'Kumar Builders', -3_000_00)]);
    assert.equal(partiesChart(adv)?.takeaway, 'No customer owes you; ₹8.0 K received in advance');
    for (const s of [five(), pay, adv]) assert.ok((partiesChart(s)?.takeaway.length ?? 0) <= 90);
  });

  it('≤ 7 parties: inline in the Net outstanding column; more: Top 6 + Other strip, Σ kept', () => {
    const r = five();
    assert.equal(inlineBars(partiesChart(r), r.rows.length), true);
    const many = partiesOf('receivable', Array.from({ length: 12 }, (_, i) => partyRow(i + 1, `Customer ${i + 1}`, (i + 1) * 1_000_00)));
    const spec = partiesChart(many);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[6], 'Other');
    assert.equal(spec.total, many.totals.pending);
    assert.equal(inlineBars(spec, many.rows.length), false, 'a strip, not inline');
  });

  it('Enter on a bar = Enter on that party\'s row (its ledger); "Other" opens nothing', () => {
    const opened: number[] = [];
    const many = partiesOf('receivable', Array.from({ length: 9 }, (_, i) => partyRow(i + 1, `Customer ${i + 1}`, (i + 1) * 1_000_00)));
    const spec = partiesChart(many, (id) => opened.push(id));
    spec?.activate?.(0);
    spec?.activate?.(6);
    assert.deepEqual(opened, [9], 'the largest is Customer 9');
  });

  it('the over-limit filter: the graph follows the rows shown and their recomputed totals', () => {
    const r = partiesOf('receivable', [partyRow(1, 'A', 50_000_00, { overLimit: true }), partyRow(2, 'B', 30_000_00, { overLimit: true }), partyRow(3, 'C', 10_000_00)]);
    const shown = partiesInView(r, true);
    assert.equal(partiesChart(shown)?.total, shown.totals.pending);
    assert.equal(shown.totals.pending, 80_000_00);
  });

  it('gates: one party is a sentence (2.1.1 D2); none → no graph', () => {
    assert.equal(partiesChart(partiesOf('receivable', [])), null);
    assert.equal(partiesChart(partiesOf('receivable', [partyRow(1, 'Asha Retail', 59_000_00)])), null);
    assert.equal(partiesChart(partiesOf('receivable', [partyRow(1, 'Asha Retail', 59_000_00), partyRow(2, 'Settled', 0)])), null);
    assert.ok(enoughData(partiesChart(partiesOf('receivable', [partyRow(1, 'A', 1), partyRow(2, 'B', -1)])) ?? (null as never)));
  });

  it('the stat is unchanged and stays allow-listed ("To collect" = the total the graph adds up to)', () => {
    assert.equal(statTotalAllowed('outstanding.receivables'), true);
    const r = five();
    assert.equal(receivablesStat(r)[0].value, partiesChart(r)?.total);
  });

  it('10,000 parties stay under 50 ms', () => {
    const big = partiesOf('receivable', Array.from({ length: 10_000 }, (_, i) => partyRow(i, `P${i}`, ((i % 97) - 10) * 1000)));
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      partiesChart(big);
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    assert.equal(partiesChart(big)?.total, big.totals.pending);
  });
});
