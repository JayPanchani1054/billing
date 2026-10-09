import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FOCUS_RANK, needsFocusWatch, shouldUpgradeFocus } from './initialFocus.ts';

describe('initial focus upgrade (Ledger / Stock Item Creation open on a loading skeleton)', () => {
  test('heading → [data-autofocus] Name field once the form renders', () => {
    assert.equal(needsFocusWatch(FOCUS_RANK.heading), true);
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.heading, stillFocused: true }, FOCUS_RANK.autofocus), true);
  });

  test('a toolbar button picked during loading gives way to the first field or grid', () => {
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.tabbable, stillFocused: true }, FOCUS_RANK.field), true);
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.tabbable, stillFocused: true }, FOCUS_RANK.grid), true);
  });

  test('never steals focus the user (or the screen) moved, never downgrades, never to a mere button', () => {
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.heading, stillFocused: false }, FOCUS_RANK.autofocus), false);
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.field, stillFocused: true }, FOCUS_RANK.grid), false);
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.heading, stillFocused: true }, FOCUS_RANK.tabbable), false);
    assert.equal(shouldUpgradeFocus({ rank: FOCUS_RANK.heading, stillFocused: true }, null), false);
  });

  test('[data-autofocus] is final', () => {
    assert.equal(needsFocusWatch(FOCUS_RANK.autofocus), false);
  });
});
