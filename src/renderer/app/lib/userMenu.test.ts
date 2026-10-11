import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MenuEntry } from '../../ui/index.ts';
import { buildUserMenu } from './userMenu.ts';
import type { UserMenuActions } from './userMenu.ts';

const calls: string[] = [];
const on: UserMenuActions = {
  appearance: () => calls.push('appearance'),
  shortcutBar: () => calls.push('shortcutBar'),
  shortcuts: () => calls.push('shortcuts'),
  about: () => calls.push('about'),
  password: () => calls.push('password'),
  lock: () => calls.push('lock'),
  logout: () => calls.push('logout'),
};
const owner = { implicit: false, displayName: 'Suresh Gupta', username: 'suresh', role: 'Owner' };
const label = (e: MenuEntry) => ('type' in e ? `[${e.type}]${e.type === 'label' ? ` ${String(e.label)}` : ''}` : String(e.label));

describe('user menu (2.1, SPEC-21 §1.12)', () => {
  test('a secured company: at most 9 rows, in the agreed order', () => {
    const rows = buildUserMenu({ session: owner, shortcutBar: false, canAbout: true }, on);
    assert.ok(rows.length <= 9, `${rows.length} rows`);
    assert.deepEqual(rows.map(label), [
      '[label] Suresh Gupta · Owner',
      'Appearance…',
      'Show shortcut bar',
      'Keyboard shortcuts',
      'About Pevqori',
      '[separator]',
      'Change password',
      'Lock',
      'Log out',
    ]);
  });

  test('security off: no name, no password / lock / log out', () => {
    const rows = buildUserMenu({ session: { ...owner, implicit: true }, shortcutBar: true, canAbout: true }, on);
    assert.deepEqual(rows.map(label), ['Appearance…', 'Show shortcut bar', 'Keyboard shortcuts', 'About Pevqori']);
    assert.deepEqual(buildUserMenu({ session: null, shortcutBar: true, canAbout: false }, on).map(label), ['Appearance…', 'Show shortcut bar', 'Keyboard shortcuts']);
  });

  test('theme, density and Home view live only in Appearance…; no icons; F1 is the only key', () => {
    const rows = buildUserMenu({ session: owner, shortcutBar: false, canAbout: true }, on);
    const text = rows.map(label).join(' | ');
    for (const gone of ['Theme', 'Light', 'Dark', 'Match Windows', 'Density', 'Compact', 'Comfortable', 'Home view', 'Essentials', 'All menus']) {
      assert.ok(!text.includes(gone), `${gone} is not in the user menu`);
    }
    for (const r of rows) if (!('type' in r)) assert.equal(r.icon, undefined, `${String(r.label)} draws no icon`);
    const keyed = rows.filter((r) => !('type' in r) && r.shortcut);
    assert.deepEqual(
      keyed.map((r) => ('type' in r ? '' : r.shortcut)),
      ['F1'],
    );
  });

  test('the shortcut bar is a checkable row that mirrors the preference; every row runs its action', () => {
    const find = (rows: MenuEntry[], key: string) => rows.find((r) => !('type' in r) && r.key === key);
    const on1 = find(buildUserMenu({ session: owner, shortcutBar: true, canAbout: true }, on), 'shortcut-bar');
    const off = find(buildUserMenu({ session: owner, shortcutBar: false, canAbout: true }, on), 'shortcut-bar');
    assert.ok(on1 && !('type' in on1) && on1.checked === true);
    assert.ok(off && !('type' in off) && off.checked === false);
    calls.length = 0;
    for (const r of buildUserMenu({ session: owner, shortcutBar: false, canAbout: true }, on)) if (!('type' in r)) r.onSelect?.();
    assert.deepEqual(calls, ['appearance', 'shortcutBar', 'shortcuts', 'about', 'password', 'lock', 'logout']);
  });
});
