import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clampPeriod,
  clampWorkingDate,
  defaultPeriod,
  defaultWorkingDate,
  describePeriod,
  loadWorkingContext,
  periodPresets,
  savePeriod,
  saveWorkingDate,
  storageKey,
} from './workingContext.ts';
import type { StorageLike } from './workingContext.ts';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const books = { companyId: 'c1', booksFrom: '2026-04-01', fyStartMonth: 4 };

describe('defaults and clamping', () => {
  test('working date defaults to today, never before the books begin', () => {
    assert.equal(defaultWorkingDate('2026-10-05', '2026-04-01'), '2026-10-05');
    assert.equal(defaultWorkingDate('2026-03-15', '2026-04-01'), '2026-04-01');
    assert.equal(clampWorkingDate('not a date', '2026-04-01'), '2026-04-01');
  });

  test('period defaults to the current FY to date', () => {
    assert.deepEqual(defaultPeriod('2026-10-05', '2025-04-01'), { from: '2026-04-01', to: '2026-10-05' });
    // Books began mid-year: the period starts at the books.
    assert.deepEqual(defaultPeriod('2026-10-05', '2026-07-15'), { from: '2026-07-15', to: '2026-10-05' });
    // Today in January → FY started the previous April.
    assert.deepEqual(defaultPeriod('2027-01-10', '2020-04-01'), { from: '2026-04-01', to: '2027-01-10' });
    // Calendar-year companies.
    assert.deepEqual(defaultPeriod('2026-10-05', '2020-01-01', 1), { from: '2026-01-01', to: '2026-10-05' });
    // Books begin in the future (new company created ahead of time).
    assert.deepEqual(defaultPeriod('2026-03-20', '2026-04-01'), { from: '2026-04-01', to: '2026-04-01' });
  });

  test('clampPeriod swaps reversed ranges and respects the books', () => {
    assert.deepEqual(clampPeriod({ from: '2026-09-30', to: '2026-09-01' }, '2026-04-01'), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(clampPeriod({ from: '2025-01-01', to: '2025-12-31' }, '2026-04-01'), { from: '2026-04-01', to: '2026-04-01' });
    assert.deepEqual(clampPeriod({ from: '2025-01-01', to: '2026-05-31' }, '2026-04-01'), { from: '2026-04-01', to: '2026-05-31' });
  });
});

describe('persistence', () => {
  test('a picked working date is remembered for the same day only', () => {
    const s = new MemoryStorage();
    saveWorkingDate(s, 'c1', '2026-09-30', '2026-10-05');
    assert.equal(loadWorkingContext(s, books, '2026-10-05').date, '2026-09-30');
    assert.equal(loadWorkingContext(s, books, '2026-10-06').date, '2026-10-06', 'next day starts at today');
  });

  test('a remembered date is clamped when the books moved', () => {
    const s = new MemoryStorage();
    saveWorkingDate(s, 'c1', '2026-01-01', '2026-10-05');
    assert.equal(loadWorkingContext(s, books, '2026-10-05').date, '2026-04-01');
  });

  test('the period is remembered per company', () => {
    const s = new MemoryStorage();
    savePeriod(s, 'c1', { from: '2026-07-01', to: '2026-07-31' });
    assert.deepEqual(loadWorkingContext(s, books, '2026-10-05').period, { from: '2026-07-01', to: '2026-07-31' });
    assert.deepEqual(loadWorkingContext(s, { ...books, companyId: 'c2' }, '2026-10-05').period, { from: '2026-04-01', to: '2026-10-05' });
    assert.ok(s.map.has(storageKey('c1', 'period')));
  });

  test('corrupt or missing storage falls back to defaults', () => {
    const s = new MemoryStorage();
    s.setItem(storageKey('c1', 'period'), '{not json');
    s.setItem(storageKey('c1', 'date'), JSON.stringify({ date: 42, setOn: '2026-10-05' }));
    assert.deepEqual(loadWorkingContext(s, books, '2026-10-05'), { date: '2026-10-05', period: { from: '2026-04-01', to: '2026-10-05' } });
    assert.deepEqual(loadWorkingContext(null, books, '2026-10-05').date, '2026-10-05');
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    assert.equal(loadWorkingContext(throwing, books, '2026-10-05').date, '2026-10-05');
    assert.doesNotThrow(() => savePeriod(throwing, 'c1', { from: '2026-04-01', to: '2026-04-30' }));
  });
});

describe('presets and labels', () => {
  test('presets relative to the working date', () => {
    const p = Object.fromEntries(periodPresets('2026-10-05', '2025-04-01').map((x) => [x.id, x.period]));
    assert.deepEqual(p.month, { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(p['last-month'], { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(p.quarter, { from: '2026-10-01', to: '2026-12-31' });
    assert.deepEqual(p['last-quarter'], { from: '2026-07-01', to: '2026-09-30' });
    assert.deepEqual(p['fy-to-date'], { from: '2026-04-01', to: '2026-10-05' });
    assert.deepEqual(p.fy, { from: '2026-04-01', to: '2027-03-31' });
    assert.deepEqual(p['last-fy'], { from: '2025-04-01', to: '2026-03-31' });
  });

  test('presets entirely before the books are dropped, others clamped', () => {
    const ids = periodPresets('2026-04-10', '2026-04-01').map((x) => x.id);
    assert.ok(!ids.includes('last-fy'));
    assert.ok(!ids.includes('last-month'));
    const q = periodPresets('2026-04-10', '2026-04-01').find((x) => x.id === 'quarter');
    assert.deepEqual(q?.period, { from: '2026-04-01', to: '2026-06-30' });
  });

  test('describePeriod', () => {
    assert.equal(describePeriod({ from: '2026-04-01', to: '2027-03-31' }), 'FY 2026-27');
    assert.equal(describePeriod({ from: '2026-10-01', to: '2026-10-31' }), 'Oct 2026');
    assert.equal(describePeriod({ from: '2026-04-01', to: '2026-10-05' }), '1-Apr-26 to 5-Oct-26');
    assert.equal(describePeriod({ from: '2026-10-05', to: '2026-10-05' }), '5-Oct-26');
  });
});
