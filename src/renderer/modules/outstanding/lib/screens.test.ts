import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReminderParty, RemindersResult } from '../../../../shared/types/outstanding.ts';
import { ageingBarText, ageingLevel, ageingSegments } from './ageingBars.ts';
import { interestBasisText, interestInput, interestSegmentLines, rateText } from './interest.ts';
import type { InterestChoices } from './interest.ts';
import { clampLookAhead, clampMinDays, dueInText, letterNumericColumns, remindersExport, remindersQuery, selectedParties, toggleAll, toggleExcluded } from './reminders.ts';

describe('ageing bars', () => {
  it('spreads the age ranges over four severity levels, last bucket always the most severe', () => {
    // Default buckets: Not due, 1–30, 31–60, 61–90, 91–180, > 180 → 6 buckets, 5 age ranges.
    // level = 1 + floor((i − 1) × 4 / 5): i=1 → 1, 2 → 1 (0.8), 3 → 2 (1.6), 4 → 3 (2.4), 5 → last → 4.
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => ageingLevel(i, 6)), [0, 1, 1, 2, 3, 4]);
    // One age range only (Not due, > 30): it is the oldest → 4.
    assert.deepEqual([0, 1].map((i) => ageingLevel(i, 2)), [0, 4]);
  });

  it('draws only positive amounts and the percentages add up to exactly 100', () => {
    // 1 : 1 : 1 → 33.3 + 33.3 + 33.3 = 99.9; the spare 0.1 goes to the first largest remainder.
    const s = ageingSegments([100, 100, 100]);
    assert.deepEqual(s.map((x) => x.percent), [33.4, 33.3, 33.3]);
    assert.equal(Math.round(s.reduce((a, x) => a + x.percent * 10, 0)), 1000);
    // Advances (negative) and zero buckets have no length.
    const t = ageingSegments([0, 40_000_00, -5_000_00, 1_20_000_00]);
    assert.deepEqual(t.map((x) => [x.index, x.percent, x.level]), [
      [1, 25, 1], // 40,000 ÷ 1,60,000 = 25%
      [3, 75, 4], // 1,20,000 ÷ 1,60,000 = 75%; index 3 is the last of 4 buckets
    ]);
    assert.deepEqual(ageingSegments([0, -1]), []);
  });

  it('describes the bar for screen readers', () => {
    const money = (p: number): string => `₹${p / 100}`;
    // 40,000 ÷ 1,20,000 = 33.33…% → 333 tenths; 80,000 ÷ 1,20,000 = 66.66…% → 666 + the spare tenth = 667.
    // The spoken shares are the bar's own, so they add up to 100 (33.3 + 66.7).
    assert.equal(ageingBarText(['Not due', '1–30 days'], [40_000_00, 80_000_00], money), 'Not due ₹40000 (33.3%), 1–30 days ₹80000 (66.7%)');
    // Only positive amounts are described (an advance is not "age").
    assert.equal(ageingBarText(['Not due', '1–30 days', '> 30 days'], [0, -5_000_00, 10_000_00], money), '> 30 days ₹10000 (100%)');
    assert.equal(ageingBarText(['Not due'], [0], money), 'Nothing outstanding to age');
  });
});

describe('interest input', () => {
  const base: InterestChoices = { scope: 'all', ledgerId: null, groupId: undefined, from: '2026-04-01', to: '2026-09-30', ratePercent: null, basis: 'due_date', graceDays: null };

  it('builds the route input for each scope; a blank rate means each ledger’s own rate', () => {
    assert.deepEqual(interestInput(base), { ok: true, input: { from: '2026-04-01', to: '2026-09-30', basis: 'due_date', graceDays: 0, method: 'simple_365' } });
    assert.deepEqual(interestInput({ ...base, scope: 'party', ledgerId: 7, groupId: 3, ratePercent: 18, graceDays: 15, basis: 'bill_date' }), {
      ok: true,
      input: { from: '2026-04-01', to: '2026-09-30', basis: 'bill_date', graceDays: 15, method: 'simple_365', ledgerId: 7, ratePercent: 18 },
    });
    const g = interestInput({ ...base, scope: 'group', groupId: 3, ledgerId: 7 });
    assert.ok(g.ok && g.input.groupId === 3 && g.input.ledgerId === undefined);
  });

  it('explains what is missing instead of calling the server', () => {
    assert.deepEqual(interestInput({ ...base, scope: 'party' }), { ok: false, reason: 'Choose the party to calculate interest for.' });
    assert.deepEqual(interestInput({ ...base, scope: 'group' }), { ok: false, reason: 'Choose the group of parties.' });
    assert.equal(interestInput({ ...base, ratePercent: 0 }).ok, false);
    assert.equal(interestInput({ ...base, ratePercent: 100.5 }).ok, false);
    assert.equal(interestInput({ ...base, graceDays: 3651 }).ok, false);
    assert.equal(interestInput({ ...base, from: '2026-10-01' }).ok, false);
  });

  it('splits the bill’s interest across segments so the lines add up to the paisa', () => {
    // Core README §3.3 example 2: ₹1,00,000 due 30-Apr, ₹40,000 received 31-May, to 14-Jun, 18%.
    // Exact: 1,00,00,000 × 31 × 18 ÷ 36,500 = 1,52,876.71 ; 60,00,000 × 14 × 18 ÷ 36,500 = 41,424.66
    // Bill interest (rounded once) = round(1,94,301.37) = 1,94,301 → floors 1,94,300 + 1 to the .71 line.
    const lines = interestSegmentLines({
      ratePercent: 18,
      interest: 1_94_301,
      segments: [
        { from: '2026-04-30', to: '2026-05-31', days: 31, balance: 1_00_000_00 },
        { from: '2026-05-31', to: '2026-06-14', days: 14, balance: 60_000_00 },
      ],
    });
    assert.deepEqual(lines.map((l) => [l.firstDay, l.lastDay, l.days, l.interest]), [
      ['2026-05-01', '2026-05-31', 31, 1_52_877],
      ['2026-06-01', '2026-06-14', 14, 41_424],
    ]);
    assert.equal(lines.reduce((s, l) => s + l.interest, 0), 1_94_301);
  });

  it('handles fractional rates exactly', () => {
    // ₹10,000 for 365 days at 12.5% = ₹1,250.00 exactly: 10,00,000 × 365 × 12.5 ÷ 36,500 = 1,25,000 paise.
    const [l] = interestSegmentLines({ ratePercent: 12.5, interest: 1_25_000, segments: [{ from: '2025-09-30', to: '2026-09-30', days: 365, balance: 10_00_000 }] });
    assert.equal(l.interest, 1_25_000);
  });

  it('formats the rate and the basis sentence', () => {
    assert.equal(rateText(18), '18% p.a.');
    assert.equal(rateText(18.5), '18.5% p.a.');
    assert.equal(interestBasisText('due_date', 0), 'Simple interest on a 365-day year, counted from the due date up to the day of payment.');
    assert.equal(interestBasisText('bill_date', 1), 'Simple interest on a 365-day year, counted from the bill date plus 1 grace day up to the day of payment.');
  });
});

describe('reminders', () => {
  const party = (ledgerId: number, over: Partial<ReminderParty> = {}): ReminderParty => ({
    ledgerId,
    ledgerName: `Party ${ledgerId}`,
    email: null,
    mobile: '98200 00000',
    tone: 'firm',
    overdueBills: [{ billName: 'C-1', billDate: '2026-05-01', dueDate: '2026-06-22', pendingAmount: 1_23_456_78, overdueDays: 100 }],
    totalOverdue: 1_23_456_78,
    unadjustedCredits: -23_456_78,
    amountDue: 1_00_000_00,
    netOutstanding: 1_00_000_00,
    oldestOverdueDays: 100,
    letter: { date: '30-Sep-2026', from: [], to: [], subject: '', salutation: '', opening: [], table: { columns: [], rows: [], total: [] }, closing: [], signOff: [], text: '' },
    ...over,
  });

  it('selects every party except the excluded ones; Space and Alt+A toggle', () => {
    const ps = [party(1), party(2), party(3)];
    let ex = toggleExcluded(new Set(), 2);
    assert.deepEqual(selectedParties(ps, ex).map((p) => p.ledgerId), [1, 3]);
    ex = toggleExcluded(ex, 2);
    assert.deepEqual(selectedParties(ps, ex).map((p) => p.ledgerId), [1, 2, 3]);
    ex = toggleAll(ps, ex); // nothing excluded → exclude all
    assert.equal(selectedParties(ps, ex).length, 0);
    ex = toggleAll(ps, toggleExcluded(new Set(), 1)); // something excluded → include all
    assert.equal(selectedParties(ps, ex).length, 3);
  });

  it('exports the follow-up list with positive amounts', () => {
    // Core README §3.5: overdue 1,23,456.78 − unadjusted 23,456.78 = amount due 1,00,000.00.
    const r: RemindersResult = { asOf: '2026-09-30', minOverdueDays: 1, parties: [party(1)], totals: { partyCount: 1, amountDue: 1_00_000_00 } };
    const e = remindersExport(r);
    assert.deepEqual(e.rows[0], ['Party 1', '98200 00000', null, 1, 100, 1_23_456_78, 23_456_78, 1_00_000_00, 'Firm']);
    assert.equal(e.rows[0].length, e.columns.length);
    assert.deepEqual(e.totals, ['Total', null, null, 1, null, 1_23_456_78, 23_456_78, 1_00_000_00, null]);
    assert.equal(e.subtitle, 'Customers overdue by 1+ day');
  });

  it('totals the follow-up list over every party', () => {
    // Party 1: overdue 1,23,456.78, unadjusted −23,456.78 → due 1,00,000.00 (README §3.5).
    // Party 2: two bills 30,000 + 20,000 = 50,000.00 overdue, nothing unadjusted → due 50,000.00.
    // Totals: bills 1 + 2 = 3; overdue 1,73,456.78; unadjusted 23,456.78; due 1,50,000.00.
    const p2 = party(2, {
      tone: 'gentle',
      overdueBills: [
        { billName: 'C-7', billDate: '2026-08-01', dueDate: '2026-08-31', pendingAmount: 30_000_00, overdueDays: 30 },
        { billName: 'C-8', billDate: '2026-08-10', dueDate: '2026-09-09', pendingAmount: 20_000_00, overdueDays: 21 },
      ],
      totalOverdue: 50_000_00,
      unadjustedCredits: 0,
      amountDue: 50_000_00,
      netOutstanding: 50_000_00,
      oldestOverdueDays: 30,
    });
    const e = remindersExport({ asOf: '2026-09-30', minOverdueDays: 15, parties: [party(1), p2], totals: { partyCount: 2, amountDue: 1_50_000_00 } });
    assert.deepEqual(e.rows[1], ['Party 2', '98200 00000', null, 2, 30, 50_000_00, null, 50_000_00, 'Gentle']);
    assert.deepEqual(e.totals, ['Total', null, null, 3, null, 1_73_456_78, 23_456_78, 1_50_000_00, null]);
    assert.equal(e.subtitle, 'Customers overdue by 15+ days');
  });

  it('asks the server to age customers who are not bill-wise FIFO (else they are never reminded)', () => {
    assert.deepEqual(remindersQuery({ asOf: '2026-09-30', minDays: 15 }), { asOf: '2026-09-30', minOverdueDays: 15, side: 'receivable', nonBillWise: 'fifo' });
    // One customer: the group filter is dropped (the ledger alone decides; both would have to agree on the server).
    assert.deepEqual(remindersQuery({ asOf: '2026-09-30', minDays: null, groupId: 4, ledgerId: 9 }), {
      asOf: '2026-09-30',
      minOverdueDays: 1,
      side: 'receivable',
      nonBillWise: 'fifo',
      ledgerId: 9,
    });
    assert.equal(remindersQuery({ asOf: '2026-09-30', minDays: 1, groupId: 4 }).groupId, 4);
  });

  it('keeps "overdue by" inside what the route accepts', () => {
    assert.deepEqual([null, 0, -3, 0.4, 1, 7.6, 99_999, Number.NaN].map(clampMinDays), [1, 1, 1, 1, 1, 8, 36_500, 1]);
    assert.deepEqual([7, 0, -1, 30.4, 400, Number.NaN, Number.POSITIVE_INFINITY].map(clampLookAhead), [7, 0, 0, 30, 366, 7, 7]);
  });

  it('right-aligns the numeric columns of the letter table', () => {
    const table = {
      columns: ['Bill No.', 'Bill Date', 'Due Date', 'Overdue (days)', 'Amount (₹)'],
      rows: [
        ['C-1', '01-May-2026', '22-Jun-2026', '100', '1,23,456.78'],
        ['C-2', '05-May-2026', '', '7', '500.00'],
      ],
    };
    assert.deepEqual(letterNumericColumns(table), [false, false, false, true, true]);
    assert.deepEqual(letterNumericColumns({ columns: ['A'], rows: [] }), [false]);
  });

  it('words the due-soon distance', () => {
    assert.deepEqual([0, 1, 5].map(dueInText), ['Due today', 'Due tomorrow', 'In 5 days']);
  });
});
