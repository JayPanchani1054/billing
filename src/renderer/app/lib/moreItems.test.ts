import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aboutItem, checkItem, columnChoices, columnLabel, columnsItem, MENU_ONLY, onColumnsRequest, requestColumns, toggleColumn } from './moreItems.ts';
import type { ColumnsRequest } from './moreItems.ts';
import { parseHotkeyList } from '../../ui/lib/hotkeys.ts';
import { readFileSync } from 'node:fs';

const COLS = [
  { key: 'name', header: 'Customer' },
  { key: 'group', header: 'Group' },
  { key: 'limit', header: { el: 'span' }, headerLabel: 'Credit limit used' },
  { key: 'secret', header: 'Never', hidden: true },
  { key: 'net', header: { el: 'b' } },
];

describe('menu-only items (SPEC-21 §3.1 rule 4)', () => {
  test('MENU_ONLY registers nothing: it parses to no key at all, and it is NO_KEY of ui/ActionRail.tsx', () => {
    assert.equal(MENU_ONLY, '');
    assert.deepEqual(parseHotkeyList(MENU_ONLY), []);
    // ActionRail.tsx imports React (not loadable here): its declaration is read from source.
    const rail = readFileSync(new URL('../../ui/ActionRail.tsx', import.meta.url), 'utf8');
    assert.match(rail, /^export const NO_KEY = '';$/m);
  });

  test('aboutItem: keyless "About this report" that opens the drawer', () => {
    let opened = 0;
    const it = aboutItem(() => opened++);
    assert.equal(it.key, MENU_ONLY);
    assert.equal(it.label, 'About this report');
    it.onClick();
    assert.equal(opened, 1);
    assert.equal(aboutItem(() => {}, 'About this return').label, 'About this return');
    assert.deepEqual(Object.keys(it).slice(0, 3), ['key', 'label', 'onClick']);
  });

  test('checkItem: checkable, keyless by default, toggles to the opposite state', () => {
    const seen: boolean[] = [];
    const on = checkItem('Show empty tables', true, (v) => seen.push(v));
    assert.equal(on.key, MENU_ONLY);
    assert.equal(on.checked, true);
    on.onClick();
    const off = checkItem('Show empty tables', false, (v) => seen.push(v));
    assert.equal(off.checked, false);
    off.onClick();
    assert.deepEqual(seen, [false, true]);
    assert.equal(checkItem('Schedule III format', false, () => {}, 'Alt+V').key, 'Alt+V');
    assert.deepEqual(Object.keys(on).slice(0, 3), ['key', 'label', 'onClick']);
  });
});

describe('Columns…', () => {
  test('labels: headerLabel, then a string header, then the key', () => {
    assert.equal(columnLabel(COLS[0]), 'Customer');
    assert.equal(columnLabel(COLS[2]), 'Credit limit used');
    assert.equal(columnLabel(COLS[4]), 'net');
  });

  test('choices: columns hidden by the screen never show; the first column is locked', () => {
    const c = columnChoices(COLS, ['group']);
    assert.deepEqual(
      c.map((x) => [x.key, x.shown, x.locked]),
      [
        ['name', true, true],
        ['group', false, false],
        ['limit', true, false],
        ['net', true, false],
      ],
    );
  });

  test('toggle hides and shows a column; never the first one, never the last one shown', () => {
    assert.deepEqual(toggleColumn(COLS, [], 'group'), ['group']);
    assert.deepEqual(toggleColumn(COLS, ['group'], 'group'), []);
    assert.deepEqual(toggleColumn(COLS, [], 'name'), [], 'the first column stays');
    const two = [COLS[0], COLS[1]];
    assert.deepEqual(toggleColumn(two, ['name'], 'group'), ['name'], 'the last shown column stays');
    assert.deepEqual(toggleColumn(COLS, ['group', 'group'], 'unknown'), ['group'], 'unknown keys ignored, duplicates dropped');
  });

  test('columnsItem: keyless "Columns…", hint counts the hidden ones', () => {
    const it = columnsItem(COLS, ['group', 'limit'], () => {});
    assert.equal(it.key, MENU_ONLY);
    assert.equal(it.label, 'Columns…');
    assert.equal(it.hint, '2 hidden');
    assert.equal(columnsItem(COLS, [], () => {}).hint, undefined);
    assert.deepEqual(Object.keys(it).slice(0, 3), ['key', 'label', 'onClick']);
  });

  test('choosing it asks the host; without a host nothing happens', () => {
    let next: string[] | null = null;
    const it = columnsItem(COLS, ['group'], (n) => (next = n));
    assert.equal(requestColumns({ columns: COLS, hidden: [], setHidden: () => {} }), false);
    assert.doesNotThrow(() => it.onClick());
    const got: ColumnsRequest[] = [];
    const off = onColumnsRequest((r) => got.push(r));
    it.onClick();
    off();
    it.onClick();
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].hidden, ['group']);
    got[0].setHidden(toggleColumn(got[0].columns, got[0].hidden, 'group'));
    assert.deepEqual(next, []);
  });
});
