import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayIn, nthOccurrence, occurrenceOf, occurrences, periodLabel } from './schedule.ts';

describe('recurring schedule', () => {
  it('monthly on the 31st falls on each month-end (30-Apr, 28-Feb, 29-Feb in a leap year)', () => {
    const s = { frequency: 'monthly' as const, dayOfMonth: 31, startDate: '2026-01-31' };
    const { list } = occurrences(s, { until: '2026-05-31' });
    assert.deepEqual(list.map((o) => o.date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    assert.deepEqual(list.map((o) => o.periodKey), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
    assert.equal(dayIn(2028, 2, 31), '2028-02-29');
    assert.equal(dayIn(2027, 2, 0), '2027-02-28', 'day 0 = last day');
  });

  it('"last day of the month" (0) and the start day as default', () => {
    const last = { frequency: 'monthly' as const, dayOfMonth: 0, startDate: '2026-04-01' };
    assert.deepEqual(occurrences(last, { until: '2026-06-30' }).list.map((o) => o.date), ['2026-04-30', '2026-05-31', '2026-06-30']);
    const dflt = { frequency: 'monthly' as const, startDate: '2026-04-05' };
    assert.deepEqual(occurrences(dflt, { until: '2026-06-30' }).list.map((o) => o.date), ['2026-04-05', '2026-05-05', '2026-06-05']);
  });

  it('skips an occurrence before the start date (start 15-Apr, day 1 → 1-May; quarterly → 1-Jul)', () => {
    assert.equal(occurrences({ frequency: 'monthly', dayOfMonth: 1, startDate: '2026-04-15' }, { until: '2026-12-31' }).list[0].date, '2026-05-01');
    assert.equal(occurrences({ frequency: 'quarterly', dayOfMonth: 1, startDate: '2026-04-15' }, { until: '2026-12-31' }).list[0].date, '2026-07-01');
  });

  it('quarterly, half-yearly and yearly step from the start month', () => {
    const q = occurrences({ frequency: 'quarterly', dayOfMonth: 10, startDate: '2026-04-10' }, { until: '2027-03-31' }).list.map((o) => o.date);
    assert.deepEqual(q, ['2026-04-10', '2026-07-10', '2026-10-10', '2027-01-10']);
    const h = occurrences({ frequency: 'half_yearly', dayOfMonth: 0, startDate: '2026-09-30' }, { until: '2027-12-31' }).list.map((o) => o.date);
    assert.deepEqual(h, ['2026-09-30', '2027-03-31', '2027-09-30']);
    const y = occurrences({ frequency: 'yearly', dayOfMonth: 29, startDate: '2028-02-29' }, { until: '2031-03-01' }).list.map((o) => o.date);
    assert.deepEqual(y, ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28']);
  });

  it('every N days, with an inclusive end date', () => {
    const s = { frequency: 'every_n_days' as const, intervalDays: 14, startDate: '2026-04-01', endDate: '2026-05-13' };
    const { list } = occurrences(s, { until: '2026-12-31' });
    assert.deepEqual(list.map((o) => o.date), ['2026-04-01', '2026-04-15', '2026-04-29', '2026-05-13']);
    assert.equal(list[1].periodKey, '2026-04-15');
  });

  it('limits catch-up lists and skips quickly to fromDate', () => {
    const s = { frequency: 'every_n_days' as const, intervalDays: 1, startDate: '2020-01-01' };
    const r = occurrences(s, { until: '2026-01-01', limit: 10 });
    assert.equal(r.list.length, 10);
    assert.equal(r.truncated, true);
    const late = occurrences(s, { fromDate: '2025-12-30', until: '2026-01-01' });
    assert.deepEqual(late.list.map((o) => o.date), ['2025-12-30', '2025-12-31', '2026-01-01']);
    const m = occurrences({ frequency: 'monthly', dayOfMonth: 5, startDate: '2020-01-05' }, { fromDate: '2026-03-01', until: '2026-05-31' });
    assert.deepEqual(m.list.map((o) => o.date), ['2026-03-05', '2026-04-05', '2026-05-05']);
  });

  it('maps a period key back to its occurrence (or null for a key off the schedule)', () => {
    const s = { frequency: 'quarterly' as const, dayOfMonth: 0, startDate: '2026-06-30' };
    assert.deepEqual(occurrenceOf(s, '2026-09'), { periodKey: '2026-09', date: '2026-09-30' });
    assert.equal(occurrenceOf(s, '2026-08'), null, 'August is not a quarter month of this schedule');
    assert.equal(occurrenceOf(s, '2026-09-30'), null, 'a date key is not a month-based key');
    assert.equal(occurrenceOf({ ...s, endDate: '2026-12-31' }, '2027-03'), null, 'after the end date');
    assert.equal(nthOccurrence(s, 2).periodKey, '2026-12');
    assert.equal(periodLabel({ periodKey: '2026-10', date: '2026-10-31' }), 'Oct 2026');
    assert.equal(periodLabel({ periodKey: '2026-10-05', date: '2026-10-05' }), '05-Oct-2026');
  });
});
