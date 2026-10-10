import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FOCUS_RANK, isShellFocus, keepUserFocusAfterLazyLoad, markShellFocus, needsFocusWatch, shouldUpgradeFocus } from './initialFocus.ts';

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

describe('shell focus picks (Voucher Entry places its own cursor once the form renders)', () => {
  test('only elements the shell focused count as provisional', () => {
    const date = {};
    const party = {};
    markShellFocus(date);
    assert.equal(isShellFocus(date), true, 'the shell put the cursor on Date while loading: the screen may move it');
    assert.equal(isShellFocus(party), false, 'a field the user moved to is left alone');
    assert.equal(isShellFocus(null), false);
    assert.equal(isShellFocus(undefined), false);
  });
});

describe('lazy screen: initial focus once its code has arrived (nav.tsx, V8)', () => {
  const button = {};
  const field = {};
  const at = (active: object | null, extra: Partial<Parameters<typeof keepUserFocusAfterLazyLoad>[0]> = {}) =>
    keepUserFocusAfterLazyLoad({ active, atOpen: button, isBody: false, inScreen: false, shown: true, ...extra });

  test('focus still where it was when the screen opened is taken, as an eager screen takes it at once', () => {
    // Topbar "Search or jump to…" → Go To → a lazy report: the palette hands focus back to the (visible)
    // search button before the screen opens; an eager screen would focus its first field right away.
    assert.equal(at(button), false);
  });

  test('a visible element the user moved to while the code loaded is left alone', () => {
    assert.equal(at(field), true);
  });

  test('nothing focused, the page body, the screen itself or a hidden leftover is not a choice', () => {
    assert.equal(at(null), false);
    assert.equal(at(field, { isBody: true }), false);
    assert.equal(at(field, { inScreen: true }), false);
    assert.equal(at(field, { shown: false }), false);
  });
});
