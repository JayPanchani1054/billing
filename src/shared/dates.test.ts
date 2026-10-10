import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addDays,
  addMonths,
  compareDates,
  daysInMonth,
  diffDays,
  endOfMonth,
  financialYear,
  formatDate,
  formatMonth,
  fyQuarter,
  isValidDate,
  isWithin,
  monthsBetween,
  parseDateInput,
  returnPeriod,
  returnPeriodRange,
  startOfMonth,
  todayLocal,
} from './dates.ts';

describe('validity and calendar arithmetic', () => {
  test('leap days and impossible dates', () => {
    assert.equal(isValidDate('2024-02-29'), true);
    assert.equal(isValidDate('2023-02-29'), false);
    assert.equal(isValidDate('2100-02-29'), false, 'century non-leap year');
    assert.equal(isValidDate('2000-02-29'), true);
    assert.equal(isValidDate('2026-02-31'), false);
    assert.equal(isValidDate('2026-04-31'), false);
    assert.equal(isValidDate('2026-13-01'), false);
    assert.equal(isValidDate('2026-1-01'), false);
    assert.equal(isValidDate('05-10-2026'), false);
  });

  test('daysInMonth, start/end of month', () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(startOfMonth('2026-10-05'), '2026-10-01');
    assert.equal(endOfMonth('2024-02-10'), '2024-02-29');
  });

  test('addDays / addMonths / diffDays', () => {
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'clamped to month end');
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
    assert.equal(addMonths('2026-02-15', -3), '2025-11-15');
    assert.equal(diffDays('2024-02-01', '2024-03-01'), 29);
    assert.equal(diffDays('2026-04-01', '2027-03-31'), 364);
    assert.equal(diffDays('2026-10-05', '2026-10-01'), -4);
  });

  test('comparisons', () => {
    assert.equal(compareDates('2026-01-01', '2026-01-02'), -1);
    assert.equal(compareDates('2026-01-02', '2026-01-02'), 0);
    assert.equal(isWithin('2026-04-01', '2026-04-01', '2027-03-31'), true);
    assert.equal(isWithin('2027-04-01', '2026-04-01', '2027-03-31'), false);
  });

  test('todayLocal uses the local calendar date', () => {
    assert.equal(todayLocal(new Date(2026, 9, 5, 23, 59)), '2026-10-05');
  });
});

describe('financial year and return periods', () => {
  test('April–March financial year', () => {
    assert.deepEqual(financialYear('2026-03-31'), { start: '2025-04-01', end: '2026-03-31', label: '2025-26' });
    assert.deepEqual(financialYear('2026-04-01'), { start: '2026-04-01', end: '2027-03-31', label: '2026-27' });
    assert.deepEqual(financialYear('2024-02-29'), { start: '2023-04-01', end: '2024-03-31', label: '2023-24' });
    assert.deepEqual(financialYear('2026-06-01', 1), { start: '2026-01-01', end: '2026-12-31', label: '2026' });
  });

  test('quarters, months and GST return periods', () => {
    assert.equal(fyQuarter('2026-04-01'), 1);
    assert.equal(fyQuarter('2026-12-31'), 3);
    assert.equal(fyQuarter('2027-03-31'), 4);
    assert.deepEqual(monthsBetween('2026-11-15', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.equal(returnPeriod('2026-10-05'), '102026');
    assert.deepEqual(returnPeriodRange('022024'), { from: '2024-02-01', to: '2024-02-29' });
  });
});

describe('formatting', () => {
  test('formatDate styles', () => {
    assert.equal(formatDate('2026-10-05'), '05-Oct-2026');
    assert.equal(formatDate('2026-10-05', 'DD-MM-YYYY'), '05-10-2026');
    assert.equal(formatDate('2026-10-05', 'DD/MM/YYYY'), '05/10/2026');
    assert.equal(formatDate('2026-10-05', 'D-MMM-YY'), '5-Oct-26');
    assert.equal(formatDate('2026-02-30'), '');
    assert.equal(formatDate(null), '');
    assert.equal(formatMonth('2026-10'), 'Oct 2026');
  });
});

describe('parseDateInput (keyboard-first entry)', () => {
  const ref = '2026-10-05';
  const p = (s: string): string | null => parseDateInput(s, ref);

  test('shortcuts and partial dates resolve against the working date', () => {
    assert.equal(p('t'), ref);
    assert.equal(p('Today'), ref);
    assert.equal(p('y'), '2026-10-04');
    assert.equal(p('5'), '2026-10-05');
    assert.equal(p('31'), '2026-10-31');
    assert.equal(p('5-11'), '2026-11-05');
    assert.equal(p('5/11'), '2026-11-05');
    assert.equal(p('5.11'), '2026-11-05');
  });

  test('full numeric forms', () => {
    assert.equal(p('5-10-26'), '2026-10-05');
    assert.equal(p('5/10/2026'), '2026-10-05');
    assert.equal(p('05102026'), '2026-10-05');
    assert.equal(p('051026'), '2026-10-05');
    assert.equal(p('2026-10-05'), '2026-10-05');
    assert.equal(p('2026/10/5'), '2026-10-05');
  });

  test('month names', () => {
    assert.equal(p('5-Oct'), '2026-10-05');
    assert.equal(p('5 october 2025'), '2025-10-05');
    assert.equal(p('Oct 5'), '2026-10-05');
    assert.equal(p('sept 1, 2026'), '2026-09-01');
  });

  test('leap days and impossible dates', () => {
    assert.equal(p('29/2/2024'), '2024-02-29');
    assert.equal(p('29-2-2023'), null);
    assert.equal(p('31/2'), null);
    assert.equal(p('31-4-2026'), null);
    assert.equal(p('0'), null);
    assert.equal(p('5-13'), null);
    assert.equal(p('30022024'), null);
    assert.equal(p('2026-02-30'), null);
  });

  test('malformed input is rejected rather than half-parsed (regression)', () => {
    assert.equal(p(''), null);
    assert.equal(p('abc'), null);
    assert.equal(p('5-10-6'), null, '1-digit year used to be ignored silently');
    assert.equal(p('5-10-202'), null, '3-digit year used to produce year 0202');
    assert.equal(p('5 10 2026 9'), null, 'extra tokens used to be ignored');
    assert.equal(p('5-xyz'), null);
  });

  test('month names must be a month, not merely start with one (regression)', () => {
    assert.equal(p('5 junk'), null, "'junk' used to parse as June");
    assert.equal(p('marching 3'), null);
    assert.equal(p('1 decimal'), null);
    assert.equal(p('5 ju'), null, 'too short to be unambiguous');
    assert.equal(p('5 jun'), '2026-06-05');
    assert.equal(p('5 july'), '2026-07-05');
    assert.equal(p('5 sep 26'), '2026-09-05');
    assert.equal(p('5 MAY'), '2026-05-05');
  });

  test('two-digit years resolve to the nearest century of the working date (regression: always 20yy)', () => {
    assert.equal(p('5-10-99'), '1999-10-05', "'99' used to become 2099");
    assert.equal(p('010199'), '1999-01-01');
    assert.equal(p('5-10-75'), '2075-10-05'); // 2026 + 49
    assert.equal(p('5-10-76'), '1976-10-05'); // 2026 − 50
    assert.equal(p('5-10-00'), '2000-10-05');
    assert.equal(parseDateInput('1-1-01', '2095-06-01'), '2101-01-01');
  });
});
