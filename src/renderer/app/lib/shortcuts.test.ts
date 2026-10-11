import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONVENTION_SHORTCUTS, GLOBAL_SHORTCUTS, reservedGlobalKeys, shortcutGroups, shortcutRows, thisScreenLabel } from './shortcuts.ts';

const keysOf = (keys: string) => keys.split(',').map((k) => k.trim().toLowerCase());

describe('keyboard map', () => {
  test('no global key is listed twice', () => {
    const all = GLOBAL_SHORTCUTS.flatMap((s) => keysOf(s.keys));
    assert.equal(new Set(all).size, all.length);
  });

  test('screen conventions never use a reserved global key (e.g. Alt+F5 = Sales Order)', () => {
    const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));
    const clashes = CONVENTION_SHORTCUTS.flatMap((s) => keysOf(s.keys)).filter((k) => reserved.has(k));
    assert.deepEqual(clashes, []);
    assert.ok(reserved.has('alt+f5'));
  });

  test('each convention key has one meaning within its group', () => {
    const seen = new Map<string, string>();
    for (const s of CONVENTION_SHORTCUTS) {
      for (const k of keysOf(s.keys)) {
        const id = `${s.group}:${k}`;
        assert.ok(!seen.has(id), `${k} means both "${seen.get(id)}" and "${s.label}" in ${s.group}`);
        seen.set(id, s.label);
      }
    }
  });

  test('the cross-screen conventions are documented (F1 overlay)', () => {
    const documented = new Set(CONVENTION_SHORTCUTS.flatMap((s) => keysOf(s.keys)));
    for (const k of ['alt+d', 'ctrl+d', 'alt+2', 'alt+x', 'alt+a', 'alt+enter', 'alt+f1', 'alt+m', 'ctrl+1', 'ctrl+f', 'alt+n', 'alt+e', 'alt+p', 'ctrl+p', 'alt+h']) {
      assert.ok(documented.has(k), `${k} missing from CONVENTION_SHORTCUTS`);
    }
  });

  test('2.1 rows (SPEC-21 §3.3): Ctrl+I, Ctrl+J and Hold Ctrl are documented once, never a reserved global key', () => {
    const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));
    for (const key of ['ctrl+i', 'ctrl+j', 'hold ctrl']) {
      const rows = CONVENTION_SHORTCUTS.filter((s) => keysOf(s.keys).includes(key));
      assert.equal(rows.length, 1, `${key} is listed once`);
      assert.equal(rows[0].global, false, `${key} is not registered by the shell`);
      assert.ok(!reserved.has(key), `${key} is not a global key`);
    }
    const row = (key: string) => CONVENTION_SHORTCUTS.find((s) => keysOf(s.keys).includes(key));
    assert.match(row('ctrl+j')?.label ?? '', /graphs/);
    assert.match(row('ctrl+i')?.label ?? '', /^More details/);
    assert.equal(row('hold ctrl')?.group, 'Help');
    // Ctrl+F also searches the Day Book and the voucher lists in 2.1.
    assert.match(row('ctrl+f')?.description ?? '', /Day Book/);
    // Alt+F1: Detailed on the voucher view, the More details alias on the master forms.
    assert.match(row('alt+f1')?.description ?? '', /voucher view/);
    assert.match(row('alt+f1')?.description ?? '', /Ctrl\+I/);
  });

  test('every key text is unique across the whole table (no row repeats another)', () => {
    const rows = [...GLOBAL_SHORTCUTS, ...CONVENTION_SHORTCUTS].map((s) => `${s.group}|${s.keys}|${s.label}`);
    assert.equal(new Set(rows).size, rows.length);
  });
});

describe('F1 card (2.1, SPEC-21 D32)', () => {
  const actions = [
    { key: 'Alt+A', label: 'Alter' },
    { key: '', label: 'About this report' }, // menu-only (NO_KEY): registers nothing
    { key: 'Alt+X', label: 'Cancel voucher', hidden: true }, // hidden: registers nothing
    { key: 'Alt+P', label: 'Print' },
  ];
  const hint = 'Enter Open · Alt+F2 Period · Alt+E Export · Alt+P Print · Esc Back';

  test('"This screen — <title>" comes first: the hint line, then the actions that have a key', () => {
    const rows = shortcutRows(actions, 'Day Book');
    const groups = shortcutGroups(rows, '', { title: 'Day Book', hint });
    assert.equal(groups[0].label, thisScreenLabel('Day Book'));
    assert.equal(groups[0].label, 'This screen — Day Book');
    assert.equal(groups[0].hint, hint);
    assert.deepEqual(
      groups[0].rows.map((r) => `${r.keys} ${r.label}`),
      ['Alt+A Alter', 'Alt+P Print'],
    );
    // Then every global group and every convention group, each once.
    const labels = groups.map((g) => g.label);
    assert.equal(new Set(labels).size, labels.length);
    for (const g of new Set([...GLOBAL_SHORTCUTS, ...CONVENTION_SHORTCUTS].map((s) => s.group))) assert.ok(labels.includes(g), `${g} group`);
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    assert.equal(total, 2 + GLOBAL_SHORTCUTS.length + CONVENTION_SHORTCUTS.length);
  });

  test('a screen without keyed actions (Home) still gets its group with the hint line', () => {
    const groups = shortcutGroups(shortcutRows([], 'Home'), '', { title: 'Home', hint: '↑↓ Move · Enter Open' });
    assert.deepEqual(groups[0], { label: 'This screen — Home', hint: '↑↓ Move · Enter Open', rows: [] });
    // No hint and no keyed action: no empty group.
    assert.ok(!shortcutGroups(shortcutRows([], 'Home'), '', { title: 'Home' }).some((g) => g.label === 'This screen — Home'));
  });

  test('the search filters rows and the hint line alike; the screen rows still match by "<title> screen"', () => {
    const rows = shortcutRows(actions, 'Day Book');
    const print = shortcutGroups(rows, 'print', { title: 'Day Book', hint });
    assert.equal(print[0].label, 'This screen — Day Book');
    assert.equal(print[0].hint, hint); // "Alt+P Print" is in the hint
    assert.ok(print[0].rows.some((r) => r.label === 'Print'));
    const byTitle = shortcutGroups(rows, 'day book screen', { title: 'Day Book', hint });
    assert.deepEqual(
      byTitle.flatMap((g) => g.rows.map((r) => r.label)),
      ['Alter', 'Print'],
    );
    assert.equal(byTitle[0].hint, undefined);
    assert.deepEqual(shortcutGroups(rows, 'zzzz-nothing', { title: 'Day Book', hint }), []);
  });
});

