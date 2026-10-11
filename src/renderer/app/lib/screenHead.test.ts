import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backTarget, capTitleRow, NOT_SAVED, TITLE_ROW_CAPS, windowTitle, workingDateLabel, workingDateName } from './screenHead.ts';

describe('title row (SPEC-21 §1.2)', () => {
  test('no back button at the root (Home); from depth 2 it names the previous screen and shows the path with Esc', () => {
    assert.equal(backTarget(['Home'], 0), null);
    assert.deepEqual(backTarget(['Home', 'Profit & Loss A/c'], 1), { label: 'Back to Home', tip: 'Home › Profit & Loss A/c · Esc' });
    assert.deepEqual(backTarget(['Home', 'Profit & Loss A/c', 'Indirect Expenses'], 2), {
      label: 'Back to Profit & Loss A/c',
      tip: 'Home › Profit & Loss A/c › Indirect Expenses · Esc',
    });
    assert.equal(backTarget(['Home', 'Ledgers'], 2), null, 'an index past the stack has no target');
    assert.equal(backTarget(['', 'Ledgers'], 1)?.label, 'Back to previous screen', 'an untitled screen still gets a name');
  });

  test('the state word of the context run is "Not saved"', () => {
    assert.equal(NOT_SAVED, 'Not saved');
  });

  test('at most one primary and three secondaries; extra secondaries move to the front of More', () => {
    assert.deepEqual(TITLE_ROW_CAPS, { primary: 1, secondary: 3 });
    const small = { primary: 'Save', buttons: ['Print', 'Share'], more: ['Delete'] };
    assert.equal(capTitleRow(small), small, 'within the caps nothing changes');
    assert.deepEqual(capTitleRow({ primary: null, buttons: ['a', 'b', 'c', 'd', 'e'], more: ['f'] }), { primary: null, buttons: ['a', 'b', 'c'], more: ['d', 'e', 'f'] });
  });

  test('window title: "• " first while anything is unsaved', () => {
    assert.equal(windowTitle('Ledger Creation', 'Shree Ganesh Hardware', false), 'Ledger Creation · Shree Ganesh Hardware · Pevqori');
    assert.equal(windowTitle('Ledger Creation', 'Shree Ganesh Hardware', true), '• Ledger Creation · Shree Ganesh Hardware · Pevqori');
    assert.equal(windowTitle('', 'X', false), 'X · Pevqori');
  });

  test('working date: weekday and D-MMM-YY, calendar-checked', () => {
    assert.deepEqual(workingDateLabel('2026-10-10'), { weekday: 'Sat', date: '10-Oct-26' });
    assert.deepEqual(workingDateLabel('2027-03-31'), { weekday: 'Wed', date: '31-Mar-27' });
    assert.deepEqual(workingDateLabel('2028-02-29'), { weekday: 'Tue', date: '29-Feb-28' });
    assert.deepEqual(workingDateLabel('2026-02-30'), { weekday: '', date: '' });
    assert.deepEqual(workingDateLabel('10-10-2026'), { weekday: '', date: '' });
  });

  test('the working-date button is named "Working date …" and keeps its visible words in order (label-in-name)', () => {
    const day = workingDateLabel('2026-10-10');
    assert.equal(workingDateName(day, true), 'Working date Sat 10-Oct-26');
    assert.equal(workingDateName(day, false), 'Working date Sat 10-Oct-26 not today');
    const visible = `${day.weekday} ${day.date} not today`;
    assert.ok(workingDateName(day, false).endsWith(visible), 'the visible text is a substring of the name');
    assert.equal(workingDateName({ weekday: '', date: '' }, true), 'Working date');
  });
});
