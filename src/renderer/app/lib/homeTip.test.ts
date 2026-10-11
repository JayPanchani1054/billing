import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tipOnFocus, tipTop } from './homeTip.ts';

describe('Home menu description tooltip (SPEC-21 D9)', () => {
  test('keyboard moves from another element show it; focus Home sets by itself or after a click does not', () => {
    assert.equal(tipOnFocus('key', true), true); // ↑/↓ in the list, Tab from the top bar
    assert.equal(tipOnFocus('key', false), false); // Esc back to Home, Ctrl+1 / Ctrl+2: the first item is focused from nowhere
    assert.equal(tipOnFocus(null, false), false); // Home opens
    assert.equal(tipOnFocus('pointer', true), false); // a click focuses the item (hover shows the tip anyway)
    assert.equal(tipOnFocus('pointer', false), false);
  });

  test('the tip centres on the item, relative to the Home root', () => {
    const root = { top: 40, bottom: 730 };
    const menu = { top: 40, bottom: 730 };
    assert.equal(tipTop({ top: 100, bottom: 124 }, root, menu), 72);
    assert.equal(tipTop({ top: 40, bottom: 64 }, root, menu), 12);
  });

  test('an item scrolled out of the column has no tip (it would point at nothing)', () => {
    const root = { top: 40, bottom: 730 };
    const menu = { top: 40, bottom: 730 };
    assert.equal(tipTop({ top: 10, bottom: 34 }, root, menu), null); // above the column
    assert.equal(tipTop({ top: 740, bottom: 764 }, root, menu), null); // below it
    assert.equal(tipTop({ top: 718, bottom: 742 }, root, menu), 690); // half visible: its middle is inside
  });
});
