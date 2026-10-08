import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstPeriodsResult, ReturnPeriod } from '../../../../shared/types/gst-returns.ts';
import { findPeriod, fyEnd, fyList, initialFy, initialPeriodKey, periodKeyForRange, periodOptionGroups, periodOptionLabel, stepPeriod } from './periods.ts';

function month(key: string, fy: string, out = 0, inw = 0, isCurrent = false): ReturnPeriod {
  const m = Number(key.slice(0, 2));
  const y = Number(key.slice(2));
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const from = `${y}-${key.slice(0, 2)}-01`;
  return { key, kind: 'month', label: `${names[m - 1]} ${y}`, from, to: from, fp: key, fy, outwardCount: out, inwardCount: inw, hasData: out + inw > 0, isCurrent };
}
function quarter(key: string, fy: string, label: string, out = 0, isCurrent = false): ReturnPeriod {
  return { key, kind: 'quarter', label, from: '', to: '', fp: '', fy, outwardCount: out, inwardCount: 0, hasData: out > 0, isCurrent };
}

// Monthly filer, working date in May 2026 (newest first): May 2026, Apr 2026, Mar 2026.
const monthly: GstPeriodsResult = {
  filingFrequency: 'monthly',
  periods: [month('052026', '2026-27', 0, 0, true), month('042026', '2026-27', 12, 4), month('032026', '2025-26', 1, 0)],
  current: '052026',
  suggested: '042026',
};

// Quarterly filer: Q1 2026-27 (current) with its months.
const quarterly: GstPeriodsResult = {
  filingFrequency: 'quarterly',
  periods: [
    month('062026', '2026-27', 0, 0, true),
    quarter('2026-27-Q1', '2026-27', 'Q1 (Apr–Jun) 2026-27', 3, true),
    month('052026', '2026-27', 1),
    month('042026', '2026-27', 2),
    quarter('2025-26-Q4', '2025-26', 'Q4 (Jan–Mar) 2025-26', 1),
    month('032026', '2025-26', 1),
  ],
  current: '2026-27-Q1',
  suggested: '2025-26-Q4',
};

describe('GST return periods', () => {
  it('labels a period with its document count and current marker', () => {
    assert.equal(periodOptionLabel(monthly.periods[1]), 'Apr 2026 · 16 documents'); // 12 outward + 4 inward
    assert.equal(periodOptionLabel(monthly.periods[0]), 'May 2026 · current · no entries');
    assert.equal(periodOptionLabel(monthly.periods[2]), 'Mar 2026 · 1 document');
  });

  it('groups options by financial year, quarters before months for quarterly filers', () => {
    const g = periodOptionGroups(quarterly);
    assert.deepEqual(
      g.map((x) => [x.label, x.options.map((o) => o.value)]),
      [
        ['FY 2026-27', ['2026-27-Q1', '062026', '052026', '042026']],
        ['FY 2025-26', ['2025-26-Q4', '032026']],
      ],
    );
  });

  it('opens the requested period, else the one being filed now, else the current one', () => {
    assert.equal(initialPeriodKey(monthly, '032026'), '032026');
    assert.equal(initialPeriodKey(monthly, '012020'), '042026'); // unknown → suggested
    assert.equal(initialPeriodKey(monthly), '042026');
    assert.equal(initialPeriodKey({ ...monthly, suggested: '022026' }), '052026'); // suggested before the books → current
    assert.equal(initialPeriodKey({ ...monthly, periods: [] }), null);
    assert.equal(initialPeriodKey(undefined), null);
  });

  it('steps to the previous / next period of the same kind', () => {
    assert.equal(stepPeriod(monthly, '042026', -1), '032026');
    assert.equal(stepPeriod(monthly, '042026', 1), '052026');
    assert.equal(stepPeriod(monthly, '052026', 1), null);
    assert.equal(stepPeriod(quarterly, '2026-27-Q1', -1), '2025-26-Q4'); // skips the months
    assert.equal(findPeriod(quarterly, '052026')?.label, 'May 2026');
  });

  it('lists financial years and picks the last completed one for GSTR-9', () => {
    assert.deepEqual(fyList(quarterly), ['2026-27', '2025-26']);
    assert.equal(fyEnd('2025-26'), '2026-03-31');
    assert.equal(initialFy(quarterly, '2026-05-10'), '2025-26'); // FY 2025-26 ended 31-Mar-2026
    assert.equal(initialFy(quarterly, '2026-03-31'), '2026-27'); // nothing has ended yet → newest
    assert.equal(initialFy(quarterly, '2026-05-10', '2026-27'), '2026-27');
    assert.equal(initialFy(undefined, '2026-05-10'), null);
  });
});

describe('range → return period key', () => {
  it('recognises whole months, including February and leap years', () => {
    assert.equal(periodKeyForRange('2026-04-01', '2026-04-30'), '042026');
    assert.equal(periodKeyForRange('2027-02-01', '2027-02-28'), '022027');
    assert.equal(periodKeyForRange('2028-02-01', '2028-02-29'), '022028');
    assert.equal(periodKeyForRange('2027-02-01', '2027-02-27'), null);
  });

  it('recognises GST-year quarters (Jan–Mar is Q4 of the previous April year)', () => {
    assert.equal(periodKeyForRange('2026-04-01', '2026-06-30'), '2026-27-Q1');
    assert.equal(periodKeyForRange('2026-10-01', '2026-12-31'), '2026-27-Q3');
    assert.equal(periodKeyForRange('2027-01-01', '2027-03-31'), '2026-27-Q4');
    assert.equal(periodKeyForRange('2099-01-01', '2099-03-31'), '2098-99-Q4');
  });

  it('anything else is not a return period', () => {
    assert.equal(periodKeyForRange('2026-04-02', '2026-04-30'), null); // not from the 1st
    assert.equal(periodKeyForRange('2026-05-01', '2026-07-31'), null); // 3 months but not a GST quarter
    assert.equal(periodKeyForRange('2026-04-01', '2027-03-31'), null); // a year
    assert.equal(periodKeyForRange('', '2026-04-30'), null);
  });
});
